// ProbeSet: the core probe path on a bare GPUDevice (SPEC phase 2). It owns
//   - the atlas: every probe's prefiltered capture in one texture of a ProbeLayout (default
//     `cube-hw`, a real texture_cube_array) and a storage format (default rgba16float,
//     `rgb9e5ufloat` at half the memory: compute pack + copy, D103), environment in the last slot;
//   - the volume table (./table.ts) in a storage buffer;
//   - the prefilter (LayoutPrefilter, three r187's plan) and the format writer;
//   - the lookup's WGSL and bind group (./lookup.ts).
// Capture stays with the engine: hand `capture()` a cube texture of `sourceSize` px faces.
//
//   const set = new ProbeSet(device, { capacity: 3 });
//   set.capture(encoder, slot, cubeTexture);           // per probe, and captureEnvironment(...)
//   set.setVolumes([{ slot: 0, center, halfSize, projectionSize }, ...]);
//   set.update();                                        // uploads the table (cheap; call per frame if probes move)
//   // shader: set.wgsl({ group: 1 }) defines probeRadiance(P, R, roughness) -> vec4f, ...
//   pass.setBindGroup(1, set.bindGroup);
//
// Per-slot sizes (D4700): `slotSizes` gives a slot its own capture size; each size gets an atlas of
// its own (the set's `sourceSize` first, with the environment), bound at bindings 3.. of the set's
// group after the table. `capture()` keeps taking global slots (a capture cube of `slotSize(slot)`).

import { createProbeLayout, type ProbeLayout, type ProbeLayoutId } from './layouts';
import { LayoutPrefilter } from './layouts/prefilter';
import { ProbeFormatWriter } from './layouts/formats';
import { maxLodFor } from './lod';
import { PROBE_IRRADIANCE_ROWS } from './table';
import { probeLookupWgsl, type ProbeLodMapping, type ProbeLookupModuleOptions } from './lookup';
import { ProbeIrradiance } from './irradiance';
import { ProbeCaptureRemap, hasCaptureFaces, resolveCaptureTransform, type ProbeCaptureTransform } from './capture';
import { packProbeTable, planProbeAtlases, probeIrradianceRow, probeTableRows, sortProbeVolumes, type ProbeAtlasPlan, type ProbeVolume } from './table';

export type ProbeSetFormat = 'rgba16float' | 'rgb9e5ufloat';

export interface ProbeSetOptions {
  /** Probe volumes the set can hold (atlas slots 0 ... capacity - 1). */
  capacity: number;
  /**
   * Default 'cube-hw' (a real cube array); 'cube2d-warp' on a compatibility-mode device (no
   * 'core-features-and-limits'), which can't create cube-array views (D2204).
   */
  layout?: ProbeLayoutId;
  /** Default 'rgba16float'. */
  format?: ProbeSetFormat;
  /**
   * Capture face size, a power of two >= 64. Default 256 (D23 / D62: mirror-grade; 128 for many
   * probes or mobile, see the three adapter's `BakeOptions.resolution` for sizing).
   */
  sourceSize?: number;
  /** Atlas size (mip 0 face, or octa side). Default `sourceSize`. */
  size?: number;
  /**
   * Capture face size per probe slot (D4700), each a power of two >= 64; absent or undefined entries
   * take `sourceSize`. Slots of each size share an atlas (`sourceSize`'s first, holding the
   * environment; at most 4 sizes), so one sharp probe can be 512 beside 256 px ones without 4x the
   * set's memory. Capture slot `s` from a cube of `slotSize(s)`. Those atlases are as large as their
   * captures (`size` applies to atlas 0 only).
   */
  slotSizes?: readonly (number | undefined)[];
  /** Reserve the last slot for the environment. Default true. */
  environment?: boolean;
  /** Captures are x-mirrored (three's CubeCamera): an alias of `captureTransform: CAPTURE_MIRROR_X`. Default false. */
  mirrorX?: boolean;
  /**
   * How the engine's captures relate to WebGPU's cube convention (./capture.ts, D1805 / D2104): `axes`
   * mirror (or swap) directions at lookup, free; `faces` remap the capture's layers and flips as
   * `capture()` reads it in (one compute pass in place of the copy; the capture then needs
   * TEXTURE_BINDING). Default: none. Not together with `mirrorX`.
   */
  captureTransform?: ProbeCaptureTransform;
  /** Lookup options (./lookup.ts). */
  dominantDirection?: boolean;
  /** Re-fit by `frameIrradianceWgsl` (D803). Default: on when `frameIrradianceWgsl` is given, else off. */
  refit?: boolean;
  /** Lagarde's distance-based roughness and roughness lerp on box-projected volumes (D53). Default false. */
  distanceRoughness?: boolean;
  roughnessLerp?: boolean;
  /** `fn frameIrradiance(P: vec3f, N: vec3f) -> vec3f` for `refit` (turns the re-fit on unless `refit: false`). */
  frameIrradianceWgsl?: string;
  /** Roughness to mip. Default 'alpha' (D101); 'r187' for three r187's PMREM mapping everywhere. */
  lodMapping?: ProbeLodMapping;
  /** Shader stages the bind group is visible to. Default COMPUTE | FRAGMENT. */
  visibility?: number;
}

export class ProbeSet {
  readonly device: GPUDevice;
  readonly layout: ProbeLayout;
  readonly format: ProbeSetFormat;
  readonly capacity: number;
  readonly sourceSize: number;
  readonly size: number;
  readonly maxLod: number;
  /** Atlas slot of the environment, or -1. */
  readonly environmentSlot: number;
  readonly atlas: GPUTexture;
  readonly atlasView: GPUTextureView;
  /** Every atlas, one per slot size (D4700): `[atlas]` unless `slotSizes` mixes sizes. */
  readonly atlases: readonly GPUTexture[];
  readonly atlasViews: readonly GPUTextureView[];
  /** Each atlas's layout (same kind, its own mip count). */
  readonly layouts: readonly ProbeLayout[];
  /** Where each slot lives: its atlas and slot there (planProbeAtlases over `slotSizes`). */
  readonly plan: ProbeAtlasPlan;
  readonly sampler: GPUSampler;
  readonly table: GPUBuffer;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  /** First row of the irradiance block. */
  readonly irradianceRow: number;
  /** Probes contribute (false while capturing, so captures see only the environment). */
  enabled = true;
  /** Upper bound of the re-fit ratio. */
  refitClamp = 4;
  private readonly options: ProbeSetOptions;
  private readonly prefilters: LayoutPrefilter[];
  private readonly writers: ProbeFormatWriter[];
  private readonly irradiance: (ProbeIrradiance | null)[];
  private readonly remap: ProbeCaptureRemap | null;
  private readonly transform: ProbeCaptureTransform;
  private volumes: ProbeVolume[] = [];
  private packed: Float32Array<ArrayBuffer> = new Float32Array(0);

  constructor(device: GPUDevice, options: ProbeSetOptions) {
    this.device = device;
    this.options = options;
    this.capacity = options.capacity;
    this.format = options.format ?? 'rgba16float';
    this.sourceSize = options.sourceSize ?? 256;
    this.size = options.size ?? this.sourceSize;
    this.maxLod = maxLodFor(this.sourceSize);
    this.transform = resolveCaptureTransform(options);
    this.remap = hasCaptureFaces(this.transform) ? new ProbeCaptureRemap(device, this.transform) : null;
    const compat = !device.features.has('core-features-and-limits' as GPUFeatureName);
    const layoutId = options.layout ?? (compat ? 'cube2d-warp' : 'cube-hw');
    this.layout = createProbeLayout(layoutId, { maxLod: this.maxLod });
    this.environmentSlot = options.environment === false ? -1 : this.capacity;
    // one atlas per capture size (D4700): sourceSize's first (with the environment), then ascending
    const sizes = Array.from({ length: this.capacity }, (_, i) => options.slotSizes?.[i]);
    this.plan = planProbeAtlases(sizes, this.sourceSize, { environment: this.environmentSlot >= 0 });
    this.layouts = this.plan.resolutions.map((r, a) => (a === 0 ? this.layout : createProbeLayout(layoutId, { maxLod: maxLodFor(r) })));
    // one texture per atlas: a cube array of N cubes is 6N layers too, so the default limit (256)
    // holds 41 probes plus the environment in the cube layouts
    this.plan.slots.forEach((n, a) => {
      const layers = n * this.layouts[a].layersPerProbe;
      if (layers > device.limits.maxTextureArrayLayers) {
        throw new Error(`ProbeSet: ${n} slots of '${this.layout.id}' need ${layers} array layers, but the device allows ${device.limits.maxTextureArrayLayers}. `
          + `Request a larger limit at requestDevice ({ requiredLimits: { maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers } }), use the 'octa' layout (1 layer per probe), or split the probes over several sets.`);
      }
    });
    const atlasSize = (a: number) => (a === 0 ? this.size : this.plan.resolutions[a]);
    this.atlases = this.plan.resolutions.map((r, a) => device.createTexture({
      ...this.layouts[a].textureDescriptor(atlasSize(a), Math.max(1, this.plan.slots[a]), this.format),
      label: a === 0 ? `ProbeSet.atlas.${this.layout.id}` : `ProbeSet.atlas.${this.layout.id}.${r}`,
    }));
    this.atlasViews = this.atlases.map((t, a) => t.createView({ dimension: this.layouts[a].viewDimension }));
    this.atlas = this.atlases[0];
    this.atlasView = this.atlasViews[0];
    this.sampler = device.createSampler({ label: 'ProbeSet.sampler', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.irradianceRow = probeIrradianceRow(this.capacity);
    const slots = this.plan.slots.reduce((x, y) => x + y, 0);
    this.table = device.createBuffer({ label: 'ProbeSet.table', size: probeTableRows(this.capacity, slots) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.prefilters = this.plan.resolutions.map((r, a) => new LayoutPrefilter(device, this.layouts[a], atlasSize(a), r));
    this.writers = this.prefilters.map((pf, a) => new ProbeFormatWriter(device, this.layouts[a], atlasSize(a), this.format, pf.scratch));
    this.irradiance = this.atlases.map(() => null);
    const visibility = options.visibility ?? (GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT);
    // atlases 1.. after the table (bindings 3..), as lookupOptions() declares them
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'ProbeSet',
      entries: [
        { binding: 0, visibility, texture: { sampleType: 'float', viewDimension: this.layout.viewDimension } },
        { binding: 1, visibility, sampler: { type: 'filtering' } },
        { binding: 2, visibility, buffer: { type: 'read-only-storage' } },
        ...this.layouts.slice(1).map((l, k) => ({ binding: 3 + k, visibility, texture: { sampleType: 'float' as const, viewDimension: l.viewDimension } })),
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: 'ProbeSet',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.atlasView }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: this.table } },
        ...this.atlasViews.slice(1).map((v, k) => ({ binding: 3 + k, resource: v })),
      ],
    });
    this.update();
  }

  /**
   * The lookup module (see probeLookupWgsl): bindings 0..2 of `@group(group)`, matching
   * `bindGroupLayout` / `bindGroup`. `suffix` renames its entry points (`probeRadiance<suffix>`, ...);
   * for several sets in one module, use `probeLookupWgsl([a.lookupOptions(...), b.lookupOptions(...)])`.
   */
  wgsl({ group = 0, suffix, atlasBinding }: { group?: number; suffix?: string; atlasBinding?: number } = {}) {
    return probeLookupWgsl(this.lookupOptions({ group, suffix, atlasBinding }));
  }

  /**
   * The lookup module options of this set (see {@link wgsl}), for `probeLookupWgsl([...])`. With
   * several atlases (`slotSizes`, D4700) atlas k is at `atlasBinding + k - 1`, default 3 (the set's
   * own bind group); a module that binds the set's resources itself can move them.
   */
  lookupOptions({ group = 0, suffix, atlasBinding }: { group?: number; suffix?: string; atlasBinding?: number } = {}): ProbeLookupModuleOptions {
    const o = this.options;
    return {
      layout: this.layout, group, suffix, captureTransform: this.transform, dominantDirection: o.dominantDirection,
      ...(this.atlases.length > 1 ? { atlases: this.atlases.length, atlasBinding: atlasBinding ?? 3 } : {}),
      refit: o.refit, distanceRoughness: o.distanceRoughness, roughnessLerp: o.roughnessLerp, frameIrradianceWgsl: o.frameIrradianceWgsl, lodMapping: o.lodMapping,
    };
  }

  /** Atlas and slot within it of probe slot `slot` (the environment slot included). */
  private where(slot: number): { atlas: number; slot: number } {
    if (slot < 0 || slot >= this.capacity + (this.environmentSlot >= 0 ? 1 : 0)) throw new Error(`ProbeSet: slot ${slot} out of range`);
    return slot === this.environmentSlot ? { atlas: 0, slot: this.plan.environmentSlot } : { atlas: this.plan.atlas[slot], slot: this.plan.slot[slot] };
  }

  /** Capture face size of slot `slot` (`sourceSize` unless `slotSizes` says otherwise; the environment's is `sourceSize`). */
  slotSize(slot: number): number {
    return this.plan.resolutions[this.where(slot).atlas];
  }

  /**
   * Records the prefilter of `cube` (`slotSize(slot)` px faces, mip 0 read) into atlas slot `slot`,
   * through the capture transform's face remap if it has one.
   */
  capture(encoder: GPUCommandEncoder, slot: number, cube: GPUTexture) {
    const at = this.where(slot);
    const prefilter = this.prefilters[at.atlas];
    prefilter.encodeScratch(encoder, cube, undefined, this.remap ?? undefined);
    this.writers[at.atlas].encode(encoder, prefilter.scratch, this.atlases[at.atlas], at.slot);
  }

  /** Records the environment capture (the last slot). */
  captureEnvironment(encoder: GPUCommandEncoder, cube: GPUTexture) {
    if (this.environmentSlot < 0) throw new Error('ProbeSet: created without an environment slot');
    this.capture(encoder, this.environmentSlot, cube);
  }

  /**
   * Records the L1 SH irradiance of `slots` (default: every volume's slot and the environment)
   * into the table, for the re-fit. Run it after the captures, in their command buffer or later.
   */
  computeIrradiance(encoder: GPUCommandEncoder, slots?: readonly number[]) {
    const all = slots ?? [...this.volumes.map((v) => v.slot), ...(this.environmentSlot >= 0 ? [this.environmentSlot] : [])];
    // per atlas: its slots, into rows from its irradiance base (one atlas: slot = row, as before)
    this.atlases.forEach((_, a) => {
      const local = all.map((s) => this.where(s)).filter((w) => w.atlas === a).map((w) => w.slot);
      if (local.length === 0) return;
      const filter = (this.irradiance[a] ??= new ProbeIrradiance(this.device, this.layouts[a], { captureTransform: this.transform }));
      filter.encode(encoder, this.atlasViews[a], this.table, this.irradianceRow + this.plan.irradianceBases[a] * PROBE_IRRADIANCE_ROWS, local);
    });
  }

  /** Sets the volumes (sorted into lookup order by priority, then size). Call `update()` after. */
  setVolumes(volumes: readonly ProbeVolume[]) {
    if (volumes.length > this.capacity) throw new Error(`ProbeSet: ${volumes.length} volumes, capacity ${this.capacity}`);
    this.volumes = sortProbeVolumes(volumes);
  }

  /** The volumes in lookup order. */
  getVolumes(): readonly ProbeVolume[] { return this.volumes; }

  /** Uploads the header and volumes (not the irradiance rows). */
  update() {
    const multi = this.atlases.length > 1;
    // volumes name global slots; the table wants each one's atlas and slot there (D4700)
    const volumes = multi ? this.volumes.map((v) => { const w = this.where(v.slot); return { ...v, atlas: w.atlas, slot: w.slot }; }) : this.volumes;
    this.packed = packProbeTable({
      maxLod: this.maxLod, enabled: this.enabled, environmentSlot: this.environmentSlot >= 0 ? this.plan.environmentSlot : -1,
      irradianceRow: this.irradianceRow, refitClamp: this.refitClamp,
      ...(multi ? { atlases: this.layouts.map((l, a) => ({ maxLod: l.mipLevelCount - 1, irradianceBase: this.plan.irradianceBases[a] })) } : {}),
    }, volumes, this.packed.length ? this.packed : undefined);
    this.device.queue.writeBuffer(this.table, 0, this.packed);
  }

  dispose() {
    for (const p of this.prefilters) p.dispose();
    for (const w of this.writers) w.dispose();
    for (const i of this.irradiance) i?.dispose();
    this.remap?.dispose();
    for (const t of this.atlases) t.destroy();
    this.table.destroy();
  }
}
