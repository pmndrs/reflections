// The three stopgap trace provider (docs/SPEC.md "Trace seam"): three-mesh-bvh's WebGPU packing
// (`BVHComputeData` from 'three-mesh-bvh/webgpu', 0.9.18) behind core's `TraceProvider`.
//
// three-mesh-bvh exposes its walk as TSL function nodes (`bvhData.fns.raycastFirstHit`), which a
// raw-WGSL core pass can't call. So this file carries a WGSL port of that walk
// (shapecastFns/getShapecastFn.js + getRaycastFirstHitFn.js + rayShapecastUtils.js +
// tsl/fns.js intersectRayTriangle; MIT, Copyright (c) 2018 Garrett Johnson, see NOTICE) over the
// same four buffers, uploaded from BVHComputeData's CPU arrays into our own GPUBuffers:
//
//   nodes       16 u32 per node: left bounds (6 f32), right bounds (6 f32), right child offset or
//               triangle offset, split axis or (leaf flag << 16 | triangle count), 2 pad.
//               A TLAS leaf holds the transform slot in the low 24 bits and the BLAS root node.
//   transforms  36 words per slot: matrixWorld, inverseMatrixWorld, visible, 3 pad words. We pack
//               the slot's material into the pad words (W27b): albedo rgb8 + roughness 8, emissive
//               rgb9e5, specular F0 as sqrt-encoded rgb565 + clear coat 8 + clear coat roughness 8;
//               the hook three-mesh-bvh's writeTransformData comment names for this.
//   index       u32 triangle corners (rebased into the packed attributes)
//   attributes  the interleaved per-vertex struct; we only read `position` (first vec4f).
//
// The layout is three-mesh-bvh's internals, not its public API: `LAYOUT` below pins what we read,
// and the constructor checks it, so a layout change fails loudly instead of tracing garbage.
//
// This is the stopgap until @pmndrs/bvh (core provider) passes its oracle on our scenes.
import * as THREE from 'three/webgpu';
import type { BindingSlot, ModuleBindingEntry, TraceProvider } from '@pmndrs/reflections-core';

/**
 * Linear diffuse albedo and emitted radiance of a traced hit (WGSL `HitMaterial`), and its specular
 * lobe (WGSL `HitSpecular`, W27b, D2750): F0 (linear), perceptual roughness, clear coat factor and
 * roughness. Without `specular` the hit is diffuse only (as before W27b).
 */
export interface HitMaterial {
  albedo: readonly [number, number, number];
  emissive: readonly [number, number, number];
  specular?: readonly [number, number, number];
  roughness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
}

/** The parts of three-mesh-bvh's `BVHComputeData` this provider reads (structural, so the optional peer stays optional for types too). */
export interface MeshBVHComputeDataLike {
  update(): void;
  updateTransforms(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storage: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structs: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bvh: any;
}

/** What we read from three-mesh-bvh's packing (0.9.18). */
const LAYOUT = { nodeWords: 16, transformWords: 36, stackDepth: 60 } as const;

export interface MeshBVHTraceProviderOptions {
  /**
   * The material a mesh contributes to traced-hit shading. Default {@link defaultHitMaterial}:
   * diffuse albedo `color x mean(map) x (1 - metalness) x (1 - transmission)`, `emissive x
   * mean(emissiveMap) x emissiveIntensity`, specular F0 `mix(0.04, base, metalness)`, roughness and
   * clear coat (one set per mesh: D902, D2750).
   */
  material?: (mesh: THREE.Mesh) => HitMaterial;
}

const mapMeans = new WeakMap<THREE.Texture, [number, number, number] | null>();
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Mean linear colour of a texture's image (cached per texture), or null if it can't be read on the
 * CPU (compressed, render target, not loaded yet). Images are averaged over a 16x16 downscale.
 */
export function textureMeanColor(t: THREE.Texture): [number, number, number] | null {
  if (mapMeans.has(t)) return mapMeans.get(t)!;
  let mean: [number, number, number] | null = null;
  const img = t.image as { data?: ArrayLike<number>; width?: number; height?: number } | CanvasImageSource | undefined;
  const srgb = t.colorSpace === THREE.SRGBColorSpace;
  try {
    if (img && 'data' in img && img.data && img.width && img.height) {
      const d = img.data, n = img.width * img.height, ch = Math.round(d.length / n);
      const scale = d instanceof Uint8Array || d instanceof Uint8ClampedArray ? 1 / 255 : 1;
      const acc = [0, 0, 0];
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) acc[c] += d[i * ch + Math.min(c, ch - 1)] * scale;
      mean = acc.map((v) => (srgb ? srgbToLinear(v / n) : v / n)) as [number, number, number];
    } else if (img && typeof document !== 'undefined' && ((img as { width?: number }).width ?? 0) > 0) {
      const S = 16;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const g = cv.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img as CanvasImageSource, 0, 0, S, S);
      const px = g.getImageData(0, 0, S, S).data;
      const acc = [0, 0, 0];
      // 8-bit canvas data is sRGB-encoded whatever the texture says; decode per texel
      for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) acc[c] += srgb ? srgbToLinear(px[i * 4 + c] / 255) : px[i * 4 + c] / 255;
      mean = acc.map((v) => v / (S * S)) as [number, number, number];
    }
  } catch { mean = null; }
  if (mean) mapMeans.set(t, mean);
  return mean;
}

/**
 * Default hit material of a three mesh (first material of a multi-material mesh), one set per mesh
 * from the material's scalars x the mean of its maps (D902):
 * - diffuse albedo `color x mean(map) x (1 - metalness) x (1 - transmission)`;
 * - `emissive x mean(emissiveMap) x emissiveIntensity`;
 * - specular F0 `mix(0.04, color x mean(map), metalness)` (W27b, D2750; standard and physical
 *   materials only), roughness `roughness x mean(roughnessMap).g`, metalness `x mean(metalnessMap).b`,
 *   clear coat `clearcoat x mean(clearcoatMap).r` and `clearcoatRoughness` (physical materials).
 */
export function defaultHitMaterial(mesh: THREE.Mesh): HitMaterial {
  const m = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshPhysicalMaterial | undefined;
  const albedo: [number, number, number] = [0.5, 0.5, 0.5];
  const emissive: [number, number, number] = [0, 0, 0];
  const out: HitMaterial = { albedo, emissive };
  const pbr = typeof m?.metalness === 'number' && typeof m?.roughness === 'number';
  const metalness = pbr ? m!.metalness * (m!.metalnessMap ? textureMeanColor(m!.metalnessMap)?.[2] ?? 1 : 1) : 0;
  if (m?.color) {
    const t = m.map ? textureMeanColor(m.map) ?? [1, 1, 1] : [1, 1, 1];
    const base = [m.color.r * t[0], m.color.g * t[1], m.color.b * t[2]];
    const k = (1 - metalness) * (1 - (m.transmission ?? 0));
    albedo[0] = base[0] * k; albedo[1] = base[1] * k; albedo[2] = base[2] * k;
    if (pbr) {
      out.specular = base.map((b) => 0.04 + (b - 0.04) * metalness) as [number, number, number];
      out.roughness = m.roughness * (m.roughnessMap ? textureMeanColor(m.roughnessMap)?.[1] ?? 1 : 1);
      out.clearcoat = (m.clearcoat ?? 0) * (m.clearcoatMap ? textureMeanColor(m.clearcoatMap)?.[0] ?? 1 : 1);
      out.clearcoatRoughness = m.clearcoatRoughness ?? 0;
    }
  }
  if (m?.emissive) {
    const k = m.emissiveIntensity ?? 1;
    const t = m.emissiveMap ? textureMeanColor(m.emissiveMap) ?? [1, 1, 1] : [1, 1, 1];
    emissive[0] = m.emissive.r * t[0] * k; emissive[1] = m.emissive.g * t[1] * k; emissive[2] = m.emissive.b * t[2] * k;
  }
  return out;
}

const providerWgsl = (slot: BindingSlot, attributeVec4s: number) => /* wgsl */ `
@group(${slot.group}) @binding(${slot.firstBinding}) var<storage, read> tmbNodes: array<u32>;
@group(${slot.group}) @binding(${slot.firstBinding + 1}) var<storage, read> tmbTransforms: array<vec4f>;
@group(${slot.group}) @binding(${slot.firstBinding + 2}) var<storage, read> tmbIndex: array<u32>;
@group(${slot.group}) @binding(${slot.firstBinding + 3}) var<storage, read> tmbAttributes: array<vec4f>;
const TMB_NODE_WORDS: u32 = ${LAYOUT.nodeWords}u;
const TMB_TRANSFORM_VEC4S: u32 = ${LAYOUT.transformWords / 4}u;
const TMB_ATTRIBUTE_VEC4S: u32 = ${attributeVec4s}u;
const TMB_STACK_DEPTH: i32 = ${LAYOUT.stackDepth};

struct TmbRay { origin: vec3f, direction: vec3f, maxDist: f32 }
struct TmbResult { didHit: bool, dist: f32, normal: vec3f, side: f32, barycoord: vec3f, indices: vec4u, objectIndex: u32 }

fn tmbInverseMatrix(slot: u32) -> mat4x4f {
  let b = slot * TMB_TRANSFORM_VEC4S + 4u;
  return mat4x4f(tmbTransforms[b], tmbTransforms[b + 1u], tmbTransforms[b + 2u], tmbTransforms[b + 3u]);
}
fn tmbExtra(slot: u32) -> vec4u { return bitcast<vec4u>(tmbTransforms[slot * TMB_TRANSFORM_VEC4S + 8u]); }

// rayShapecastUtils.js bvh_rayBoundsDistance: distance to the box, -1 if missed.
fn tmbRayBoundsDistance(ray: TmbRay, base: u32) -> f32 {
  let boundsMin = vec3f(bitcast<f32>(tmbNodes[base]), bitcast<f32>(tmbNodes[base + 1u]), bitcast<f32>(tmbNodes[base + 2u]));
  let boundsMax = vec3f(bitcast<f32>(tmbNodes[base + 3u]), bitcast<f32>(tmbNodes[base + 4u]), bitcast<f32>(tmbNodes[base + 5u]));
  let parallel = ray.direction == vec3f(0.0);
  if (any(parallel & ((ray.origin < boundsMin) | (ray.origin > boundsMax)))) { return -1.0; }
  let invDir = 1.0 / select(ray.direction, vec3f(1.0), parallel);
  let tMinPlane = (boundsMin - ray.origin) * invDir;
  let tMaxPlane = (boundsMax - ray.origin) * invDir;
  const FLT_MAX = 3.402823e38;
  let tMinHit = select(min(tMinPlane, tMaxPlane), vec3f(-FLT_MAX), parallel);
  let tMaxHit = select(max(tMinPlane, tMaxPlane), vec3f(FLT_MAX), parallel);
  let t0 = max(max(tMinHit.x, tMinHit.y), tMinHit.z);
  let t1 = min(min(tMaxHit.x, tMaxHit.y), tMaxHit.z);
  let dist = max(t0, 0.0);
  return select(dist, -1.0, t1 < dist);
}

// getRaycastFirstHitFn.js rayIntersectsBounds
fn tmbIntersectsBounds(ray: TmbRay, base: u32, result: ptr<function, TmbResult>, scalar: f32) -> bool {
  let dist = tmbRayBoundsDistance(ray, base) * scalar;
  if (dist < 0.0) { return false; }
  if (ray.maxDist > 0.0 && dist >= ray.maxDist) { return false; }
  if ((*result).didHit && dist >= (*result).dist) { return false; }
  return true;
}

// tsl/fns.js intersectRayTriangle (threshold 0)
fn tmbIntersectTriangle(ray: TmbRay, a: vec3f, b: vec3f, c: vec3f, out: ptr<function, TmbResult>) -> bool {
  let edge1 = b - a;
  let edge2 = c - a;
  let n = cross(edge1, edge2);
  let det = -dot(ray.direction, n);
  if (abs(det) < 1e-15) { return false; }
  let invdet = 1.0 / det;
  let AO = ray.origin - a;
  let DAO = cross(AO, ray.direction);
  let u = dot(edge2, DAO) * invdet;
  if (u < 0.0 || u > 1.0) { return false; }
  let v = -dot(edge1, DAO) * invdet;
  if (v < 0.0 || u + v > 1.0) { return false; }
  let t = dot(AO, n) * invdet;
  if (t < 0.0) { return false; }
  (*out).barycoord = vec3f(1.0 - u - v, u, v);
  (*out).dist = t;
  (*out).side = sign(det);
  (*out).normal = (*out).side * normalize(n);
  return true;
}

// getRaycastFirstHitFn.js intersectRange
fn tmbIntersectRange(ray: TmbRay, offset: u32, count: u32, result: ptr<function, TmbResult>, scalar: f32) -> bool {
  var didHit = false;
  for (var ti = offset; ti < offset + count; ti++) {
    let i0 = tmbIndex[ti * 3u];
    let i1 = tmbIndex[ti * 3u + 1u];
    let i2 = tmbIndex[ti * 3u + 2u];
    let a = tmbAttributes[i0 * TMB_ATTRIBUTE_VEC4S].xyz;
    let b = tmbAttributes[i1 * TMB_ATTRIBUTE_VEC4S].xyz;
    let c = tmbAttributes[i2 * TMB_ATTRIBUTE_VEC4S].xyz;
    var tri: TmbResult;
    if (!tmbIntersectTriangle(ray, a, b, c, &tri)) { continue; }
    let dist = tri.dist * scalar;
    if ((ray.maxDist <= 0.0 || dist < ray.maxDist) && (!(*result).didHit || dist < (*result).dist)) {
      (*result).didHit = true;
      (*result).dist = dist;
      (*result).normal = tri.normal;
      (*result).side = tri.side;
      (*result).barycoord = tri.barycoord;
      (*result).indices = vec4u(i0, i1, i2, ti);
      didHit = true;
    }
  }
  return didHit;
}

// getShapecastFn.js: TLAS and per-cluster BLAS in one stack and loop.
fn tmbRaycastFirstHit(shape: TmbRay, result: ptr<function, TmbResult>) -> bool {
  var didHit = false;
  var isTLAS = true;
  var pointer: i32 = 0;
  var stack: array<u32, ${LAYOUT.stackDepth}>;
  stack[0] = 0u;
  var blasDidHit = false;
  var objectIndex = 0u;
  var localShape = shape;
  var scalar = 1.0;
  var tlasReset: i32 = 0;
  loop {
    if (!isTLAS && tlasReset == pointer) {
      if (blasDidHit) {
        blasDidHit = false;
        didHit = true;
        // transformResult: normal back to world space
        let toLocal = tmbInverseMatrix(objectIndex);
        (*result).normal = normalize((transpose(toLocal) * vec4f((*result).normal, 0.0)).xyz);
        (*result).objectIndex = objectIndex;
      }
      scalar = 1.0;
      objectIndex = 0u;
      isTLAS = true;
      localShape = shape;
    }
    if (pointer < 0 || pointer >= TMB_STACK_DEPTH) { break; }
    let nodeIndex = stack[pointer];
    let base = nodeIndex * TMB_NODE_WORDS;
    pointer -= 1;
    let infoX = tmbNodes[base + 13u];
    let infoY = tmbNodes[base + 12u];
    if ((infoX & 0xffff0000u) != 0u) {
      if (isTLAS) {
        objectIndex = infoX & 0x00ffffffu;
        if (tmbExtra(objectIndex).x != 0u) {
          tlasReset = pointer;
          isTLAS = false;
          blasDidHit = false;
          // transformRay: into object space, unit direction, scalar = world units per local unit
          let toLocal = tmbInverseMatrix(objectIndex);
          localShape = shape;
          localShape.origin = (toLocal * vec4f(shape.origin, 1.0)).xyz;
          let d = (toLocal * vec4f(shape.direction, 0.0)).xyz;
          let len = length(d);
          localShape.direction = d / len;
          scalar = 1.0 / len;
          pointer += 1;
          stack[pointer] = infoY;
        }
      } else {
        blasDidHit = tmbIntersectRange(localShape, infoY, infoX & 0x0000ffffu, result, scalar) || blasDidHit;
      }
    } else {
      let leftIndex = nodeIndex + 1u;
      let splitAxis = infoX & 0x0000ffffu;
      let rightIndex = nodeIndex + infoY;
      let hitLeft = tmbIntersectsBounds(localShape, base, result, scalar);
      let hitRight = tmbIntersectsBounds(localShape, base + 6u, result, scalar);
      let axisDir = select(select(localShape.direction.z, localShape.direction.y, splitAxis == 1u), localShape.direction.x, splitAxis == 0u);
      let leftToRight = axisDir >= 0.0;
      let c1 = select(rightIndex, leftIndex, leftToRight);
      let c2 = select(leftIndex, rightIndex, leftToRight);
      let hit1 = select(hitRight, hitLeft, leftToRight);
      let hit2 = select(hitLeft, hitRight, leftToRight);
      if (hit2) { pointer += 1; stack[pointer] = c2; }
      if (hit1) { pointer += 1; stack[pointer] = c1; }
    }
  }
  return didHit;
}

// getRaycastAnyHitFn.js rayIntersectsBoundsAnyHit: no closest-so-far test.
fn tmbIntersectsBoundsAny(ray: TmbRay, base: u32, scalar: f32) -> bool {
  let dist = tmbRayBoundsDistance(ray, base) * scalar;
  return dist >= 0.0 && (ray.maxDist <= 0.0 || dist < ray.maxDist);
}

// getRaycastAnyHitFn.js intersectRangeAnyHit: the first triangle within maxDist stops the walk.
fn tmbIntersectRangeAny(ray: TmbRay, offset: u32, count: u32, scalar: f32) -> bool {
  for (var ti = offset; ti < offset + count; ti++) {
    let a = tmbAttributes[tmbIndex[ti * 3u] * TMB_ATTRIBUTE_VEC4S].xyz;
    let b = tmbAttributes[tmbIndex[ti * 3u + 1u] * TMB_ATTRIBUTE_VEC4S].xyz;
    let c = tmbAttributes[tmbIndex[ti * 3u + 2u] * TMB_ATTRIBUTE_VEC4S].xyz;
    var tri: TmbResult;
    if (tmbIntersectTriangle(ray, a, b, c, &tri) && (ray.maxDist <= 0.0 || tri.dist * scalar < ray.maxDist)) { return true; }
  }
  return false;
}

// getShapecastFn.js with getRaycastAnyHitFn.js's callbacks (bvh_RaycastAnyHit): the same TLAS +
// BLAS loop and near-first order, returning at the first triangle found (STOP_TRAVERSAL).
fn tmbRaycastAnyHit(shape: TmbRay) -> bool {
  var isTLAS = true;
  var pointer: i32 = 0;
  var stack: array<u32, ${LAYOUT.stackDepth}>;
  stack[0] = 0u;
  var localShape = shape;
  var scalar = 1.0;
  var tlasReset: i32 = 0;
  loop {
    if (!isTLAS && tlasReset == pointer) {
      scalar = 1.0;
      isTLAS = true;
      localShape = shape;
    }
    if (pointer < 0 || pointer >= TMB_STACK_DEPTH) { break; }
    let nodeIndex = stack[pointer];
    let base = nodeIndex * TMB_NODE_WORDS;
    pointer -= 1;
    let infoX = tmbNodes[base + 13u];
    let infoY = tmbNodes[base + 12u];
    if ((infoX & 0xffff0000u) != 0u) {
      if (isTLAS) {
        let objectIndex = infoX & 0x00ffffffu;
        if (tmbExtra(objectIndex).x != 0u) {
          tlasReset = pointer;
          isTLAS = false;
          let toLocal = tmbInverseMatrix(objectIndex);
          localShape = shape;
          localShape.origin = (toLocal * vec4f(shape.origin, 1.0)).xyz;
          let d = (toLocal * vec4f(shape.direction, 0.0)).xyz;
          let len = length(d);
          localShape.direction = d / len;
          scalar = 1.0 / len;
          pointer += 1;
          stack[pointer] = infoY;
        }
      } else if (tmbIntersectRangeAny(localShape, infoY, infoX & 0x0000ffffu, scalar)) {
        return true;
      }
    } else {
      let leftIndex = nodeIndex + 1u;
      let splitAxis = infoX & 0x0000ffffu;
      let rightIndex = nodeIndex + infoY;
      let hitLeft = tmbIntersectsBoundsAny(localShape, base, scalar);
      let hitRight = tmbIntersectsBoundsAny(localShape, base + 6u, scalar);
      let axisDir = select(select(localShape.direction.z, localShape.direction.y, splitAxis == 1u), localShape.direction.x, splitAxis == 0u);
      let leftToRight = axisDir >= 0.0;
      let c1 = select(rightIndex, leftIndex, leftToRight);
      let c2 = select(leftIndex, rightIndex, leftToRight);
      let hit1 = select(hitRight, hitLeft, leftToRight);
      let hit2 = select(hitLeft, hitRight, leftToRight);
      if (hit2) { pointer += 1; stack[pointer] = c2; }
      if (hit1) { pointer += 1; stack[pointer] = c1; }
    }
  }
  return false;
}

fn traceAny(origin: vec3f, dir: vec3f, tMax: f32) -> bool {
  return tmbRaycastAnyHit(TmbRay(origin, dir, tMax));
}

fn traceFirstHit(origin: vec3f, dir: vec3f, tMax: f32) -> Hit {
  var r: TmbResult;
  r.didHit = false;
  if (!tmbRaycastFirstHit(TmbRay(origin, dir, tMax), &r)) { return noHit(); }
  // barycoord = weights of corners (a, b, c); Hit carries those of corners 1 and 2
  return Hit(r.dist, r.indices.w, r.barycoord.yz, r.objectIndex, r.objectIndex, r.normal, r.side > 0.0);
}

fn tmbRgb9e5(p: u32) -> vec3f {
  let scale = exp2(f32(p >> 27u) - 24.0); // exponent bias 15, 9 mantissa bits
  return vec3f(f32(p & 511u), f32((p >> 9u) & 511u), f32((p >> 18u) & 511u)) * scale;
}
fn traceHitMaterial(hit: Hit) -> HitMaterial {
  if (hit.material == 0xffffffffu) { return HitMaterial(vec3f(0.5), vec3f(0.0)); }
  let w = tmbExtra(hit.material);
  return HitMaterial(unpack4x8unorm(w.y).rgb, tmbRgb9e5(w.z));
}
fn traceHitSpecular(hit: Hit) -> HitSpecular {
  if (hit.material == 0xffffffffu) { return HitSpecular(vec3f(0.0), 1.0, 0.0, 0.0); }
  let w = tmbExtra(hit.material);
  let f = vec3f(f32(w.w & 31u) / 31.0, f32((w.w >> 5u) & 63u) / 63.0, f32((w.w >> 11u) & 31u) / 31.0);
  let cc = unpack4x8unorm(w.w);
  return HitSpecular(f * f, unpack4x8unorm(w.y).w, cc.z, cc.w);
}
`;

/** Shared-exponent rgb9e5 (as WebGPU's rgb9e5ufloat): HDR emissive in one word. */
function rgb9e5(c: readonly [number, number, number]): number {
  const MAX = (511 / 512) * 2 ** 16;
  const [r, g, b] = c.map((v) => Math.min(MAX, Math.max(0, v || 0)));
  const m = Math.max(r, g, b);
  if (m <= 0) return 0;
  let e = Math.max(-16, Math.floor(Math.log2(m))) + 1 + 15;
  let d = 2 ** (e - 24);
  if (Math.floor(m / d + 0.5) >= 512) { e += 1; d *= 2; }
  const q = (v: number) => Math.min(511, Math.floor(v / d + 0.5));
  return (q(r) | (q(g) << 9) | (q(b) << 18) | (e << 27)) >>> 0;
}
/** Specular F0 as rgb565 of its square root (dielectric 0.04 decodes to 0.037-0.043, not 0.032-0.048). */
function sqrt565(c: readonly [number, number, number]): number {
  const q = (v: number, n: number) => Math.round(Math.sqrt(Math.min(1, Math.max(0, v))) * n);
  return q(c[0], 31) | (q(c[1], 63) << 5) | (q(c[2], 31) << 11);
}

const unorm8 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);

/**
 * A three-mesh-bvh `BVHComputeData` behind core's trace seam. Build it with
 * {@link MeshBVHTraceProvider.fromObjects} (imports three-mesh-bvh on demand), or hand it a
 * `BVHComputeData` you already have (after `update()`).
 *
 *   const rt = await MeshBVHTraceProvider.fromObjects(device, meshes);
 *   // objects moved:  rt.refit()   (BVHComputeData.updateTransforms + re-upload)
 *   // topology changed: rt.rebuild()
 */
export class MeshBVHTraceProvider implements TraceProvider {
  readonly name = 'three-mesh-bvh';
  readonly storageBufferCount = 4;
  readonly capabilities = { hitNormal: true, hitMaterial: true, hitSpecular: true, anyHit: true } as const;
  readonly entries: readonly ModuleBindingEntry[] = [0, 1, 2, 3].map(() => ({ visibility: 0x4, buffer: { type: 'read-only-storage' as const } }));
  readonly data: MeshBVHComputeDataLike;
  private buffers: GPUBuffer[] = [];
  private attributeVec4s = 1;
  private _version = 0;
  /** Triangles in the packed index buffer. */
  triangles = 0;

  constructor(readonly device: GPUDevice, data: MeshBVHComputeDataLike, private readonly options: MeshBVHTraceProviderOptions = {}) {
    this.data = data;
    this.upload();
  }

  /** Build a BVH over `objects` (meshes or groups; only meshes are traced) and wrap it. */
  static async fromObjects(device: GPUDevice, objects: THREE.Object3D | THREE.Object3D[], options: MeshBVHTraceProviderOptions = {}) {
    const { BVHComputeData } = await import('three-mesh-bvh/webgpu');
    const data = new BVHComputeData(objects as never, { attributes: { position: 'vec4f' } }) as unknown as MeshBVHComputeDataLike;
    data.update();
    return new MeshBVHTraceProvider(device, data, options);
  }

  get version() { return this._version; }

  code(slot: BindingSlot) { return providerWgsl(slot, this.attributeVec4s); }

  resources(): readonly GPUBindingResource[] { return this.buffers.map((buffer) => ({ buffer })); }

  /** Objects moved (same meshes): refit the TLAS, rewrite transforms and materials, re-upload. */
  refit() {
    this.data.updateTransforms();
    this.writeMaterials();
    const [nodes, transforms] = this.arrays();
    this.device.queue.writeBuffer(this.buffers[0], 0, nodes);
    this.device.queue.writeBuffer(this.buffers[1], 0, transforms);
  }

  /** Meshes added / removed / geometry changed: rebuild everything (new buffers, `version` bumps). */
  rebuild() {
    this.data.update();
    this.upload();
  }

  /** Re-pack the materials only (a material colour changed). */
  updateMaterials() {
    this.writeMaterials();
    this.device.queue.writeBuffer(this.buffers[1], 0, this.arrays()[1]);
  }

  private arrays(): Uint32Array<ArrayBuffer>[] {
    const s = this.data.storage;
    return ['nodes', 'transforms', 'index', 'attributes'].map((k) => {
      const a = s[k]?.proxyNode?.value?.array;
      if (!a) throw new Error(`MeshBVHTraceProvider: BVHComputeData has no '${k}' buffer (call update() first)`);
      return new Uint32Array(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength / 4);
    });
  }

  private writeMaterials() {
    const transforms = this.arrays()[1];
    const material = this.options.material ?? defaultHitMaterial;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map: Map<string, { object: THREE.Object3D; slot: number }> = (this.data as any)._getTransformMap(this.data.bvh);
    for (const { object, slot } of map.values()) {
      const m = (object as THREE.Mesh).isMesh ? material(object as THREE.Mesh) : { albedo: [0.5, 0.5, 0.5], emissive: [0, 0, 0] } as HitMaterial;
      const o = slot * LAYOUT.transformWords + 33;
      transforms[o] = (unorm8(m.albedo[0]) | (unorm8(m.albedo[1]) << 8) | (unorm8(m.albedo[2]) << 16) | (unorm8(m.roughness ?? 1) << 24)) >>> 0;
      transforms[o + 1] = rgb9e5(m.emissive);
      transforms[o + 2] = (sqrt565(m.specular ?? [0, 0, 0]) | (unorm8(m.clearcoat ?? 0) << 16) | (unorm8(m.clearcoatRoughness ?? 0) << 24)) >>> 0;
    }
  }

  private upload() {
    const transformLen = this.data.structs.transform?.proxyNode?.getLength?.();
    if (transformLen !== LAYOUT.transformWords) throw new Error(`MeshBVHTraceProvider: three-mesh-bvh transform struct is ${transformLen} words, this port reads ${LAYOUT.transformWords}`);
    const attrLen = this.data.structs.attributes?.proxyNode?.getLength?.();
    if (!attrLen || attrLen % 4) throw new Error(`MeshBVHTraceProvider: attribute struct of ${attrLen} words; needs a vec4f-aligned struct with position first`);
    this.attributeVec4s = attrLen / 4;
    this.writeMaterials();
    for (const b of this.buffers) b.destroy();
    const labels = ['nodes', 'transforms', 'index', 'attributes'];
    const arrays = this.arrays();
    if (arrays[0].length % LAYOUT.nodeWords) throw new Error('MeshBVHTraceProvider: node buffer is not a whole number of 64-byte nodes');
    this.buffers = arrays.map((a, i) => {
      const b = this.device.createBuffer({ label: `three-mesh-bvh ${labels[i]}`, size: Math.max(16, a.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(b, 0, a);
      return b;
    });
    this.triangles = Math.floor(arrays[2].length / 3);
    this._version++;
  }

  destroy() {
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
  }
}
