// Screen-space reflections for a three.js WebGPURenderer: the frame-contract G-buffer
// (../frame/FrameGBuffer.ts) followed by core's tracer (@pmndrs/reflections-core, sssr/), on the
// renderer's own GPUDevice. The adapter does no tracing maths of its own: it maps the frame onto
// the core inputs (`screenSpaceInputsFromFrame`), dispatches, and copies the three outputs the
// composite needs into three-owned textures so TSL can sample them.
//
//   const ssr = new ScreenSpaceReflectionsPass(renderer);
//   ssr.render(scene, camera);             // once per frame: G-buffer + trace
//   texture(ssr.radiance), texture(ssr.confidence), texture(ssr.hitDistance)  // in any TSL graph
//
// See ./composite.ts for the hybrid composite (SSR -> probes by coverage -> environment).
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
  createScreenSpaceReflections, screenSpaceInputsFromFrame,
  type FrameInputs, type ScreenSpaceReflections as CoreTracer, type ScreenSpaceReflectionsSettings,
} from '@pmndrs/reflections-core';
import { FrameGBuffer, getDevice, getGPUTexture, type FrameGBufferOptions } from '../frame/FrameGBuffer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface ScreenSpaceReflectionsPassOptions {
  /** Share an existing G-buffer (it must be rendered by this pass's `render()`, or by you before `trace()`). Default: a new one. */
  gbuffer?: FrameGBuffer;
  /** Options for the G-buffer this pass creates. `lit` defaults to 'auto' (the composite needs it). */
  gbufferOptions?: FrameGBufferOptions;
  /**
   * Use the subgroup variant when the device has the `subgroups` feature (three requests every
   * feature the adapter offers unless the app passes its own device). `false` forces the
   * workgroup-memory variant. Default true.
   */
  subgroups?: boolean;
  /** Allocate core's miss list (for a ray-traced pass or the miss debug view). Default false. */
  missList?: boolean;
  /** Per-pass GPU timestamps (`readTimings()`); needs 'timestamp-query'. Default false. */
  timestamps?: boolean;
  /** Tracer settings (perceptual `roughnessThreshold`, default 0.447). `fallbackColor` is forced to black, see `radiance`. */
  settings?: ScreenSpaceReflectionsSettings;
}

const make = (name: string, w: number, h: number, type: THREE.TextureDataType, format: THREE.AnyPixelFormat) => {
  const t = new THREE.StorageTexture(w, h);
  t.name = name;
  t.type = type;
  t.format = format;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
};

/**
 * Screen-space reflections on any three scene. Each `render()` renders the G-buffer, traces on the
 * renderer's device, and copies the results into {@link radiance}, {@link hitDistance} and
 * {@link confidence}.
 */
export class ScreenSpaceReflectionsPass {
  readonly renderer: THREE.WebGPURenderer;
  readonly gbuffer: FrameGBuffer;
  /** Tracer settings, read every frame. */
  settings: ScreenSpaceReflectionsSettings;
  /**
   * rgba16float. rgb: confidence x hit radiance (the tracer's fallback is black, so a miss is 0 and
   * the composite adds its own probe / environment term for `1 - confidence`); w: world ray length.
   * Rough pixels (above the threshold) and the background are 0.
   */
  readonly radiance: THREE.StorageTexture;
  /** r32float: world hit distance, 0 where nothing was hit (the denoiser seam's convention). */
  readonly hitDistance: THREE.StorageTexture;
  /** r32float: hit confidence in [0, 1]; 0 for misses, rough pixels and the background. */
  readonly confidence: THREE.StorageTexture;
  /** Camera of the last `render()`, for composites that rebuild world positions from depth. */
  readonly uniforms = {
    projectionInverse: uniform(new THREE.Matrix4()),
    cameraWorld: uniform(new THREE.Matrix4()),
    cameraPosition: uniform(new THREE.Vector3()),
  };
  private readonly ownsGBuffer: boolean;
  private readonly options: ScreenSpaceReflectionsPassOptions;
  private core: CoreTracer | null = null;

  constructor(renderer: THREE.WebGPURenderer, options: ScreenSpaceReflectionsPassOptions = {}) {
    this.renderer = renderer;
    this.options = options;
    this.ownsGBuffer = !options.gbuffer;
    this.gbuffer = options.gbuffer ?? new FrameGBuffer(renderer, { lit: 'auto', ...options.gbufferOptions });
    this.settings = { ...options.settings };
    const { width: w, height: h } = this.gbuffer;
    this.radiance = make('ssr radiance', w, h, THREE.HalfFloatType, THREE.RGBAFormat);
    this.hitDistance = make('ssr hit distance', w, h, THREE.FloatType, THREE.RedFormat);
    this.confidence = make('ssr confidence', w, h, THREE.FloatType, THREE.RedFormat);
  }

  /** The core tracer (lists, counters, pyramid, miss list); recreated on resize, null before the first frame. */
  get tracer(): CoreTracer | null { return this.core; }
  get device(): GPUDevice { return getDevice(this.renderer); }
  /** 'subgroups' or 'workgroup' once the first frame ran. */
  get variant() { return this.core?.variant ?? null; }

  /** Render the G-buffer and trace. Returns the frame's contract inputs. */
  render(scene: THREE.Scene, camera: THREE.Camera, opts: { jitter?: readonly [number, number] } = {}): FrameInputs {
    const frame = this.gbuffer.render(scene, camera, opts);
    this.trace(frame, camera);
    return frame;
  }

  /** Trace a frame the G-buffer already rendered (when you call `gbuffer.render()` yourself). */
  trace(frame: FrameInputs, camera: THREE.Camera) {
    const device = this.device;
    this.ensure(frame.width, frame.height, frame.conventions.depthInverted);
    const core = this.core!;
    const inputs = screenSpaceInputsFromFrame(frame, core);
    const cmd = device.createCommandEncoder({ label: 'ssr (three)' });
    const out = core.dispatch(cmd, inputs, { frameIndex: frame.frameIndex, ...this.settings, fallbackColor: [0, 0, 0] });
    const size = [frame.width, frame.height];
    cmd.copyTextureToTexture({ texture: out.radiance }, { texture: this.gpu(this.radiance) }, size);
    cmd.copyTextureToTexture({ texture: out.hitDistance }, { texture: this.gpu(this.hitDistance) }, size);
    cmd.copyTextureToTexture({ texture: out.confidence }, { texture: this.gpu(this.confidence) }, size);
    device.queue.submit([cmd.finish()]);

    const cam = camera as THREE.PerspectiveCamera;
    this.uniforms.projectionInverse.value.copy(cam.projectionMatrixInverse);
    this.uniforms.cameraWorld.value.copy(cam.matrixWorld);
    this.uniforms.cameraPosition.value.setFromMatrixPosition(cam.matrixWorld);
  }

  /** With `timestamps`: ms per core pass for the last traced frame (+ 'total'). */
  readTimings() { return this.core?.readTimings() ?? Promise.resolve(new Map<string, number>()); }

  private gpu(t: THREE.Texture): GPUTexture {
    // allocated lazily (and again after a resize disposed it)
    if (!(this.renderer as N).backend.get(t)?.texture) this.renderer.initTexture(t);
    return getGPUTexture(this.renderer, t);
  }

  private ensure(w: number, h: number, inverted: boolean) {
    const c = this.core;
    if (c && c.width === w && c.height === h && c.depthInverted === inverted) return;
    c?.destroy();
    const device = this.device;
    const sub = (this.options.subgroups ?? true) && device.features.has('subgroups' as GPUFeatureName);
    this.core = createScreenSpaceReflections(device, {
      width: w, height: h, depthInverted: inverted, variant: sub ? 'subgroups' : 'workgroup',
      missList: this.options.missList ?? false, timestamps: this.options.timestamps ?? false,
    });
    for (const t of [this.radiance, this.hitDistance, this.confidence]) (t as unknown as { setSize(w: number, h: number): void }).setSize(w, h);
  }

  dispose() {
    this.core?.destroy();
    this.core = null;
    for (const t of [this.radiance, this.hitDistance, this.confidence]) t.dispose();
    if (this.ownsGBuffer) this.gbuffer.dispose();
  }
}
