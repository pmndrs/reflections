// WGSL port of the stochastic screen-space reflection tracer from the AMD FidelityFX SDK v1.1.4:
//   sdk/include/FidelityFX/gpu/sssr/ffx_sssr_common.h
//   sdk/include/FidelityFX/gpu/sssr/ffx_sssr_depth_downsample.h      (+ gpu/spd/ffx_spd.h, LDS path)
//   sdk/include/FidelityFX/gpu/sssr/ffx_sssr_classify_tiles.h
//   sdk/include/FidelityFX/gpu/sssr/ffx_sssr_prepare_blue_noise_texture.h
//   sdk/include/FidelityFX/gpu/sssr/ffx_sssr_prepare_indirect_args.h
//   sdk/include/FidelityFX/gpu/sssr/ffx_sssr_intersect.h
//   sdk/include/FidelityFX/gpu/sssr/ffx_sssr_callbacks_hlsl.h         (resource access)
//   sdk/src/backends/dx12/shaders/sssr/ffx_sssr_*_pass.hlsl           (entry points, group sizes)
// The miss list follows samples/hybridreflections/shaders/Intersect.hlsl and
// prepare_indirect_args_hw.hlsl of the same SDK.
//
// This file is part of the FidelityFX SDK.
//
// Copyright (C) 2024 Advanced Micro Devices, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files(the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and /or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions :
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// Port notes. Every knowing difference is in docs/DIVERGES.md (D300-D399); in short:
// - fp32 paths only (no FFX_HALF).
// - Two variants of classify and intersect: 'subgroups' (WGSL `subgroups`: ballot, exclusive add,
//   broadcast-first, elect) and 'workgroup' (workgroup-memory prefix sums and counters). Quad copy
//   flags go through workgroup memory in both, because WGSL does not tie subgroup lanes to
//   local_invocation_index in compute, so a lane ^ 1 read is not a pixel ^ 1 read.
// - The depth pyramid is built in two dispatches of an SPD-style 64x64-tile kernel (mips 0-3, then
//   4-6), since core WebGPU allows only 4 storage textures per stage. SSSR's SPD runs without
//   FFX_WAVE, so this is SPD's LDS path; min/max is exact, so the result is the same texel for texel.
// - Out-of-bounds texture loads return 0 explicitly (FFX relies on D3D's robust loads returning 0;
//   WebGPU implementations clamp instead).
// - Extracted roughness and hit distance are r32float (r8unorm / r16float are not core storage
//   formats). Radiance keeps FFX's layout: rgb + world ray length in w.
// - The environment-map lookup is the radiance-fallback seam `sampleRadianceFallback(P, dir,
//   perceptualRoughness)`, a WGSL snippet with its own @group(1) bindings.

/** Byte size of the uniform block (struct Params below). */
export const PARAMS_SIZE = 512;

export const PARAMS_WGSL = /* wgsl */ `
struct Params {
  invViewProjection: mat4x4f,
  projection: mat4x4f,
  invProjection: mat4x4f,
  viewMatrix: mat4x4f,
  invView: mat4x4f,
  prevViewProjection: mat4x4f,
  renderSize: vec2u,
  inverseRenderSize: vec2f,
  normalsUnpackMul: f32,
  normalsUnpackAdd: f32,
  roughnessChannel: u32,
  isRoughnessPerceptual: u32,
  iblFactor: f32,
  temporalStabilityFactor: f32,
  depthBufferThickness: f32,
  roughnessThreshold: f32,
  varianceThreshold: f32,
  frameIndex: u32,
  maxTraversalIntersections: u32,
  minTraversalOccupancy: u32,
  mostDetailedMip: u32,
  samplesPerQuad: u32,
  temporalVarianceGuidedTracingEnabled: u32,
  maxMip: u32,
  fallbackColor: vec4f,
  missListCapacity: u32,
  missConfidenceThreshold: f32,
  missRoughnessThreshold: f32,
  _pad0: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
`;

/** Shared helpers (ffx_sssr_common.h). `inverted` = FFX_SSSR_OPTION_INVERTED_DEPTH. */
const commonWgsl = (inverted: boolean) => /* wgsl */ `
const INVERTED_DEPTH: bool = ${inverted};
const FAR_PLANE: f32 = ${inverted ? '0.0' : '1.0'};

fn projectPosition(origin: vec3f, m: mat4x4f) -> vec3f {
  let projected = m * vec4f(origin, 1.0);
  var p = projected.xyz / projected.w;
  p = vec3f(0.5 * p.xy + 0.5, p.z);
  p.y = 1.0 - p.y;
  return p;
}
fn invProjectPosition(coord_in: vec3f, m: mat4x4f) -> vec3f {
  var coord = coord_in;
  coord.y = 1.0 - coord.y;
  coord = vec3f(2.0 * coord.xy - 1.0, coord.z);
  let projected = m * vec4f(coord, 1.0);
  return projected.xyz / projected.w;
}
fn projectDirection(origin: vec3f, direction: vec3f, screen_space_origin: vec3f, m: mat4x4f) -> vec3f {
  return projectPosition(origin + direction, m) - screen_space_origin;
}
fn isGlossyReflection(roughness: f32) -> bool { return roughness < P.roughnessThreshold; }
fn isMirrorReflection(roughness: f32) -> bool { return roughness < 0.0001; }
// Hybrid sample (Common.hlsl FFX_DNSR_Reflections_IsBackground): far plane within 1e-6.
fn isBackground(depth: f32) -> bool { return ${inverted ? 'depth < 1.e-6' : 'depth >= (1.0 - 1.e-6)'}; }
fn screenSpaceToViewSpace(c: vec3f) -> vec3f { return invProjectPosition(c, P.invProjection); }
fn screenSpaceToWorldSpace(c: vec3f) -> vec3f { return invProjectPosition(c, P.invViewProjection); }

fn unpackRayCoords(packed: u32) -> vec2u { return vec2u(packed & 32767u, (packed >> 15u) & 16383u); }
fn packRayCoords(c: vec2u, h: bool, v: bool, d: bool) -> u32 {
  return (select(0u, 1u, d) << 31u) | (select(0u, 1u, v) << 30u) | (select(0u, 1u, h) << 29u)
       | ((c.y & 16383u) << 15u) | (c.x & 32767u);
}
`;

/** The radiance-fallback seam's default: a constant colour from the uniform block. */
export const CONSTANT_FALLBACK_WGSL = /* wgsl */ `
fn sampleRadianceFallback(P_world: vec3f, dir: vec3f, roughness: f32) -> vec3f {
  return P.fallbackColor.rgb * P.iblFactor;
}
`;

/** One cube environment in @group(1), sampled like FFX_SSSR_SampleEnvironmentMap. */
export const ENVIRONMENT_FALLBACK_WGSL = /* wgsl */ `
@group(1) @binding(0) var fallbackEnvironment: texture_cube<f32>;
@group(1) @binding(1) var fallbackSampler: sampler;
fn sampleRadianceFallback(P_world: vec3f, dir: vec3f, roughness: f32) -> vec3f {
  let width = f32(textureDimensions(fallbackEnvironment).x);
  let maxMip = floor(log2(max(width, 1.0)));
  let mip = clamp(roughness * maxMip, 0.0, maxMip);
  return textureSampleLevel(fallbackEnvironment, fallbackSampler, dir, mip).xyz * P.iblFactor;
}
`;

// Hierarchical depth: see depthPyramid.ts.

// ---------------------------------------------------------------------------------------------
// Tile classification (ffx_sssr_classify_tiles.h + ffx_sssr_classify_tiles_pass.hlsl).

export type Variant = 'subgroups' | 'workgroup';

export function classifyWgsl(variant: Variant, inverted: boolean, fallbackWgsl: string): string {
  const sg = variant === 'subgroups';
  return /* wgsl */ `
${sg ? 'enable subgroups;' : ''}
${PARAMS_WGSL}
${commonWgsl(inverted)}
@group(0) @binding(1) var t_depth_hierarchy: texture_2d<f32>;
@group(0) @binding(2) var t_normal: texture_2d<f32>;
@group(0) @binding(3) var t_material: texture_2d<f32>;
@group(0) @binding(4) var t_variance: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> rayList: array<u32>;
@group(0) @binding(6) var<storage, read_write> tileList: array<u32>;
@group(0) @binding(7) var<storage, read_write> rayCounter: array<atomic<u32>, 4>;
@group(0) @binding(8) var<storage, read_write> tileFlags: array<u32>;
@group(0) @binding(9) var o_radiance: texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var o_hit: texture_storage_2d<r32float, write>;
@group(0) @binding(11) var o_roughness: texture_storage_2d<r32float, write>;
${fallbackWgsl}

var<workgroup> g_TileCount: atomic<u32>;
var<workgroup> g_DenoiseCount: atomic<u32>;
var<workgroup> g_RequireCopy: array<u32, 64>;
${sg ? '' : 'var<workgroup> g_Scan: array<u32, 64>;\nvar<workgroup> g_Base: u32;'}

fn bitfieldExtract(src: u32, off: u32, bits: u32) -> u32 { return (src >> off) & ((1u << bits) - 1u); }
fn bitfieldInsertMask(src: u32, ins: u32, bits: u32) -> u32 { let m = (1u << bits) - 1u; return (ins & m) | (src & ~m); }
// ffxRemapForWaveReduction: lane 4k..4k+3 hold one 2x2 quad, so lane ^ 1 / ^ 2 / ^ 3 is the x / y / diagonal neighbour.
fn remapForWaveReduction(a: u32) -> vec2u {
  return vec2u(bitfieldInsertMask(bitfieldExtract(a, 2u, 3u), a, 1u),
               bitfieldInsertMask(bitfieldExtract(a, 3u, 3u), bitfieldExtract(a, 1u, 2u), 2u));
}
fn isBaseRay(id: vec2u, samples_per_quad: u32) -> bool {
  switch (samples_per_quad) {
    case 1u: { return ((id.x & 1u) | (id.y & 1u)) == 0u; }
    case 2u: { return (id.x & 1u) == (id.y & 1u); }
    default: { return true; }
  }
}
fn loadRoughness(p: vec2i) -> f32 {
  var r = textureLoad(t_material, p, 0)[min(P.roughnessChannel, 3u)];
  if (P.isRoughnessPerceptual != 0u) { r *= r; }
  return r;
}
fn loadWorldSpaceNormal(p: vec2i) -> vec3f {
  return normalize(P.normalsUnpackMul * textureLoad(t_normal, p, 0).xyz + P.normalsUnpackAdd);
}
fn isReflectiveSurface(p: vec2i) -> bool {
  let z = textureLoad(t_depth_hierarchy, p, 0).x;
  return ${inverted ? 'z > FAR_PLANE' : 'z < FAR_PLANE'};
}

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wg: vec3u,
        @builtin(num_workgroups) nwg: vec3u) {
  let group_thread_id = remapForWaveReduction(lid);
  let dispatch_thread_id = wg.xy * 8u + group_thread_id;
  let on_screen = all(dispatch_thread_id < P.renderSize);
  let px = vec2i(min(dispatch_thread_id, P.renderSize - 1u));
  let roughness = loadRoughness(px);

  var needs_ray = on_screen;
  let is_reflective_surface = on_screen && isReflectiveSurface(px);
  let is_glossy_reflection = isGlossyReflection(roughness);
  needs_ray = needs_ray && is_glossy_reflection && is_reflective_surface;
  let needs_denoiser = needs_ray && !isMirrorReflection(roughness);
  let is_base_ray = isBaseRay(dispatch_thread_id, P.samplesPerQuad);
  needs_ray = needs_ray && (!needs_denoiser || is_base_ray);
  if (P.temporalVarianceGuidedTracingEnabled != 0u && needs_denoiser && !needs_ray) {
    let has_temporal_variance = textureLoad(t_variance, px, 0).x > P.varianceThreshold;
    needs_ray = needs_ray || has_temporal_variance;
  }

  if (is_glossy_reflection && is_reflective_surface) { atomicAdd(&g_TileCount, 1u); }
  if (needs_denoiser) { atomicAdd(&g_DenoiseCount, 1u); }

  let require_copy = !needs_ray && needs_denoiser;
  g_RequireCopy[lid] = select(0u, 1u, require_copy);
  workgroupBarrier();
  let copy_horizontal = g_RequireCopy[lid ^ 1u] != 0u && (P.samplesPerQuad != 4u) && is_base_ray;
  let copy_vertical   = g_RequireCopy[lid ^ 2u] != 0u && (P.samplesPerQuad == 1u) && is_base_ray;
  let copy_diagonal   = g_RequireCopy[lid ^ 3u] != 0u && (P.samplesPerQuad == 1u) && is_base_ray;

  // Compact the rays and append them to the ray list, one atomic per ${sg ? 'subgroup' : 'workgroup'}.
  let ray_bit = select(0u, 1u, needs_ray);
${sg ? `
  let ballot = subgroupBallot(needs_ray);
  let wave_ray_count = countOneBits(ballot.x) + countOneBits(ballot.y) + countOneBits(ballot.z) + countOneBits(ballot.w);
  let local_ray_index = subgroupExclusiveAdd(ray_bit);
  var base_ray_index = 0u;
  if (subgroupElect()) { base_ray_index = atomicAdd(&rayCounter[0], wave_ray_count); }
  base_ray_index = subgroupBroadcastFirst(base_ray_index);` : `
  g_Scan[lid] = ray_bit;
  workgroupBarrier();
  for (var off = 1u; off < 64u; off <<= 1u) {
    var v = 0u;
    if (lid >= off) { v = g_Scan[lid - off]; }
    workgroupBarrier();
    g_Scan[lid] += v;
    workgroupBarrier();
  }
  let local_ray_index = g_Scan[lid] - ray_bit;
  if (lid == 63u) { g_Base = atomicAdd(&rayCounter[0], g_Scan[63]); }
  let base_ray_index = workgroupUniformLoad(&g_Base);`}
  if (needs_ray) {
    rayList[base_ray_index + local_ray_index] = packRayCoords(dispatch_thread_id, copy_horizontal, copy_vertical, copy_diagonal);
  }

  var intersection_output = vec4f(0.0);
  if (is_reflective_surface && !is_glossy_reflection) {
    // Fall back to the environment (here: the radiance-fallback seam) without preparing a ray.
    let uv = (vec2f(dispatch_thread_id) + 0.5) * P.inverseRenderSize;
    let world_space_normal = loadWorldSpaceNormal(px);
    let z = textureLoad(t_depth_hierarchy, px, 0).x;
    let screen_uv_space_ray_origin = vec3f(uv, z);
    let view_space_ray = screenSpaceToViewSpace(screen_uv_space_ray_origin);
    let view_space_ray_direction = normalize(view_space_ray);
    let view_space_surface_normal = (P.viewMatrix * vec4f(world_space_normal, 0.0)).xyz;
    let view_space_reflected_direction = reflect(view_space_ray_direction, view_space_surface_normal);
    let world_space_reflected_direction = (P.invView * vec4f(view_space_reflected_direction, 0.0)).xyz;
    let world_space_origin = (P.invView * vec4f(view_space_ray, 1.0)).xyz;
    intersection_output = vec4f(sampleRadianceFallback(world_space_origin, world_space_reflected_direction, sqrt(roughness)), 0.0);
  }
  if (on_screen) {
    textureStore(o_radiance, dispatch_thread_id, intersection_output);
    textureStore(o_hit, dispatch_thread_id, vec4f(0.0));
    // Extract only the roughness channel so later passes load one value.
    textureStore(o_roughness, dispatch_thread_id, vec4f(roughness));
  }

  workgroupBarrier();
  if (lid == 0u) {
    let tile_count = atomicLoad(&g_TileCount);
    let denoise_count = atomicLoad(&g_DenoiseCount);
    if (tile_count > 0u) {
      let tile_offset = atomicAdd(&rayCounter[2], 1u);
      tileList[tile_offset] = ((dispatch_thread_id.y & 0xffffu) << 16u) | (dispatch_thread_id.x & 0xffffu);
    }
    // Port addition: bit 0 = listed for the denoiser, bit 1 = has a non-mirror glossy pixel.
    // Listed without bit 1 means every glossy pixel in the tile is a mirror, so a denoiser may skip it.
    tileFlags[wg.y * nwg.x + wg.x] = select(0u, 1u, tile_count > 0u) | select(0u, 2u, denoise_count > 0u);
  }
}
`;
}

// ---------------------------------------------------------------------------------------------
// Blue noise (ffx_sssr_prepare_blue_noise_texture.h). The Sobol x scrambling lookups for sample 0,
// dimensions 0 and 1, are pre-folded into a 128x128x2 byte table (blueNoiseData.ts).

export const BLUE_NOISE_WGSL = /* wgsl */ `
${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> table: array<u32>;
@group(0) @binding(2) var o_blue_noise: texture_storage_2d<rgba8unorm, write>;
const GOLDEN_RATIO: f32 = 1.61803398875;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = (id.y & 127u) * 128u + (id.x & 127u);
  let pair = (table[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu;
  let shift = f32(P.frameIndex & 0xffu) * GOLDEN_RATIO;
  let u = vec2f((f32(pair & 0xffu) + 0.5) / 256.0 + shift, (f32(pair >> 8u) + 0.5) / 256.0 + shift) % vec2f(1.0);
  textureStore(o_blue_noise, id.xy, vec4f(u, 0.0, 0.0)); // unorm8, like FFX's R8G8_UNORM
}
`;

// ---------------------------------------------------------------------------------------------
// Indirect arguments (ffx_sssr_prepare_indirect_args.h). One thread.
// args[0..2]: intersect (64 rays per group); args[3..5]: denoiser (one group per tile).

export const INDIRECT_ARGS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> rayCounter: array<u32, 4>;
@group(0) @binding(1) var<storage, read_write> args: array<u32, 6>;
@compute @workgroup_size(1)
fn main() {
  let ray_count = rayCounter[0];
  args[0] = (ray_count + 63u) / 64u; args[1] = 1u; args[2] = 1u;
  rayCounter[0] = 0u; rayCounter[1] = ray_count;
  let tile_count = rayCounter[2];
  args[3] = tile_count; args[4] = 1u; args[5] = 1u;
  rayCounter[2] = 0u; rayCounter[3] = tile_count;
}
`;

/** Miss-list indirect args (hybrid sample's prepare_indirect_args_hw.hlsl), run after intersect.
 *  missCounter: [0] append counter, [1] this frame's count, [2] overflow (dropped entries).
 *  args: x = ceil(count / 64), 1, 1 for the ray-traced pass. */
export const MISS_ARGS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> missCounter: array<u32, 4>;
@group(0) @binding(1) var<storage, read_write> args: array<u32, 3>;
@compute @workgroup_size(1)
fn main() {
  let count = missCounter[0];
  missCounter[0] = 0u;
  missCounter[1] = count;
  args[0] = (count + 63u) / 64u; args[1] = 1u; args[2] = 1u;
}
`;

// ---------------------------------------------------------------------------------------------
// Intersection (ffx_sssr_intersect.h + ffx_sssr_intersect_pass.hlsl).

export function intersectWgsl(variant: Variant, inverted: boolean, fallbackWgsl: string, missList: boolean): string {
  const sg = variant === 'subgroups';
  return /* wgsl */ `
${sg ? 'enable subgroups;\ndiagnostic(off, subgroup_uniformity);' : ''}
${PARAMS_WGSL}
${commonWgsl(inverted)}
@group(0) @binding(1) var t_color: texture_2d<f32>;
@group(0) @binding(2) var t_normal: texture_2d<f32>;
@group(0) @binding(3) var t_depth_hierarchy: texture_2d<f32>;
@group(0) @binding(4) var t_roughness: texture_2d<f32>;
@group(0) @binding(5) var t_blue_noise: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> rayList: array<u32>;
@group(0) @binding(7) var<storage, read> rayCounter: array<u32, 4>;
@group(0) @binding(8) var o_radiance: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var o_hit: texture_storage_2d<r32float, write>;
${missList ? `@group(0) @binding(10) var<storage, read_write> missList: array<vec2u>;
@group(0) @binding(11) var<storage, read_write> missCounter: array<atomic<u32>, 4>;` : ''}
${fallbackWgsl}

const M_PI: f32 = 3.14159265358979;
const FLOAT_MAX: f32 = 3.402823466e+38;

${sg ? '' : `var<workgroup> wgActive: atomic<u32>;
var<workgroup> wgActivePlain: u32;
${missList ? 'var<workgroup> g_Scan: array<u32, 64>;\nvar<workgroup> g_Base: u32;' : ''}`}

// D3D-style loads: out of bounds (texel or mip) returns 0.
fn loadDepth(p: vec2i, mip: i32) -> f32 {
  if (mip < 0 || mip > i32(textureNumLevels(t_depth_hierarchy)) - 1) { return 0.0; }
  let dims = vec2i(textureDimensions(t_depth_hierarchy, mip));
  if (any(p < vec2i(0)) || any(p >= dims)) { return 0.0; }
  return textureLoad(t_depth_hierarchy, p, mip).x;
}
fn loadWorldSpaceNormal(p: vec2i) -> vec3f {
  var n = vec3f(0.0);
  if (all(p >= vec2i(0)) && all(p < vec2i(P.renderSize))) { n = textureLoad(t_normal, p, 0).xyz; }
  return normalize(P.normalsUnpackMul * n + P.normalsUnpackAdd);
}
fn loadInputColor(p: vec2i) -> vec3f {
  if (any(p < vec2i(0)) || any(p >= vec2i(textureDimensions(t_color)))) { return vec3f(0.0); }
  return textureLoad(t_color, p, 0).xyz;
}
fn sampleRandomVector2D(p: vec2u) -> vec2f { return textureLoad(t_blue_noise, vec2i(p % 128u), 0).xy; }

fn sampleGGXVNDF(Ve: vec3f, alpha_x: f32, alpha_y: f32, U1: f32, U2: f32) -> vec3f {
  let Vh = normalize(vec3f(alpha_x * Ve.x, alpha_y * Ve.y, Ve.z));
  let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
  var T1 = vec3f(1.0, 0.0, 0.0);
  if (lensq > 0.0) { T1 = vec3f(-Vh.y, Vh.x, 0.0) * inverseSqrt(lensq); }
  let T2 = cross(Vh, T1);
  let r = sqrt(U1);
  let phi = 2.0 * M_PI * U2;
  let t1 = r * cos(phi);
  var t2 = r * sin(phi);
  let s = 0.5 * (1.0 + Vh.z);
  t2 = (1.0 - s) * sqrt(1.0 - t1 * t1) + s * t2;
  let Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
  return normalize(vec3f(alpha_x * Nh.x, alpha_y * Nh.y, max(0.0, Nh.z)));
}

fn sampleReflectionVector(view_direction: vec3f, normal: vec3f, roughness: f32, did: vec2u) -> vec3f {
  var U: vec3f;
  let N = normal;
  if (abs(N.z) > 0.0) {
    let k = sqrt(N.y * N.y + N.z * N.z);
    U = vec3f(0.0, -N.z / k, N.y / k);
  } else {
    let k = sqrt(N.x * N.x + N.y * N.y);
    U = vec3f(N.y / k, -N.x / k, 0.0);
  }
  let TBN_row0 = U;
  let TBN_row1 = cross(N, U);
  let TBN_row2 = N;
  let view_direction_tbn = vec3f(dot(TBN_row0, -view_direction), dot(TBN_row1, -view_direction), dot(TBN_row2, -view_direction));
  let u = sampleRandomVector2D(did);
  let sampled_normal_tbn = sampleGGXVNDF(view_direction_tbn, roughness, roughness, u.x, u.y);
  let reflected_direction_tbn = reflect(-view_direction_tbn, sampled_normal_tbn);
  let TBN_col0 = vec3f(TBN_row0[0], TBN_row1[0], TBN_row2[0]);
  let TBN_col1 = vec3f(TBN_row0[1], TBN_row1[1], TBN_row2[1]);
  let TBN_col2 = vec3f(TBN_row0[2], TBN_row1[2], TBN_row2[2]);
  return vec3f(dot(TBN_col0, reflected_direction_tbn), dot(TBN_col1, reflected_direction_tbn), dot(TBN_col2, reflected_direction_tbn));
}

fn getMipResolution(screen_dimensions: vec2f, mip_level: i32) -> vec2f {
  return screen_dimensions * pow(0.5, f32(mip_level));
}

// FFX_SSSR_HierarchicalRaymarch, split into init + step so both variants share the math.
struct March {
  origin: vec3f,
  direction: vec3f,
  inv_direction: vec3f,
  position: vec3f,
  current_t: f32,
  current_mip: i32,
  most_detailed_mip: i32,
  current_mip_resolution: vec2f,
  current_mip_resolution_inv: vec2f,
  floor_offset: vec2f,
  uv_offset: vec2f,
  is_mirror: bool,
  exit_due_to_low_occupancy: bool,
  i: u32,
};

fn marchInit(origin: vec3f, direction: vec3f, is_mirror: bool, screen_size: vec2f, most_detailed_mip: i32) -> March {
  var m: March;
  m.origin = origin;
  m.direction = direction;
  m.inv_direction = select(vec3f(FLOAT_MAX), vec3f(1.0) / direction, direction != vec3f(0.0));
  m.current_mip = most_detailed_mip;
  m.most_detailed_mip = most_detailed_mip;
  m.current_mip_resolution = getMipResolution(screen_size, m.current_mip);
  m.current_mip_resolution_inv = 1.0 / m.current_mip_resolution;
  var uv_offset = 0.005 * exp2(f32(most_detailed_mip)) / screen_size;
  uv_offset.x = select(uv_offset.x, -uv_offset.x, direction.x < 0.0);
  uv_offset.y = select(uv_offset.y, -uv_offset.y, direction.y < 0.0);
  m.uv_offset = uv_offset;
  m.floor_offset = vec2f(select(1.0, 0.0, direction.x < 0.0), select(1.0, 0.0, direction.y < 0.0));
  m.is_mirror = is_mirror;
  m.exit_due_to_low_occupancy = false;
  m.i = 0u;
  // FFX_SSSR_InitialAdvanceRay
  let current_mip_position = m.current_mip_resolution * origin.xy;
  var xy_plane = floor(current_mip_position) + m.floor_offset;
  xy_plane = xy_plane * m.current_mip_resolution_inv + m.uv_offset;
  let t = xy_plane * m.inv_direction.xy - origin.xy * m.inv_direction.xy;
  m.current_t = min(t.x, t.y);
  m.position = origin + m.current_t * direction;
  return m;
}

fn marchRunning(m: ptr<function, March>) -> bool {
  return (*m).i < P.maxTraversalIntersections && (*m).current_mip >= (*m).most_detailed_mip && !(*m).exit_due_to_low_occupancy;
}

// One iteration of the traversal loop; \`occupancy\` = active invocations (ffxWaveActiveCountBits(true)).
fn marchStep(m: ptr<function, March>, occupancy: u32) {
  let current_mip_position = (*m).current_mip_resolution * (*m).position.xy;
  let surface_z = loadDepth(vec2i(current_mip_position), (*m).current_mip);
  (*m).exit_due_to_low_occupancy = !(*m).is_mirror && occupancy <= P.minTraversalOccupancy;
  // FFX_SSSR_AdvanceRay
  var xy_plane = floor(current_mip_position) + (*m).floor_offset;
  xy_plane = xy_plane * (*m).current_mip_resolution_inv + (*m).uv_offset;
  let boundary_planes = vec3f(xy_plane, surface_z);
  var t = boundary_planes * (*m).inv_direction - (*m).origin * (*m).inv_direction;
  ${inverted ? 't.z = select(FLOAT_MAX, t.z, (*m).direction.z < 0.0);' : 't.z = select(FLOAT_MAX, t.z, (*m).direction.z > 0.0);'}
  let t_min = min(min(t.x, t.y), t.z);
  let above_surface = ${inverted ? 'surface_z < (*m).position.z' : 'surface_z > (*m).position.z'};
  let skipped_tile = bitcast<u32>(t_min) != bitcast<u32>(t.z) && above_surface;
  (*m).current_t = select((*m).current_t, t_min, above_surface);
  (*m).position = (*m).origin + (*m).current_t * (*m).direction;
  // Don't go coarser than the pyramid we built.
  let next_mip_out_of_range = skipped_tile && ((*m).current_mip >= i32(P.maxMip));
  if (!next_mip_out_of_range) {
    (*m).current_mip += select(-1, 1, skipped_tile);
    (*m).current_mip_resolution *= select(2.0, 0.5, skipped_tile);
    (*m).current_mip_resolution_inv *= select(0.5, 2.0, skipped_tile);
  }
  (*m).i += 1u;
}

fn validateHit(hit: vec3f, uv: vec2f, world_space_ray_direction: vec3f, screen_size: vec2f, depth_buffer_thickness: f32) -> f32 {
  if (hit.x < 0.0 || hit.y < 0.0 || hit.x > 1.0 || hit.y > 1.0) { return 0.0; }
  let manhattan_dist = abs(hit.xy - uv);
  if (manhattan_dist.x < (2.0 / screen_size.x) && manhattan_dist.y < (2.0 / screen_size.y)) { return 0.0; }
  let texel_coords = vec2i(screen_size * hit.xy);
  let surface_z = loadDepth(texel_coords / 2, 1);
  if (surface_z == FAR_PLANE) { return 0.0; }
  let hit_normal = loadWorldSpaceNormal(texel_coords);
  if (dot(hit_normal, world_space_ray_direction) > 0.0) { return 0.0; }
  let view_space_surface = screenSpaceToViewSpace(vec3f(hit.xy, surface_z));
  let view_space_hit = screenSpaceToViewSpace(hit);
  let distance = length(view_space_surface - view_space_hit);
  let fov = 0.05 * vec2f(screen_size.y / screen_size.x, 1.0);
  let border = smoothstep(vec2f(0.0), fov, hit.xy) * (1.0 - smoothstep(vec2f(1.0) - fov, vec2f(1.0), hit.xy));
  let vignette = border.x * border.y;
  var confidence = 1.0 - smoothstep(0.0, depth_buffer_thickness, distance);
  confidence *= confidence;
  return vignette * confidence;
}

fn octEncode(n: vec3f) -> vec2f {
  var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) {
    let s = select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
    p = (1.0 - abs(p.yx)) * s;
  }
  return p;
}

fn storeRadiance(packed: u32, coords: vec2u, value: vec4f, hit_distance: f32) {
  let copy_target = coords ^ vec2u(1u);
  textureStore(o_radiance, coords, value);
  textureStore(o_hit, coords, vec4f(hit_distance));
  if (((packed >> 29u) & 1u) != 0u) { let c = vec2u(copy_target.x, coords.y); textureStore(o_radiance, c, value); textureStore(o_hit, c, vec4f(hit_distance)); }
  if (((packed >> 30u) & 1u) != 0u) { let c = vec2u(coords.x, copy_target.y); textureStore(o_radiance, c, value); textureStore(o_hit, c, vec4f(hit_distance)); }
  if (((packed >> 31u) & 1u) != 0u) { textureStore(o_radiance, copy_target, value); textureStore(o_hit, copy_target, vec4f(hit_distance)); }
}

struct Ray {
  packed: u32,
  coords: vec2u,
  uv: vec2f,
  roughness: f32,
  origin_ss: vec3f,
  view_space_ray: vec3f,
  view_space_reflected_direction: vec3f,
  march: March,
};

fn setupRay(ray_index: u32) -> Ray {
  var r: Ray;
  r.packed = rayList[min(ray_index, arrayLength(&rayList) - 1u)];
  r.coords = unpackRayCoords(r.packed);
  let screen_size = vec2f(P.renderSize);
  r.uv = (vec2f(r.coords) + 0.5) * P.inverseRenderSize;
  let world_space_normal = loadWorldSpaceNormal(vec2i(r.coords));
  r.roughness = textureLoad(t_roughness, vec2i(r.coords), 0).x;
  let is_mirror = isMirrorReflection(r.roughness);
  let most_detailed_mip = select(i32(P.mostDetailedMip), 0, is_mirror);
  let mip_resolution = getMipResolution(screen_size, most_detailed_mip);
  let z = loadDepth(vec2i(r.uv * mip_resolution), most_detailed_mip);
  r.origin_ss = vec3f(r.uv, z);
  r.view_space_ray = screenSpaceToViewSpace(r.origin_ss);
  let view_space_ray_direction = normalize(r.view_space_ray);
  let view_space_surface_normal = (P.viewMatrix * vec4f(world_space_normal, 0.0)).xyz;
  r.view_space_reflected_direction = sampleReflectionVector(view_space_ray_direction, view_space_surface_normal, r.roughness, r.coords);
  let screen_space_ray_direction = projectDirection(r.view_space_ray, r.view_space_reflected_direction, r.origin_ss, P.projection);
  r.march = marchInit(r.origin_ss, screen_space_ray_direction, is_mirror, screen_size, most_detailed_mip);
  return r;
}

// Shade the march result; returns true when the ray goes to the miss list.
fn finishRay(r: ptr<function, Ray>) -> bool {
  let screen_size = vec2f(P.renderSize);
  let hit = (*r).march.position;
  let valid_hit = (*r).march.i <= P.maxTraversalIntersections;
  let world_space_origin = screenSpaceToWorldSpace((*r).origin_ss);
  let world_space_hit = screenSpaceToWorldSpace(hit);
  let world_space_ray = world_space_hit - world_space_origin;
  var confidence = 0.0;
  if (valid_hit) { confidence = validateHit(hit, (*r).uv, world_space_ray, screen_size, P.depthBufferThickness); }
  let world_ray_length = max(0.0, length(world_space_ray));
  var reflection_radiance = vec3f(0.0);
  if (confidence > 0.0) { reflection_radiance = loadInputColor(vec2i(screen_size * hit.xy)); }
  let world_space_reflected_direction = (P.invView * vec4f((*r).view_space_reflected_direction, 0.0)).xyz;
  let environment_lookup = sampleRadianceFallback(world_space_origin, world_space_reflected_direction, 0.0);
  reflection_radiance = mix(environment_lookup, reflection_radiance, confidence);
  storeRadiance((*r).packed, (*r).coords, vec4f(reflection_radiance, world_ray_length), select(0.0, world_ray_length, confidence > 0.0));
  // Hybrid sample: low confidence, not marched into the background, and not too rough to trace.
  return confidence < P.missConfidenceThreshold && !isBackground(hit.z) && (*r).roughness <= P.missRoughnessThreshold;
}

fn missEntry(r: ptr<function, Ray>) -> vec2u {
  let d = normalize((P.invView * vec4f((*r).view_space_reflected_direction, 0.0)).xyz);
  return vec2u((*r).packed, pack2x16snorm(octEncode(d)));
}

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) gi: u32, @builtin(workgroup_id) wg: vec3u) {
  let ray_index = wg.x * 64u + gi;
${sg ? `
  if (ray_index >= rayCounter[1]) { return; }
  var r = setupRay(ray_index);
  while (marchRunning(&r.march)) {
    let ballot = subgroupBallot(true);
    let occupancy = countOneBits(ballot.x) + countOneBits(ballot.y) + countOneBits(ballot.z) + countOneBits(ballot.w);
    marchStep(&r.march, occupancy);
  }
  let miss = finishRay(&r);
  ${missList ? `
  // One atomic per subgroup (the hybrid sample's WaveActiveCountBits / WavePrefixCountBits append).
  let mb = subgroupBallot(miss);
  let wave_count = countOneBits(mb.x) + countOneBits(mb.y) + countOneBits(mb.z) + countOneBits(mb.w);
  let local_index = subgroupExclusiveAdd(select(0u, 1u, miss));
  var base = 0u;
  if (subgroupElect() && wave_count > 0u) { base = atomicAdd(&missCounter[0], wave_count); }
  base = subgroupBroadcastFirst(base);
  if (miss) {
    let idx = base + local_index;
    if (idx < P.missListCapacity) { missList[idx] = missEntry(&r); } else { atomicAdd(&missCounter[2], 1u); }
  }` : ''}` : `
  // Workgroup variant: the traversal loop runs in uniform control flow so the whole workgroup can
  // count its active invocations each iteration (FFX's wave occupancy, with a 64-wide "wave").
  let has_ray = ray_index < rayCounter[1];
  var r = setupRay(ray_index);
  var running = has_ray;
  for (var k = 0u; k < P.maxTraversalIntersections; k++) {
    running = running && marchRunning(&r.march);
    if (gi == 0u) { atomicStore(&wgActive, 0u); }
    workgroupBarrier();
    if (running) { atomicAdd(&wgActive, 1u); }
    workgroupBarrier();
    if (gi == 0u) { wgActivePlain = atomicLoad(&wgActive); }
    let occupancy = workgroupUniformLoad(&wgActivePlain);
    if (occupancy == 0u) { break; }
    if (running) { marchStep(&r.march, occupancy); }
  }
  var miss = false;
  if (has_ray) { miss = finishRay(&r); }
  ${missList ? `
  // One atomic per workgroup: prefix sum in workgroup memory.
  let bit = select(0u, 1u, miss);
  g_Scan[gi] = bit;
  workgroupBarrier();
  for (var off = 1u; off < 64u; off <<= 1u) {
    var v = 0u;
    if (gi >= off) { v = g_Scan[gi - off]; }
    workgroupBarrier();
    g_Scan[gi] += v;
    workgroupBarrier();
  }
  if (gi == 63u) { g_Base = select(0u, atomicAdd(&missCounter[0], g_Scan[63]), g_Scan[63] > 0u); }
  let base = workgroupUniformLoad(&g_Base);
  if (miss) {
    let idx = base + g_Scan[gi] - bit;
    if (idx < P.missListCapacity) { missList[idx] = missEntry(&r); } else { atomicAdd(&missCounter[2], 1u); }
  }` : ''}`}
}
`;
}
