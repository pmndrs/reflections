// Screen-space reflections on a Babylon.js WebGPUEngine: the frame contract from a Babylon G-buffer
// (./frame.ts) and the core tracer (@pmndrs/reflections-core, sssr/) on Babylon's own GPUDevice.
// The adapter does no tracing maths: it maps Babylon's conventions onto the contract
// (./conventions.ts), dispatches core, and hands core's outputs back to Babylon as InternalTextures
// that share core's allocations (no copies).
//
// The radiance fallback is core's seam: `probeRadianceFallback(probes.set)` over a BabylonProbeSet
// (local probes + the environment slot, captured from Babylon) or, without probes, the constant
// `settings.fallbackColor`. So `radiance` is FFX SSSR's lerp(fallback, hit, confidence) for every
// reflective pixel, rough ones included (classify writes the fallback at their roughness), and a
// composite only multiplies it by the split-sum weight (./composite.ts). Glossy misses take the
// fallback at the pixel's roughness too (core's `fallbackRoughness`, default 'surface', D3100;
// 'mirror' is FFX's roughness-0 lookup).
//
//   const ssr = new ScreenSpaceReflections({ engine, probes });
//   ssr.configure(width, height);              // allocates; rebuild the frame graph after
//   ssr.dispatch(gbuffer, camera);             // per frame, after the G-buffer render
//   ssr.radiance / ssr.confidence / ssr.hitDistance   // InternalTextures for post processes
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';
import {
  constantRadianceFallback, createScreenSpaceReflections, probeRadianceFallback, screenSpaceInputsFromFrame,
  type FrameInputs, type RadianceFallback, type ScreenSpaceReflections as CoreTracer,
  type ScreenSpaceReflectionsSettings, type ScreenSpaceVariant,
} from '@pmndrs/reflections-core';
import { BabylonFrame, type BabylonFrameOptions, type BabylonGBuffer } from './frame';
import { asWebGPUEngine, getDevice, wrapGPUTexture } from './internal/babylonWebGPU';
import type { BabylonProbeSet } from './probes';

export interface ScreenSpaceReflectionsOptions {
  /** An initialized WebGPUEngine (after `await engine.initAsync()`). */
  engine: AbstractEngine;
  /**
   * Probes (and the environment slot) for misses and rough pixels, through core's probe radiance
   * fallback. Fixed at construction: the fallback is part of the tracer's pipelines. Default: none,
   * the constant `settings.fallbackColor`.
   */
  probes?: BabylonProbeSet | null;
  /** 'auto' (default): 'subgroups' when the device has the feature (WebGPUEngine `enableAllFeatures`). */
  variant?: 'auto' | ScreenSpaceVariant;
  /** Tracer settings, read every dispatch (perceptual `roughnessThreshold`, default 0.447). */
  settings?: ScreenSpaceReflectionsSettings;
  /** Frame options (./frame.ts). */
  frame?: BabylonFrameOptions;
  /** Per-pass GPU timestamps (`readTimings()`); needs 'timestamp-query'. Default false. */
  timestamps?: boolean;
}

export class ScreenSpaceReflections {
  readonly engine: AbstractEngine;
  readonly device: GPUDevice;
  readonly frame: BabylonFrame;
  readonly probes: BabylonProbeSet | null;
  /** Tracer settings, read every dispatch. `iblFactor` scales the fallback (Babylon: scene.environmentIntensity). */
  settings: ScreenSpaceReflectionsSettings;
  /**
   * Trace screen-space rays. Off: every reflective pixel takes the radiance fallback at its own
   * roughness (core classify with a zero roughness threshold), i.e. probes / environment only.
   */
  enabled = true;
  /** The last frame's inputs, as handed to core (debug, the denoise seam). */
  lastFrame: FrameInputs | null = null;
  private readonly variantOption: 'auto' | ScreenSpaceVariant;
  private readonly fallback: RadianceFallback;
  private readonly timestamps: boolean;
  private tracer: CoreTracer | null = null;
  private wrapped: { radiance: InternalTexture; confidence: InternalTexture; hitDistance: InternalTexture } | null = null;

  constructor(options: ScreenSpaceReflectionsOptions) {
    asWebGPUEngine(options.engine);
    this.engine = options.engine;
    this.device = getDevice(options.engine);
    this.frame = new BabylonFrame(options.engine, options.frame);
    this.probes = options.probes ?? null;
    this.settings = { ...options.settings };
    this.variantOption = options.variant ?? 'auto';
    this.timestamps = options.timestamps ?? false;
    this.fallback = this.probes ? probeRadianceFallback(this.probes.set) : constantRadianceFallback();
  }

  get width() { return this.tracer?.width ?? 0; }
  get height() { return this.tracer?.height ?? 0; }
  get variant(): ScreenSpaceVariant | null { return this.tracer?.variant ?? null; }
  /** The core tracer (its raw outputs, lists and counters). Null before `configure()`. */
  get core(): CoreTracer | null { return this.tracer; }

  /**
   * (Re)allocates the tracer for a render size. Call before building the frame graph and on resize,
   * then re-read the output textures (they are new allocations).
   */
  configure(width: number, height: number) {
    if (this.tracer && this.tracer.width === width && this.tracer.height === height) return;
    this.disposeTracer();
    this.tracer = createScreenSpaceReflections(this.device, {
      width, height, depthInverted: this.frame.conventions.depthInverted, variant: this.variantOption,
      radianceFallback: this.fallback, timestamps: this.timestamps,
    });
    const o = this.tracer.outputs;
    this.wrapped = {
      radiance: wrapGPUTexture(this.engine, o.radiance),
      confidence: wrapGPUTexture(this.engine, o.confidence),
      hitDistance: wrapGPUTexture(this.engine, o.hitDistance),
    };
  }

  private out(): NonNullable<ScreenSpaceReflections['wrapped']> {
    if (!this.wrapped) throw new Error('ScreenSpaceReflections: call configure(width, height) first');
    return this.wrapped;
  }
  /** rgba16float: lerp(fallback, hit, confidence) in rgb, world ray length in w. Babylon render-target orientation. */
  get radiance(): InternalTexture { return this.out().radiance; }
  /** r32float: hit confidence in [0, 1]; 0 for misses, rough pixels and the background. */
  get confidence(): InternalTexture { return this.out().confidence; }
  /** r32float: world hit distance, 0 where nothing was hit. */
  get hitDistance(): InternalTexture { return this.out().hitDistance; }

  /**
   * Encodes and submits the frame conversion and the tracer. Flushes Babylon first, so the submit
   * lands after the G-buffer render on the queue and before whatever Babylon records next.
   */
  dispatch(gbuffer: BabylonGBuffer, camera: Camera) {
    const tracer = this.tracer;
    if (!tracer) throw new Error('ScreenSpaceReflections: call configure(width, height) first');
    asWebGPUEngine(this.engine).flushFramebuffer();
    const encoder = this.device.createCommandEncoder({ label: 'babylon ssr' });
    const frame = this.frame.build(encoder, gbuffer, camera);
    this.lastFrame = frame;
    const inputs = screenSpaceInputsFromFrame(frame, tracer, { fallbackBindGroup: this.probes?.set.bindGroup });
    const settings: ScreenSpaceReflectionsSettings = { ...this.settings, frameIndex: frame.frameIndex };
    if (!this.enabled) settings.roughnessThreshold = 0;
    tracer.dispatch(encoder, inputs, settings);
    this.device.queue.submit([encoder.finish()]);
  }

  /** With `timestamps`: ms per core pass (+ 'total') of the last dispatch. */
  readTimings(): Promise<ReadonlyMap<string, number>> {
    return this.tracer?.readTimings() ?? Promise.resolve(new Map());
  }

  private disposeTracer() {
    if (this.wrapped) for (const t of Object.values(this.wrapped)) t.dispose();
    this.wrapped = null;
    this.tracer?.destroy();
    this.tracer = null;
  }

  dispose() {
    this.disposeTracer();
    this.frame.dispose();
  }
}
