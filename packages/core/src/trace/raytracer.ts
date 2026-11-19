// The core trace provider (docs/SPEC.md "Trace seam"; P1.5 of pmndrs/pathtracer): @pmndrs/raytracer's trace core
// behind core's `TraceProvider`. @pmndrs/raytracer owns the walk (@pmndrs/bvh's, L0 `rtVisible` / L1 `rtClosest`),
// the surface decode (`rtSurface`: interpolated shading normals), the material table (OpenPBR records, `rtMaterial`)
// and one-bounce shading (`rtShade`: emission + one next-event ray toward the scene's lights). This file only
// builds the trees and the scene copy from engine-free geometry and maps their WGSL onto the seam's names, so the
// shading buffer, the normal-matrix packing and the vertex-normal walk the old @pmndrs/bvh wrapper carried are gone
// (they live, tested, in @pmndrs/raytracer's scene copy).
//
// @pmndrs/raytracer and @pmndrs/bvh are optional peers, imported on demand (or passed in: `options.module`,
// `options.bvhModule`); their types are not imported, so core type-checks without them.
//
// Bindings (group = the pass's provider slot), all read-only storage:
//   0..2   bvh nodes, triangles, top level                 (@pmndrs/bvh, `rtWalkEntries`; 3 for record leaves)
//   3..4   scene copy table, data                          (@pmndrs/raytracer, `rtSceneEntries`)
// Five storage buffers, one more than the old wrapper (D5200): a probe fallback + probe hit shading pass needs
// `maxStorageBuffersPerShaderStage` >= 10 (`reflectionsRequiredLimits` asks for it).
//
// What the seam gets:
//   traceFirstHit            rtClosest; Hit.instance = the input instance's position, Hit.material = the triangle's
//                            material (`triangleMaterials`) else the instance's, as before
//   traceAny                 !rtVisible (bvh's any-hit walk)
//   traceHitShadingNormal    rtSurface(RT_SURF_SHADING_NORMAL) (the geometric normal where a mesh has no normals)
//   traceHitMaterial/Specular  from rtMaterial: albedo = base x baseWeight x (1 - metalness) x (1 - transmission),
//                            F0 = mix(F0(ior) x specularWeight x specularColor, base, metalness)
//   traceHitShade            (capability `hitShade`, new) rtShade FULL: emission + one light sample with its shadow ray,
//                            over the lights of the scene copy (emissive triangles, `lights.sun`, `lights.environment`)
import type { BindingSlot, ModuleBindingEntry, TraceProvider } from './provider';

/** The @pmndrs/bvh GPU layout version @pmndrs/raytracer's walk reads (its `BVH_LAYOUT_VERSION`). */
export const RAYTRACER_BVH_LAYOUT_VERSION = 2;

/** The largest material index @pmndrs/bvh's instance and triangle records hold (its `MAX_MATERIAL`, layout 2). */
export const BVH_MAX_MATERIAL = 65534;

/** A {@link BvhMeshGeometry.triangleMaterials} entry for "no material here": the hit takes its instance's (@pmndrs/bvh's `TRIANGLE_MATERIAL_NONE`). */
export const BVH_TRIANGLE_MATERIAL_NONE = 0xffff;

/** One mesh's geometry in object space (what @pmndrs/bvh's builders and @pmndrs/raytracer's scene copy take). */
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
  /**
   * One material per triangle (an index into the scene's `materials`, at most {@link BVH_MAX_MATERIAL}),
   * or {@link BVH_TRIANGLE_MATERIAL_NONE} where the instance's applies (W49, D1701). Omit for the
   * instance's material everywhere.
   */
  readonly triangleMaterials?: Uint16Array | Uint32Array | null;
}

/** One placed copy of a mesh. */
export interface BvhTraceInstance {
  /** Position in `meshes`. */
  readonly mesh: number;
  /** Object-to-world, column-major 4x4. Mirrors and non-uniform scales are fine. */
  readonly matrixWorld: ArrayLike<number>;
  /** Index into `materials` (at most {@link BVH_MAX_MATERIAL}); omit for the default grey. */
  readonly material?: number;
}

/**
 * A traced hit's material. The seam's own fields (`albedo`, `emissive`, `specular` = F0, perceptual
 * `roughness`, clear coat) are what the probe / environment hit shadings read (WGSL `HitMaterial`,
 * `HitSpecular`). @pmndrs/raytracer stores physical (metal-rough, OpenPBR) records: give `baseColor` +
 * `metalness` (+ `transmission`) when you have them (three's `defaultHitMaterial` does); otherwise they
 * are solved from `albedo` and `specular` by three's own formulas (`albedo = base (1 - m)`,
 * `F0 = 0.04 + (base - 0.04) m`). `openpbr` passes any further @pmndrs/raytracer material field
 * through unchanged (`RtMaterialInput`), last.
 */
export interface BvhTraceMaterial {
  readonly albedo: readonly [number, number, number];
  readonly emissive?: readonly [number, number, number];
  readonly specular?: readonly [number, number, number];
  readonly roughness?: number;
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
  /** Linear base colour before metalness / transmission (three: `color x mean(map)`). */
  readonly baseColor?: readonly [number, number, number];
  readonly metalness?: number;
  readonly transmission?: number;
  /** @pmndrs/raytracer `RtMaterialInput` fields, applied over the ones derived here. */
  readonly openpbr?: Readonly<Record<string, unknown>>;
}

/** A directional light for `rtShade`: `direction` is where the light TRAVELS (down for an overhead sun). */
export interface RaytracerSun {
  readonly direction: readonly [number, number, number];
  /** Irradiance on a surface facing the light (three: colour x intensity), linear. */
  readonly irradiance: readonly [number, number, number];
  /** Disc radius in radians; omit for a delta light. */
  readonly angularRadius?: number;
}

/** The environment for `rtShade` (sampled as a light and returned on a miss). */
export interface RaytracerEnvironment {
  /** Constant radiance; with `map`, defaults to the map's mean. */
  readonly radiance?: readonly [number, number, number];
  /** An equirect HDR map (rows top to bottom, `channels` floats per texel). */
  readonly map?: { readonly width: number; readonly height: number; readonly channels: number; readonly data: ArrayLike<number> };
  readonly scale?: number;
  readonly rotationY?: number;
}

export interface BvhTraceScene {
  readonly meshes: readonly BvhMeshGeometry[];
  readonly instances: readonly BvhTraceInstance[];
  readonly materials?: readonly BvhTraceMaterial[];
  /** The lights `traceHitShade` samples besides emissive triangles. Not read by the probe / environment hit shadings. */
  readonly lights?: { readonly sun?: RaytracerSun | null; readonly environment?: RaytracerEnvironment | null };
}

/** Which @pmndrs/bvh builder makes the mesh trees. */
export type BvhBuilderPreference = 'auto' | 'tinybvh' | 'gpu-hploc' | 'gpu-lbvh';

export interface RaytracerTraceProviderOptions {
  /** 'auto' (default): H-PLOC on the GPU when the device has `subgroups`, tinybvh otherwise (@pmndrs/bvh's `createMeshLayoutBuilder`). */
  builder?: BvhBuilderPreference;
  /** The @pmndrs/raytracer module, if the caller already has it. Default: `import('@pmndrs/raytracer')`. */
  module?: unknown;
  /** The @pmndrs/bvh module (the same one @pmndrs/raytracer links). Default: `import('@pmndrs/bvh')`. */
  bvhModule?: unknown;
  /** Compile the instance-mask test into the walk. Default false (W48: 1-6% of the trace pass, D3591). */
  rayMasks?: boolean;
  /**
   * `traceHitShade`'s `rtShade` options (`RtShadeOptions`: `envSampling`, `minAlpha`, `sunVisible`, ...). The indirect
   * hook stays @pmndrs/raytracer's default (black): the hit shading adds its own indirect term, if any.
   */
  shade?: Readonly<Record<string, unknown>>;
  /** Minify the provider's WGSL (line breaks kept). Default true: the module with `rtShade` is ~50 KB unminified. */
  minify?: boolean;
}

// ---- the parts of @pmndrs/bvh and @pmndrs/raytracer this file uses ------------------------------------------------

interface BvhMeshLayout { readonly bounds: Float32Array; readonly triangleCount: number }
interface BvhTopLevel { readonly buffer: ArrayBuffer; readonly instanceCount: number; readonly skippedSingular: number }
interface BvhSceneData {
  readonly topLevel: BvhTopLevel;
  readonly meshes: readonly { readonly nodeOffset: number; readonly triangleOffset: number }[];
}
interface TraceSceneBuffers {
  readonly nodes: GPUBuffer; readonly triangles: GPUBuffer; readonly topLevel: GPUBuffer; readonly positions?: GPUBuffer | null;
  readonly triangleLeaves: string; readonly positionLayout: string; readonly nodeFormat: string;
  destroy(): void;
}
interface BvhModule {
  readonly GPU_LAYOUT_VERSION: number;
  createMeshLayoutBuilder(device: GPUDevice | null, options?: { prefer?: 'gpu-hploc' | 'gpu-lbvh' | 'tinybvh'; label?: string }): Promise<{
    readonly kind: string;
    readonly fallbackReason: string | null;
    buildLayouts(geometries: readonly BvhMeshGeometry[]): Promise<{ layout: BvhMeshLayout; builtBy: string; fallbackReason: string | null }[]>;
  }>;
  assembleTraceScene(meshes: readonly BvhMeshLayout[], instances: readonly { meshIndex: number; instanceIndex: number; objectToWorld: ArrayLike<number>; material?: number }[]): BvhSceneData;
  uploadTraceScene(device: GPUDevice, scene: BvhSceneData, label?: string): TraceSceneBuffers;
  buildTopLevel(instances: readonly {
    instanceIndex: number; nodeOffset: number; triangleOffset: number; meshBounds: ArrayLike<number>; objectToWorld: ArrayLike<number>; material?: number;
  }[]): BvhTopLevel;
}
interface SceneCopy { readonly layout: unknown; readonly byteLength: number; readonly lights: readonly unknown[]; readonly triangleLightCount: number; readonly table: Uint32Array<ArrayBuffer>; readonly data: Uint32Array<ArrayBuffer> }
interface SceneCopyBuffers { readonly table: GPUBuffer; readonly data: GPUBuffer; destroy(): void }
interface RaytracerModule {
  readonly BVH_LAYOUT_VERSION: number;
  buildCaps(source: { features: ReadonlySet<string>; limits: Record<string, unknown> }, wgslLanguageFeatures?: ReadonlySet<string>): unknown;
  sceneFormatOf(buffers: object): Record<string, string>;
  rtModuleWgsl(caps: unknown, options: Record<string, unknown>): string;
  rtWalkEntries(format: object): readonly ModuleBindingEntry[];
  /** `packing` exists since pathtracer P3.11 (default 'packed' there: one buffer); we ask for 'split' (table, data), what this provider binds. Older versions ignore it. */
  rtSceneEntries(packing?: 'split' | 'packed'): readonly ModuleBindingEntry[];
  buildSceneCopy(input: Record<string, unknown>): SceneCopy;
  uploadSceneCopy(device: GPUDevice, copy: SceneCopy, options?: { label?: string; packing?: 'split' | 'packed' }): SceneCopyBuffers;
}

/** Load @pmndrs/raytracer and @pmndrs/bvh and check that they read the same GPU layout this wrapper was written for. */
export async function loadRaytracer(module?: unknown, bvhModule?: unknown): Promise<{ rt: RaytracerModule; bvh: BvhModule }> {
  const rt = (module ?? (await import('@pmndrs/raytracer'))) as RaytracerModule;
  const bvh = (bvhModule ?? (await import('@pmndrs/bvh'))) as BvhModule;
  if (rt.BVH_LAYOUT_VERSION !== RAYTRACER_BVH_LAYOUT_VERSION || bvh.GPU_LAYOUT_VERSION !== RAYTRACER_BVH_LAYOUT_VERSION) {
    throw new Error(`RaytracerTraceProvider: @pmndrs/raytracer reads bvh layout ${rt.BVH_LAYOUT_VERSION}, @pmndrs/bvh writes ${bvh.GPU_LAYOUT_VERSION}; this provider was written for ${RAYTRACER_BVH_LAYOUT_VERSION}`);
  }
  return { rt, bvh };
}

// ---- materials ----------------------------------------------------------------------------------------------------

const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * A seam material as an @pmndrs/raytracer material input (metal-rough, OpenPBR names). Without `baseColor` /
 * `metalness`, metalness is solved from three's `albedo = base (1 - m)` and `F0 = 0.04 + (base - 0.04) m` on
 * luminance (exact for a grey base, transmission taken as 0); no `specular` means no specular lobe
 * (`specularWeight` 0, a pure Lambertian, as the seam's default `HitSpecular`).
 */
export function raytracerMaterialOf(m: BvhTraceMaterial): Record<string, unknown> {
  let baseColor: readonly number[] = m.baseColor ?? m.albedo;
  let metalness = m.metalness ?? 0;
  if (m.baseColor === undefined && m.metalness === undefined && m.specular) {
    const a = lum(m.albedo), f = lum(m.specular);
    if (f > 0.04 + 1e-6) {
      // 0.04 m^2 + (a + f - 0.08) m - (f - 0.04) = 0, the root in [0, 1]
      const B = a + f - 0.08;
      metalness = Math.min(1, Math.max(0, (-B + Math.sqrt(B * B + 0.16 * (f - 0.04))) / 0.08));
      // base from whichever equation is better conditioned
      baseColor = metalness > 0.5
        ? m.specular.map((f0) => (f0 - 0.04 * (1 - metalness)) / metalness)
        : m.albedo.map((x) => x / (1 - metalness));
    }
  }
  const out: Record<string, unknown> = {
    baseColor: baseColor.map((x) => Math.max(0, x)) as [number, number, number],
    metalness,
    specularRoughness: m.roughness ?? 1,
    specularWeight: m.specular || m.metalness !== undefined ? 1 : 0,
    emissionColor: [...(m.emissive ?? [0, 0, 0])],
    coatWeight: m.clearcoat ?? 0,
    coatRoughness: m.clearcoatRoughness ?? 0,
  };
  if (m.transmission) out.transmissionWeight = m.transmission;
  return m.openpbr ? { ...out, ...m.openpbr } : out;
}

// ---- WGSL ---------------------------------------------------------------------------------------------------------

const seamWgsl = /* wgsl */ `
fn rtpRtHit(hit: Hit) -> RtHit { return RtHit(hit.t, hit.instance, hit.triangle, hit.frontFace, hit.barycentrics, hit.material, hit.normal, 0.0); }

fn traceFirstHit(origin: vec3f, dir: vec3f, tMax: f32) -> Hit {
  let h = rtClosest(RtRay(origin, 0.0, dir, tMax), RT_MASK_ALL);
  if (h.t < 0.0) { return noHit(); }
  return Hit(h.t, h.triangle, h.bary, h.material, h.instance, h.normal, h.frontFace);
}

fn traceAny(origin: vec3f, dir: vec3f, tMax: f32) -> bool { return !rtVisible(RtRay(origin, 0.0, dir, tMax), RT_MASK_ALL); }

fn traceHitShadingNormal(hit: Hit) -> vec3f {
  return rtSurface(rtpRtHit(hit), RtRay(vec3f(0.0), 0.0, vec3f(0.0, 0.0, 1.0), hit.t), RT_SURF_SHADING_NORMAL).shadingNormal;
}

fn traceHitMaterial(hit: Hit) -> HitMaterial {
  if (hit.material >= rtSceneInfo().materialCount) { return HitMaterial(vec3f(0.5), vec3f(0.0)); }
  let m = rtMaterial(hit.material);
  return HitMaterial(m.baseColor * (m.baseWeight * (1.0 - m.metalness) * (1.0 - m.transmissionWeight)), m.emissionColor);
}

fn traceHitSpecular(hit: Hit) -> HitSpecular {
  if (hit.material >= rtSceneInfo().materialCount) { return HitSpecular(vec3f(0.0), 1.0, 0.0, 0.0); }
  let m = rtMaterial(hit.material);
  let d = (m.ior - 1.0) / (m.ior + 1.0);
  let f0 = mix(m.specularColor * (m.specularWeight * d * d), m.baseColor * m.baseWeight, m.metalness);
  return HitSpecular(f0, m.specularRoughness, m.coatWeight, m.coatRoughness);
}

// emission + one light sample (u: light pick, point on the light) with its shadow ray, toward the ray origin
fn traceHitShade(hit: Hit, origin: vec3f, dir: vec3f, u: vec3f) -> vec3f {
  let s = rtShade(rtpRtHit(hit), RtRay(origin, 0.0, dir, hit.t), RT_SHADE_FULL, u, RT_MASK_ALL);
  return s.emission + s.direct;
}
`;

/** Build stats, for labels and benches. */
export interface RaytracerBuildInfo {
  /** Which builder made the mesh trees ('gpu-hploc', 'gpu-lbvh' or 'tinybvh'). */
  builder: string;
  /** Why the GPU builder is not in use (e.g. no `subgroups`), or null. */
  fallbackReason: string | null;
  meshes: number;
  instances: number;
  triangles: number;
  /** Instances left out because their matrix is singular. */
  skippedSingular: number;
  /** Lights in the scene copy (emissive triangles, sun, environment). */
  lights: number;
  /** Bytes of the scene copy. */
  sceneCopyBytes: number;
  /** Wall time of the mesh trees + scene assembly + scene copy + upload. */
  buildMs: number;
}

/**
 * @pmndrs/raytracer behind core's trace seam. Create it with {@link createRaytracerTraceProvider}.
 *
 *   const rt = await createRaytracerTraceProvider(device, { meshes, instances, materials, lights });
 *   // instances moved:   rt.setTransforms(matrices)   (new top level; scene copy rebuilt)
 *   // materials changed: rt.setMaterials(materials)
 */
export class RaytracerTraceProvider implements TraceProvider {
  readonly name = '@pmndrs/raytracer';
  readonly capabilities = { hitNormal: true, hitMaterial: true, hitSpecular: true, anyHit: true, shadingNormal: true, hitShade: true } as const;
  readonly layoutVersion = RAYTRACER_BVH_LAYOUT_VERSION;
  readonly entries: readonly ModuleBindingEntry[];
  readonly storageBufferCount: number;
  private _version = 1;
  private copy: SceneCopy;
  private copyBuffers: SceneCopyBuffers;
  private readonly format: Record<string, string>;
  private readonly caps: unknown;

  /** @internal use {@link createRaytracerTraceProvider} */
  constructor(
    readonly device: GPUDevice,
    private readonly rt: RaytracerModule,
    private readonly bvh: BvhModule,
    private readonly layouts: readonly BvhMeshLayout[],
    private readonly sceneData: BvhSceneData,
    /** bvh's GPU buffers (nodes, triangles, top level): the same ones @pmndrs/pathtracer's `PtMegakernel.setScene` takes. */
    readonly traceBuffers: TraceSceneBuffers,
    private scene: BvhTraceScene,
    readonly info: RaytracerBuildInfo,
    private readonly options: RaytracerTraceProviderOptions,
  ) {
    this.format = rt.sceneFormatOf(traceBuffers);
    // No optional features: the module goes into the pass's shader, which can't take `enable` lines mid-file, and the
    // inline walk needs none.
    this.caps = rt.buildCaps({ features: new Set(), limits: device.limits as unknown as Record<string, unknown> }, new Set());
    this.copy = this.buildCopy();
    this.copyBuffers = rt.uploadSceneCopy(device, this.copy, { label: 'reflections rt scene', packing: 'split' });
    this.entries = [...rt.rtWalkEntries(this.format), ...rt.rtSceneEntries('split')];
    this.storageBufferCount = this.entries.length;
    info.lights = this.copy.lights.length;
    info.sceneCopyBytes = this.copy.byteLength;
  }

  get version() { return this._version; }

  /** The scene copy and its GPU buffers (for @pmndrs/pathtracer's `PtMegakernel.setScene(traceBuffers, sceneCopyBuffers)`). */
  get sceneCopy() { return this.copy; }
  get sceneCopyBuffers() { return this.copyBuffers; }

  private buildCopy(): SceneCopy {
    const s = this.scene;
    return this.rt.buildSceneCopy({
      meshes: s.meshes,
      instances: s.instances.map((instance, i) => ({ instanceIndex: i, meshIndex: instance.mesh, objectToWorld: instance.matrixWorld, material: instance.material })),
      materials: (s.materials ?? []).map(raytracerMaterialOf),
      sun: s.lights?.sun ?? null,
      environment: s.lights?.environment ?? null,
    });
  }

  code(slot: BindingSlot) {
    const walk = this.rt.rtWalkEntries(this.format).length;
    const module = this.rt.rtModuleWgsl(this.caps, {
      ...this.format,
      traceSlot: slot,
      rayMasks: this.options.rayMasks ?? false,
      scene: { slot: { group: slot.group, firstBinding: slot.firstBinding + walk }, layout: this.copy.layout, packing: 'split' },
      shade: this.options.shade ?? {},
      minify: this.options.minify ?? true,
    });
    return module + seamWgsl;
  }

  resources(): readonly GPUBindingResource[] {
    const t = this.traceBuffers;
    return [t.nodes, t.triangles, t.topLevel, ...(t.positions ? [t.positions] : []), this.copyBuffers.table, this.copyBuffers.data].map((buffer) => ({ buffer }));
  }

  /**
   * Instances moved: rebuild the top level on the CPU from new object-to-world matrices (one per instance, in the
   * order given at creation) and the scene copy (instance transforms, light areas). Mesh trees are untouched.
   * The scene copy is rebuilt whole (@pmndrs/raytracer has no incremental update yet, its P1.4b).
   */
  setTransforms(matrices: readonly ArrayLike<number>[]) {
    if (matrices.length !== this.scene.instances.length) throw new RangeError(`setTransforms: ${matrices.length} matrices for ${this.scene.instances.length} instances`);
    const instances = this.scene.instances.map((instance, i) => ({ ...instance, matrixWorld: Array.from(matrices[i]) }));
    this.scene = { ...this.scene, instances };
    const top = this.bvh.buildTopLevel(instances.map((instance, i) => ({
      instanceIndex: i,
      nodeOffset: this.sceneData.meshes[instance.mesh].nodeOffset,
      triangleOffset: this.sceneData.meshes[instance.mesh].triangleOffset,
      meshBounds: this.layouts[instance.mesh].bounds,
      objectToWorld: instance.matrixWorld,
      material: instance.material,
    })));
    if (top.buffer.byteLength > this.traceBuffers.topLevel.size) throw new RangeError('setTransforms: the top level grew (an instance was singular at creation); build a new provider');
    this.device.queue.writeBuffer(this.traceBuffers.topLevel, 0, top.buffer);
    this.replaceCopy();
  }

  /** Material colours changed (same indices). */
  setMaterials(materials: readonly BvhTraceMaterial[]) {
    this.scene = { ...this.scene, materials };
    this.replaceCopy();
  }

  /** The sun or environment changed. */
  setLights(lights: BvhTraceScene['lights']) {
    this.scene = { ...this.scene, lights };
    this.replaceCopy();
  }

  private replaceCopy() {
    const copy = this.buildCopy();
    this.copy = copy;
    if (this.copyBuffers.table.size >= copy.table.byteLength && this.copyBuffers.data.size >= Math.max(16, copy.data.byteLength)) {
      this.device.queue.writeBuffer(this.copyBuffers.table, 0, copy.table);
      if (copy.data.byteLength) this.device.queue.writeBuffer(this.copyBuffers.data, 0, copy.data);
      return;
    }
    this.copyBuffers.destroy();
    this.copyBuffers = this.rt.uploadSceneCopy(this.device, copy, { label: 'reflections rt scene', packing: 'split' });
    this._version++;
  }

  destroy() {
    this.traceBuffers.destroy();
    this.copyBuffers.destroy();
  }
}

/**
 * Build @pmndrs/bvh trees and @pmndrs/raytracer's scene copy over engine-free geometry and wrap them as a
 * {@link TraceProvider}. The mesh trees come from H-PLOC on the GPU when the device has `subgroups`, from tinybvh
 * otherwise (`options.builder`). `Hit.instance` is the instance's position in `scene.instances`; `Hit.material` the
 * hit triangle's entry of its mesh's `triangleMaterials` when it has one, else the instance's `material`.
 */
export async function createRaytracerTraceProvider(
  device: GPUDevice,
  scene: BvhTraceScene,
  options: RaytracerTraceProviderOptions = {},
): Promise<RaytracerTraceProvider> {
  const { rt, bvh } = await loadRaytracer(options.module, options.bvhModule);
  const t0 = performance.now();
  const prefer = options.builder && options.builder !== 'auto' ? options.builder : undefined;
  const builder = await bvh.createMeshLayoutBuilder(device, { prefer, label: 'reflections' });
  const built = await builder.buildLayouts(scene.meshes);
  const layouts = built.map((b) => b.layout);
  const materials = scene.materials ?? [];
  if (materials.length > BVH_MAX_MATERIAL + 1) throw new RangeError(`@pmndrs/bvh holds material indices up to ${BVH_MAX_MATERIAL}; the scene has ${materials.length} materials`);
  for (const instance of scene.instances) {
    if (!(instance.mesh >= 0 && instance.mesh < layouts.length)) throw new RangeError(`instance uses mesh ${instance.mesh}; there are ${layouts.length}`);
    if (instance.material !== undefined && !(instance.material < materials.length)) throw new RangeError(`instance uses material ${instance.material}; there are ${materials.length}`);
  }
  scene.meshes.forEach((mesh, i) => {
    const tm = mesh.triangleMaterials;
    if (!tm) return;
    const triangles = mesh.indices ? Math.floor(mesh.indices.length / 3) : Math.floor(mesh.positions.length / 9);
    if (tm.length < triangles) throw new RangeError(`mesh ${i}: triangleMaterials has ${tm.length} entries for ${triangles} triangles`);
    for (let t = 0; t < triangles; t++) {
      if (tm[t] !== BVH_TRIANGLE_MATERIAL_NONE && !(tm[t] < materials.length)) throw new RangeError(`mesh ${i}: triangle ${t} uses material ${tm[t]}; there are ${materials.length}`);
    }
  });
  const data = bvh.assembleTraceScene(layouts, scene.instances.map((instance, i) => ({
    meshIndex: instance.mesh, instanceIndex: i, objectToWorld: instance.matrixWorld, material: instance.material,
  })));
  const buffers = bvh.uploadTraceScene(device, data, 'reflections rt');
  const info: RaytracerBuildInfo = {
    builder: builder.kind,
    fallbackReason: builder.fallbackReason ?? built.find((b) => b.fallbackReason)?.fallbackReason ?? null,
    meshes: layouts.length,
    instances: scene.instances.length,
    triangles: scene.instances.reduce((n, instance) => n + layouts[instance.mesh].triangleCount, 0),
    skippedSingular: data.topLevel.skippedSingular,
    lights: 0,
    sceneCopyBytes: 0,
    buildMs: 0,
  };
  const provider = new RaytracerTraceProvider(device, rt, bvh, layouts, data, buffers, scene, info, options);
  info.buildMs = performance.now() - t0;
  return provider;
}
