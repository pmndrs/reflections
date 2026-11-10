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
//               the slot's material into the pad words (albedo rgba8, emissive as 3 halves), the
//               hook three-mesh-bvh's writeTransformData comment names for this.
//   index       u32 triangle corners (rebased into the packed attributes)
//   attributes  the interleaved per-vertex struct; we only read `position` (first vec4f).
//
// The layout is three-mesh-bvh's internals, not its public API: `LAYOUT` below pins what we read,
// and the constructor checks it, so a layout change fails loudly instead of tracing garbage.
//
// This is the stopgap until @pmndrs/bvh (core provider) passes its oracle on our scenes.
import * as THREE from 'three/webgpu';
import type { BindingSlot, ModuleBindingEntry, TraceProvider } from '@pmndrs/reflections-core';

/** Linear diffuse albedo and emitted radiance of a traced hit (WGSL `HitMaterial`). */
export interface HitMaterial {
  albedo: readonly [number, number, number];
  emissive: readonly [number, number, number];
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
   * diffuse albedo `color x mean(map) x (1 - metalness)` and `emissive x mean(emissiveMap) x
   * emissiveIntensity` (one colour per mesh: D902).
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
 * Default hit material of a three mesh (first material of a multi-material mesh): diffuse albedo
 * `color x mean(map) x (1 - metalness)` and `emissive x mean(emissiveMap) x emissiveIntensity`.
 */
export function defaultHitMaterial(mesh: THREE.Mesh): HitMaterial {
  const m = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial | undefined;
  const albedo: [number, number, number] = [0.5, 0.5, 0.5];
  const emissive: [number, number, number] = [0, 0, 0];
  if (m?.color) {
    const k = 1 - (m.metalness ?? 0);
    const t = m.map ? textureMeanColor(m.map) ?? [1, 1, 1] : [1, 1, 1];
    albedo[0] = m.color.r * t[0] * k; albedo[1] = m.color.g * t[1] * k; albedo[2] = m.color.b * t[2] * k;
  }
  if (m?.emissive) {
    const k = m.emissiveIntensity ?? 1;
    const t = m.emissiveMap ? textureMeanColor(m.emissiveMap) ?? [1, 1, 1] : [1, 1, 1];
    emissive[0] = m.emissive.r * t[0] * k; emissive[1] = m.emissive.g * t[1] * k; emissive[2] = m.emissive.b * t[2] * k;
  }
  return { albedo, emissive };
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

fn traceFirstHit(origin: vec3f, dir: vec3f, tMax: f32) -> Hit {
  var r: TmbResult;
  r.didHit = false;
  if (!tmbRaycastFirstHit(TmbRay(origin, dir, tMax), &r)) { return noHit(); }
  // barycoord = weights of corners (a, b, c); Hit carries those of corners 1 and 2
  return Hit(r.dist, r.indices.w, r.barycoord.yz, r.objectIndex, r.objectIndex, r.normal, r.side > 0.0);
}

fn traceHitMaterial(hit: Hit) -> HitMaterial {
  if (hit.material == 0xffffffffu) { return HitMaterial(vec3f(0.5), vec3f(0.0)); }
  let w = tmbExtra(hit.material);
  return HitMaterial(unpack4x8unorm(w.y).rgb, vec3f(unpack2x16float(w.z), unpack2x16float(w.w).x));
}
`;

const toHalf = THREE.DataUtils.toHalfFloat;
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
  readonly capabilities = { hitNormal: true, hitMaterial: true } as const;
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
      transforms[o] = unorm8(m.albedo[0]) | (unorm8(m.albedo[1]) << 8) | (unorm8(m.albedo[2]) << 16) | (255 << 24);
      transforms[o + 1] = toHalf(m.emissive[0]) | (toHalf(m.emissive[1]) << 16);
      transforms[o + 2] = toHalf(m.emissive[2]);
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
