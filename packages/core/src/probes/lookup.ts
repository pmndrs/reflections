// The probe lookup, in WGSL: influence weights, priority, blending, box projection and the
// roughness-to-mip mapping of three.js #35046 (Ben Houston), over any ProbeLayout and the volume
// table of ./table.ts. Engine-free. Two ways to bind it:
//
//   probeLookupWgsl(options)      a module snippet with its own bindings in @group(options.group):
//                                 0 the atlas (layout.textureType), 1 a filtering sampler, 2 the table
//                                 (storage, read). Defines probeRadiance(), probeRadianceWithEnvironment()
//                                 and friends. For raw WebGPU, babylon, pixi: see ProbeSet (./set.ts).
//   probeLookupFunctionWgsl(...)  one function that takes the atlas, sampler and table as parameters
//                                 (`ptr<storage, array<vec4f>, read>`, WGSL's unrestricted pointer
//                                 parameters), for engines that own the bindings: three's adapter calls
//                                 it through `wgslFn`.
//
// Both are the same body (`lookupBody` below); only how a table row is read differs.
//
// Method (#35046, as ported in packages/three before phase 2; D58): volumes are walked in table order.
// Each takes `clamp(distance inside its influence box / fade) * remaining` of the weight and leaves
// the rest to the next; inside its projection box the direction is box-projected (Lagarde's BPCEM,
// the guarded form of #35046) and sampled from the capture point. What is left over goes to the
// environment slot (or, for the coverage form, the radiance is normalized by the weight it got).
// lod = maxLod * r * (2 - r) (three r187's PMREM mapping, D3), r perceptual roughness.
//
// Options, each off by default:
//   dominantDirection  Lagarde 2014's specular dominant direction, mix(N, R, s * (sqrt(s) + a)),
//                      s = 1 - a, a = perceptual^2 (Frostbite's `roughness`), D57. Needs N. The probe
//                      volumes and the environment slot sample the same bent direction (F2).
//   refit              idTech 8 / Lazarov 2013 normalization: each probe's radiance times
//                      clamp(frameIrradiance(P, N) / probeIrradiance(N), 0, refitClamp), with
//                      probeIrradiance the probe's L1 SH (table rows, ./irradiance.ts), D60.
//   probeSpecularOcclusion(NdotV, ao, roughness) is always defined: Lagarde 2014's
//                      saturate(pow(NdotV + ao, exp2(-16 a - 1)) - 1 + ao), a = perceptual^2, D66.
//
// Direction convention: R and N are world directions. `mirrorX` mirrors x before the layout lookup,
// for engines whose cube captures are x-mirrored (three's CubeCamera).

import { PROBE_HEADER_ROWS, PROBE_IRRADIANCE_ROWS, PROBE_ROWS_PER_VOLUME } from './table';
import type { ProbeLayout } from './layouts/types';

/**
 * How roughness maps to the atlas mip. 'r187': three r187's `maxLod * r * (2 - r)` (D3), so a
 * lookup between two mips blends them linearly in lod. 'alpha': the same mips (each exact at the
 * roughness it was prefiltered for), but between neighbouring mips that are both below r = 0.3 the
 * blend is linear in alpha = r^2, the lobe width, instead of in lod (D101 experiment, W7).
 */
export type ProbeLodMapping = 'r187' | 'alpha';

export interface ProbeLookupOptions {
  layout: ProbeLayout;
  /** The atlas holds x-mirrored captures (three's CubeCamera). Default false. */
  mirrorX?: boolean;
  /** Lagarde's dominant direction (D57). Default false. */
  dominantDirection?: boolean;
  /** Re-fit by frame irradiance (SPEC "Probe re-fit", D60). Default false. */
  refit?: boolean;
  /** Roughness to mip. Default 'r187'. */
  lodMapping?: ProbeLodMapping;
  /**
   * Unroll the volume loop for exactly this many volumes (the table's count is then ignored). An
   * engine that recompiles when the probe count changes (three) gets constant table indices; the
   * runtime loop measured ~1.5x the lookup cost on Apple M-series (W7). Default: a runtime loop.
   */
  count?: number;
}

/** WGSL roughness -> lod for a mapping (`r` perceptual, clamped). */
export function lodWgsl(mapping: ProbeLodMapping = 'r187') {
  switch (mapping) {
    case 'r187': return 'maxLod * r * (2.0 - r)';
    case 'alpha': return 'pr_lodAlpha(r, maxLod)';
  }
}

/**
 * Helpers every flavour shares (no bindings). Names are prefixed `pr_`. They depend only on the layout,
 * `mirrorX` and `lodMapping`, so lookups with different dominant-direction / re-fit / count options
 * can share one include in a shader module.
 */
const helpersWgsl = (o: ProbeLookupOptions) => /* wgsl */ `
const PR_HEADER_ROWS: u32 = ${PROBE_HEADER_ROWS}u;
const PR_ROWS_PER_VOLUME: u32 = ${PROBE_ROWS_PER_VOLUME}u;
const PR_IRRADIANCE_ROWS: u32 = ${PROBE_IRRADIANCE_ROWS}u;
const PR_MIRROR_X: bool = ${o.mirrorX === true};
// Mip l holds roughness 1 - sqrt(1 - l / maxLod); between mips l and l + 1 below r = 0.3, blend
// linearly in r^2 (the lobe width) instead of in lod.
fn pr_lodAlpha(r: f32, maxLod: f32) -> f32 {
  let l = min(floor(maxLod * r * (2.0 - r)), max(maxLod - 1.0, 0.0));
  let rl = 1.0 - sqrt(1.0 - l / maxLod);
  let rh = 1.0 - sqrt(max(1.0 - (l + 1.0) / maxLod, 0.0));
  // only between sharp mips (both below r = 0.3): above, lod-linear measured better (W7, D101)
  if (rh > 0.3) { return maxLod * r * (2.0 - r); }
  return l + clamp((r * r - rl * rl) / max(rh * rh - rl * rl, 1e-6), 0.0, 1.0);
}
fn pr_lod(roughness: f32, maxLod: f32) -> f32 {
  let r = clamp(roughness, 0.0, 1.0);
  return ${lodWgsl(o.lodMapping)};
}
// World direction to the layout's texture space.
fn pr_texDir(d: vec3f) -> vec3f { return select(d, vec3f(-d.x, d.y, d.z), PR_MIRROR_X); }
// Box-projected direction (BPCEM, #35046's guarded form): where the ray from P along dir leaves the
// box (size boxSize, centre boxPos), as a direction from the capture point origin.
fn pr_parallax(P: vec3f, dir: vec3f, boxSize: vec3f, boxPos: vec3f, origin: vec3f) -> vec3f {
  let d = normalize(dir);
  let side = step(vec3f(0.0), d) * 2.0 - 1.0;
  let safe = side * max(abs(d), vec3f(1e-6));
  let dist = (side * (boxSize * 0.5) + boxPos - P) / safe;
  return P + d * min(dist.x, min(dist.y, dist.z)) - origin;
}
// Lagarde 2014 (Frostbite), getSpecularDominantDir: a = perceptual^2.
fn pr_dominantDirection(N: vec3f, R: vec3f, roughness: f32) -> vec3f {
  let a = roughness * roughness;
  let s = clamp(1.0 - a, 0.0, 1.0);
  return mix(N, R, s * (sqrt(s) + a));
}
// Lagarde 2014 (Frostbite), computeSpecOcclusion: a = perceptual^2.
fn probeSpecularOcclusion(NdotV: f32, ao: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  return clamp(pow(max(NdotV + ao, 0.0), exp2(-16.0 * a - 1.0)) - 1.0 + ao, 0.0, 1.0);
}
// L1 SH irradiance (Ramamoorthi & Hanrahan 2001: A0 = pi, A1 = 2 pi / 3) at normal N from 3 rows:
// (L00.rgb, L1-1.r), (L1-1.gb, L10.rg), (L10.b, L11.rgb); Y00 = 0.282095, Y1m = 0.488603 (y, z, x).
fn pr_shIrradiance(a: vec4f, b: vec4f, c: vec4f, N: vec3f) -> vec3f {
  let L00 = a.xyz; let L1m1 = vec3f(a.w, b.x, b.y); let L10 = vec3f(b.z, b.w, c.x); let L11 = c.yzw;
  let e = 0.886227 * L00 + 1.023327 * (L1m1 * N.y + L10 * N.z + L11 * N.x);
  return max(e, vec3f(0.0));
}
`;

/**
 * The lookup body. `row(i)` is a WGSL expression for table row `i` (a u32 expression), `tex` and
 * `samp` the atlas and sampler expressions. In scope: P, N, R, roughness, envRotation (mat4x4f: the
 * environment slot is sampled along envRotation * dir, dir being R or its dominant direction),
 * frameIrr (vec3f; negative: no re-fit), withEnv (bool). Returns vec4f: with `withEnv`, (radiance with the environment
 * fallback, 1); without, (probe radiance normalized by its coverage, coverage).
 */
const lookupBody = (o: ProbeLookupOptions, row: (i: string) => string, tex: string, samp: string) => {
  const unroll = o.count;
  const volume = /* wgsl */ `    let b = PR_HEADER_ROWS + i * PR_ROWS_PER_VOLUME;
    let r0 = ${row('b')};
    let r1 = ${row('b + 1u')};
    let lp = P - r0.xyz;
    let d = r1.xyz - abs(lp);
    // negative outside the box, so the clamped fade is zero there
    let inside = min(d.x, min(d.y, d.z));
    let weight = clamp(inside / max(r0.w, 1e-6), 0.0, 1.0) * remaining;
    if (weight > 0.0) {
      let r2 = ${row('b + 2u')};
      let r3 = ${row('b + 3u')};
      let r4 = ${row('b + 4u')};
      // the projection box is centred at centre + offset; the capture point is r4
      let insideProjection = all(abs(lp - r2.xyz) <= r3.xyz * 0.5);
      var corrected = dir;
      if ((u32(r1.w) & 1u) != 0u && insideProjection) { corrected = pr_parallax(P, dir, r3.xyz, r0.xyz + r2.xyz, r4.xyz); }
      let slot = u32(r2.w);
      var c = sampleLayout(${tex}, ${samp}, slot, pr_texDir(corrected), lod).rgb;
      if (refitOn) {
        let s = irrRow + slot * PR_IRRADIANCE_ROWS;
        let probeIrr = pr_shIrradiance(${row('s')}, ${row('s + 1u')}, ${row('s + 2u')}, N);
        c *= clamp(frameIrr / max(probeIrr, vec3f(1e-4)), vec3f(0.0), vec3f(irr.y));
      }
      radiance += c * weight;
    }
    remaining -= weight;
`;
  return /* wgsl */ `
  let hdr = ${row('0u')};
  let count = u32(hdr.x);
  let lod = pr_lod(roughness, hdr.y);
  let enabled = hdr.z;
  let envSlot = hdr.w;
  let irr = ${row('1u')};
  let irrRow = u32(irr.x);
  // a negative frameIrr switches the re-fit off (no provider)
  let refitOn = ${o.refit === true} && all(frameIrr >= vec3f(0.0));
  var dir = R;
  if (${o.dominantDirection === true}) { dir = pr_dominantDirection(N, R, roughness); }
  var radiance = vec3f(0.0);
  var remaining = enabled;
${unroll === undefined ? `  for (var i = 0u; i < count; i++) {\n${volume}  }\n` : Array.from({ length: unroll }, (_, k) => `  {\n    let i = ${k}u;\n${volume}  }\n`).join('')}  let coverage = enabled - remaining;
  if (!withEnv) { return vec4f(radiance / max(coverage, 1e-6), coverage); }
  if (envSlot >= 0.0) {
    let slot = u32(envSlot);
    // the same (possibly bent) direction as the volumes, into the environment's frame
    let envDir = (envRotation * vec4f(dir, 0.0)).xyz;
    var c = sampleLayout(${tex}, ${samp}, slot, pr_texDir(envDir), lod).rgb;
    if (refitOn) {
      let s = irrRow + slot * PR_IRRADIANCE_ROWS;
      let probeIrr = pr_shIrradiance(${row('s')}, ${row('s + 1u')}, ${row('s + 2u')}, N);
      c *= clamp(frameIrr / max(probeIrr, vec3f(1e-4)), vec3f(0.0), vec3f(irr.y));
    }
    radiance += c * (remaining + (1.0 - enabled));
  }
  return vec4f(radiance, 1.0);
`;
};

const SIGNATURE = 'P: vec3f, N: vec3f, R: vec3f, roughness: f32, envRotation: mat4x4f, frameIrr: vec3f, withEnv: bool';

/**
 * Module-scope WGSL for engines that own the bindings: the layout's sampling code and the shared
 * helpers (no bindings). Include it once per shader module, then call the function of
 * {@link probeLookupFunctionWgsl}.
 */
export function probeLookupIncludesWgsl(options: ProbeLookupOptions): string {
  return options.layout.wgsl + helpersWgsl(options);
}

/**
 * One WGSL function, `name`, that takes the bindings as parameters:
 *   fn <name>(atlas: <layout.textureType>, samp: sampler, table: ptr<storage, array<vec4f>, read>,
 *             P, N, R: vec3f, roughness: f32, envRotation: mat4x4f, frameIrr: vec3f, withEnv: bool) -> vec4f
 * (`envRotation`: world to environment-slot directions, e.g. an environment rotation; identity if none)
 * Needs {@link probeLookupIncludesWgsl} in the same module (and WGSL's unrestricted pointer
 * parameters, which Chrome has shipped since 123). Returns what {@link probeLookupWgsl}'s
 * `probeLookup` returns.
 */
export function probeLookupFunctionWgsl(options: ProbeLookupOptions, name = 'probeLookup'): string {
  return `fn ${name}(atlas: ${options.layout.textureType}, samp: sampler, table: ptr<storage, array<vec4f>, read>, ${SIGNATURE}) -> vec4f {${lookupBody(options, (i) => `(*table)[${i}]`, 'atlas', 'samp')}}\n`;
}

export interface ProbeLookupModuleOptions extends ProbeLookupOptions {
  /** Bind group index of the atlas, sampler and table. Default 0. */
  group?: number;
  /** First binding index (atlas; sampler +1, table +2). Default 0. */
  binding?: number;
  /**
   * WGSL defining `fn frameIrradiance(P: vec3f, N: vec3f) -> vec3f`, the frame's irradiance from
   * the app's GI, for `refit`. Default: none (re-fit then uses each probe's own irradiance, a no-op).
   */
  frameIrradianceWgsl?: string;
}

/**
 * The lookup as a self-contained module snippet with its bindings in @group(group): binding+0 the
 * atlas, +1 a filtering sampler, +2 the table (`var<storage, read> array<vec4f>`). Defines:
 *
 *   fn probeLookup(P, N, R, roughness, envRotation, frameIrr, withEnv) -> vec4f   (the general form)
 *   fn probeRadiance(P: vec3f, R: vec3f, roughness: f32) -> vec4f
 *        (probe radiance normalized by coverage, coverage); no environment
 *   fn probeRadianceWithEnvironment(P: vec3f, R: vec3f, roughness: f32) -> vec3f
 *        probes, then the environment slot for the uncovered rest
 *   fn probeRadianceN(P, N, R, roughness) -> vec4f and probeRadianceWithEnvironmentN(...) -> vec3f
 *        the same with the shading normal (dominant direction, re-fit)
 *   fn probeSpecularOcclusion(NdotV: f32, ao: f32, roughness: f32) -> f32
 *
 * `roughness` is perceptual. Without N (the first two), N = R: no dominant-direction bend, and the
 * re-fit evaluates irradiance about R.
 */
export function probeLookupWgsl(options: ProbeLookupModuleOptions): string {
  const g = options.group ?? 0, b = options.binding ?? 0;
  const frame = options.refit ? (options.frameIrradianceWgsl ?? '') : '';
  // without a provider, a negative frame irradiance switches the re-fit off
  const frameCall = options.refit && options.frameIrradianceWgsl ? 'frameIrradiance(P, N)' : 'vec3f(-1.0)';
  return `${probeLookupIncludesWgsl(options)}
@group(${g}) @binding(${b}) var pr_atlas: ${options.layout.textureType};
@group(${g}) @binding(${b + 1}) var pr_sampler: sampler;
@group(${g}) @binding(${b + 2}) var<storage, read> pr_table: array<vec4f>;
${frame}
fn probeLookup(${SIGNATURE}) -> vec4f {${lookupBody(options, (i) => `pr_table[${i}]`, 'pr_atlas', 'pr_sampler')}}
fn probeFrameIrradiance(P: vec3f, N: vec3f) -> vec3f { return ${frameCall}; }
const PR_IDENTITY = mat4x4f(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);
fn probeRadianceN(P: vec3f, N: vec3f, R: vec3f, roughness: f32) -> vec4f {
  return probeLookup(P, N, R, roughness, PR_IDENTITY, probeFrameIrradiance(P, N), false);
}
fn probeRadianceWithEnvironmentN(P: vec3f, N: vec3f, R: vec3f, roughness: f32) -> vec3f {
  return probeLookup(P, N, R, roughness, PR_IDENTITY, probeFrameIrradiance(P, N), true).rgb;
}
fn probeRadiance(P: vec3f, R: vec3f, roughness: f32) -> vec4f { return probeRadianceN(P, normalize(R), R, roughness); }
fn probeRadianceWithEnvironment(P: vec3f, R: vec3f, roughness: f32) -> vec3f { return probeRadianceWithEnvironmentN(P, normalize(R), R, roughness); }
`;
}
