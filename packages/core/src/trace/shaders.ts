// WGSL of the ray-traced reflection pass (docs/SPEC.md section 4, "Work lists and indirect
// dispatch"): one thread per screen-space miss, dispatched indirectly from the miss list that the
// SSSR intersect pass appends (packages/core/src/sssr/shaders.ts, after the FidelityFX SDK v1.1.4
// `samples/hybridreflections`). The ray origin offset (normal x 3e-3 x view distance) and the
// length cap (100 exp(-5 roughness)) follow that sample's hybrid intersect (sources.md section 3).
// Copyright (C) 2024 Advanced Micro Devices, Inc., MIT, for those two formulas; see NOTICE.
import { HIT_WGSL } from './provider';

/** Byte size of the uniform block (struct RtParams). */
export const RT_PARAMS_SIZE = 256;

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
} as const;

/** Per-pixel source codes written to `source` (0 = the RT pass did not touch the pixel). */
export const RT_SOURCE = { none: 0, tracedHit: 1, tracedMiss: 2, capped: 3, onScreenHit: 4 } as const;

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
}
`;

/**
 * The trace pass. `fallbackWgsl` defines `sampleRadianceFallback` (group 1), `providerWgsl`
 * `traceFirstHit` (group 2), `hitShadingWgsl` `shadeTracedHit` (group 3 if it binds anything),
 * `materialWgsl` `traceHitMaterial`.
 */
export function rtTraceWgsl(parts: { fallbackWgsl: string; providerWgsl: string; materialWgsl: string; anyHitWgsl: string; shadingNormalWgsl: string; hitShadingWgsl: string }): string {
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

${HIT_WGSL}
${parts.fallbackWgsl}
${parts.providerWgsl}
${parts.materialWgsl}
${parts.anyHitWgsl}
${parts.shadingNormalWgsl}

// The shadow query hit shading calls (D903): false if geometry lies between the hit point and
// P + L x tMax. The origin is offset along the normal by normalOffset x the view distance, as the
// reflection ray's own origin (D8). With hitShadows off, every light is visible.
fn traceLightVisible(hitP: vec3f, N: vec3f, L: vec3f, tMax: f32) -> bool {
  if (P.hitShadows == 0u) { return true; }
  let origin = hitP + N * (P.normalOffset * length(hitP - P.cameraPosition));
  return !traceAny(origin, L, tMax);
}

// The pass's hitSpecular setting (W41, D3510); a function, since hit shading names its point P.
fn rtHitSpecularOn() -> bool { return P.hitSpecular != 0u; }

${parts.hitShadingWgsl}

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
  // reprojected through motion; off screen last frame keeps this frame's scene colour.
  if (P.useHistory != 0u) {
    let prev = (vec2f(c) + 0.5) * P.inverseRenderSize - textureLoad(t_motion, c, 0).xy * P.motionVectorScale;
    if (all(prev >= vec2f(0.0)) && all(prev < vec2f(1.0))) {
      *out_color = textureLoad(t_history, vec2i(prev * vec2f(textureDimensions(t_history))), 0).rgb;
    }
  }
  return true;
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
  if (P.reuseOnScreen != 0u && onScreenRadiance(hitP, hitN, &L)) {
    source = ${RT_SOURCE.onScreenHit}u;
    atomicAdd(&state[${RT_STATE.onScreen}], 1u);
  } else {
    L = shadeTracedHit(hit, hitP, hitN, dir);
  }
  store(packed, coords, vec4f(L, hit.t), hit.t, 1.0, source);
}
`;
}
