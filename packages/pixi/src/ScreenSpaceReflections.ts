// Screen-space reflections on a pixi.js v8 WebGPURenderer: core's tracer (@pmndrs/reflections-core,
// sssr/) on pixi's own GPUDevice, fed the frame contract from the adapter's G-buffer (./frame.ts).
// The adapter does no tracing maths: it dispatches core and repacks core's outputs into pixi
// textures, so a pixi Filter can sample them (./ReflectionsFilter.ts).
//
// The radiance fallback is core's seam: `probeRadianceFallback(probes.set)` over a PixiProbeSet
// (local probes + the sky in the environment slot) or, without probes, the constant
// `settings.fallbackColor`. `radiance` therefore holds FFX SSSR's lerp(fallback, hit, confidence) for
// every reflective pixel, rough ones included, and the composite only applies the split-sum weight.
//
// Why a repack (D2002): core allocates its outputs itself and pixi can't wrap a foreign GPUTexture in
// a TextureSource with public API, and r32float (confidence, hit distance) can't be bound to the
// `float` sample type pixi's WGSL layouts use. One compute dispatch writes two rgba16float pixi
// storage textures instead:
//   reflection  rgb = core radiance, a = confidence
//   aux         r = world hit distance, g = world ray length (radiance.w), b = alpha roughness, a = 1
import type { Renderer, Texture } from 'pixi.js';
import {
  constantRadianceFallback, createScreenSpaceReflections, probeRadianceFallback, screenSpaceInputsFromFrame,
  type FrameInputs, type RadianceFallback, type ScreenSpaceReflections as CoreTracer,
  type ScreenSpaceReflectionsSettings, type ScreenSpaceVariant,
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
}

export class ScreenSpaceReflections {
  readonly renderer: Renderer;
  readonly device: GPUDevice;
  readonly probes: PixiProbeSet | null;
  settings: ScreenSpaceReflectionsSettings;
  /** Trace rays. Off: every reflective pixel takes the fallback at its own roughness (probes / environment only). */
  enabled = true;
  private readonly variantOption: 'auto' | ScreenSpaceVariant;
  private readonly fallback: RadianceFallback;
  private readonly timestamps: boolean;
  private readonly packPipe: GPUComputePipeline;
  private readonly packLayout: GPUBindGroupLayout;
  private tracer: CoreTracer | null = null;
  private packed: { reflection: ReturnType<typeof createPixiTarget>; aux: ReturnType<typeof createPixiTarget>; group: GPUBindGroup } | null = null;

  constructor(options: ScreenSpaceReflectionsOptions) {
    this.renderer = options.renderer;
    this.device = getDevice(options.renderer);
    this.probes = options.probes ?? null;
    this.settings = { ...options.settings };
    this.variantOption = options.variant ?? 'auto';
    this.timestamps = options.timestamps ?? false;
    this.fallback = this.probes ? probeRadianceFallback(this.probes.set) : constantRadianceFallback();
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
    const tracer = (this.tracer = createScreenSpaceReflections(this.device, {
      width, height, depthInverted: false, variant: this.variantOption, radianceFallback: this.fallback, timestamps: this.timestamps,
    }));
    const reflection = createPixiTarget(this.renderer, 'reflections: radiance + confidence', width, height, 'rgba16float', true);
    const aux = createPixiTarget(this.renderer, 'reflections: hit distance, ray length, roughness', width, height, 'rgba16float', true);
    const o = tracer.outputs;
    const group = this.device.createBindGroup({
      label: 'pixi reflections: pack', layout: this.packLayout,
      entries: [o.radiance, o.confidence, o.hitDistance, o.extractedRoughness, reflection.gpu, aux.gpu].map((t, binding) => ({ binding, resource: t.createView() })),
    });
    this.packed = { reflection, aux, group };
  }

  private out() {
    if (!this.packed) throw new Error('ScreenSpaceReflections: call configure(width, height) first');
    return this.packed;
  }
  /** rgba16float pixi texture: reflected radiance (SSR hit / probes / environment) in rgb, confidence in a. */
  get reflection(): Texture { return this.out().reflection.texture; }
  /** rgba16float pixi texture: r world hit distance (0: no hit), g world ray length, b alpha roughness. */
  get aux(): Texture { return this.out().aux.texture; }

  /** Records core's passes and the repack into `encoder` (submit it before pixi samples the outputs). */
  dispatch(encoder: GPUCommandEncoder, frame: FrameInputs) {
    const tracer = this.tracer;
    if (!tracer || !this.packed) throw new Error('ScreenSpaceReflections: call configure(width, height) first');
    const inputs = screenSpaceInputsFromFrame(frame, tracer, { fallbackBindGroup: this.probes?.set.bindGroup });
    const settings: ScreenSpaceReflectionsSettings = { ...this.settings, frameIndex: frame.frameIndex };
    if (!this.enabled) settings.roughnessThreshold = 0;
    tracer.dispatch(encoder, inputs, settings);
    const pass = encoder.beginComputePass({ label: 'pixi reflections: pack' });
    pass.setPipeline(this.packPipe);
    pass.setBindGroup(0, this.packed.group);
    pass.dispatchWorkgroups(Math.ceil(tracer.width / 8), Math.ceil(tracer.height / 8));
    pass.end();
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

  dispose() { this.disposeTracer(); }
}
