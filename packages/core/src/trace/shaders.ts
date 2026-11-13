// WGSL of the ray-traced reflection pass (docs/SPEC.md section 4, "Work lists and indirect
// dispatch"): one thread per screen-space miss, dispatched indirectly from the miss list that the
// SSSR intersect pass appends (packages/core/src/sssr/shaders.ts, after the FidelityFX SDK v1.1.4
// `samples/hybridreflections`). The ray origin offset (normal x 3e-3 x view distance) and the
// length cap (100 exp(-5 roughness)) follow that sample's hybrid intersect (sources.md section 3).
// Copyright (C) 2024 Advanced Micro Devices, Inc., MIT, for those two formulas; see NOTICE.
import { HIT_WGSL } from './provider';
import { SCREEN_VISIBILITY_WGSL, shadeLobeWgslFor } from './hitShading';

/** Byte size of the uniform block (struct RtParams). */
export const RT_PARAMS_SIZE = 320;

/** u32 words before the per-tile counters in the state buffer. */
export const RT_STATE_HEADER = 16;

/**
 * State buffer header, u32 words. 0-4 and 6-7 are this frame's counts (zeroed by the begin pass,
 * read back for debug); 5 and 8-11 are inputs the begin pass computes (10 persists across frames).
 */
export const RT_STATE = {
  traced: 0,
  capped: 1,
  hits: 2,
  misses: 3,
  tilesWithMisses: 4,
  tilesWithMissesLastFrame: 5,
  granted: 6,
  onScreen: 7,
  /** The most rays any tile may trace this frame (`tileBase`, + 1 when `tileExtra` > 0). */
  tileCap: 8,
  /** Rays every tile may trace: floor(budget / tiles with misses last frame), at most maxRaysPerTile. */
  tileBase: 9,
  /** f32 bits: phase of the rotating remainder, in [0, 1). */
  tilePhase: 10,
  /** f32 bits: the fraction of tiles that get one ray more (remainder / tiles). */
  tileExtra: 11,
  /** W74 (X4): fill-list pixels the bilateral fill gave their traced neighbours' result (zeroed by the begin pass). */
  filled: 12,
  /** W74 (X4): fill-list pixels with no usable neighbour (kept intersect's fallback, source 'capped'). */
  fillFallbacks: 13,
} as const;

/** Per-pixel source codes written to `source` (0 = the RT pass did not touch the pixel). */
export const RT_SOURCE = { none: 0, tracedHit: 1, tracedMiss: 2, capped: 3, onScreenHit: 4, fillPending: 5 } as const;
// fillPending (W74): a fill-list pixel between the mark and the scatter pass of the half-rate fill;
// none is left after the scatter (a filled pixel takes its main tap's code, an unfilled one 'capped').

export const RT_PARAMS_WGSL = /* wgsl */ `
struct RtParams {
  invViewProjection: mat4x4f,
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  depthInverted: u32,
  renderSize: vec2u,
  inverseRenderSize: vec2f,
  normalsUnpackMul: f32,
  normalsUnpackAdd: f32,
  maxRaysPerFrame: u32,
  maxRaysPerTile: u32,
  maxRayLength: f32,
  rayLengthRoughnessFalloff: f32,
  normalOffset: f32,
  reuseOnScreen: u32,
  onScreenDepthTolerance: f32,
  tilesX: u32,
  iblFactor: f32,
  hitShadows: u32,
  fallbackColor: vec4f,
  motionVectorScale: vec2f,
  useHistory: u32,
  fallbackRoughnessSurface: u32,
  hitSpecular: u32,
  reshadeOnScreen: u32,
  hitLobeFilter: f32,
  hitShadeVisibilityAll: u32,
  hitShadeOcclusion: u32,
  hitLobeFilterMixed: f32,
  glossyAlpha: f32,
  hitLobeFilterGrazing: f32, // W71 (X1 #3, word 67; D5002)
  fillPlaneTolerance: f32,      // 68 (W74, X4): the half-rate fill's BilateralWeights
  fillNormalPower: f32,         // 69
  fillRoughnessTolerance: f32,  // 70
  fillSourceMask: u32,          // 71
  fillMinWeightSum: f32,        // 72
  missCapacity: u32,            // 73: the fill list starts at missList[missCapacity]
  fillFootprint: u32,           // 74: 2, 3 or 4 quads across
  _pad75: u32,
  _pad76: vec4u,               // 76-79: reserved, RT_PARAMS_SIZE 320
};
@group(0) @binding(0) var<uniform> P: RtParams;
`;

/**
 * Begin pass: roll the tile-occupancy feedback and size this frame's per-tile cap (D9, D56, D1100).
 * n tiles had misses last frame and the budget is B: every tile may trace floor(B / n) rays, and a
 * fraction (B mod n) / n of them one more. Which ones rotates: a tile gets the extra ray when
 * fract(hash(tile) + phase) < that fraction, and the phase advances by the fraction each frame, so
 * the window of chosen tiles sweeps the hash order round-robin and every tile gets its share over
 * 1 / fraction frames, whatever order the miss list appends in.
 */
export const RT_BEGIN_WGSL = /* wgsl */ `
${RT_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read_write> state: array<u32>;
@compute @workgroup_size(1)
fn main() {
  let last = state[${RT_STATE.tilesWithMisses}];
  state[${RT_STATE.tilesWithMissesLastFrame}] = last;
  let budget = P.maxRaysPerFrame;
  var base = min(budget, P.maxRaysPerTile); // first frame: no feedback yet, the grant counter bounds it
  var extra = 0.0;
  if (last > 0u) {
    base = budget / last;
    extra = f32(budget % last) / f32(last);
    if (base >= P.maxRaysPerTile) { base = P.maxRaysPerTile; extra = 0.0; }
  }
  let phase = fract(bitcast<f32>(state[${RT_STATE.tilePhase}]) + extra);
  state[${RT_STATE.tileBase}] = base;
  state[${RT_STATE.tileExtra}] = bitcast<u32>(extra);
  state[${RT_STATE.tilePhase}] = bitcast<u32>(phase);
  state[${RT_STATE.tileCap}] = base + select(0u, 1u, extra > 0.0);
  for (var i = 0u; i < 8u; i++) {
    if (i != ${RT_STATE.tilesWithMissesLastFrame}u) { state[i] = 0u; }
  }
  state[${RT_STATE.filled}] = 0u;
  state[${RT_STATE.fillFallbacks}] = 0u;
}
`;

/**
 * The trace pass. `fallbackWgsl` defines `sampleRadianceFallback` (group 1), `providerWgsl`
 * `traceFirstHit` (group 2), `hitShadingWgsl` `shadeTracedHit` (group 3 if it binds anything),
 * `materialWgsl` `traceHitMaterial`.
 */
export function rtTraceWgsl(parts: { fallbackWgsl: string; providerWgsl: string; materialWgsl: string; anyHitWgsl: string; shadingNormalWgsl: string; hitShadingWgsl: string; lobeGrazing?: boolean }): string {
  return /* wgsl */ `
${RT_PARAMS_WGSL}
@group(0) @binding(1) var t_depth: texture_2d<f32>;
@group(0) @binding(2) var t_normal: texture_2d<f32>;
@group(0) @binding(3) var t_roughness: texture_2d<f32>;
@group(0) @binding(4) var t_color: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> missList: array<vec2u>;
@group(0) @binding(6) var<storage, read> missCounter: array<u32, 4>;
@group(0) @binding(7) var<storage, read_write> state: array<atomic<u32>>;
@group(0) @binding(8) var o_radiance: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var o_hit: texture_storage_2d<r32float, write>;
@group(0) @binding(10) var o_confidence: texture_storage_2d<r32float, write>;
@group(0) @binding(11) var o_source: texture_storage_2d<r32float, write>;
@group(0) @binding(12) var t_history: texture_2d<f32>;
@group(0) @binding(13) var t_motion: texture_2d<f32>;
@group(0) @binding(14) var t_prev_source: texture_2d<f32>;

${HIT_WGSL}
${parts.fallbackWgsl}
${parts.providerWgsl}
${parts.materialWgsl}
${parts.anyHitWgsl}
${parts.shadingNormalWgsl}

// The shadow query hit shading calls (D903): false if geometry lies between the hit point and
// P + L x tMax. The origin is offset along the normal by normalOffset x the view distance, as the
// reflection ray's own origin (D8). With hitShadows off, every light is visible.
// W44 (D3542): while re-shading an on-screen hit the lobe takes no visibility ray by default (as the
// screen-space re-shade, which has none): a blocked lobe goes black (D3513, no second bounce), which
// turned a mirror seen in a mirror black and the black car paint over a mirror floor darker.
// W52: hitShadeVisibility 'all' gives it the ray (RT_VIS_BVH, D3640); hitShadeOcclusion
// 'screen' the depth-buffer march instead (RT_VIS_SCREEN, D3642).
const RT_VIS_NONE: u32 = 0u;
const RT_VIS_SCREEN: u32 = 1u;
const RT_VIS_BVH: u32 = 2u;
var<private> rtLobeVisibility: u32 = RT_VIS_BVH;
fn traceLightVisible(hitP: vec3f, N: vec3f, L: vec3f, tMax: f32) -> bool {
  if (rtLobeVisibility == RT_VIS_SCREEN) { return hitScreenVisible(hitP, N, L); }
  if (P.hitShadows == 0u || rtLobeVisibility == RT_VIS_NONE) { return true; }
  let origin = hitP + N * (P.normalOffset * length(hitP - P.cameraPosition));
  return !traceAny(origin, L, tMax);
}

// The depth-buffer march's view of this pass (SCREEN_VISIBILITY_WGSL).
fn hsoProject(p: vec3f) -> vec3f {
  let clip = P.viewProjection * vec4f(p, 1.0);
  let ndc = clip.xy / clip.w;
  return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, clip.w);
}
fn hsoSceneDistance(c: vec2i) -> f32 {
  let p = clamp(c, vec2i(0), vec2i(P.renderSize) - 1);
  let z = textureLoad(t_depth, p, 0).x;
  if (isBackground(z)) { return 3.4e38; }
  return length(worldFromDepth((vec2f(p) + 0.5) * P.inverseRenderSize, z) - P.cameraPosition);
}
fn hsoCamera() -> vec3f { return P.cameraPosition; }
fn hsoSize() -> vec2u { return P.renderSize; }
${SCREEN_VISIBILITY_WGSL}

// The pass's hitSpecular setting (W41, D3510); a function, since hit shading names its point P.
fn rtHitSpecularOn() -> bool { return P.hitSpecular != 0u; }

${parts.hitShadingWgsl}
${shadeLobeWgslFor(parts.hitShadingWgsl)}

// A fixed position in [0, 1) per tile (PCG hash), the order the rotating remainder walks.
fn rtTileHash(tile: u32) -> f32 {
  var h = tile * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn unpackRayCoords(packed: u32) -> vec2u { return vec2u(packed & 32767u, (packed >> 15u) & 16383u); }

fn octDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n = vec3f(n.xy + select(vec2f(t), vec2f(-t), n.xy >= vec2f(0.0)), n.z);
  return normalize(n);
}

fn worldFromDepth(uv: vec2f, z: f32) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  let w = P.invViewProjection * ndc;
  return w.xyz / w.w;
}

fn isBackground(z: f32) -> bool { return select(z >= 1.0 - 1e-6, z < 1e-6, P.depthInverted != 0u); }

fn loadNormal(c: vec2u) -> vec3f {
  return normalize(P.normalsUnpackMul * textureLoad(t_normal, c, 0).xyz + P.normalsUnpackAdd);
}

fn storePixel(c: vec2u, radiance: vec4f, hit: f32, confidence: f32, source: u32) {
  textureStore(o_radiance, c, radiance);
  textureStore(o_hit, c, vec4f(hit));
  textureStore(o_confidence, c, vec4f(confidence));
  textureStore(o_source, c, vec4f(f32(source)));
}
// The entry's quad-copy flags (bits 29-31) name the neighbours that took this pixel's ray in
// classify; they get the traced result too, as intersect's storeRadiance does.
fn store(packed: u32, c: vec2u, radiance: vec4f, hit: f32, confidence: f32, source: u32) {
  let t = c ^ vec2u(1u);
  storePixel(c, radiance, hit, confidence, source);
  if (((packed >> 29u) & 1u) != 0u) { storePixel(vec2u(t.x, c.y), radiance, hit, confidence, source); }
  if (((packed >> 30u) & 1u) != 0u) { storePixel(vec2u(c.x, t.y), radiance, hit, confidence, source); }
  if (((packed >> 31u) & 1u) != 0u) { storePixel(t, radiance, hit, confidence, source); }
}
// A traced miss: radiance = the fallback, confidence 0 (D900). With fallbackRoughness 'surface'
// (default, as the SSSR tracer's, D3100) every stored pixel (the ray's and its quad copies) takes
// the rough-pixel lookup of its own: mirror direction from its depth and normal, sqrt(alpha).
// Mirror pixels (alpha < 1e-4) and 'mirror' keep the ray's direction at roughness 0 (FFX).
fn storeTracedMiss(packed: u32, c0: vec2u, origin: vec3f, dir: vec3f) {
  let t = c0 ^ vec2u(1u);
  for (var k = 0u; k < 4u; k++) {
    if (k > 0u && ((packed >> (28u + k)) & 1u) == 0u) { continue; }
    let c = select(select(select(t, vec2u(c0.x, t.y), k == 2u), vec2u(t.x, c0.y), k == 1u), c0, k == 0u);
    var o = origin;
    var d = dir;
    var roughness = 0.0;
    let alpha = textureLoad(t_roughness, c, 0).x;
    if (P.fallbackRoughnessSurface != 0u && alpha >= 0.0001) {
      let s = worldFromDepth((vec2f(c) + 0.5) * P.inverseRenderSize, textureLoad(t_depth, c, 0).x);
      d = reflect(normalize(s - P.cameraPosition), loadNormal(c));
      o = s;
      roughness = sqrt(alpha);
    }
    storePixel(c, vec4f(sampleRadianceFallback(o, d, roughness), 0.0), 0.0, 0.0, ${RT_SOURCE.tracedMiss}u);
  }
}
// Capped entries keep what intersect wrote (its radiance is already mix(fallback, hit, confidence));
// only the source code changes.
fn storeSource(packed: u32, c: vec2u, source: u32) {
  let t = c ^ vec2u(1u);
  textureStore(o_source, c, vec4f(f32(source)));
  if (((packed >> 29u) & 1u) != 0u) { textureStore(o_source, vec2u(t.x, c.y), vec4f(f32(source))); }
  if (((packed >> 30u) & 1u) != 0u) { textureStore(o_source, vec2u(c.x, t.y), vec4f(f32(source))); }
  if (((packed >> 31u) & 1u) != 0u) { textureStore(o_source, t, vec4f(f32(source))); }
}

// D55: a hit the camera sees this frame takes the scene colour there (diffuse + emissive, no
// specular: view independent, so reusing it from another direction is fair).
fn onScreenRadiance(hitP: vec3f, hitN: vec3f, out_color: ptr<function, vec3f>) -> bool {
  let clip = P.viewProjection * vec4f(hitP, 1.0);
  if (clip.w <= 0.0) { return false; }
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv <= vec2f(0.0)) || any(uv >= vec2f(1.0))) { return false; }
  let c = min(vec2u(uv * vec2f(P.renderSize)), P.renderSize - 1u);
  let z = textureLoad(t_depth, c, 0).x;
  if (isBackground(z)) { return false; }
  let seen = worldFromDepth((vec2f(c) + 0.5) * P.inverseRenderSize, z);
  let dHit = length(hitP - P.cameraPosition);
  let dSeen = length(seen - P.cameraPosition);
  if (abs(dHit - dSeen) > P.onScreenDepthTolerance * dHit) { return false; }
  if (dot(loadNormal(c), hitN) < 0.5) { return false; }
  *out_color = textureLoad(t_color, c, 0).rgb;
  // With the SSSR tracer's hitColor 'history' (D1002), on-screen hits take last frame's colour too,
  // reprojected through motion; off screen last frame keeps this frame's scene colour. Not when the
  // hit is re-shaded (W44): its view-independent part is this frame's scene colour.
  if (P.useHistory != 0u && P.reshadeOnScreen == 0u) {
    let prev = (vec2f(c) + 0.5) * P.inverseRenderSize - textureLoad(t_motion, c, 0).xy * P.motionVectorScale;
    if (all(prev >= vec2f(0.0)) && all(prev < vec2f(1.0))) {
      *out_color = textureLoad(t_history, vec2i(prev * vec2f(textureDimensions(t_history))), 0).rgb;
    }
  }
  return true;
}

// Lobe filter where hits mix (W52, D3641), the traced side of the SSSR tracer's: a traced hit with a
// screen-space hit among 3x3 samples 5 px apart in last frame's source (RT_SOURCE 0 on a glossy,
// non-background pixel: intersect's own result, which a confident hit is, since the rest went to
// the miss list) looks up with hitLobeFilter x hitLobeFilterMixed.
fn rtLobeMixScale(c: vec2u) -> f32 {
  if (P.hitLobeFilterMixed >= 1.0) { return 1.0; }
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let p = vec2u(clamp(vec2i(c) + vec2i(i, j) * 5, vec2i(0), vec2i(P.renderSize) - 1));
      if (u32(textureLoad(t_prev_source, p, 0).x + 0.5) != ${RT_SOURCE.none}u) { continue; }
      let a = textureLoad(t_roughness, p, 0).x;
      if (a < P.glossyAlpha && !isBackground(textureLoad(t_depth, p, 0).x)) { return P.hitLobeFilterMixed; }
    }
  }
  return 1.0;
}

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) gi: u32, @builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let index = (wg.y * nwg.x + wg.x) * 64u + gi; // 2-D indirect groups (D601)
  if (index >= min(missCounter[1], arrayLength(&missList))) { return; }
  let entry = missList[index];
  let packed = entry.x;
  let coords = unpackRayCoords(packed);
  let dir = octDecode(unpack2x16snorm(entry.y));

  // Per-8x8-tile cap (D9): the k-th miss of a tile traces only while k < this frame's tile cap,
  // and only while the frame budget lasts. Past either, the entry keeps intersect's fallback.
  let tile = (coords.y / 8u) * P.tilesX + coords.x / 8u;
  let k = atomicAdd(&state[${RT_STATE_HEADER}u + tile], 1u);
  if (k == 0u) { atomicAdd(&state[${RT_STATE.tilesWithMisses}], 1u); }
  // floor share + the rotating remainder (D1100): see RT_BEGIN_WGSL
  let extra = bitcast<f32>(atomicLoad(&state[${RT_STATE.tileExtra}]));
  let phase = bitcast<f32>(atomicLoad(&state[${RT_STATE.tilePhase}]));
  let cap = atomicLoad(&state[${RT_STATE.tileBase}]) + select(0u, 1u, fract(rtTileHash(tile) + phase) < extra);
  var granted = k < cap;
  if (granted) { granted = atomicAdd(&state[${RT_STATE.granted}], 1u) < P.maxRaysPerFrame; }
  if (!granted) {
    atomicAdd(&state[${RT_STATE.capped}], 1u);
    storeSource(packed, coords, ${RT_SOURCE.capped}u);
    return;
  }
  atomicAdd(&state[${RT_STATE.traced}], 1u);

  // Restart at the surface along the stored direction (D8 / D54), offset along the normal by
  // 3e-3 x the view distance, at most 100 exp(-5 alpha) long (FFX hybrid sample).
  let uv = (vec2f(coords) + 0.5) * P.inverseRenderSize;
  let surface = worldFromDepth(uv, textureLoad(t_depth, coords, 0).x);
  let N = loadNormal(coords);
  let alpha = textureLoad(t_roughness, coords, 0).x;
  let origin = surface + N * (P.normalOffset * length(surface - P.cameraPosition));
  let tMax = P.maxRayLength * exp(-P.rayLengthRoughnessFalloff * alpha);
  let hit = traceFirstHit(origin, dir, tMax);

  if (hit.t < 0.0) {
    // A traced miss leaves the scene: the fallback, as an SSR miss (fallbackRoughness, D3100). Confidence 0 keeps "radiance = mix(fallback, hit, confidence)" true, so a resolve
    // that blends its own fallback by confidence does the same here.
    atomicAdd(&state[${RT_STATE.misses}], 1u);
    storeTracedMiss(packed, coords, origin, dir);
    return;
  }
  atomicAdd(&state[${RT_STATE.hits}], 1u);
  let hitP = origin + dir * hit.t;
  var hitN = select(-dir, hit.normal, dot(hit.normal, hit.normal) > 0.0);
  hitN = select(hitN, -hitN, dot(hitN, dir) > 0.0);
  // the provider's interpolated vertex normal (D1700), on the side of the ray-facing geometric one
  let sn = traceHitShadingNormal(hit);
  if (dot(sn, sn) > 1e-20) {
    let n = normalize(sn);
    hitN = select(n, -n, dot(n, hitN) < 0.0);
  }
  var L = vec3f(0.0);
  var source = ${RT_SOURCE.tracedHit}u;
  let spread = P.hitLobeFilter * rtLobeMixScale(coords) * alpha; // D3550: the ray stands for its lobe
  hitLobeSpread = spread * spread;
${parts.lobeGrazing ? `  // W71 (X1 #3, D5002): shrink it at grazing angles, as the SSSR tracer's lobeFilterGrazingScale. Compiled
  // in only while hitLobeFilterGrazing > 0: with the branch present the default's output moved (up to
  // 14/255 on 6 px of rooms, Metal), so the default pipeline is today's code.
  let n_dot_v = dot(N, normalize(P.cameraPosition - surface));
  let g = mix(1.0, mix(saturate(2.0 * n_dot_v), 1.0, sqrt(sqrt(max(alpha, 0.0)))), P.hitLobeFilterGrazing);
  hitLobeSpread *= g * g;
` : ''}  if (P.reuseOnScreen != 0u && onScreenRadiance(hitP, hitN, &L)) {
    source = ${RT_SOURCE.onScreenHit}u;
    atomicAdd(&state[${RT_STATE.onScreen}], 1u);
    // W44 (D3540): the screen's diffuse plus the hit material's specular along the ray, as the
    // screen-space re-shade does for its own hits (no visibility ray, D3542).
    // W52: with hitShadeVisibility 'all' it takes D3513's ray (D3640), with hitShadeOcclusion
    // 'screen' (and 'offscreen') the depth-buffer march (D3642).
    if (P.reshadeOnScreen != 0u) {
      rtLobeVisibility = select(select(RT_VIS_NONE, RT_VIS_SCREEN, P.hitShadeOcclusion != 0u), RT_VIS_BVH, P.hitShadeVisibilityAll != 0u);
      hsoPixel = coords;
      L = hitShadeSurface(hit, hitP, hitN, dir, vec3f(0.0), L);
      rtLobeVisibility = RT_VIS_BVH;
    }
  } else {
    L = shadeTracedHit(hit, hitP, hitN, dir);
  }
  store(packed, coords, vec4f(L, hit.t), hit.t, 1.0, source);
}
`;
}

// ---------------------------------------------------------------------------------------------
// W74 (plan X4, D5060): the half-rate fill. With tracedMissRate 'half' the SSSR intersect pass puts
// the glossy misses of every other 2x2 quad on a fill list (missList[missCapacity + i], i <
// missCounter[5]) instead of the miss list. After the trace, three passes over that list give each
// of their pixels (the entry's pixel and its quad copies) a joint bilateral gather of its traced
// neighbours (core/bilateral, over a footprint of quads), so the denoiser and the composite see one
// signal: the same radiance / hit distance / confidence / source targets the trace writes.
//   mark     source = fillPending on every fill pixel (so no fill pixel taps another one)
//   gather   reads the targets (sampled), writes each pixel's result to a scratch buffer
//   scatter  writes the scratch to the targets (storage); no usable neighbour: source 'capped', the
//            rest stays as intersect wrote it (its probe fallback, as an entry past the ray budget)
// Two passes because a target can't be sampled and written in one dispatch, and only r32float
// targets have read-write storage in core WebGPU. One thread per (entry, quad pixel) slot: the
// fill args (missArgs bytes 12-23) cover 4 x the fill entries.

const FILL_COMMON_WGSL = /* wgsl */ `
${RT_PARAMS_WGSL}
fn unpackRayCoords(packed: u32) -> vec2u { return vec2u(packed & 32767u, (packed >> 15u) & 16383u); }
// The entry's k-th pixel: 0 its own, 1-3 the quad copies classify flagged (bits 29-31), as store().
fn fillPixel(packed: u32, k: u32) -> vec2i {
  let c0 = unpackRayCoords(packed);
  let t = c0 ^ vec2u(1u);
  return vec2i(select(select(select(t, vec2u(c0.x, t.y), k == 2u), vec2u(t.x, c0.y), k == 1u), c0, k == 0u));
}
fn fillHasPixel(packed: u32, k: u32) -> bool { return k == 0u || ((packed >> (28u + k)) & 1u) != 0u; }
// slot = entry * 4 + k over 2-D indirect groups (D601)
fn fillSlot(gi: u32, wg: vec3u, nwg: vec3u) -> u32 { return (wg.y * nwg.x + wg.x) * 64u + gi; }
`;

export const RT_FILL_MARK_WGSL = /* wgsl */ `
${FILL_COMMON_WGSL}
@group(0) @binding(1) var<storage, read> missList: array<vec2u>;
@group(0) @binding(2) var<storage, read> missCounter: array<u32, 8>;
@group(0) @binding(3) var o_source: texture_storage_2d<r32float, write>;
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) gi: u32, @builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let slot = fillSlot(gi, wg, nwg);
  if ((slot >> 2u) >= missCounter[5]) { return; }
  let packed = missList[P.missCapacity + (slot >> 2u)].x;
  if (fillHasPixel(packed, slot & 3u)) { textureStore(o_source, fillPixel(packed, slot & 3u), vec4f(${RT_SOURCE.fillPending}.0)); }
}
`;

/** Gather: `bilateralWgsl` is core/bilateral's BILATERAL_FILL_WGSL (passed in to keep this module's imports one-way). */
export const rtFillGatherWgsl = (bilateralWgsl: string) => /* wgsl */ `
${FILL_COMMON_WGSL}
@group(0) @binding(1) var t_depth: texture_2d<f32>;
@group(0) @binding(2) var t_normal: texture_2d<f32>;
@group(0) @binding(3) var t_roughness: texture_2d<f32>;
@group(0) @binding(4) var t_radiance: texture_2d<f32>;
@group(0) @binding(5) var t_hit: texture_2d<f32>;
@group(0) @binding(6) var t_confidence: texture_2d<f32>;
@group(0) @binding(7) var t_source: texture_2d<f32>;
@group(0) @binding(8) var<storage, read> missList: array<vec2u>;
@group(0) @binding(9) var<storage, read> missCounter: array<u32, 8>;
@group(0) @binding(10) var<storage, read_write> scratch: array<vec4u>;
@group(0) @binding(11) var<storage, read_write> state: array<atomic<u32>>;
${bilateralWgsl}

fn worldFromDepth(uv: vec2f, z: f32) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  let w = P.invViewProjection * ndc;
  return w.xyz / w.w;
}
fn isBackground(z: f32) -> bool { return select(z >= 1.0 - 1e-6, z < 1e-6, P.depthInverted != 0u); }
fn fillSurface(c: vec2i) -> BilateralSurface {
  var s: BilateralSurface;
  if (any(c < vec2i(0)) || any(c >= vec2i(P.renderSize))) { return s; }
  let z = textureLoad(t_depth, c, 0).x;
  if (isBackground(z)) { return s; }
  s.position = worldFromDepth((vec2f(c) + 0.5) * P.inverseRenderSize, z);
  s.normal = normalize(P.normalsUnpackMul * textureLoad(t_normal, c, 0).xyz + P.normalsUnpackAdd);
  s.roughness = sqrt(max(textureLoad(t_roughness, c, 0).x, 0.0));
  s.valid = true;
  return s;
}
// X4's tap: of quad 'cell', the pixel nearest the one filled (a traced quad wrote its ray to each of
// its glossy pixels; the nearest one's own depth and normal are what the weights compare). The
// source is read first: a tap the mask rejects (the checkerboard's own and diagonal quads are
// fillPending) loads no geometry.
fn bilateralTap(cell: vec2i, pixel: vec2i) -> BilateralTap {
  var t: BilateralTap;
  let c = clamp(pixel, cell * 2, cell * 2 + 1);
  if (any(c < vec2i(0)) || any(c >= vec2i(P.renderSize))) { return t; }
  t.source = u32(textureLoad(t_source, c, 0).x + 0.5);
  if (t.source >= 32u || ((P.fillSourceMask >> t.source) & 1u) == 0u) { return t; }
  t.surface = fillSurface(c);
  if (!t.surface.valid) { return t; }
  t.radiance = textureLoad(t_radiance, c, 0);
  t.hitDistance = textureLoad(t_hit, c, 0).x;
  t.confidence = textureLoad(t_confidence, c, 0).x;
  t.spatial = 1.0;
  return t;
}

const FILL_FILLED: u32 = 0x80000000u;
var<workgroup> wgFilled: atomic<u32>;
var<workgroup> wgFallbacks: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) gi: u32, @builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  if (gi == 0u) { atomicStore(&wgFilled, 0u); atomicStore(&wgFallbacks, 0u); }
  workgroupBarrier();
  let slot = fillSlot(gi, wg, nwg);
  let index = slot >> 2u;
  let k = slot & 3u;
  if (index < missCounter[5]) {
    let packed = missList[P.missCapacity + index].x;
    if (fillHasPixel(packed, k)) {
      let w = BilateralWeights(P.fillPlaneTolerance, P.fillNormalPower, P.fillRoughnessTolerance, P.fillSourceMask, P.fillMinWeightSum);
      let c = fillPixel(packed, k);
      let p = fillSurface(c);
      var out = vec4u(0u);
      if (p.valid) {
        // one coverage class (W74 review): no partial confidence from mixing hits and misses, t from hits only
        let r = bilateralFillMajority(p, P.cameraPosition, c, c >> vec2u(1u), P.fillFootprint, w);
        if (r.weightSum > 0.0 && r.weightSum >= w.minWeightSum) {
          let conf = min(u32(round(saturate(r.confidence) * 16777215.0)), 0xffffffu); // (x + 0.5 rounds to 2^24 in f32 at 1)
          out = vec4u(pack2x16float(r.radiance.xy), pack2x16float(r.radiance.zw), bitcast<u32>(r.hitDistance), FILL_FILLED | ((r.source & 7u) << 24u) | conf);
        }
      }
      if ((out.w & FILL_FILLED) != 0u) { atomicAdd(&wgFilled, 1u); } else { atomicAdd(&wgFallbacks, 1u); }
      scratch[slot] = out;
    }
  }
  workgroupBarrier();
  if (gi == 0u) {
    let f = atomicLoad(&wgFilled);
    let b = atomicLoad(&wgFallbacks);
    if (f > 0u) { atomicAdd(&state[${RT_STATE.filled}], f); }
    if (b > 0u) { atomicAdd(&state[${RT_STATE.fillFallbacks}], b); }
  }
}
`;

export const RT_FILL_SCATTER_WGSL = /* wgsl */ `
${FILL_COMMON_WGSL}
@group(0) @binding(1) var<storage, read> missList: array<vec2u>;
@group(0) @binding(2) var<storage, read> missCounter: array<u32, 8>;
@group(0) @binding(3) var<storage, read> scratch: array<vec4u>;
@group(0) @binding(4) var o_radiance: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var o_hit: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var o_confidence: texture_storage_2d<r32float, write>;
@group(0) @binding(7) var o_source: texture_storage_2d<r32float, write>;
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) gi: u32, @builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let slot = fillSlot(gi, wg, nwg);
  if ((slot >> 2u) >= missCounter[5]) { return; }
  let packed = missList[P.missCapacity + (slot >> 2u)].x;
  if (!fillHasPixel(packed, slot & 3u)) { return; }
  let c = fillPixel(packed, slot & 3u);
  let v = scratch[slot];
  if ((v.w & 0x80000000u) == 0u) {
    textureStore(o_source, c, vec4f(${RT_SOURCE.capped}.0));
    return;
  }
  textureStore(o_radiance, c, vec4f(unpack2x16float(v.x), unpack2x16float(v.y)));
  textureStore(o_hit, c, vec4f(bitcast<f32>(v.z)));
  textureStore(o_confidence, c, vec4f(f32(v.w & 0xffffffu) / 16777215.0));
  textureStore(o_source, c, vec4f(f32((v.w >> 24u) & 7u)));
}
`;
