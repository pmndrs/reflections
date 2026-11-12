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
// lod: three r187's PMREM mapping `maxLod * r * (2 - r)` (D3), r perceptual roughness, except
// between the sharp mips (both below r = 0.3), where the default 'alpha' mapping blends linearly in
// r^2 (D101, decided 2026-11-11); `lodMapping: 'r187'` keeps r187's mapping everywhere.
//
// Options, each off by default (the re-fit: on when the module gets a frame irradiance provider, D803):
//   dominantDirection  Lagarde 2014's specular dominant direction, mix(N, R, s * (sqrt(s) + a)),
//                      s = 1 - a, a = perceptual^2 (Frostbite's `roughness`), D57. Needs N. The probe
//                      volumes and the environment slot sample the same bent direction (F2).
//   refit              idTech 8 / Lazarov 2013 normalization: each probe's radiance times
//                      clamp(frameIrradiance(P, N) / probeIrradiance(N), 0, refitClamp), with
//                      probeIrradiance the probe's L1 SH (table rows, ./irradiance.ts), D60.
//   distanceRoughness  Lagarde 2014's distance-based roughness (Listing 25), per box-projected volume:
//                      r' = mix(clamp(t / |hit - origin| * r, 0, r), r, r), t the distance from P to
//                      where the ray leaves the projection box, r perceptual (Frostbite's
//                      `linearRoughness`), so the lookup is sharp near contact and the volume's own
//                      roughness from the capture point's distance on (D53).
//   roughnessLerp      Lagarde 2014 Appendix F: the box-projected direction lerped back toward the
//                      unprojected one by r, mix(normalize(corrected), normalize(dir), r) (Frostbite
//                      lerps the unnormalized corrected vector, D2700).
//   probeSpecularOcclusion(NdotV, ao, roughness) is always defined: Lagarde 2014's
//                      saturate(pow(NdotV + ao, exp2(-16 a - 1)) - 1 + ao), a = perceptual^2, D66.
//
// Direction convention: R and N are world directions. `captureTransform.axes` (./capture.ts) maps them
// into the captures' texture space before the layout lookup: `mirrorX` (three's x-mirrored
// CubeCamera) is its alias for ['-x', 'y', 'z'].

import { PROBE_HEADER_ROWS, PROBE_IRRADIANCE_ROWS, PROBE_MAX_ATLASES, PROBE_ROWS_PER_VOLUME } from './table';
import { dedupeChunks } from './layouts';
import { captureAxesWgsl, resolveCaptureTransform, type ProbeCaptureTransform } from './capture';
import type { ProbeLayout, ProbeWgslChunk } from './layouts/types';

/**
 * How roughness maps to the atlas mip. 'r187': three r187's `maxLod * r * (2 - r)` (D3), so a
 * lookup between two mips blends them linearly in lod. 'alpha' (the default, D101 / D806): the
 * same mips (each exact at the roughness it was prefiltered for), but between neighbouring mips that
 * are both below r = 0.3 the blend is linear in alpha = r^2, the lobe width, instead of in lod
 * (W7: p99 against the GGX reference at r .05 44.5 -> 19.7 / 255 at 128 px); above, r187's.
 */
export type ProbeLodMapping = 'r187' | 'alpha';

export interface ProbeLookupOptions {
  layout: ProbeLayout;
  /** The atlas holds x-mirrored captures (three's CubeCamera): an alias of `captureTransform: CAPTURE_MIRROR_X`. Default false. */
  mirrorX?: boolean;
  /**
   * How the atlas's captures relate to WebGPU's cube convention (./capture.ts, D1805). The lookup
   * applies its `axes` to every world direction (its `faces` act at capture time only). Default:
   * none. Not together with `mirrorX`.
   */
  captureTransform?: ProbeCaptureTransform;
  /** Lagarde's dominant direction (D57). Default false. */
  dominantDirection?: boolean;
  /**
   * Re-fit by frame irradiance (SPEC "Probe re-fit", D60, D803). Default: on when the lookup has a
   * frame irradiance provider ({@link ProbeLookupModuleOptions.frameIrradianceWgsl}), else off; the
   * function form ({@link probeLookupFunctionWgsl}) has no provider option, so there the default is
   * off and the caller decides (a negative `frameIrr` also switches it off at run time). An explicit
   * value wins.
   */
  refit?: boolean;
  /**
   * Lagarde 2014's distance-based roughness on box-projected volumes (Listing 25, D53): the
   * roughness shrinks toward contact with the projection box, by the ratio of P's and the capture
   * point's distances to the box hit. Default false.
   */
  distanceRoughness?: boolean;
  /**
   * Lagarde 2014's roughness lerp of the box-projected direction back toward the unprojected one
   * (Appendix F, D53, D2700). Default false.
   */
  roughnessLerp?: boolean;
  /** Roughness to mip. Default 'alpha' (D101); 'r187' is three r187's PMREM mapping everywhere. */
  lodMapping?: ProbeLodMapping;
  /**
   * Unroll the volume loop for exactly this many volumes (the table's count is then ignored). An
   * engine that recompiles when the probe count changes (three) gets constant table indices; the
   * runtime loop measured ~1.5x the lookup cost on Apple M-series (W7). Default: a runtime loop.
   */
  count?: number;
  /**
   * Atlases the set's captures live in, one per resolution class (D4700), all of `layout`'s kind
   * (each its own size and mip count: the table's row 2 holds each one's maxLod, a volume's row +4.w
   * its atlas). Atlas 0 holds the environment slot. Default 1: the one-atlas lookup, unchanged.
   * At most 4 (PROBE_MAX_ATLASES).
   */
  atlases?: number;
  /**
   * With `count` and several `atlases`: the atlas of each unrolled volume, fixed at compile time
   * (an engine that recompiles per bake, three), so each volume samples its own texture with no
   * branch. Absent, each volume's atlas is read from the table and picked by a branch.
   */
  volumeAtlases?: readonly number[];
}

/** The default {@link ProbeLodMapping} (D101, decided 2026-11-11). */
export const DEFAULT_PROBE_LOD_MAPPING: ProbeLodMapping = 'alpha';

/** WGSL roughness -> lod for a mapping (`r` perceptual, clamped), in terms of `r` and `maxLod`. */
export function lodWgsl(mapping: ProbeLodMapping = DEFAULT_PROBE_LOD_MAPPING) {
  switch (mapping) {
    case 'r187': return 'maxLod * r * (2.0 - r)';
    case 'alpha': return 'pr_lodAlpha(r, maxLod)';
  }
}

/**
 * Helpers every flavour shares (no bindings, no options). Names are prefixed `pr_`. Lookups of any
 * layout and options (lod mapping, dominant direction, re-fit, distance roughness, roughness lerp,
 * count, mirrorX) share this one chunk in a shader module; the layout's own WGSL comes in its own
 * chunks (D805).
 */
const HELPERS_WGSL = /* wgsl */ `
const PR_HEADER_ROWS: u32 = ${PROBE_HEADER_ROWS}u;
const PR_ROWS_PER_VOLUME: u32 = ${PROBE_ROWS_PER_VOLUME}u;
const PR_IRRADIANCE_ROWS: u32 = ${PROBE_IRRADIANCE_ROWS}u;
const PR_IDENTITY = mat4x4f(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);
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
// roughness -> lod, one function per ProbeLodMapping (the lookup body picks one)
fn pr_lod_r187(roughness: f32, maxLod: f32) -> f32 {
  let r = clamp(roughness, 0.0, 1.0);
  return ${lodWgsl('r187')};
}
fn pr_lod_alpha(roughness: f32, maxLod: f32) -> f32 {
  let r = clamp(roughness, 0.0, 1.0);
  return ${lodWgsl('alpha')};
}
// Box-projected direction (BPCEM, #35046's guarded form): where the ray from P along dir leaves the
// box (size boxSize, centre boxPos), as a direction from the capture point origin.
fn pr_parallax(P: vec3f, dir: vec3f, boxSize: vec3f, boxPos: vec3f, origin: vec3f) -> vec3f {
  let d = normalize(dir);
  let side = step(vec3f(0.0), d) * 2.0 - 1.0;
  let safe = side * max(abs(d), vec3f(1e-6));
  let dist = (side * (boxSize * 0.5) + boxPos - P) / safe;
  return P + d * min(dist.x, min(dist.y, dist.z)) - origin;
}
// Distance from P along dir to where the ray leaves the box (pr_parallax's intersection).
fn pr_parallaxDistance(P: vec3f, dir: vec3f, boxSize: vec3f, boxPos: vec3f) -> f32 {
  let d = normalize(dir);
  let side = step(vec3f(0.0), d) * 2.0 - 1.0;
  let safe = side * max(abs(d), vec3f(1e-6));
  let dist = (side * (boxSize * 0.5) + boxPos - P) / safe;
  return min(dist.x, min(dist.y, dist.z));
}
// Lagarde 2014 (Frostbite), computeDistanceBaseRoughness (Listing 25), in perceptual roughness r
// (Frostbite's linearRoughness): dHit from the shading point, dCentre from the capture point, both
// to the projection-box hit.
fn pr_distanceRoughness(dHit: f32, dCentre: f32, r: f32) -> f32 {
  let n = clamp(dHit / max(dCentre, 1e-4) * r, 0.0, r);
  return mix(n, r, r);
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
/** WGSL name of atlas `k` given atlas 0's name (`atlas`, `atlas_1`, ...). */
const atlasName = (tex: string, k: number) => (k === 0 ? tex : `${tex}_${k}`);

/** The number of atlases a lookup binds (1 unless `atlases` asks for more), checked. */
function atlasCount(o: Pick<ProbeLookupOptions, 'atlases' | 'volumeAtlases' | 'count'>): number {
  const n = Math.floor(o.atlases ?? 1);
  if (n < 1 || n > PROBE_MAX_ATLASES) throw new Error(`probe lookup: atlases ${o.atlases}, 1 to ${PROBE_MAX_ATLASES}`);
  if (o.volumeAtlases !== undefined) {
    if (o.count === undefined || o.volumeAtlases.length !== o.count) throw new Error('probe lookup: volumeAtlases needs `count` and one atlas per volume');
    if (o.volumeAtlases.some((a) => !(a >= 0 && a < n))) throw new Error(`probe lookup: volumeAtlases ${o.volumeAtlases.join(',')} outside 0..${n - 1}`);
  }
  return n;
}

/** W63 bench only (not exported from the package): lookup variants for the cost profile. */
export const PROBE_LOOKUP_EXPERIMENT: { mode: string } = { mode: '' };

const lookupBody = (o: ProbeLookupOptions, row: (i: string) => string, tex: string, samp: string) => {
  const X = PROBE_LOOKUP_EXPERIMENT.mode.split(',');
  const unroll = X.includes('loop') ? undefined : o.count;
  const atlases = atlasCount(o);
  const multi = atlases > 1;
  const sample = o.layout.sampleFunction;
  // world direction to the layout's texture space (the capture transform's axes)
  const transform = resolveCaptureTransform(o);
  const texDir = (d: string) => captureAxesWgsl(transform, d);
  const lodFn = `pr_lod_${o.lodMapping ?? DEFAULT_PROBE_LOD_MAPPING}`;
  // box projection; with Lagarde's seam options (D53) pr_parallax with its distance t kept (App. F)
  const seam = o.distanceRoughness === true || o.roughnessLerp === true;
  const projection = !seam
    ? '        corrected = pr_parallax(P, dir, r3.xyz, r0.xyz + r2.xyz, r4.xyz);\n'
    : [
      '        let t = pr_parallaxDistance(P, dir, r3.xyz, r0.xyz + r2.xyz);',
      '        corrected = P + normalize(dir) * t - r4.xyz;',
      ...(o.distanceRoughness === true ? [`        vlod = ${lodFn}(pr_distanceRoughness(t, length(corrected), rough), ${multi ? 'vmax' : 'hdr.y'});`] : []),
      ...(o.roughnessLerp === true ? ['        corrected = mix(normalize(corrected), normalize(dir), rough);'] : []),
    ].join('\n') + '\n';
  // Several atlases (D4700): each volume's maxLod and irradiance base come from header rows 2 / 3 by
  // its atlas, and its sample reads that atlas: named at compile time when `volumeAtlases` fixes
  // it, else picked by a branch on the table's atlas index. One atlas: the code as it always was.
  const comp = ['x', 'y', 'z', 'w'];
  const pick = (k: number | undefined, sampleArgs: string) => {
    if (X.includes('nosample')) return '      var c = vec3f(0.5) + 0.001 * corrected + vec3f(0.001 * vlod);\n';
    if (!multi) return `      var c = ${sample}(${tex}, ${samp}, ${sampleArgs}).rgb;\n`;
    if (k !== undefined) return `      var c = ${sample}(${atlasName(tex, k)}, ${samp}, ${sampleArgs}).rgb;\n`;
    const branches = Array.from({ length: atlases }, (_, a) => `${a === 0 ? '      ' : ' else '}${a < atlases - 1 ? `if (va == ${a}u) ` : ''}{ c = ${sample}(${atlasName(tex, a)}, ${samp}, ${sampleArgs}).rgb; }`);
    return `      var c = vec3f(0.0);\n${branches.join('')}\n`;
  };
  const volume = (k: number | undefined) => X.includes('boxonly') ? /* wgsl */ `    let b = PR_HEADER_ROWS + i * PR_ROWS_PER_VOLUME;
    let r0 = ${row('b')};
    let r1 = ${row('b + 1u')};
    let lp = P - r0.xyz;
    let d = r1.xyz - abs(lp);
    let inside = min(d.x, min(d.y, d.z));
    let weight = clamp(inside / max(r0.w, 1e-6), 0.0, 1.0) * remaining;
    radiance += vec3f(weight);
    remaining -= weight;
` : /* wgsl */ `${X.includes('skip') ? (unroll === undefined ? '    if (remaining <= 0.0) { break; }\n' : '') : ''}    let b = PR_HEADER_ROWS + i * PR_ROWS_PER_VOLUME;
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
${!multi ? '' : k !== undefined
    ? `      let vmax = atl.${comp[k]};
      let vbase = u32(atlBase.${comp[k]});
`
    : `      let va = u32(r4.w);
      let vmax = atl[va];
      let vbase = u32(atlBase[va]);
`}      // the projection box is centred at centre + offset; the capture point is r4
      let insideProjection = all(abs(lp - r2.xyz) <= r3.xyz * 0.5);
      var corrected = dir;
      var vlod = ${multi ? `${lodFn}(rough, vmax)` : 'lod'};
      if ((u32(r1.w) & 1u) != 0u && insideProjection) {
${projection}      }
      let slot = u32(r2.w);
${pick(k, `slot, ${texDir('corrected')}, vlod`)}      if (refitOn) {
        let s = irrRow + ${multi ? '(vbase + slot)' : 'slot'} * PR_IRRADIANCE_ROWS;
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
  let rough = clamp(roughness, 0.0, 1.0);
  let lod = ${lodFn}(rough, hdr.y);
  let enabled = hdr.z;
  let envSlot = hdr.w;
  let irr = ${row('1u')};
  let irrRow = u32(irr.x);${multi ? `
  var atl = ${row('2u')};
  var atlBase = ${row('3u')};` : ''}
  // a negative frameIrr switches the re-fit off (no provider)
  let refitOn = ${o.refit === true} && all(frameIrr >= vec3f(0.0));
  var dir = R;
  if (${o.dominantDirection === true}) { dir = pr_dominantDirection(N, R, roughness); }
  var radiance = vec3f(0.0);
  var remaining = enabled;
${unroll === undefined ? `  for (var i = 0u; i < count; i++) {\n${volume(undefined)}  }\n` : Array.from({ length: unroll }, (_, k) => `  ${X.includes('skip') ? 'if (remaining > 0.0) ' : ''}{\n    let i = ${k}u;\n${volume(o.volumeAtlases?.[k])}  }\n`).join('')}  let coverage = enabled - remaining;
  if (!withEnv) { return vec4f(radiance / max(coverage, 1e-6), coverage); }
  if (envSlot >= 0.0) {
    let slot = u32(envSlot);
    // the same (possibly bent) direction as the volumes, into the environment's frame
    let envDir = (envRotation * vec4f(dir, 0.0)).xyz;
    var c = ${sample}(${tex}, ${samp}, slot, ${texDir('envDir')}, lod).rgb;
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
 * The proxy-share body (W22, DIVERGES D2400): the lookup's volume weights, walked in the same order,
 * but instead of radiance each box-projected volume adds `weight x (1 - smoothstep(near, far, t))`,
 * t the distance from P along dir to its projection box (the surface its radiance is projected
 * onto). Volumes sampled without box projection and the environment are at infinity and add 0. In
 * scope: P, dir, near, far. Returns the share of the probe term whose surface lies within ~near.
 */
const proxyBody = (o: Pick<ProbeLookupOptions, 'count'>, row: (i: string) => string) => {
  const volume = /* wgsl */ `    let b = PR_HEADER_ROWS + i * PR_ROWS_PER_VOLUME;
    let r0 = ${row('b')};
    let r1 = ${row('b + 1u')};
    let lp = P - r0.xyz;
    let d = r1.xyz - abs(lp);
    let inside = min(d.x, min(d.y, d.z));
    let weight = clamp(inside / max(r0.w, 1e-6), 0.0, 1.0) * remaining;
    if (weight > 0.0) {
      let r2 = ${row('b + 2u')};
      let r3 = ${row('b + 3u')};
      let insideProjection = all(abs(lp - r2.xyz) <= r3.xyz * 0.5);
      if ((u32(r1.w) & 1u) != 0u && insideProjection) {
        share += weight * (1.0 - smoothstep(near, far, pr_parallaxDistance(P, dir, r3.xyz, r0.xyz + r2.xyz)));
      }
    }
    remaining -= weight;
`;
  return /* wgsl */ `
  let hdr = ${row('0u')};
  let count = u32(hdr.x);
  var share = 0.0;
  var remaining = hdr.z;
${o.count === undefined ? `  for (var i = 0u; i < count; i++) {\n${volume}  }\n` : Array.from({ length: o.count }, (_, k) => `  {\n    let i = ${k}u;\n${volume}  }\n`).join('')}  return share;
`;
};

/**
 * WGSL `fn <name>(table: ptr<storage, array<vec4f>, read>, P: vec3f, dir: vec3f, near: f32, far: f32) -> f32`:
 * the share of the probe term at P along dir (volumes by weight, then the environment, as the
 * lookup blends them) whose box-projected surface lies nearer than `near` along the ray, fading to
 * 0 at `far`. The environment and volumes without box projection count as infinitely far. Pass the
 * direction the lookup samples (R, or its dominant direction if the lookup bends it). A resolve
 * uses it to tell whether the probe can be what a ray sees: a screen-space hit at distance h with
 * share(h + tolerance) = 0 means the probe's surface is behind the hit (DIVERGES D2400). Needs
 * {@link probeLookupIncludesWgsl} in the module. `count` unrolls the volume loop as in the lookup.
 */
export function probeProxyShareFunctionWgsl(options: Pick<ProbeLookupOptions, 'count'> = {}, name = 'probeProxyShare'): string {
  return `fn ${name}(table: ptr<storage, array<vec4f>, read>, P: vec3f, dir: vec3f, near: f32, far: f32) -> f32 {${proxyBody(options, (i) => `(*table)[${i}]`)}}\n`;
}

const HELPERS_CHUNK: ProbeWgslChunk = { key: 'pr_helpers', wgsl: HELPERS_WGSL };

/**
 * The module-scope WGSL of {@link probeLookupIncludesWgsl} as named chunks (each layout's chunks,
 * then the shared helpers), one per key. An engine that assembles shaders from pieces (three's
 * `code()` nodes) emits each key once per module; lookups of every layout and option then live
 * side by side (D805).
 */
export function probeLookupIncludeChunks(options: Pick<ProbeLookupOptions, 'layout'> | readonly Pick<ProbeLookupOptions, 'layout'>[]): ProbeWgslChunk[] {
  const list = Array.isArray(options) ? options : [options as Pick<ProbeLookupOptions, 'layout'>];
  return dedupeChunks([...list.flatMap((o) => o.layout.chunks), HELPERS_CHUNK]);
}

/**
 * Module-scope WGSL for engines that own the bindings: the layout's sampling code and the shared
 * helpers (no bindings). Include it once per shader module, then call the function of
 * {@link probeLookupFunctionWgsl}. For lookups of several layouts in one module, pass all their
 * options at once (each piece is emitted once); the result depends only on the layouts.
 */
export function probeLookupIncludesWgsl(options: Pick<ProbeLookupOptions, 'layout'> | readonly Pick<ProbeLookupOptions, 'layout'>[]): string {
  return probeLookupIncludeChunks(options).map((c) => c.wgsl).join('\n');
}

/**
 * One WGSL function, `name`, that takes the bindings as parameters:
 *   fn <name>(atlas: <layout.textureType>, samp: sampler, table: ptr<storage, array<vec4f>, read>,
 *             P, N, R: vec3f, roughness: f32, envRotation: mat4x4f, frameIrr: vec3f, withEnv: bool) -> vec4f
 * (`envRotation`: world to environment-slot directions, e.g. an environment rotation; identity if none)
 * Needs {@link probeLookupIncludesWgsl} in the same module (and WGSL's unrestricted pointer
 * parameters, which Chrome has shipped since 123). Returns what {@link probeLookupWgsl}'s
 * `probeLookup` returns. With `atlases: n > 1` (D4700) the function takes `atlas_1` ... `atlas_<n-1>`
 * (same type) right after `atlas`.
 */
export function probeLookupFunctionWgsl(options: ProbeLookupOptions, name = 'probeLookup'): string {
  // several atlases (D4700): atlas_1, atlas_2, ... after atlas, same type
  const extra = Array.from({ length: atlasCount(options) - 1 }, (_, k) => `${atlasName('atlas', k + 1)}: ${options.layout.textureType}, `).join('');
  return `fn ${name}(atlas: ${options.layout.textureType}, ${extra}samp: sampler, table: ptr<storage, array<vec4f>, read>, ${SIGNATURE}) -> vec4f {${lookupBody(options, (i) => `(*table)[${i}]`, 'atlas', 'samp')}}\n`;
}

export interface ProbeLookupModuleOptions extends ProbeLookupOptions {
  /** Bind group index of the atlas, sampler and table. Default 0. */
  group?: number;
  /** First binding index (atlas; sampler +1, table +2). Default 0. */
  binding?: number;
  /**
   * With several `atlases` (D4700): the binding of atlas 1 (atlas k at `atlasBinding + k - 1`, same
   * group). Default `binding + 3`, right after the table.
   */
  atlasBinding?: number;
  /**
   * WGSL defining `fn frameIrradiance(P: vec3f, N: vec3f) -> vec3f`, the frame's irradiance from
   * the app's GI, for `refit`; given, the re-fit is on unless `refit: false` (D803). Default: none.
   * Several sets in one module share one provider: pass the same text to each (it is emitted once).
   */
  frameIrradianceWgsl?: string;
  /**
   * Appended to every name this set's module defines (its bindings `pr_atlas`..., `probeLookup`,
   * `probeRadiance`, `probeRadianceWithEnvironment`, the `N` forms, `probeFrameIrradiance`,
   * `probeProxyShare`), so several sets live in one module (D805): `suffix: 'B'` gives
   * `probeRadianceB(P, R, r)`. Shared helpers (`probeSpecularOcclusion`) keep their names. Default ''.
   */
  suffix?: string;
}

/** One set's bindings and entry points, without the includes. */
function moduleWgsl(moduleOptions: ProbeLookupModuleOptions): { frame: string; body: string } {
  // the re-fit defaults on with a frame irradiance provider, off without (D803); explicit wins
  const options = { ...moduleOptions, refit: moduleOptions.refit ?? moduleOptions.frameIrradianceWgsl !== undefined };
  const g = options.group ?? 0, b = options.binding ?? 0, x = options.suffix ?? '';
  const frame = options.refit ? (options.frameIrradianceWgsl ?? '') : '';
  // without a provider, a negative frame irradiance switches the re-fit off
  const frameCall = options.refit && options.frameIrradianceWgsl ? 'frameIrradiance(P, N)' : 'vec3f(-1.0)';
  const atlas = `pr_atlas${x}`, samp = `pr_sampler${x}`, table = `pr_table${x}`;
  const ab = options.atlasBinding ?? b + 3;
  const extra = Array.from({ length: atlasCount(options) - 1 }, (_, k) => `@group(${g}) @binding(${ab + k}) var ${atlasName(atlas, k + 1)}: ${options.layout.textureType};\n`).join('');
  return {
    frame,
    body: `
@group(${g}) @binding(${b}) var ${atlas}: ${options.layout.textureType};
@group(${g}) @binding(${b + 1}) var ${samp}: sampler;
@group(${g}) @binding(${b + 2}) var<storage, read> ${table}: array<vec4f>;
${extra}fn probeLookup${x}(${SIGNATURE}) -> vec4f {${lookupBody(options, (i) => `${table}[${i}]`, atlas, samp)}}
fn probeFrameIrradiance${x}(P: vec3f, N: vec3f) -> vec3f { return ${frameCall}; }
fn probeRadianceN${x}(P: vec3f, N: vec3f, R: vec3f, roughness: f32) -> vec4f {
  return probeLookup${x}(P, N, R, roughness, PR_IDENTITY, probeFrameIrradiance${x}(P, N), false);
}
fn probeRadianceWithEnvironmentN${x}(P: vec3f, N: vec3f, R: vec3f, roughness: f32) -> vec3f {
  return probeLookup${x}(P, N, R, roughness, PR_IDENTITY, probeFrameIrradiance${x}(P, N), true).rgb;
}
fn probeRadiance${x}(P: vec3f, R: vec3f, roughness: f32) -> vec4f { return probeRadianceN${x}(P, normalize(R), R, roughness); }
fn probeRadianceWithEnvironment${x}(P: vec3f, R: vec3f, roughness: f32) -> vec3f { return probeRadianceWithEnvironmentN${x}(P, normalize(R), R, roughness); }
fn probeProxyShare${x}(P: vec3f, dir: vec3f, near: f32, far: f32) -> f32 {${proxyBody(options, (i) => `${table}[${i}]`)}}
`,
  };
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
 *   fn probeProxyShare(P: vec3f, dir: vec3f, near: f32, far: f32) -> f32
 *        see {@link probeProxyShareFunctionWgsl}
 *
 * `roughness` is perceptual. Without N (the first two), N = R: no dominant-direction bend, and the
 * re-fit evaluates irradiance about R.
 *
 * Several sets in one module (any layouts, D805): pass an array, each with its own `suffix` and
 * group / binding range. The includes are emitted once for all of them:
 *
 *   probeLookupWgsl([a.lookupOptions({ group: 1 }), b.lookupOptions({ group: 2, suffix: 'B' })])
 *   // probeRadiance(P, R, r) samples a, probeRadianceB(P, R, r) samples b
 */
export function probeLookupWgsl(moduleOptions: ProbeLookupModuleOptions | readonly ProbeLookupModuleOptions[]): string {
  const list: readonly ProbeLookupModuleOptions[] = Array.isArray(moduleOptions) ? moduleOptions : [moduleOptions as ProbeLookupModuleOptions];
  const suffixes = list.map((o) => o.suffix ?? '');
  if (new Set(suffixes).size !== list.length) throw new Error(`probeLookupWgsl: each set in one module needs its own suffix, got [${suffixes.map((x) => `'${x}'`).join(', ')}]`);
  const slots = list.flatMap((o) => [
    ...[0, 1, 2].map((k) => `${o.group ?? 0}:${(o.binding ?? 0) + k}`),
    ...Array.from({ length: atlasCount(o) - 1 }, (_, k) => `${o.group ?? 0}:${(o.atlasBinding ?? (o.binding ?? 0) + 3) + k}`),
  ]);
  if (new Set(slots).size !== slots.length) throw new Error('probeLookupWgsl: two sets in one module share a binding (give each its own group or binding)');
  const parts = list.map(moduleWgsl);
  const frames = [...new Set(parts.map((p) => p.frame).filter((f) => f !== ''))];
  return `${probeLookupIncludesWgsl(list)}\n${frames.join('\n')}${parts.map((p) => p.body).join('')}`;
}
