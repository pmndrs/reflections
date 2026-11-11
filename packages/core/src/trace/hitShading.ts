// Hit shading with its own environment and lights (group 3), for passes whose radiance fallback is
// not a lighting source: e.g. the three adapter, whose SSSR fallback is black because its composite
// adds the probe / environment term itself (packages/three/src/sssr/composite.ts).
//
// The traced hit is shaded as a Lambert surface (D11, D903):
//
//   L = emissive + albedo x (envMean(N) x intensity + sum_hemi mix(ground, sky, 0.5 N.up + 0.5) / pi
//                            + sum_dir colour x max(N.l, 0) / pi)
//
// plus, for providers with `traceHitSpecular` (W27, D2700), the specular lobe and clear coat by
// `hitLayered`: the environment along the mirror direction R, as the mean over a cone around R
// whose width follows the roughness (one sample below ~0.1). Without it a metal hit (albedo
// x (1 - metalness) = 0) was black: a mirror floor or metal car paint seen by a ray.
//
// envMean is the cosine-weighted mean of the environment over the hemisphere around N (= E / pi),
// estimated with a fixed 32-direction Fibonacci set (same set every pixel: no noise, a small bias
// on sharp environments). The light terms are three's (BRDF_Lambert = albedo / pi, hemisphere
// weight 0.5 N.up + 0.5). No shadows, no probes yet (W7 brings a probe snippet; D901).
import type { HitShading } from './provider';

export type EnvironmentMapping = 'equirect' | 'cube';

/** Up to this many directional and hemisphere lights reach the hit shading (the rest are dropped). */
export const HIT_MAX_DIRECTIONAL = 4;
export const HIT_MAX_HEMISPHERE = 2;

export interface HitLights {
  /** `direction`: unit vector from the surface toward the light (world). `color`: colour x intensity (linear). */
  directional?: { direction: readonly [number, number, number]; color: readonly [number, number, number] }[];
  /** `up`: unit world direction of `sky`. Colours are colour x intensity (linear). */
  hemisphere?: { up: readonly [number, number, number]; sky: readonly [number, number, number]; ground: readonly [number, number, number] }[];
}

const UNIFORM_WGSL = /* wgsl */ `
struct HitEnv {
  intensity: vec4f,
  counts: vec4u,
  dirDirection: array<vec4f, ${HIT_MAX_DIRECTIONAL}>,
  dirColor: array<vec4f, ${HIT_MAX_DIRECTIONAL}>,
  hemiUp: array<vec4f, ${HIT_MAX_HEMISPHERE}>,
  hemiSky: array<vec4f, ${HIT_MAX_HEMISPHERE}>,
  hemiGround: array<vec4f, ${HIT_MAX_HEMISPHERE}>,
};`;
const UNIFORM_BYTES = 16 + 16 + 32 * HIT_MAX_DIRECTIONAL + 48 * HIT_MAX_HEMISPHERE;

const SHADE = /* wgsl */ `
const HIT_ENV_SAMPLES: u32 = 32u;
fn hitEnvMean(N: vec3f) -> vec3f { return hitEnvLobe(N, 1.0, false); }
// Mean of the environment over a cone around N: disk radius 'spread' in the tangent plane (1 = the
// cosine-weighted hemisphere). 'sharp' reads the full-resolution environment (specular).
fn hitEnvLobe(N: vec3f, spread: f32, sharp: bool) -> vec3f {
  // tangent frame (Duff et al. 2017)
  let s = select(-1.0, 1.0, N.z >= 0.0);
  let a = -1.0 / (s + N.z);
  let b = N.x * N.y * a;
  let T = vec3f(1.0 + s * N.x * N.x * a, s * b, -s * N.x);
  let B = vec3f(b, s + N.y * N.y * a, -N.y);
  var sum = vec3f(0.0);
  for (var i = 0u; i < HIT_ENV_SAMPLES; i++) {
    // cosine-weighted: r = sqrt(u), phi = golden angle x i
    let u = (f32(i) + 0.5) / f32(HIT_ENV_SAMPLES);
    let r = sqrt(u) * spread;
    let phi = f32(i) * 2.39996323;
    let d = T * (r * cos(phi)) + B * (r * sin(phi)) + N * sqrt(max(0.0, 1.0 - r * r));
    if (sharp) { sum += hitEnvSampleSharp(d); } else { sum += hitEnvSample(d); }
  }
  return sum / f32(HIT_ENV_SAMPLES);
}
fn hitLights(N: vec3f) -> vec3f {
  var E = vec3f(0.0);
  for (var i = 0u; i < min(hitEnv.counts.x, ${HIT_MAX_DIRECTIONAL}u); i++) {
    E += hitEnv.dirColor[i].rgb * max(dot(N, hitEnv.dirDirection[i].xyz), 0.0);
  }
  for (var i = 0u; i < min(hitEnv.counts.y, ${HIT_MAX_HEMISPHERE}u); i++) {
    E += mix(hitEnv.hemiGround[i].rgb, hitEnv.hemiSky[i].rgb, dot(N, hitEnv.hemiUp[i].xyz) * 0.5 + 0.5);
  }
  return E * 0.31830989;
}
// The environment along R at perceptual roughness r: one sample for near-mirrors, else a cone whose
// radius follows alpha (a rough stand-in for the prefiltered GGX lobe).
fn hitEnvSpecular(R: vec3f, roughness: f32) -> vec3f {
  let alpha = roughness * roughness;
  if (alpha < 0.01) { return hitEnvSampleSharp(R); }
  return hitEnvLobe(R, min(1.0, 2.0 * alpha), true);
}
fn shadeTracedHit(hit: Hit, P: vec3f, N: vec3f, dir: vec3f) -> vec3f {
  let m = traceHitMaterial(hit);
  let s = traceHitSpecular(hit);
  let diffuse = m.albedo * (hitEnvMean(N) * hitEnv.intensity.x + hitLights(N));
  if (max(s.color.x, max(s.color.y, s.color.z)) <= 0.0 && s.clearcoat <= 0.0) { return m.emissive + diffuse; }
  let R = reflect(dir, N);
  let NdotV = clamp(dot(N, -dir), 1e-4, 1.0);
  let envBase = hitEnvSpecular(R, s.roughness) * hitEnv.intensity.x;
  var envCoat = envBase;
  if (s.clearcoat > 0.0 && abs(s.clearcoatRoughness - s.roughness) > 0.02) { envCoat = hitEnvSpecular(R, s.clearcoatRoughness) * hitEnv.intensity.x; }
  return m.emissive + hitLayered(s, diffuse, envBase, envCoat, NdotV);
}
`;

// three's equirectUV (u = atan(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5), texel row = v x height,
// read with textureLoad + bilinear so float32 data (unfilterable without 'float32-filterable') works.
const EQUIRECT = /* wgsl */ `${UNIFORM_WGSL}
@group(3) @binding(0) var hitEnvTexture: texture_2d<f32>;
@group(3) @binding(1) var<uniform> hitEnv: HitEnv;
fn hitEnvTexel(c: vec2i, size: vec2i) -> vec3f {
  let x = ((c.x % size.x) + size.x) % size.x;
  let y = clamp(c.y, 0, size.y - 1);
  return textureLoad(hitEnvTexture, vec2i(x, y), 0).rgb;
}
fn hitEnvSample(d: vec3f) -> vec3f {
  let size = vec2i(textureDimensions(hitEnvTexture, 0));
  let uv = vec2f(atan2(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  let p = uv * vec2f(size) - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  return mix(mix(hitEnvTexel(i, size), hitEnvTexel(i + vec2i(1, 0), size), f.x),
             mix(hitEnvTexel(i + vec2i(0, 1), size), hitEnvTexel(i + vec2i(1, 1), size), f.x), f.y);
}
fn hitEnvSampleSharp(d: vec3f) -> vec3f { return hitEnvSample(d); }
`;

const CUBE = /* wgsl */ `${UNIFORM_WGSL}
@group(3) @binding(0) var hitEnvTexture: texture_cube<f32>;
@group(3) @binding(1) var<uniform> hitEnv: HitEnv;
@group(3) @binding(2) var hitEnvSampler: sampler;
fn hitEnvSample(d: vec3f) -> vec3f {
  // a coarse mip: the hemisphere sum does the integration
  let mip = max(0.0, f32(textureNumLevels(hitEnvTexture)) - 4.0);
  return textureSampleLevel(hitEnvTexture, hitEnvSampler, d, mip).rgb;
}
fn hitEnvSampleSharp(d: vec3f) -> vec3f { return textureSampleLevel(hitEnvTexture, hitEnvSampler, d, 0.0).rgb; }
`;

export interface EnvironmentHitShading extends HitShading {
  readonly mapping: EnvironmentMapping;
  /** `view`: an equirect 2-D texture (any float format) or a cube. Recreate when the texture changes. */
  createBindGroup(view: GPUTextureView): GPUBindGroup;
  /** Environment intensity and lights for groups made by `createBindGroup` (one shared uniform). */
  setLighting(intensity: number, lights?: HitLights): void;
  destroy(): void;
}

export function environmentHitShading(device: GPUDevice, mapping: EnvironmentMapping = 'equirect'): EnvironmentHitShading {
  const C = 0x4;
  const layout = device.createBindGroupLayout({
    label: `rt hit shading (${mapping} environment)`,
    entries: mapping === 'equirect'
      ? [{ binding: 0, visibility: C, texture: { sampleType: 'unfilterable-float' } }, { binding: 1, visibility: C, buffer: { type: 'uniform' } }]
      : [{ binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: 'cube' } }, { binding: 1, visibility: C, buffer: { type: 'uniform' } },
        { binding: 2, visibility: C, sampler: { type: 'filtering' } }],
  });
  const uniform = device.createBuffer({ label: 'rt hit env', size: UNIFORM_BYTES, usage: 0x40 | 0x8 /* UNIFORM | COPY_DST */ });
  const data = new ArrayBuffer(UNIFORM_BYTES);
  const f = new Float32Array(data), u = new Uint32Array(data);
  const setLighting = (k: number, lights: HitLights = {}) => {
    f.fill(0);
    f[0] = k;
    const dirs = (lights.directional ?? []).slice(0, HIT_MAX_DIRECTIONAL);
    const hemis = (lights.hemisphere ?? []).slice(0, HIT_MAX_HEMISPHERE);
    u[4] = dirs.length; u[5] = hemis.length;
    const D = 8, DC = D + 4 * HIT_MAX_DIRECTIONAL, HU = DC + 4 * HIT_MAX_DIRECTIONAL, HS = HU + 4 * HIT_MAX_HEMISPHERE, HG = HS + 4 * HIT_MAX_HEMISPHERE;
    dirs.forEach((l, i) => { f.set(l.direction, D + 4 * i); f.set(l.color, DC + 4 * i); });
    hemis.forEach((l, i) => { f.set(l.up, HU + 4 * i); f.set(l.sky, HS + 4 * i); f.set(l.ground, HG + 4 * i); });
    device.queue.writeBuffer(uniform, 0, data);
  };
  setLighting(1);
  let sampler: GPUSampler | undefined;
  return {
    wgsl: (mapping === 'equirect' ? EQUIRECT : CUBE) + SHADE,
    layout,
    mapping,
    createBindGroup(view) {
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: uniform } }];
      if (mapping === 'cube') entries.push({ binding: 2, resource: (sampler ??= device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })) });
      return device.createBindGroup({ label: 'rt hit env', layout, entries });
    },
    setLighting,
    destroy() { uniform.destroy(); },
  };
}
