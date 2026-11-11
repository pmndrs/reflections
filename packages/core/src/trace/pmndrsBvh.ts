// The core trace provider (docs/SPEC.md "Trace seam"): @pmndrs/bvh's WGSL walk (`giTraceClosest`
// over its two-level GPU layout) behind core's `TraceProvider`, built from engine-free geometry.
//
// @pmndrs/bvh is an optional peer: it is imported on demand by `createPmndrsBvhTraceProvider`, so
// pixel paths that never trace never load it. Its types are not imported either: `PmndrsBvhModule`
// below names the part of its API this file uses, so core type-checks without it.
//
// Bindings (group = the pass's provider slot), all read-only storage:
//   0 nodes      every mesh tree's 64-byte nodes                    (@pmndrs/bvh)
//   1 triangles  every mesh's 48-byte triangles in tree order       (@pmndrs/bvh)
//   2 top level  header, instance records, top-level nodes          (@pmndrs/bvh)
//   3 shading    ours, array<vec4f>: a header row, the materials (albedo + clear coat, emissive + clear coat
//                roughness, F0 + roughness (W41); indexed by
//                GiHit.material), per instance its normal matrix + mesh, per mesh where its vertex
//                normals and triangle corners are, then those corners and normals (D1700)
//
// What the walk gives back: `GiHit.t / triangle / barycentrics / frontFace` map one to one onto
// core's `Hit`; `GiHit.instance` is the input instance's position; `GiHit.normal` is the world
// geometric normal of the authored front side; `GiHit.material` is the instance's material.
// `traceAny` (shadow rays, D903) is its `giTraceAny`. `traceHitShadingNormal` (D1700) interpolates
// the caller's vertex normals (`BvhMeshGeometry.normals`) at `GiHit.triangle` (the input triangle,
// not the tree-order slot) with `GiHit.barycentrics`, through the instance's normal matrix.
import type { BindingSlot, ModuleBindingEntry, TraceProvider } from './provider';

/** The @pmndrs/bvh GPU layout version this wrapper was written against (`GPU_LAYOUT_VERSION`). */
export const PMNDRS_BVH_LAYOUT_VERSION = 1;

/** One mesh's geometry in object space (what @pmndrs/bvh's builders take). */
export interface BvhMeshGeometry {
  /** `x, y, z` per vertex, tightly packed. */
  readonly positions: Float32Array;
  /** Three vertex indices per triangle; omit for a plain triangle list. */
  readonly indices?: Uint16Array | Uint32Array | null;
  /**
   * Object-space vertex normals, `x, y, z` per vertex (same count as `positions`): traced hits are
   * shaded with them interpolated (D1700). Omit for flat shading with the geometric normal.
   */
  readonly normals?: Float32Array | null;
}

/** One placed copy of a mesh. */
export interface BvhTraceInstance {
  /** Position in `meshes`. */
  readonly mesh: number;
  /** Object-to-world, column-major 4x4 (any engine's matrix layout). Mirrors and non-uniform scales are fine. */
  readonly matrixWorld: ArrayLike<number>;
  /** Index into `materials`; omit for the default grey. */
  readonly material?: number;
}

/**
 * Linear diffuse albedo and emitted radiance of a traced hit (WGSL `HitMaterial`), and its specular
 * lobe (WGSL `HitSpecular`, W41): F0 (linear), perceptual roughness, clear coat factor and roughness.
 * Without `specular` the hit has no specular lobe (diffuse only, as before W41).
 */
export interface BvhTraceMaterial {
  readonly albedo: readonly [number, number, number];
  readonly emissive?: readonly [number, number, number];
  readonly specular?: readonly [number, number, number];
  readonly roughness?: number;
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
}

export interface BvhTraceScene {
  readonly meshes: readonly BvhMeshGeometry[];
  readonly instances: readonly BvhTraceInstance[];
  readonly materials?: readonly BvhTraceMaterial[];
}

/** Which @pmndrs/bvh builder makes the mesh trees. */
export type BvhBuilderPreference = 'auto' | 'tinybvh' | 'gpu-hploc' | 'gpu-lbvh';

export interface PmndrsBvhTraceProviderOptions {
  /**
   * 'auto' (default): H-PLOC on the GPU when the device has `subgroups`, tinybvh (WebAssembly, on
   * this thread) otherwise; that is @pmndrs/bvh's own choice (`createMeshLayoutBuilder`).
   */
  builder?: BvhBuilderPreference;
  /**
   * The @pmndrs/bvh module, if the caller already has it (tests, a bundler that can't follow the
   * dynamic import). Default: `import('@pmndrs/bvh')`.
   */
  module?: unknown;
}

// ---- the part of @pmndrs/bvh this file uses ---------------------------------------------------

interface BvhMeshLayout {
  readonly nodes: ArrayBuffer;
  readonly triangles: ArrayBuffer;
  readonly parents: Uint32Array;
  readonly nodeCount: number;
  readonly triangleCount: number;
  readonly maxDepth: number;
  readonly leafCount: number;
  readonly bounds: Float32Array;
}
interface BvhTopLevel { readonly buffer: ArrayBuffer; readonly instanceCount: number; readonly skippedSingular: number }
interface BvhSceneData {
  readonly nodes: ArrayBuffer;
  readonly triangles: ArrayBuffer;
  readonly topLevel: BvhTopLevel;
  readonly meshes: readonly { readonly nodeOffset: number; readonly triangleOffset: number }[];
}
interface PmndrsBvhModule {
  readonly GPU_LAYOUT_VERSION: number;
  /** Word positions in a batch hit record; `normal` and `material` exist from the reflections-integration branch on. */
  readonly HIT_RECORD_WORD: Readonly<Record<string, number>>;
  readonly TRACE_MODULE_ENTRIES: readonly ModuleBindingEntry[];
  traceModuleWgsl(slot: BindingSlot): string;
  createMeshLayoutBuilder(device: GPUDevice | null, options?: { prefer?: 'gpu-hploc' | 'gpu-lbvh' | 'tinybvh'; label?: string }): Promise<{
    readonly kind: string;
    readonly fallbackReason: string | null;
    buildLayouts(geometries: readonly BvhMeshGeometry[]): Promise<{ layout: BvhMeshLayout; builtBy: string; fallbackReason: string | null }[]>;
  }>;
  assembleTraceScene(meshes: readonly BvhMeshLayout[], instances: readonly {
    meshIndex: number; instanceIndex: number; objectToWorld: ArrayLike<number>; material?: number;
  }[]): BvhSceneData;
  buildTopLevel(instances: readonly {
    instanceIndex: number; nodeOffset: number; triangleOffset: number; meshBounds: ArrayLike<number>; objectToWorld: ArrayLike<number>; material?: number;
  }[]): BvhTopLevel;
}

/** Load @pmndrs/bvh and check that its GPU layout and walk are the ones this wrapper reads. */
export async function loadPmndrsBvh(module?: unknown): Promise<PmndrsBvhModule> {
  const bvh = (module ?? (await import('@pmndrs/bvh'))) as PmndrsBvhModule;
  if (bvh.GPU_LAYOUT_VERSION !== PMNDRS_BVH_LAYOUT_VERSION) {
    throw new Error(`PmndrsBvhTraceProvider: @pmndrs/bvh writes GPU layout ${bvh.GPU_LAYOUT_VERSION}; this provider reads ${PMNDRS_BVH_LAYOUT_VERSION}`);
  }
  if (bvh.HIT_RECORD_WORD?.normal === undefined || bvh.HIT_RECORD_WORD?.material === undefined) {
    throw new Error('PmndrsBvhTraceProvider: this @pmndrs/bvh has no GiHit.normal / GiHit.material (needs its reflections-integration branch, 2026-11-10)');
  }
  return bvh;
}

const MATERIAL_VEC4S = 3; // albedo + clear coat, emissive + clear coat roughness, F0 + roughness (W41, D3510)
const INSTANCE_VEC4S = 3;
const NO_MATERIAL = 0xffffffff;

const providerWgsl = (bvh: PmndrsBvhModule, slot: BindingSlot, shadingNormal: boolean) => /* wgsl */ `
${bvh.traceModuleWgsl(slot)}
@group(${slot.group}) @binding(${slot.firstBinding + bvh.TRACE_MODULE_ENTRIES.length}) var<storage, read> pbvhShading: array<vec4f>;
// row 0: material count, first instance row, first mesh row, instance count
fn pbvhHeader() -> vec4u { return bitcast<vec4u>(pbvhShading[0]); }

fn traceFirstHit(origin: vec3f, dir: vec3f, tMax: f32) -> Hit {
  let h = giTraceClosest(GiRay(origin, 0.0, dir, tMax));
  if (h.t < 0.0) { return noHit(); }
  return Hit(h.t, h.triangle, h.barycentrics, h.material, h.instance, h.normal, h.frontFace);
}

// any-hit: @pmndrs/bvh's own occlusion walk (stops at the first triangle, far child first)
fn traceAny(origin: vec3f, dir: vec3f, tMax: f32) -> bool {
  return giTraceAny(GiRay(origin, 0.0, dir, tMax));
}

fn traceHitMaterial(hit: Hit) -> HitMaterial {
  if (hit.material >= pbvhHeader().x) { return HitMaterial(vec3f(0.5), vec3f(0.0)); }
  let row = 1u + hit.material * ${MATERIAL_VEC4S}u;
  return HitMaterial(pbvhShading[row].rgb, pbvhShading[row + 1u].rgb);
}

fn traceHitSpecular(hit: Hit) -> HitSpecular {
  if (hit.material >= pbvhHeader().x) { return HitSpecular(vec3f(0.0), 1.0, 0.0, 0.0); }
  let row = 1u + hit.material * ${MATERIAL_VEC4S}u;
  let spec = pbvhShading[row + 2u];
  return HitSpecular(spec.rgb, spec.w, pbvhShading[row].w, pbvhShading[row + 1u].w);
}

${shadingNormal ? `// D1700: the mesh's vertex normals at the triangle's corners, weighted by the barycentrics, through
// the instance's normal matrix; 0 for a mesh without normals.
fn traceHitShadingNormal(hit: Hit) -> vec3f {
  let h = pbvhHeader();
  if (hit.instance >= h.w) { return vec3f(0.0); }
  let ib = h.y + hit.instance * ${INSTANCE_VEC4S}u;
  let c0 = pbvhShading[ib];
  // x: first corner row (indexed meshes), y: first normal row, z: 1 normals + 2 indexed
  let mesh = bitcast<vec4u>(pbvhShading[h.z + bitcast<u32>(c0.w)]);
  if ((mesh.z & 1u) == 0u) { return vec3f(0.0); }
  var i = vec3u(hit.triangle * 3u) + vec3u(0u, 1u, 2u);
  if ((mesh.z & 2u) != 0u) { i = bitcast<vec4u>(pbvhShading[mesh.x + hit.triangle]).xyz; }
  let w = vec3f(1.0 - hit.barycentrics.x - hit.barycentrics.y, hit.barycentrics);
  let n = pbvhShading[mesh.y + i.x].xyz * w.x + pbvhShading[mesh.y + i.y].xyz * w.y + pbvhShading[mesh.y + i.z].xyz * w.z;
  return mat3x3f(c0.xyz, pbvhShading[ib + 1u].xyz, pbvhShading[ib + 2u].xyz) * n;
}
` : ''}
`;

/** Build stats, for labels and benches. */
export interface PmndrsBvhBuildInfo {
  /** Which builder made the mesh trees ('gpu-hploc', 'gpu-lbvh' or 'tinybvh'). */
  builder: string;
  /** Why the GPU builder is not in use (e.g. no `subgroups`), or null. */
  fallbackReason: string | null;
  meshes: number;
  instances: number;
  triangles: number;
  /** Instances left out because their matrix is singular. */
  skippedSingular: number;
  /** Wall time of the mesh trees + scene assembly + upload. */
  buildMs: number;
}

/**
 * @pmndrs/bvh behind core's trace seam. Create it with {@link createPmndrsBvhTraceProvider}.
 *
 *   const rt = await createPmndrsBvhTraceProvider(device, { meshes, instances, materials });
 *   // instances moved:   rt.setTransforms(matrices)   (new top level on the CPU; mesh trees untouched)
 *   // materials changed: rt.setMaterials(materials)
 */
export class PmndrsBvhTraceProvider implements TraceProvider {
  readonly name = '@pmndrs/bvh';
  readonly capabilities: { readonly hitNormal: true; readonly hitMaterial: true; readonly hitSpecular: true; readonly anyHit: true; readonly shadingNormal: boolean };
  readonly layoutVersion: number;
  readonly entries: readonly ModuleBindingEntry[];
  readonly storageBufferCount: number;
  private buffers: GPUBuffer[];
  private _version = 1;
  private shading: ShadingPack;

  /** @internal use {@link createPmndrsBvhTraceProvider} */
  constructor(
    readonly device: GPUDevice,
    private readonly bvh: PmndrsBvhModule,
    private readonly layouts: readonly BvhMeshLayout[],
    private readonly scene: BvhSceneData,
    private instances: readonly BvhTraceInstance[],
    materials: readonly BvhTraceMaterial[],
    readonly info: PmndrsBvhBuildInfo,
    private readonly meshes: readonly BvhMeshGeometry[],
  ) {
    this.layoutVersion = bvh.GPU_LAYOUT_VERSION;
    this.shading = packShading(materials, instances, meshes);
    this.capabilities = { hitNormal: true, hitMaterial: true, hitSpecular: true, anyHit: true, shadingNormal: this.shading.hasNormals };
    this.entries = [...bvh.TRACE_MODULE_ENTRIES, { visibility: 0x4, buffer: { type: 'read-only-storage' } }];
    this.storageBufferCount = this.entries.length;
    const upload = (label: string, data: ArrayBuffer | Float32Array) => {
      const buffer = device.createBuffer({ label: `@pmndrs/bvh ${label}`, size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, data as ArrayBuffer);
      return buffer;
    };
    this.buffers = [
      upload('nodes', scene.nodes),
      upload('triangles', scene.triangles),
      upload('top level', scene.topLevel.buffer),
      upload('shading', this.shading.data),
    ];
  }

  get version() { return this._version; }

  code(slot: BindingSlot) { return providerWgsl(this.bvh, slot, this.capabilities.shadingNormal); }

  resources(): readonly GPUBindingResource[] { return this.buffers.map((buffer) => ({ buffer })); }

  /**
   * Instances moved: rebuild the top level on the CPU from new object-to-world matrices (one per
   * instance, in the order given at creation) and upload it. Mesh trees are untouched.
   */
  setTransforms(matrices: readonly ArrayLike<number>[]) {
    if (matrices.length !== this.instances.length) throw new RangeError(`setTransforms: ${matrices.length} matrices for ${this.instances.length} instances`);
    this.instances = this.instances.map((instance, i) => ({ ...instance, matrixWorld: matrices[i] }));
    const top = this.bvh.buildTopLevel(this.instances.map((instance, i) => ({
      instanceIndex: i,
      nodeOffset: this.scene.meshes[instance.mesh].nodeOffset,
      triangleOffset: this.scene.meshes[instance.mesh].triangleOffset,
      meshBounds: this.layouts[instance.mesh].bounds,
      objectToWorld: instance.matrixWorld,
      material: instance.material,
    })));
    this.replace(2, top.buffer, 'top level');
    // the instances' normal matrices only (the mesh normals and corners don't move)
    const { data, instanceRow } = this.shading;
    writeInstances(data, instanceRow, this.instances);
    this.device.queue.writeBuffer(this.buffers[3], instanceRow * 16, data.buffer, data.byteOffset + instanceRow * 16, this.instances.length * INSTANCE_VEC4S * 16);
  }

  /** Material colours changed (same indices). */
  setMaterials(materials: readonly BvhTraceMaterial[]) {
    this.shading = packShading(materials, this.instances, this.meshes);
    this.replace(3, this.shading.data, 'shading');
  }

  private replace(index: number, data: ArrayBuffer | Float32Array, label: string) {
    const old = this.buffers[index];
    if (old.size >= data.byteLength) {
      this.device.queue.writeBuffer(old, 0, data as ArrayBuffer);
      return;
    }
    old.destroy();
    this.buffers[index] = this.device.createBuffer({ label: `@pmndrs/bvh ${label}`, size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.buffers[index], 0, data as ArrayBuffer);
    this._version++;
  }

  destroy() {
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
  }
}

interface ShadingPack { data: Float32Array<ArrayBuffer>; instanceRow: number; hasNormals: boolean }

/** Normal matrix (inverse transpose of the upper 3x3, columns) of each instance + its mesh index, at `row`. */
function writeInstances(out: Float32Array, row: number, instances: readonly BvhTraceInstance[]) {
  const u = new Uint32Array(out.buffer, out.byteOffset, out.length);
  instances.forEach((instance, k) => {
    const e = instance.matrixWorld;
    const a0 = [e[0], e[1], e[2]], a1 = [e[4], e[5], e[6]], a2 = [e[8], e[9], e[10]];
    const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const c0 = cross(a1, a2), c1 = cross(a2, a0), c2 = cross(a0, a1);
    const det = a0[0] * c0[0] + a0[1] * c0[1] + a0[2] * c0[2];
    const k1 = det !== 0 && Number.isFinite(det) ? 1 / det : 0;
    const o = (row + k * INSTANCE_VEC4S) * 4;
    out.set([c0[0] * k1, c0[1] * k1, c0[2] * k1, 0, c1[0] * k1, c1[1] * k1, c1[2] * k1, 0, c2[0] * k1, c2[1] * k1, c2[2] * k1, 0], o);
    u[o + 3] = instance.mesh;
  });
}

/**
 * The shading buffer (binding 3): header, materials (at least one entry, an unused grey, so the
 * binding is never empty), instances, mesh records, then the corners and normals of meshes with
 * normals. One buffer so the provider stays at 4 storage buffers (D1700).
 */
function packShading(materials: readonly BvhTraceMaterial[], instances: readonly BvhTraceInstance[], meshes: readonly BvhMeshGeometry[]): ShadingPack {
  const materialRow = 1, instanceRow = materialRow + Math.max(1, materials.length) * MATERIAL_VEC4S;
  const meshRow = instanceRow + instances.length * INSTANCE_VEC4S;
  let rows = meshRow + meshes.length;
  const records = meshes.map((m) => {
    const vertices = m.positions.length / 3;
    if (!m.normals || m.normals.length < vertices * 3) return null;
    const corners = m.indices ? rows : 0;
    rows += m.indices ? Math.floor(m.indices.length / 3) : 0;
    const normals = rows;
    rows += vertices;
    return { corners, normals };
  });
  const data = new Float32Array(rows * 4);
  const u = new Uint32Array(data.buffer);
  u[0] = materials.length; u[1] = instanceRow; u[2] = meshRow; u[3] = instances.length;
  data.set([0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 1], materialRow * 4);
  materials.forEach((m, i) => {
    const o = (materialRow + i * MATERIAL_VEC4S) * 4;
    data.set([m.albedo[0], m.albedo[1], m.albedo[2], m.clearcoat ?? 0], o);
    data.set([m.emissive?.[0] ?? 0, m.emissive?.[1] ?? 0, m.emissive?.[2] ?? 0, m.clearcoatRoughness ?? 0], o + 4);
    data.set([m.specular?.[0] ?? 0, m.specular?.[1] ?? 0, m.specular?.[2] ?? 0, m.roughness ?? 1], o + 8);
  });
  writeInstances(data, instanceRow, instances);
  meshes.forEach((m, i) => {
    const r = records[i];
    if (!r) return;
    const o = (meshRow + i) * 4;
    u[o] = r.corners; u[o + 1] = r.normals; u[o + 2] = 1 | (m.indices ? 2 : 0);
    if (m.indices) for (let t = 0, n = Math.floor(m.indices.length / 3); t < n; t++) u.set([m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]], (r.corners + t) * 4);
    const nv = m.positions.length / 3;
    for (let v = 0; v < nv; v++) data.set([m.normals![v * 3], m.normals![v * 3 + 1], m.normals![v * 3 + 2]], (r.normals + v) * 4);
  });
  return { data, instanceRow, hasNormals: records.some((r) => r !== null) };
}

/**
 * Build @pmndrs/bvh trees over engine-free geometry and wrap them as a {@link TraceProvider}.
 * Loads @pmndrs/bvh on first use and checks its `GPU_LAYOUT_VERSION`. The mesh trees come from
 * H-PLOC on the GPU when the device has `subgroups`, from tinybvh otherwise (`options.builder`).
 * `Hit.instance` is the instance's position in `scene.instances`; `Hit.material` its `material`.
 */
export async function createPmndrsBvhTraceProvider(
  device: GPUDevice,
  scene: BvhTraceScene,
  options: PmndrsBvhTraceProviderOptions = {},
): Promise<PmndrsBvhTraceProvider> {
  const bvh = await loadPmndrsBvh(options.module);
  const t0 = performance.now();
  const prefer = options.builder && options.builder !== 'auto' ? options.builder : undefined;
  const builder = await bvh.createMeshLayoutBuilder(device, { prefer, label: 'reflections' });
  const built = await builder.buildLayouts(scene.meshes);
  const layouts = built.map((b) => b.layout);
  const materials = scene.materials ?? [];
  for (const instance of scene.instances) {
    if (!(instance.mesh >= 0 && instance.mesh < layouts.length)) throw new RangeError(`instance uses mesh ${instance.mesh}; there are ${layouts.length}`);
    if (instance.material !== undefined && instance.material !== NO_MATERIAL && !(instance.material < materials.length)) {
      throw new RangeError(`instance uses material ${instance.material}; there are ${materials.length}`);
    }
  }
  const data = bvh.assembleTraceScene(layouts, scene.instances.map((instance, i) => ({
    meshIndex: instance.mesh, instanceIndex: i, objectToWorld: instance.matrixWorld, material: instance.material,
  })));
  const triangles = scene.instances.reduce((n, instance) => n + layouts[instance.mesh].triangleCount, 0);
  const fallback = built.find((b) => b.fallbackReason)?.fallbackReason ?? null;
  const info: PmndrsBvhBuildInfo = {
    builder: builder.kind,
    fallbackReason: builder.fallbackReason ?? fallback,
    meshes: layouts.length,
    instances: scene.instances.length,
    triangles,
    skippedSingular: data.topLevel.skippedSingular,
    buildMs: 0,
  };
  const provider = new PmndrsBvhTraceProvider(device, bvh, layouts, data, scene.instances, materials, info, scene.meshes);
  info.buildMs = performance.now() - t0;
  return provider;
}
