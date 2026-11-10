// Hit shading with its own environment (group 3), for passes whose radiance fallback is not a
// lighting source: e.g. the three adapter, whose SSSR fallback is black because its composite adds
// the probe / environment term itself (packages/three/src/sssr/composite.ts).
//
// The traced hit is shaded as a diffuse surface: emissive + albedo x E(N) / pi x intensity, where
// E / pi is the cosine-weighted mean of the environment over the hemisphere around N, estimated
// with a fixed 32-direction Fibonacci set (same set every pixel: no noise, a small bias on sharp
// environments). No direct light, no shadows, no probes yet (W7 brings a probe snippet; D901).
import type { HitShading } from './provider';

export type EnvironmentMapping = 'equirect' | 'cube';

const HEMISPHERE = /* wgsl */ `
const HIT_ENV_SAMPLES: u32 = 32u;
fn hitEnvIrradiance(N: vec3f) -> vec3f {
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
    let r = sqrt(u);
    let phi = f32(i) * 2.39996323;
    let d = T * (r * cos(phi)) + B * (r * sin(phi)) + N * sqrt(max(0.0, 1.0 - u));
    sum += hitEnvSample(d);
  }
  return sum / f32(HIT_ENV_SAMPLES);
}
fn shadeTracedHit(hit: Hit, P: vec3f, N: vec3f, dir: vec3f) -> vec3f {
  let m = traceHitMaterial(hit);
  return m.emissive + m.albedo * hitEnvIrradiance(N) * hitEnv.intensity.x;
}
`;

// three's equirectUV (u = atan(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5), texel row = v x height,
// read with textureLoad + bilinear so float32 data (unfilterable without 'float32-filterable') works.
const EQUIRECT = /* wgsl */ `
struct HitEnv { intensity: vec4f };
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
`;

const CUBE = /* wgsl */ `
struct HitEnv { intensity: vec4f };
@group(3) @binding(0) var hitEnvTexture: texture_cube<f32>;
@group(3) @binding(1) var<uniform> hitEnv: HitEnv;
@group(3) @binding(2) var hitEnvSampler: sampler;
fn hitEnvSample(d: vec3f) -> vec3f {
  // a coarse mip: the hemisphere sum does the integration
  let mip = max(0.0, f32(textureNumLevels(hitEnvTexture)) - 4.0);
  return textureSampleLevel(hitEnvTexture, hitEnvSampler, d, mip).rgb;
}
`;

export interface EnvironmentHitShading extends HitShading {
  readonly mapping: EnvironmentMapping;
  /** `view`: an equirect 2-D texture (any float format) or a cube. Recreate when the texture changes. */
  createBindGroup(view: GPUTextureView, intensity?: number): GPUBindGroup;
  /** Update the intensity of groups made by `createBindGroup` (shared uniform). */
  setIntensity(intensity: number): void;
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
  const uniform = device.createBuffer({ label: 'rt hit env', size: 16, usage: 0x40 | 0x8 /* UNIFORM | COPY_DST */ });
  const setIntensity = (k: number) => device.queue.writeBuffer(uniform, 0, new Float32Array([k, 0, 0, 0]));
  setIntensity(1);
  let sampler: GPUSampler | undefined;
  return {
    wgsl: (mapping === 'equirect' ? EQUIRECT : CUBE) + HEMISPHERE,
    layout,
    mapping,
    createBindGroup(view, intensity) {
      if (intensity !== undefined) setIntensity(intensity);
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: uniform } }];
      if (mapping === 'cube') entries.push({ binding: 2, resource: (sampler ??= device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })) });
      return device.createBindGroup({ label: 'rt hit env', layout, entries });
    },
    setIntensity,
    destroy() { uniform.destroy(); },
  };
}
