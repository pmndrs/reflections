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

import { createProbeLayout, type ProbeLayout, type ProbeLayoutId } from './layouts';
import { LayoutPrefilter } from './layouts/prefilter';
import { ProbeFormatWriter } from './layouts/formats';
import { maxLodFor } from './lod';
import { probeLookupWgsl, type ProbeLodMapping } from './lookup';
import { ProbeIrradiance } from './irradiance';
import { packProbeTable, probeIrradianceRow, probeTableRows, sortProbeVolumes, type ProbeVolume } from './table';

export type ProbeSetFormat = 'rgba16float' | 'rgb9e5ufloat';

export interface ProbeSetOptions {
  /** Probe volumes the set can hold (atlas slots 0 ... capacity - 1). */
  capacity: number;
  /** Default 'cube-hw'. */
  layout?: ProbeLayoutId;
  /** Default 'rgba16float'. */
  format?: ProbeSetFormat;
  /** Capture face size, a power of two >= 64. Default 128. */
  sourceSize?: number;
  /** Atlas size (mip 0 face, or octa side). Default `sourceSize`. */
  size?: number;
  /** Reserve the last slot for the environment. Default true. */
  environment?: boolean;
  /** Captures are x-mirrored (three's CubeCamera). Default false. */
  mirrorX?: boolean;
  /** Lookup options (./lookup.ts). */
  dominantDirection?: boolean;
  refit?: boolean;
  /** `fn frameIrradiance(P: vec3f, N: vec3f) -> vec3f` for `refit`. */
  frameIrradianceWgsl?: string;
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
  private readonly prefilter: LayoutPrefilter;
  private readonly writer: ProbeFormatWriter;
  private irradiance: ProbeIrradiance | null = null;
  private volumes: ProbeVolume[] = [];
  private packed: Float32Array<ArrayBuffer> = new Float32Array(0);

  constructor(device: GPUDevice, options: ProbeSetOptions) {
    this.device = device;
    this.options = options;
    this.capacity = options.capacity;
    this.format = options.format ?? 'rgba16float';
    this.sourceSize = options.sourceSize ?? 128;
    this.size = options.size ?? this.sourceSize;
    this.maxLod = maxLodFor(this.sourceSize);
    this.layout = createProbeLayout(options.layout ?? 'cube-hw', { maxLod: this.maxLod });
    this.environmentSlot = options.environment === false ? -1 : this.capacity;
    const slots = this.capacity + (this.environmentSlot >= 0 ? 1 : 0);
    const layers = slots * this.layout.layersPerProbe;
    // one atlas texture: a cube array of N cubes is 6N layers too, so the default limit (256)
    // holds 41 probes plus the environment in the cube layouts
    if (layers > device.limits.maxTextureArrayLayers) {
      throw new Error(`ProbeSet: ${slots} slots of '${this.layout.id}' need ${layers} array layers, but the device allows ${device.limits.maxTextureArrayLayers}. `
        + `Request a larger limit at requestDevice ({ requiredLimits: { maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers } }), use the 'octa' layout (1 layer per probe), or split the probes over several sets.`);
    }
    const descriptor = this.layout.textureDescriptor(this.size, slots, this.format);
    this.atlas = device.createTexture({ ...descriptor, label: `ProbeSet.atlas.${this.layout.id}` });
    this.atlasView = this.atlas.createView({ dimension: this.layout.viewDimension });
    this.sampler = device.createSampler({ label: 'ProbeSet.sampler', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.irradianceRow = probeIrradianceRow(this.capacity);
    this.table = device.createBuffer({ label: 'ProbeSet.table', size: probeTableRows(this.capacity, slots) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.prefilter = new LayoutPrefilter(device, this.layout, this.size, this.sourceSize);
    this.writer = new ProbeFormatWriter(device, this.layout, this.size, this.format, this.prefilter.scratch);
    const visibility = options.visibility ?? (GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT);
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'ProbeSet',
      entries: [
        { binding: 0, visibility, texture: { sampleType: 'float', viewDimension: this.layout.viewDimension } },
        { binding: 1, visibility, sampler: { type: 'filtering' } },
        { binding: 2, visibility, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: 'ProbeSet',
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: this.atlasView }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: this.table } }],
    });
    this.update();
  }

  /**
   * The lookup module (see probeLookupWgsl): bindings 0..2 of `@group(group)`, matching
   * `bindGroupLayout` / `bindGroup`.
   */
  wgsl({ group = 0 }: { group?: number } = {}) {
    const o = this.options;
    return probeLookupWgsl({
      layout: this.layout, group, mirrorX: o.mirrorX, dominantDirection: o.dominantDirection,
      refit: o.refit, frameIrradianceWgsl: o.frameIrradianceWgsl, lodMapping: o.lodMapping,
    });
  }

  /** Records the prefilter of `cube` (`sourceSize` px faces, mip 0 read) into atlas slot `slot`. */
  capture(encoder: GPUCommandEncoder, slot: number, cube: GPUTexture) {
    if (slot < 0 || slot >= this.capacity + (this.environmentSlot >= 0 ? 1 : 0)) throw new Error(`ProbeSet: slot ${slot} out of range`);
    this.prefilter.encodeScratch(encoder, cube);
    this.writer.encode(encoder, this.prefilter.scratch, this.atlas, slot);
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
    this.irradiance ??= new ProbeIrradiance(this.device, this.layout, { mirrorX: this.options.mirrorX });
    const all = slots ?? [...this.volumes.map((v) => v.slot), ...(this.environmentSlot >= 0 ? [this.environmentSlot] : [])];
    this.irradiance.encode(encoder, this.atlasView, this.table, this.irradianceRow, all);
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
    this.packed = packProbeTable({
      maxLod: this.maxLod, enabled: this.enabled, environmentSlot: this.environmentSlot,
      irradianceRow: this.irradianceRow, refitClamp: this.refitClamp,
    }, this.volumes, this.packed.length ? this.packed : undefined);
    this.device.queue.writeBuffer(this.table, 0, this.packed);
  }

  dispose() {
    this.prefilter.dispose();
    this.writer.dispose();
    this.irradiance?.dispose();
    this.atlas.destroy();
    this.table.destroy();
  }
}
