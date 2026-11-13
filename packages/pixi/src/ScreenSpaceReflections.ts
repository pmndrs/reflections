// Screen-space reflections on a pixi.js v8 WebGPURenderer: core's tracer (@pmndrs/reflections-core,
// sssr/) on pixi's own GPUDevice, fed the frame contract unpacked from a pixi-3d view (./frame.ts).
// The adapter does no tracing maths: it dispatches core and repacks core's outputs into pixi
// textures, so a pixi Filter can sample them (./ReflectionsFilter.ts).
//
// The radiance fallback is core's seam: `probeRadianceFallback(probes.set)` over a PixiProbeSet
// (local probes + the sky in the environment slot) or, without probes, the constant
// `settings.fallbackColor`. `radiance` therefore holds FFX SSSR's lerp(fallback, hit, confidence) for
// every reflective pixel, rough ones included, and the composite only applies the split-sum weight.
// Glossy misses take the fallback at the pixel's roughness (core's `fallbackRoughness`, default
// 'surface', D3100; 'mirror' is FFX's roughness-0 lookup).
//
// Why a repack (D2002): core allocates its outputs itself and pixi can't wrap a foreign GPUTexture in
// a TextureSource with public API, and r32float (confidence, hit distance) can't be bound to the
// `float` sample type pixi's WGSL layouts use. One compute dispatch writes two rgba16float pixi
// storage textures instead:
//   reflection  rgb = core radiance, a = confidence
//   aux         r = world hit distance, g = world ray length (radiance.w), b = alpha roughness, a = 1
//
// Denoising (SPEC "Denoise seam", rule 7: it lives in the denoiser repo): pass any denoiser-core
// shaped `TemporalDenoiser<SpecularInputs>` (e.g. `FfxReflectionDenoiser` from denoiser/ffx, created
// on pixi's device) as `denoiser`; core's seam feeds it the frame contract, and the repack then reads
// the denoised radiance instead of the raw one. The seam submits its own work, so `dispatch()`
// submits too (the tracer's command buffer, the seam's, then the repack).
import type { Renderer, Texture } from 'pixi.js';
import {
  constantRadianceFallback, createReflectionDenoiseSeam, createScreenSpaceReflections, probeRadianceFallback, screenSpaceInputsFromFrame,
  type FrameInputs, type RadianceFallback, type ScreenSpaceReflections as CoreTracer,
  type ReflectionDenoiseSeam, type ScreenSpaceReflectionsSettings, type ScreenSpaceVariant, type SpecularInputs, type TemporalDenoiser,
} from '@pmndrs/reflections-core';
import { createPixiTarget, getDevice } from './internal/pixiWebGPU';
import type { PixiProbeSet } from './probes';

const PACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var radiance: texture_2d<f32>;
@group(0) @binding(1) var confidence: texture_2d<f32>;
@group(0) @binding(2) var hitDistance: texture_2d<f32>;
@group(0) @binding(3) var roughness: texture_2d<f32>;
@group(0) @binding(4) var reflection: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var aux: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(reflection))) { return; }
  let p = vec2i(id.xy);
  let r = textureLoad(radiance, p, 0);
  textureStore(reflection, p, vec4f(r.rgb, textureLoad(confidence, p, 0).x));
  textureStore(aux, p, vec4f(textureLoad(hitDistance, p, 0).x, r.w, textureLoad(roughness, p, 0).x, 1.0));
}
`;

export interface ScreenSpaceReflectionsOptions {
  /** An initialized pixi WebGPURenderer (`app.renderer` after `await app.init({ preference: 'webgpu' })`). */
  renderer: Renderer;
  /** Probes + environment for misses and rough pixels (fixed at construction). Default: none (constant `fallbackColor`). */
  probes?: PixiProbeSet | null;
  /** 'auto' (default): 'subgroups' when the device has the feature (see `requestReflectionsDevice`). */
  variant?: 'auto' | ScreenSpaceVariant;
  /** Tracer settings, read every dispatch. */
  settings?: ScreenSpaceReflectionsSettings;
  /** Per-pass GPU timestamps (`readTimings()`); needs 'timestamp-query'. */
  timestamps?: boolean;
  /**
   * A denoiser-core `TemporalDenoiser<SpecularInputs>` on pixi's device (optional peer, never a
   * dependency). Gate it at the tracer's threshold (FFX compares alpha: `roughnessThreshold: 0.447 ** 2`).
   */
  denoiser?: TemporalDenoiser<SpecularInputs> | null;
}

export class ScreenSpaceReflections {
  readonly renderer: Renderer;
  readonly device: GPUDevice;
  readonly probes: PixiProbeSet | null;
  settings: ScreenSpaceReflectionsSettings;
  /** Trace rays. Off: every reflective pixel takes the fallback at its own roughness (probes / environment only). */
  enabled = true;
  /** Denoise the traced signal when a denoiser was given. */
  denoise = true;
  /** The denoise seam (null without a denoiser). */
  readonly seam: ReflectionDenoiseSeam | null;
  private denoisedGroup: { texture: GPUTexture; group: GPUBindGroup } | null = null;
  private readonly variantOption: 'auto' | ScreenSpaceVariant;
  private readonly fallback: RadianceFallback;
  private readonly timestamps: boolean;
  private readonly packPipe: GPUComputePipeline;
  private readonly packLayout: GPUBindGroupLayout;
  private tracer: CoreTracer | null = null;
  /** The tracer was created with the hit-colour pyramid (W72, D5020: `settings.hitColorFilter` 'cone'). */
  private tracerCone = false;
  private packed: { reflection: ReturnType<typeof createPixiTarget>; aux: ReturnType<typeof createPixiTarget>; group: GPUBindGroup } | null = null;

  constructor(options: ScreenSpaceReflectionsOptions) {
    this.renderer = options.renderer;
    this.device = getDevice(options.renderer);
    this.probes = options.probes ?? null;
    this.settings = { ...options.settings };
    this.variantOption = options.variant ?? 'auto';
    this.timestamps = options.timestamps ?? false;
    this.fallback = this.probes ? probeRadianceFallback(this.probes.set) : constantRadianceFallback();
    this.seam = options.denoiser ? createReflectionDenoiseSeam(this.device, { denoiser: options.denoiser }) : null;
    const C = GPUShaderStage.COMPUTE;
    this.packLayout = this.device.createBindGroupLayout({
      label: 'pixi reflections: pack',
      entries: [
        ...[0, 1, 2, 3].map((binding) => ({ binding, visibility: C, texture: { sampleType: 'unfilterable-float' as const } })),
        ...[4, 5].map((binding) => ({ binding, visibility: C, storageTexture: { access: 'write-only' as const, format: 'rgba16float' as const } })),
      ],
    });
    this.packPipe = this.device.createComputePipeline({
      label: 'pixi reflections: pack', layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.packLayout] }),
      compute: { module: this.device.createShaderModule({ label: 'pixi reflections: pack', code: PACK_WGSL }), entryPoint: 'main' },
    });
  }

  get width() { return this.tracer?.width ?? 0; }
  get height() { return this.tracer?.height ?? 0; }
  get variant(): ScreenSpaceVariant | null { return this.tracer?.variant ?? null; }
  /** The core tracer (raw outputs, lists, counters). Null before `configure()`. */
  get core(): CoreTracer | null { return this.tracer; }

  /** (Re)allocates for a render size (G-buffer pixels). The output textures are new allocations after a resize. */
  configure(width: number, height: number) {
    if (this.tracer && this.tracer.width === width && this.tracer.height === height) return;
    this.disposeTracer();
    const tracer = (this.tracer = this.createTracer(width, height));
    const reflection = createPixiTarget(this.renderer, 'reflections: radiance + confidence', width, height, 'rgba16float', true);
    const aux = createPixiTarget(this.renderer, 'reflections: hit distance, ray length, roughness', width, height, 'rgba16float', true);
    this.packed = { reflection, aux, group: this.packGroup(tracer.outputs.radiance, reflection.gpu, aux.gpu) };
    this.denoisedGroup = null;
    this.seam?.resetHistory();
  }

  private createTracer(width: number, height: number): CoreTracer {
    this.tracerCone = this.settings.hitColorFilter === 'cone';
    return createScreenSpaceReflections(this.device, {
      width, height, depthInverted: false, variant: this.variantOption, radianceFallback: this.fallback, timestamps: this.timestamps,
      hitColorPyramid: this.tracerCone,
    });
  }

  private packGroup(radiance: GPUTexture, reflection: GPUTexture, aux: GPUTexture) {
    const o = this.tracer!.outputs;
    return this.device.createBindGroup({
      label: 'pixi reflections: pack', layout: this.packLayout,
      entries: [radiance, o.confidence, o.hitDistance, o.extractedRoughness, reflection, aux].map((t, binding) => ({ binding, resource: t.createView() })),
    });
  }

  /** True when this frame's radiance goes through the denoiser. */
  get denoising() { return !!this.seam && this.denoise && this.enabled; }

  /** Forget the denoiser's history (camera cut). */
  resetHistory() { this.seam?.resetHistory(); }

  private out() {
    if (!this.packed) throw new Error('ScreenSpaceReflections: call configure(width, height) first');
    return this.packed;
  }
  /** rgba16float pixi texture: reflected radiance (SSR hit / probes / environment) in rgb, confidence in a. */
  get reflection(): Texture { return this.out().reflection.texture; }
  /** rgba16float pixi texture: r world hit distance (0: no hit), g world ray length, b alpha roughness. */
  get aux(): Texture { return this.out().aux.texture; }

  /**
   * Records core's passes into `encoder` and submits it (with whatever the caller recorded before,
   * e.g. the frame unpack), then denoises (when set) and repacks into the pixi textures. pixi's next
   * render samples the results.
   */
  dispatch(encoder: GPUCommandEncoder, frame: FrameInputs) {
    let tracer = this.tracer;
    const packed = this.packed;
    if (!tracer || !packed) throw new Error('ScreenSpaceReflections: call configure(width, height) first');
    if ((this.settings.hitColorFilter === 'cone') !== this.tracerCone) {
      // W72 (D5020): the hit-colour pyramid is a binding of the tracer: rebuild it, keep the pixi targets
      const { width, height } = tracer;
      tracer.destroy();
      tracer = this.tracer = this.createTracer(width, height);
      packed.group = this.packGroup(tracer.outputs.radiance, packed.reflection.gpu, packed.aux.gpu);
      this.denoisedGroup = null;
    }
    const inputs = screenSpaceInputsFromFrame(frame, tracer, { fallbackBindGroup: this.probes?.set.bindGroup });
    const settings: ScreenSpaceReflectionsSettings = { ...this.settings, frameIndex: frame.frameIndex };
    if (!this.enabled) settings.roughnessThreshold = 0;
    tracer.dispatch(encoder, inputs, settings);
    let group = packed.group;
    let packEncoder = encoder;
    if (this.seam && this.denoising) {
      this.device.queue.submit([encoder.finish()]);
      const o = tracer.outputs;
      const denoised = this.seam.dispatch(frame, { radiance: o.radiance, hitDistance: o.hitDistance });
      if (this.denoisedGroup?.texture !== denoised) {
        this.denoisedGroup = { texture: denoised, group: this.packGroup(denoised, packed.reflection.gpu, packed.aux.gpu) };
      }
      group = this.denoisedGroup.group;
      packEncoder = this.device.createCommandEncoder({ label: 'pixi reflections: pack' });
    }
    const pass = packEncoder.beginComputePass({ label: 'pixi reflections: pack' });
    pass.setPipeline(this.packPipe);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(tracer.width / 8), Math.ceil(tracer.height / 8));
    pass.end();
    this.device.queue.submit([packEncoder.finish()]);
  }

  readTimings(): Promise<ReadonlyMap<string, number>> {
    return this.tracer?.readTimings() ?? Promise.resolve(new Map());
  }

  private disposeTracer() {
    this.packed?.reflection.destroy();
    this.packed?.aux.destroy();
    this.packed = null;
    this.tracer?.destroy();
    this.tracer = null;
  }

  dispose() {
    this.disposeTracer();
    this.seam?.destroy();
  }
}
