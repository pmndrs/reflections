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
//   3 materials  two vec4f per material: albedo, emissive            (ours; indexed by GiHit.material)
//
// What the walk gives back: `GiHit.t / triangle / barycentrics / frontFace` map one to one onto
// core's `Hit`; `GiHit.instance` is the input instance's position; `GiHit.normal` is the world
// geometric normal of the authored front side; `GiHit.material` is the instance's material.
// `traceAny` (shadow rays, D903) is its `giTraceAny`.
import type { BindingSlot, ModuleBindingEntry, TraceProvider } from './provider';

/** The @pmndrs/bvh GPU layout version this wrapper was written against (`GPU_LAYOUT_VERSION`). */
export const PMNDRS_BVH_LAYOUT_VERSION = 1;

/** One mesh's geometry in object space (what @pmndrs/bvh's builders take). */
export interface BvhMeshGeometry {
  /** `x, y, z` per vertex, tightly packed. */
  readonly positions: Float32Array;
  /** Three vertex indices per triangle; omit for a plain triangle list. */
  readonly indices?: Uint16Array | Uint32Array | null;
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

/** Linear diffuse albedo and emitted radiance of a traced hit (WGSL `HitMaterial`). */
export interface BvhTraceMaterial {
  readonly albedo: readonly [number, number, number];
  readonly emissive?: readonly [number, number, number];
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

const MATERIAL_VEC4S = 2;
const NO_MATERIAL = 0xffffffff;

const providerWgsl = (bvh: PmndrsBvhModule, slot: BindingSlot) => /* wgsl */ `
${bvh.traceModuleWgsl(slot)}
@group(${slot.group}) @binding(${slot.firstBinding + bvh.TRACE_MODULE_ENTRIES.length}) var<storage, read> pbvhMaterials: array<vec4f>;

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
  let count = arrayLength(&pbvhMaterials) / ${MATERIAL_VEC4S}u;
  if (hit.material >= count) { return HitMaterial(vec3f(0.5), vec3f(0.0)); }
  return HitMaterial(pbvhMaterials[hit.material * ${MATERIAL_VEC4S}u].rgb, pbvhMaterials[hit.material * ${MATERIAL_VEC4S}u + 1u].rgb);
}
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
  readonly capabilities = { hitNormal: true, hitMaterial: true, anyHit: true } as const;
  readonly layoutVersion: number;
  readonly entries: readonly ModuleBindingEntry[];
  readonly storageBufferCount: number;
  private buffers: GPUBuffer[];
  private _version = 1;

  /** @internal use {@link createPmndrsBvhTraceProvider} */
  constructor(
    readonly device: GPUDevice,
    private readonly bvh: PmndrsBvhModule,
    private readonly layouts: readonly BvhMeshLayout[],
    private readonly scene: BvhSceneData,
    private instances: readonly BvhTraceInstance[],
    materials: readonly BvhTraceMaterial[],
    readonly info: PmndrsBvhBuildInfo,
  ) {
    this.layoutVersion = bvh.GPU_LAYOUT_VERSION;
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
      upload('materials', packMaterials(materials)),
    ];
  }

  get version() { return this._version; }

  code(slot: BindingSlot) { return providerWgsl(this.bvh, slot); }

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
  }

  /** Material colours changed (same indices). */
  setMaterials(materials: readonly BvhTraceMaterial[]) {
    this.replace(3, packMaterials(materials), 'materials');
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

function packMaterials(materials: readonly BvhTraceMaterial[]): Float32Array {
  // At least one entry so the binding is never empty; an unused grey.
  const out = new Float32Array(Math.max(1, materials.length) * MATERIAL_VEC4S * 4);
  out.set([0.5, 0.5, 0.5, 1]);
  materials.forEach((m, i) => {
    const o = i * MATERIAL_VEC4S * 4;
    out.set([m.albedo[0], m.albedo[1], m.albedo[2], 1], o);
    out.set([m.emissive?.[0] ?? 0, m.emissive?.[1] ?? 0, m.emissive?.[2] ?? 0, 0], o + 4);
  });
  return out;
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
  const provider = new PmndrsBvhTraceProvider(device, bvh, layouts, data, scene.instances, materials, info);
  info.buildMs = performance.now() - t0;
  return provider;
}
