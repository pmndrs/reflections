// Hit shading with its own lighting (group 3), for passes whose radiance fallback is not a
// lighting source: e.g. the three adapter, whose SSSR fallback is black because its composite adds
// the probe / environment term itself (packages/three/src/sssr/composite.ts).
//
// The traced hit is shaded as a Lambert surface (D11, D903):
//
//   L = emissive + albedo x (indirect(P, N) x intensity + sum_hemi mix(ground, sky, 0.5 N.up + 0.5) / pi
//                            + sum_dir colour x max(N.l, 0) x V(P, l) / pi)
//
// `indirect` is E / pi, the radiance a white Lambert surface reflects from what surrounds it:
//
//   - environmentHitShading: the cosine-weighted mean of the environment over the hemisphere
//     around N, a fixed 32-direction Fibonacci set (same set every pixel: no noise, a small bias on
//     sharp environments). Unoccluded: the sky as if nothing stood around the hit.
//   - probeHitShading (D901, W28): the probe lookup at the hit point along N at roughness 1, with the
//     environment slot for what no probe covers. That is what three's own lighting uses for the
//     diffuse term when the probes are the scene's environment node (EnvironmentNode's irradiance
//     context: direction N, level 1, x pi x intensity, then x albedo / pi), so lit walls and floors
//     around the hit bounce into it as they do on screen.
//
// The light terms are three's (BRDF_Lambert = albedo / pi, hemisphere weight 0.5 N.up + 0.5). V is
// a shadow ray toward each directional light (the pass's `traceLightVisible`, any-hit; 1 with
// `hitShadows` off; D903). The indirect and hemisphere terms are unshadowed.
//
// Plus, for providers with `traceHitSpecular` (W41, D3510), the specular lobe and clear coat by
// `hitLayered` (three's split sum, the coat layered as three's finish()) on the radiance along the
// mirror direction R at the hit's roughness: the environment (a cone around R whose width follows
// the roughness; one sample below alpha 0.01), or the probe lookup at (P, R, roughness). Without it
// a metal hit (albedo x (1 - metalness) = 0) was black: a mirror floor or metal car paint seen by
// a ray.
import type { HitShading } from './provider';
import { probeLookupWgsl, type ProbeLookupOptions } from '../probes/lookup';
import type { ProbeSet } from '../probes/set';

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

// Directional (shadowed) and hemisphere lights, E / pi (needs `hitEnv`).
const LIGHTS = /* wgsl */ `
// Shadow rays toward directional lights: far enough to leave any scene.
const HIT_SHADOW_RAY_LENGTH: f32 = 1e30;
fn hitLights(P: vec3f, N: vec3f) -> vec3f {
  var E = vec3f(0.0);
  for (var i = 0u; i < min(hitEnv.counts.x, ${HIT_MAX_DIRECTIONAL}u); i++) {
    let l = hitEnv.dirDirection[i].xyz;
    let nl = dot(N, l);
    if (nl <= 0.0) { continue; }
    if (!traceLightVisible(P, N, l, HIT_SHADOW_RAY_LENGTH)) { continue; }
    E += hitEnv.dirColor[i].rgb * nl;
  }
  for (var i = 0u; i < min(hitEnv.counts.y, ${HIT_MAX_HEMISPHERE}u); i++) {
    E += mix(hitEnv.hemiGround[i].rgb, hitEnv.hemiSky[i].rgb, dot(N, hitEnv.hemiUp[i].xyz) * 0.5 + 0.5);
  }
  return E * 0.31830989;
}
`;

const SPECULAR = /* wgsl */ `
// The specular lobe and clear coat on top of the diffuse part (W41, D3510); needs
// hitSpecularRadiance(P, R, roughness), the radiance along R at a perceptual roughness.
fn hitShadeSurface(hit: Hit, P: vec3f, N: vec3f, dir: vec3f, emissive: vec3f, diffuse: vec3f) -> vec3f {
  return hitShadeLobe(traceHitSpecular(hit), P, N, dir, emissive, diffuse);
}
// The same for a lobe that does not come from the provider (W44, D3540: a screen-space hit's
// material read from the G-buffer).
fn hitShadeLobe(s: HitSpecular, P: vec3f, N: vec3f, dir: vec3f, emissive: vec3f, diffuse: vec3f) -> vec3f {
  if (!rtHitSpecularOn() || (max(s.color.x, max(s.color.y, s.color.z)) <= 0.0 && s.clearcoat <= 0.0)) { return emissive + diffuse; }
  let R = reflect(dir, N);
  let NdotV = clamp(dot(N, -dir), 1e-4, 1.0);
  // Specular visibility (D3513): one any-hit ray along R; where geometry blocks it, what the lobe sees
  // is not the environment / probe (a car's sill over a mirror floor sees its own underside). Rough
  // lobes leak around the blocker, so the occlusion fades out from roughness 0.3 to 1.
  var vis = 1.0;
  if (!traceLightVisible(P, N, R, HIT_SHADOW_RAY_LENGTH)) { vis = smoothstep(0.3, 1.0, s.roughness); }
  let envBase = hitSpecularRadiance(P, R, hitLookupRoughness(s.roughness)) * vis;
  var envCoat = envBase;
  if (s.clearcoat > 0.0 && abs(s.clearcoatRoughness - s.roughness) > 0.02) { envCoat = hitSpecularRadiance(P, R, hitLookupRoughness(s.clearcoatRoughness)) * select(smoothstep(0.3, 1.0, s.clearcoatRoughness), 1.0, vis >= 1.0); }
  return emissive + hitLayered(s, diffuse, envBase, envCoat, NdotV);
}
`;

/**
 * `hitShadeLobe` / `hitShadeSurface` on the pass's radiance fallback (`sampleRadianceFallback` along
 * R at the lobe's roughness), for a hit shading that does not define them (core's
 * `fallbackHitShading`, or a screen-space pass without one; W44, D3540).
 */
export const FALLBACK_SHADE_LOBE_WGSL = /* wgsl */ `
const HIT_SHADOW_RAY_LENGTH: f32 = 1e30;
fn hitSpecularRadiance(P: vec3f, R: vec3f, roughness: f32) -> vec3f { return sampleRadianceFallback(P, R, roughness); }
${SPECULAR}`;

/**
 * Re-shade occlusion without a BVH (W52, D3642): a short march along R from a re-shaded hit through
 * the depth buffer, the screen-space stand-in for D3513's visibility ray. `false` when a sample
 * along R lands behind the depth buffer by less than a thickness, i.e. something the camera sees
 * stands in front of the lobe (a rim's R into the wheel well, a sill's R into the underside).
 * Off screen, behind the camera or past the background: unknown, counted visible.
 *
 * Needs, from the pass that includes it: `hsoProject(p) -> vec3f` (uv and clip w of a world
 * point), `hsoSceneDistance(c) -> f32` (camera distance of the depth buffer's surface at pixel c;
 * a huge value for the background), `hsoCamera() -> vec3f`, `hsoSize() -> vec2u`, and the private
 * `hsoPixel` (the reflecting pixel, for the step jitter).
 *
 * The march is HSO_STEPS samples on t = len x ((i + j) / n)^2 (denser near the hit), len =
 * HSO_LENGTH x the hit's camera distance, thickness HSO_THICKNESS x that distance, starting past a
 * normal offset of 3e-3 x the distance (the traced pass's own, D8). Samples within 1.5 px of the
 * hit's own pixel are skipped (its own surface).
 */
export const SCREEN_VISIBILITY_WGSL = /* wgsl */ `
const HSO_STEPS: u32 = 8u;
const HSO_LENGTH: f32 = 0.3;
const HSO_THICKNESS: f32 = 0.15;
var<private> hsoPixel: vec2u = vec2u(0u);
fn hitScreenVisible(hitP: vec3f, N: vec3f, R: vec3f) -> bool {
  let cam = hsoCamera();
  let d0 = length(hitP - cam);
  let size = vec2f(hsoSize());
  let start = hsoProject(hitP);
  let c0 = start.xy * size;
  let origin = hitP + N * (3e-3 * d0);
  let len = HSO_LENGTH * d0;
  let thickness = HSO_THICKNESS * d0;
  // interleaved gradient noise (Jimenez 2014): one start offset per pixel, the denoiser blurs it
  let j = fract(52.9829189 * fract(dot(vec2f(hsoPixel), vec2f(0.06711056, 0.00583715))));
  for (var i = 0u; i < HSO_STEPS; i++) {
    let s = (f32(i) + j) / f32(HSO_STEPS);
    let X = origin + R * (len * s * s);
    let q = hsoProject(X);
    if (q.z <= 0.0 || any(q.xy <= vec2f(0.0)) || any(q.xy >= vec2f(1.0))) { return true; }
    let c = q.xy * size;
    if (all(abs(c - c0) < vec2f(1.5))) { continue; }
    let behind = length(X - cam) - hsoSceneDistance(vec2i(c));
    if (behind > 0.01 * d0 && behind < thickness) { return false; }
  }
  return true;
}
`;

/** The WGSL to add after a hit shading's own so that `hitShadeLobe` / `hitShadeSurface` exist. */
export function shadeLobeWgslFor(shadingWgsl: string): string {
  return /fn\s+hitShadeLobe\s*\(/.test(shadingWgsl) ? '' : FALLBACK_SHADE_LOBE_WGSL;
}

// The environment's cosine-weighted hemisphere mean (needs `hitEnvSample`).
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
${LIGHTS}
// The environment along R at perceptual roughness r: one sample for near-mirrors, else a cone whose
// radius follows alpha (a rough stand-in for the prefiltered GGX lobe).
fn hitSpecularRadiance(P: vec3f, R: vec3f, roughness: f32) -> vec3f {
  let alpha = roughness * roughness;
  if (alpha < 0.01) { return hitEnvSampleSharp(R) * hitEnv.intensity.x; }
  return hitEnvLobe(R, min(1.0, 2.0 * alpha), true) * hitEnv.intensity.x;
}
${SPECULAR}
fn shadeTracedHit(hit: Hit, P: vec3f, N: vec3f, dir: vec3f) -> vec3f {
  let m = traceHitMaterial(hit);
  return hitShadeSurface(hit, P, N, dir, m.emissive, m.albedo * (hitEnvMean(N) * hitEnv.intensity.x + hitLights(P, N)));
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
  let dx = select(d.x, 1e-6, abs(d.x) + abs(d.z) < 1e-6); // atan2(0, 0) is NaN on some backends (the poles)
  let uv = vec2f(atan2(d.z, dx) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
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

/** The `HitEnv` uniform (intensity, lights) and its writer, shared by both hit shadings. */
function hitLightingUniform(device: GPUDevice, label: string) {
  const uniform = device.createBuffer({ label, size: UNIFORM_BYTES, usage: 0x40 | 0x8 /* UNIFORM | COPY_DST */ });
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
  return { uniform, setLighting };
}

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
  const { uniform, setLighting } = hitLightingUniform(device, 'rt hit env');
  let sampler: GPUSampler | undefined;
  return {
    wgsl: (mapping === 'equirect' ? EQUIRECT : CUBE) + SHADE,
    layout,
    sampledTextureCount: 1,
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

// ---- probes at the hit (D901) -------------------------------------------------------------------

/**
 * Where a probe hit shading's lookup comes from: a core {@link ProbeSet} (its lookup options and,
 * in `createBindGroup`, its atlas / sampler / table), or the lookup options of an engine's own
 * atlas and table (three's ReflectionProbes: `probeLayoutFor(probes)`, `mirrorX: true`, `count`).
 */
export type ProbeHitShadingSource = ProbeSet | ProbeLookupOptions;

/** The probe set's GPU resources for {@link ProbeHitShading.createBindGroup}. */
export interface ProbeHitShadingResources {
  /** The atlas, viewed as the layout's `viewDimension` (a ProbeSet's `atlasView`). */
  atlas: GPUTextureView;
  /** A filtering sampler (a ProbeSet's `sampler`). */
  sampler: GPUSampler;
  /** The volume table (core `packProbeTable` rows; a ProbeSet's `table`). */
  table: GPUBuffer;
  /**
   * A set with several atlases (one per probe size, D4700): atlases 1.. in order, viewed like
   * `atlas` (a ProbeSet's `atlasViews.slice(1)`); one per extra atlas the shading was compiled for
   * (`atlases - 1`). Omit for a one-atlas set.
   */
  atlases?: readonly GPUTextureView[];
}

export interface ProbeHitShading extends HitShading {
  readonly layoutId: string;
  createBindGroup(resources: ProbeHitShadingResources): GPUBindGroup;
  /** Environment intensity (scales the probe term, as three's `environmentIntensity`) and lights. */
  setLighting(intensity: number, lights?: HitLights): void;
  destroy(): void;
}

// The probe lookup module sits at bindings 0..2 of group 3 (atlas, sampler, table: a ProbeSet's
// own layout), the HitEnv uniform at 3, a multi-size set's atlases 1.. at 4.. (D4702: the lookup's
// `atlasBinding`; a ProbeSet's own group has them at 3..). Its set-level names carry
// PROBE_HIT_SUFFIX (`pr_atlas_g3`, `probeRadianceWithEnvironment_g3`, ...), so a pass whose radiance
// fallback is the same set's lookup at group 1 (`probeRadianceFallback`) holds both; the shared
// includes are marked chunks the pass keeps once (`dedupeWgslChunks`, D4901).
const PROBE_HIT_SUFFIX = '_g3';
const PROBE_SHADE = /* wgsl */ `
${UNIFORM_WGSL}
@group(3) @binding(3) var<uniform> hitEnv: HitEnv;
${LIGHTS}
// The probes along R at the hit's roughness (box-projected from the hit point, the environment slot
// for the rest), as three's specular IBL with the probes as the environment (W41, D3510).
fn hitSpecularRadiance(P: vec3f, R: vec3f, roughness: f32) -> vec3f {
  return probeRadianceWithEnvironment${PROBE_HIT_SUFFIX}(P, R, roughness) * hitEnv.intensity.x;
}
${SPECULAR}
fn shadeTracedHit(hit: Hit, P: vec3f, N: vec3f, dir: vec3f) -> vec3f {
  let m = traceHitMaterial(hit);
  // three's diffuse IBL with the probes as the environment: lookup(P, N, roughness 1) x pi x
  // intensity x albedo / pi; probes first, the environment slot for the rest
  let E = probeRadianceWithEnvironment${PROBE_HIT_SUFFIX}(P, N, 1.0);
  return hitShadeSurface(hit, P, N, dir, m.emissive, m.albedo * (E * hitEnv.intensity.x + hitLights(P, N)));
}
`;

const isProbeSet = (s: ProbeHitShadingSource): s is ProbeSet => typeof (s as ProbeSet).wgsl === 'function';

/**
 * Hit shading from reflection probes at the hit point (D901, SPEC section 4): emissive + albedo x
 * (the probe lookup at P along N at roughness 1 x intensity + the directional / hemisphere lights of
 * {@link environmentHitShading}). Group 3 holds the lookup's atlas, sampler and table (bindings
 * 0..2) and the lighting uniform (3); one storage buffer (the table). A set with several atlases
 * (probes of several sizes, D4700: a ProbeSet with mixed `slotSizes`, or lookup options with
 * `atlases`) binds atlases 1.. at 4.. (`resources.atlases`); a one-atlas set compiles as before.
 *
 *   const shading = probeHitShading(device, set);   // or (device, { layout, mirrorX, count })
 *   const rt = createTracedReflections(device, { ..., hitShading: shading });
 *   rt.dispatch(cmd, { ..., hitShadingBindGroup: shading.createBindGroup({ atlas: set.atlasView, sampler: set.sampler, table: set.table, atlases: set.atlasViews.slice(1) }) });
 */
export function probeHitShading(device: GPUDevice, source: ProbeHitShadingSource): ProbeHitShading {
  const layoutDesc = source.layout;
  const C = 0x4;
  // atlases 1.. of a multi-size set (D4700) after the uniform (D4702)
  const atlases = isProbeSet(source) ? source.atlasViews.length : Math.floor(source.atlases ?? 1);
  const texture = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, texture: { sampleType: 'float', viewDimension: layoutDesc.viewDimension } });
  const layout = device.createBindGroupLayout({
    label: `rt hit shading (probes, ${layoutDesc.id}${atlases > 1 ? `, ${atlases} atlases` : ''})`,
    entries: [
      texture(0),
      { binding: 1, visibility: C, sampler: { type: 'filtering' } },
      { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: C, buffer: { type: 'uniform' } },
      ...Array.from({ length: atlases - 1 }, (_, k) => texture(4 + k)),
    ],
  });
  const { uniform, setLighting } = hitLightingUniform(device, 'rt hit probes');
  const lookup = isProbeSet(source)
    ? source.wgsl({ group: 3, atlasBinding: 4, suffix: PROBE_HIT_SUFFIX })
    : probeLookupWgsl({ ...source, group: 3, binding: 0, atlasBinding: 4, suffix: PROBE_HIT_SUFFIX });
  return {
    wgsl: lookup + PROBE_SHADE,
    layout,
    storageBufferCount: 1,
    sampledTextureCount: atlases,
    layoutId: layoutDesc.id,
    createBindGroup({ atlas, sampler, table, atlases: extra = [] }) {
      if (extra.length !== atlases - 1) throw new Error(`probeHitShading: compiled for ${atlases} atlases, got ${1 + extra.length} (resources.atlases holds atlases 1..)`);
      return device.createBindGroup({
        label: 'rt hit probes', layout,
        entries: [{ binding: 0, resource: atlas }, { binding: 1, resource: sampler }, { binding: 2, resource: { buffer: table } }, { binding: 3, resource: { buffer: uniform } },
          ...extra.map((v, k) => ({ binding: 4 + k, resource: v }))],
      });
    },
    setLighting,
    destroy() { uniform.destroy(); },
  };
}

// ---- @pmndrs/raytracer's one-bounce shading at the hit (P1.5, D5201) ----------------------------------

/**
 * Hit shading by the provider's `traceHitShade` (`capabilities.hitShade`: `createRaytracerTraceProvider`):
 * @pmndrs/raytracer's `rtShade` in its FULL mode, i.e. emission + `samples` light samples (light picked by power
 * among the scene copy's emissive triangles, sun and environment; one shadow ray each), each through the builtin
 * diffuse + GGX BSDF. That is a path tracer's first bounce at maxDepth 1: no indirect light, no probes (the
 * probes hold the emitters and the sky too, so adding their irradiance would count those twice; D5201).
 * Stochastic: the pixel and `setFrame(frame)` seed it; the denoiser averages it.
 *
 *   const shading = raytracerHitShading(device);
 *   const rt = createTracedReflections(device, { ..., provider, hitShading: shading });
 *   shading.setFrame(frameIndex);   // every frame
 *   rt.dispatch(cmd, { ..., hitShadingBindGroup: shading.bindGroup });
 */
export interface RaytracerHitShading extends HitShading {
  readonly bindGroup: GPUBindGroup;
  /** Seeds this frame's light samples (any integer; change it every frame). */
  setFrame(frame: number): void;
  destroy(): void;
}

export function raytracerHitShading(device: GPUDevice, options: { samples?: number } = {}): RaytracerHitShading {
  const samples = Math.max(1, Math.floor(options.samples ?? 1));
  const layout = device.createBindGroupLayout({ label: 'rt hit shading (raytracer)', entries: [{ binding: 0, visibility: 0x4, buffer: { type: 'uniform' } }] });
  const uniform = device.createBuffer({ label: 'rt hit shading (raytracer)', size: 16, usage: 0x40 | 0x8 /* UNIFORM | COPY_DST */ });
  const words = new Uint32Array(4);
  const setFrame = (frame: number) => { words[0] = frame >>> 0; device.queue.writeBuffer(uniform, 0, words); };
  setFrame(0);
  return {
    wgsl: /* wgsl */ `
@group(3) @binding(0) var<uniform> rtpShadeFrame: vec4u;
const RTP_SHADE_SAMPLES: u32 = ${samples}u;
fn rtpShadeHash(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rtpShadeRand(seed: u32, k: u32) -> f32 { return f32(rtpShadeHash(seed ^ rtpShadeHash(k + 0x9e3779b9u)) >> 8u) * 5.9604644775390625e-8; }
fn shadeTracedHit(hit: Hit, P: vec3f, N: vec3f, dir: vec3f) -> vec3f {
  let origin = P - dir * hit.t;
  let seed = rtpShadeHash((hsoPixel.x * 0x8da6b343u) ^ (hsoPixel.y * 0xd8163841u) ^ rtpShadeHash(rtpShadeFrame.x));
  var L = vec3f(0.0);
  for (var i = 0u; i < RTP_SHADE_SAMPLES; i++) {
    let u = vec3f(rtpShadeRand(seed, 3u * i), rtpShadeRand(seed, 3u * i + 1u), rtpShadeRand(seed, 3u * i + 2u));
    L += traceHitShade(hit, origin, dir, u);
  }
  return L / f32(RTP_SHADE_SAMPLES);
}
`,
    layout,
    requiresHitShade: true,
    bindGroup: device.createBindGroup({ label: 'rt hit shading (raytracer)', layout, entries: [{ binding: 0, resource: { buffer: uniform } }] }),
    setFrame,
    destroy() { uniform.destroy(); },
  };
}
