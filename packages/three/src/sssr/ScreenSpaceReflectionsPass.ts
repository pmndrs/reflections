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
//
// Ray-traced fallback (SPEC section 4; off unless `trace` is given, D51): core's
// `createTracedReflections` runs right after the tracer in the same encoder, over its miss list,
// through a TraceProvider (../trace/MeshBVHTraceProvider.ts for three-mesh-bvh). Traced hits
// overwrite radiance / hit distance / confidence (1) before the copies, so the composite and the
// denoise seam see one signal; `source` says which pixels the traced pass touched.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
  createHalfResolutionFrame, createScreenSpaceReflections, createTracedReflections, DEFAULT_ROUGHNESS_THRESHOLD, halfResolutionSize, PassTimer, screenSpaceInputsFromFrame,
  type FrameInputs, type HalfResolutionFrame, type HitLights, type ScreenSpaceReflections as CoreTracer,
  type ScreenSpaceReflectionsSettings, type ScreenSpaceVariant, type TraceProvider, type TracedReflections,
  type TracedReflectionsSettings, type TracedReflectionsStats,
} from '@pmndrs/reflections-core';
import { FrameGBuffer, getDevice, getGPUTexture, type FrameGBufferOptions } from '../frame/FrameGBuffer';
import type { ReflectionProbes } from '../probes/ReflectionProbes';
import { ThreeHitShading, sceneLightingProbes } from '../trace/hitShading';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * The pass's settings: core's tracer settings plus where the reflections run (W75, plan X5).
 */
export interface ScreenSpaceReflectionsPassSettings extends ScreenSpaceReflectionsSettings {
  /**
   * W75 (plan X5, D5080): the resolution the tracer, the ray-traced pass and (through
   * `HybridReflections`) the denoiser run at. 'full' (default): the G-buffer's size. 'half':
   * ceil(w / 2) x ceil(h / 2), from a half-size frame point-sampled at one pixel per 2x2 quad (core
   * `createHalfResolutionFrame`); `HybridReflections` denoises there and upsamples the residual
   * (`denoised - probeEnv`) with a joint bilateral filter (core `createReflectionUpsample`). The
   * pass's `radiance` / `hitDistance` / `confidence` / `source` are then half size. Composites are
   * built for one mode: after a change, rebuild them (`hybrid.rebuild()` and your `composite()` calls).
   */
  reflectionResolution?: 'full' | 'half';
  /**
   * W75 (plan X5 step 2, D5084): with 'half', pixels below this perceptual roughness (mirrors and
   * near-mirrors) are traced by a second, full-res tracer instead (every pixel its own ray, its own
   * ray-traced pass over its miss list, no denoiser), and composited at full res; the half-res tracer
   * skips them (core `minRoughness`). Default 0: every pixel at half res (step 1). A change between 0
   * and > 0 needs the composites rebuilt, like `reflectionResolution`.
   */
  halfResMinRoughness?: number;
}

/** W75 (X5 step 2): the full-res mirror path's outputs, as the pass's own targets (full size). */
export interface ScreenSpaceMirrorTargets {
  radiance: THREE.StorageTexture;
  hitDistance: THREE.StorageTexture;
  confidence: THREE.StorageTexture;
  source: THREE.StorageTexture;
}

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
  /** Allocate core's miss list (for a ray-traced pass or the miss debug view). Default false; `trace` implies it. */
  missList?: boolean;
  /** Per-pass GPU timestamps (`readTimings()`); needs 'timestamp-query'. Default false. */
  timestamps?: boolean;
  /** Tracer settings (perceptual `roughnessThreshold`, default 0.447). `fallbackColor` is forced to black, see `radiance`. */
  settings?: ScreenSpaceReflectionsPassSettings;
  /** Trace rays for the screen-space misses. Off unless given (D51). */
  trace?: ScreenSpaceTraceOptions;
}

export interface ScreenSpaceTraceOptions {
  /** The BVH walk, e.g. `await MeshBVHTraceProvider.fromObjects(pass.device, meshes)`. */
  provider: TraceProvider;
  /**
   * Environment the hit shading lights hits with (an equirect 2-D texture or a CubeTexture).
   * Default: the scene's `environment` at `render()`; black if none.
   */
  environment?: THREE.Texture | null;
  /** Default: the scene's `environmentIntensity` at `render()` (1 if `trace()` is called directly). */
  environmentIntensity?: number;
  /**
   * Reflection probes the hit shading lights hits with (the lookup at the hit along N at roughness
   * 1, the environment slot for the rest; D901), instead of the environment's hemisphere mean.
   * Default: the scene's, when `scene.environmentNode` is `reflectionProbes(probes)` at `render()`
   * (what three lights the same surfaces with on screen). null: always the environment.
   */
  probes?: ReflectionProbes | null;
  /**
   * Light traced hits with the scene's visible directional and hemisphere lights too (Lambert; up
   * to 4 + 2), gathered at `render()`. Directional lights are shadowed by one ray each through the
   * provider (`settings.hitShadows`, default on; every traced mesh casts, `castShadow` is not read);
   * hemisphere lights and the environment are not. Default true.
   */
  lights?: boolean;
  /** Ray budget, length cap, origin offset, on-screen reuse, hit shadows. */
  settings?: TracedReflectionsSettings;
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
 * renderer's device (plus rays for the misses with `trace`), and copies the results into
 * {@link radiance}, {@link hitDistance} and {@link confidence}.
 */
export class ScreenSpaceReflectionsPass {
  readonly renderer: THREE.WebGPURenderer;
  readonly gbuffer: FrameGBuffer;
  /** Tracer settings, read every frame. */
  settings: ScreenSpaceReflectionsPassSettings;
  /**
   * rgba16float. rgb: confidence x hit radiance (the tracer's fallback is black, so a miss is 0 and
   * the composite adds its own probe / environment term for `1 - confidence`); w: world ray length.
   * Rough pixels (above the threshold) and the background are 0. Traced hits: the shaded hit.
   */
  readonly radiance: THREE.StorageTexture;
  /** r32float: world hit distance, 0 where nothing was hit (the denoiser seam's convention). */
  readonly hitDistance: THREE.StorageTexture;
  /** r32float: hit confidence in [0, 1]; 0 for misses, rough pixels and the background; 1 where a traced ray hit. */
  readonly confidence: THREE.StorageTexture;
  /**
   * r32float: what the ray-traced pass did per pixel (core `RT_SOURCE`): 0 untouched, 1 traced
   * hit, 2 traced miss, 3 capped (kept the screen-space result), 4 traced hit shaded from the
   * on-screen colour. All 0 without `trace` or with `rayTracing` off.
   */
  readonly source: THREE.StorageTexture;
  /** Trace rays for the misses (only does something with `options.trace`). */
  rayTracing: boolean;
  /** Ray-traced pass settings, read every frame. */
  traceSettings: TracedReflectionsSettings;
  /** Camera of the last `render()`, for composites that rebuild world positions from depth. */
  readonly uniforms = {
    projectionInverse: uniform(new THREE.Matrix4()),
    cameraWorld: uniform(new THREE.Matrix4()),
    cameraPosition: uniform(new THREE.Vector3()),
    /** projection x view of the traced frame (the composite projects hits for the screen-edge fade, W22). */
    viewProjection: uniform(new THREE.Matrix4()),
  };
  /**
   * With `settings.hitColor = 'history'`: the texture holding last frame's image (rgba16float,
   * render size), e.g. a render target the app draws the composite's `final` into after each frame,
   * so a mirror seen in a mirror shows its own reflection (one bounce deeper per frame). Null
   * (default): the G-buffer's `lit` target of the previous frame (three's lighting with its
   * specular IBL, without our SSR). The first 'history' frame, the frame after `resetHistory()` and
   * the frame after a change of `hitColor` or of this texture use this frame's scene colour instead.
   */
  historySource: THREE.Texture | null = null;
  private history: GPUTexture | null = null;
  private historyValid = false;
  /** What last frame's history came from (null: hitColor 'current'); a change invalidates it. */
  private historyKey: THREE.Texture | 'lit' | null = null;
  private readonly ownsGBuffer: boolean;
  private readonly options: ScreenSpaceReflectionsPassOptions;
  private core: CoreTracer | null = null;
  private rt: TracedReflections | null = null;
  private hitShading: ThreeHitShading | null = null;
  private sceneEnvironment: THREE.Texture | null = null;
  private sceneProbes: ReflectionProbes | null = null;
  private sceneEnvironmentIntensity = 1;
  private sceneLights: HitLights = {};
  private blackEnvironment: THREE.DataTexture | null = null;
  private sourceDirty = false;
  /** The core tracer binds last frame's hit source (W52, D3641): only while `settings.hitLobeFilterMixed` < 1 with `trace`. */
  private coreHitSource = false;
  private traceOptions: ScreenSpaceTraceOptions | null;
  /** W75: the half-res frame (made on the first 'half' frame) and the frame the last trace ran on. */
  private half: HalfResolutionFrame | null = null;
  private halfTimer: PassTimer | null = null;
  private halfTimerDone: (() => void) | undefined;
  private lastTraceFrame: FrameInputs | null = null;
  private latchedMode: 'full' | 'half' | 'mixed' = 'full';
  private latchedMinRoughness = 0;
  /** W75 (X5 step 2): the full-res mirror path (tracer, traced pass, targets, history). */
  private mirrorCore: CoreTracer | null = null;
  private mirrorRt: TracedReflections | null = null;
  private mirrorOut: ScreenSpaceMirrorTargets | null = null;
  private mirrorHistory: GPUTexture | null = null;
  private mirrorHistoryReady = false;
  private mirrorSourceDirty = false;
  private mirrorRan = false;

  constructor(renderer: THREE.WebGPURenderer, options: ScreenSpaceReflectionsPassOptions = {}) {
    this.renderer = renderer;
    this.options = options;
    this.traceOptions = options.trace ? { ...options.trace } : null;
    this.ownsGBuffer = !options.gbuffer;
    this.gbuffer = options.gbuffer ?? new FrameGBuffer(renderer, { lit: 'auto', ...options.gbufferOptions });
    this.settings = { ...options.settings };
    const { width: w, height: h } = this.gbuffer;
    this.radiance = make('ssr radiance', w, h, THREE.HalfFloatType, THREE.RGBAFormat);
    this.hitDistance = make('ssr hit distance', w, h, THREE.FloatType, THREE.RedFormat);
    this.confidence = make('ssr confidence', w, h, THREE.FloatType, THREE.RedFormat);
    this.source = make('ssr rt source', w, h, THREE.FloatType, THREE.RedFormat);
    this.rayTracing = !!options.trace;
    this.traceSettings = { ...options.trace?.settings };
  }

  /** The core tracer (lists, counters, pyramid, miss list); recreated on resize, null before the first frame. */
  get tracer(): CoreTracer | null { return this.core; }
  /** The core ray-traced pass (null without `trace`, or before the first frame). */
  get traced(): TracedReflections | null { return this.rt; }
  /** What traced hits are lit with this frame: the probes at the hit (D901) or the environment mean; null before the first traced frame. */
  get hitShadingSource(): 'probes' | 'environment' | null { return this.rt && this.hitShading ? this.hitShading.kind : null; }
  get device(): GPUDevice { return getDevice(this.renderer); }
  /**
   * W75: the frame the last trace ran on: the G-buffer's frame, or with `reflectionResolution: 'half'`
   * its half-size point-sampled copy (what the denoise seam must be given). Null before the first trace.
   */
  get traceFrame(): FrameInputs | null { return this.lastTraceFrame; }
  /** W75: the resolution the last trace ran at (latched by `trace()`, not read from the settings). */
  get resolution(): 'full' | 'half' { return this.latchedMode === 'full' ? 'full' : 'half'; }
  /**
   * W75: the mode the last trace ran in, latched once per `trace()`: 'full', 'half', or 'mixed' (half
   * with the full-res mirror path below `traceMinRoughness`). `HybridReflections.update()` follows it,
   * so a setting changed between `render()` and `update()` takes effect on the next frame.
   */
  get traceMode(): 'full' | 'half' | 'mixed' { return this.latchedMode; }
  /** W75: the `halfResMinRoughness` the last trace used (0 unless `traceMode` is 'mixed'). */
  get traceMinRoughness(): number { return this.latchedMinRoughness; }
  /**
   * W75 (X5 step 2): the full-res mirror path's targets: radiance / hit distance / confidence / source
   * of the pixels below `settings.halfResMinRoughness`. Created 1x1 on the first call (composites built
   * for half res bind them), sized to the G-buffer while the mirror path runs, back to 1x1 when it stops.
   */
  mirrorTargets(): ScreenSpaceMirrorTargets {
    this.mirrorOut ??= {
      radiance: make('ssr mirror radiance', 1, 1, THREE.HalfFloatType, THREE.RGBAFormat),
      hitDistance: make('ssr mirror hit distance', 1, 1, THREE.FloatType, THREE.RedFormat),
      confidence: make('ssr mirror confidence', 1, 1, THREE.FloatType, THREE.RedFormat),
      source: make('ssr mirror rt source', 1, 1, THREE.FloatType, THREE.RedFormat),
    };
    return this.mirrorOut;
  }
  private sizeMirrorTargets(w: number, h: number) {
    for (const t of Object.values(this.mirrorTargets())) if (t.image.width !== w || t.image.height !== h) (t as unknown as { setSize(w: number, h: number): void }).setSize(w, h);
  }
  /** W75: the mirror path ran in the last trace (`traceMode` 'mixed'). */
  get mirrorPath(): boolean { return this.mirrorRan; }
  /** Per-pass GPU timestamps were asked for (`options.timestamps`). */
  get timestamps(): boolean { return this.options.timestamps ?? false; }
  /** 'subgroups' or 'workgroup' once the first frame ran. */
  get variant(): ScreenSpaceVariant | null { return this.core?.variant ?? null; }

  /** Debug counts of the last traced frame (rays traced, capped, hits, misses). Null without `trace`. */
  readTraceStats(): Promise<TracedReflectionsStats | null> { return this.rt ? this.rt.readStats() : Promise.resolve(null); }

  /**
   * Attach, swap (new scene) or detach (null) the trace provider; keeps the other `trace` options.
   * Rebuilds the traced pass on the next frame. Attaching turns `rayTracing` on.
   */
  setTraceProvider(provider: TraceProvider | null) {
    this.rt?.destroy();
    this.rt = null;
    this.destroyMirror();
    if (!provider) { this.traceOptions = null; this.rayTracing = false; return; }
    this.traceOptions = { ...this.traceOptions, provider };
    this.rayTracing = true;
    // the tracer needs its miss list: recreate it on the next frame if it was made without one
    if (this.core && !this.core.outputs.missList) { this.core.destroy(); this.core = null; }
  }

  /**
   * Render the G-buffer and trace. Returns the frame's contract inputs. With a jittered camera
   * (TAA), pass the jitter and the unjittered `projection` (FrameGBuffer.render, D405).
   */
  render(scene: THREE.Scene, camera: THREE.Camera, opts: { jitter?: readonly [number, number]; projection?: ArrayLike<number> } = {}): FrameInputs {
    this.sceneEnvironment = scene.environment;
    this.sceneEnvironmentIntensity = scene.environmentIntensity ?? 1;
    this.sceneProbes = sceneLightingProbes(scene);
    if (this.traceOptions && this.traceOptions.lights !== false) this.sceneLights = ScreenSpaceReflectionsPass.gatherLights(scene);
    const frame = this.gbuffer.render(scene, camera, opts);
    this.trace(frame, camera);
    return frame;
  }

  /** Trace a frame the G-buffer already rendered (when you call `gbuffer.render()` yourself). */
  trace(fullFrame: FrameInputs, camera: THREE.Camera) {
    const device = this.device;
    // W75 (X5): 'half' traces a point-sampled half-size copy of the frame
    // latched once per frame (review fix 5): the settings are read here and nowhere else this frame
    const half = (this.settings.reflectionResolution ?? 'full') === 'half';
    const mirrorMin = half ? Math.max(0, this.settings.halfResMinRoughness ?? 0) : 0;
    this.latchedMode = !half ? 'full' : mirrorMin > 0 ? 'mixed' : 'half';
    this.latchedMinRoughness = mirrorMin;
    const [tw, th] = half ? halfResolutionSize(fullFrame.width, fullFrame.height) : [fullFrame.width, fullFrame.height];
    this.ensure(tw, th, fullFrame.conventions.depthInverted);
    const core = this.core!;
    const size = [tw, th];
    const cmd = device.createCommandEncoder({ label: 'ssr (three)' });
    let frame = fullFrame;
    if (half) {
      if (this.timestamps && !this.halfTimer && PassTimer.supported(device)) this.halfTimer = new PassTimer(device, 2);
      this.half ??= createHalfResolutionFrame(device, { timestampWrites: () => this.halfTimer?.pass('half-res sample') });
      this.halfTimer?.begin();
      frame = this.half.build(cmd, fullFrame);
      this.halfTimerDone = this.halfTimer?.end(cmd);
    } else if (this.half) { this.half.destroy(); this.half = null; }
    this.lastTraceFrame = frame;
    // Hit colour from last frame (D69): an app texture is copied before the trace (it still holds
    // last frame's image); the G-buffer's lit target after it (it already holds this frame's).
    const wantHistory = this.settings.hitColor === 'history';
    const appHistory = this.historySource ? this.gpu(this.historySource) : undefined;
    const source = wantHistory ? (appHistory ? (half ? this.half!.sample(cmd, appHistory) : appHistory) : frame.textures.lit) : undefined;
    if (wantHistory && !source) throw new Error("ScreenSpaceReflectionsPass: hitColor 'history' needs historySource or the G-buffer's lit target");
    const history = source ? this.historyTexture(source.format, tw, th) : undefined;
    // Valid only if the previous frame ran in the same mode from the same source and nothing reset
    // it. The app texture is valid from the frame after the first one (the app draws it after each
    // frame); the copy below never makes the frame that does it valid.
    const key = !wantHistory ? null : this.historySource ?? 'lit';
    if (key !== this.historyKey) this.historyValid = false;
    this.historyKey = key;
    const useHistory = !!history && this.historyValid;
    if (source && this.historySource) cmd.copyTextureToTexture({ texture: source }, { texture: history! }, size);
    // the re-shade's radiance along a hit's reflected ray (W44, D3540) and the traced hits' shading: one group 3
    const hitShadingBindGroup = this.hitShadingGroup();
    // W52 (D3641): last frame's hit source for the lobe filter where hits mix; the traced pass's own
    // texture still holds it (its dispatch below clears it first)
    const hitSource = this.coreHitSource && this.rt && this.rayTracing ? this.rt.source : undefined;
    const inputs = screenSpaceInputsFromFrame(frame, core, { history: useHistory ? history : undefined, hitShadingBindGroup, hitSource });
    const hitShading = this.settings.hitShading ?? 'reshade';
    // W74 (X4, D5060): tracedMissRate 'half' needs the traced pass's fill this frame. traceSettings wins, then
    // settings (review fix 3: either place works); both passes get the same value.
    const tracing = !!this.rt && this.rayTracing;
    const wantHalf = tracing && (this.traceSettings.tracedMissRate ?? this.settings.tracedMissRate) === 'half';
    // review fix 4: 'full' until the fill's pipelines (compiled asynchronously) are ready
    if (wantHalf && !this.rt!.halfRateReady) this.rt!.prepareHalfRate().catch((e) => console.error(e));
    const halfRate = wantHalf && this.rt!.halfRateReady;
    const halfRateMin = this.traceSettings.tracedHalfRateMinRoughness ?? this.settings.tracedHalfRateMinRoughness;
    // W75 (X5 step 2): mirrors and near-mirrors go to the full-res mirror path, the half-res tracer skips them
    const out = core.dispatch(cmd, inputs, {
      frameIndex: frame.frameIndex, ...this.settings, hitColor: useHistory ? 'history' : 'current', fallbackColor: [0, 0, 0],
      missesTraced: !!(this.rt && this.rayTracing), // W73 (D5043): rayReuse 'ratio' leaves the traced pass's pixels to it
      tracedMissRate: halfRate ? 'half' : 'full', tracedHalfRateMinRoughness: halfRateMin,
      ...(mirrorMin > 0 ? { minRoughness: mirrorMin } : {}),
    });
    if (this.rt && tracing) {
      // traced misses take black like the tracer's fallback: the composite adds probes /
      // environment for 1 - confidence, exactly the term three's lit image already has
      this.rt.dispatch(cmd, { tracer: core, inputs, hitShadingBindGroup }, { ...this.traceSettings, hitColor: useHistory ? 'history' : 'current', hitShading, hitLobeFilter: this.traceSettings.hitLobeFilter ?? this.settings.hitLobeFilter, hitShadeOcclusion: this.traceSettings.hitShadeOcclusion ?? this.settings.hitShadeOcclusion,
        hitLobeFilterMixed: this.traceSettings.hitLobeFilterMixed ?? this.settings.hitLobeFilterMixed,
        hitLobeFilterGrazing: this.traceSettings.hitLobeFilterGrazing ?? this.settings.hitLobeFilterGrazing, roughnessThreshold: this.settings.roughnessThreshold, fallbackColor: [0, 0, 0],
        tracedMissRate: halfRate ? 'half' : 'full', tracedHalfRateMinRoughness: halfRateMin,
        // W72 (D5021): the traced lobe filter follows the tracer's lobe split
        mirrorBias: this.settings.mirrorBias, mirrorBiasCompensate: this.settings.mirrorBiasCompensate, hitColorFilter: this.settings.hitColorFilter });
      cmd.copyTextureToTexture({ texture: this.rt.source }, { texture: this.gpu(this.source) }, size);
      this.sourceDirty = true;
    } else if (this.sourceDirty) {
      cmd.beginRenderPass({ colorAttachments: [{ view: this.gpu(this.source).createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
      this.sourceDirty = false;
    }
    if (mirrorMin > 0) this.traceMirror(cmd, fullFrame, mirrorMin, { wantHistory, appHistory, useHistory, hitShadingBindGroup, hitShading });
    else if (this.mirrorCore || this.mirrorRan) {
      // review fix 4: leaving 'mixed' frees the mirror tracer and shrinks its targets (half-res composites keep binding them)
      this.destroyMirror();
      this.sizeMirrorTargets(1, 1);
    }
    this.mirrorRan = mirrorMin > 0;
    // after both traces read it: this frame's lit image becomes next frame's history
    if (source && !this.historySource) cmd.copyTextureToTexture({ texture: source }, { texture: history! }, size);
    // next frame's history: the lit copy above, or the app texture drawn after this frame
    this.historyValid = !!source;
    cmd.copyTextureToTexture({ texture: out.radiance }, { texture: this.gpu(this.radiance) }, size);
    cmd.copyTextureToTexture({ texture: out.hitDistance }, { texture: this.gpu(this.hitDistance) }, size);
    cmd.copyTextureToTexture({ texture: out.confidence }, { texture: this.gpu(this.confidence) }, size);
    device.queue.submit([cmd.finish()]);

    const cam = camera as THREE.PerspectiveCamera;
    this.uniforms.projectionInverse.value.copy(cam.projectionMatrixInverse);
    this.uniforms.cameraWorld.value.copy(cam.matrixWorld);
    this.uniforms.cameraPosition.value.setFromMatrixPosition(cam.matrixWorld);
    this.uniforms.viewProjection.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  /**
   * W75 (X5 step 2): trace the pixels below `minRoughness` at full res: a second core tracer whose
   * roughness threshold is `minRoughness` (every pixel its own ray: samplesPerQuad 4), its own traced
   * pass over its miss list, its own full-res history; outputs into `mirrorTargets()`.
   */
  private traceMirror(cmd: GPUCommandEncoder, frame: FrameInputs, minRoughness: number,
    o: { wantHistory: boolean; appHistory?: GPUTexture; useHistory: boolean; hitShadingBindGroup: GPUBindGroup; hitShading: 'reshade' | 'off' }) {
    const device = this.device;
    const { width: w, height: h } = frame;
    const size = [w, h];
    this.sizeMirrorTargets(w, h);
    const t = this.mirrorTargets();
    const m0 = this.mirrorCore;
    if (!m0 || m0.width !== w || m0.height !== h || m0.depthInverted !== frame.conventions.depthInverted) {
      this.destroyMirror();
      this.mirrorCore = createScreenSpaceReflections(device, {
        width: w, height: h, depthInverted: frame.conventions.depthInverted, variant: this.core!.variant,
        missList: !!this.traceOptions || (this.options.missList ?? false), timestamps: this.timestamps, hitSpecularShading: this.hitShading!.shading,
      });
    }
    const mc = this.mirrorCore!;
    if (this.traceOptions && !this.mirrorRt) {
      this.mirrorRt = createTracedReflections(device, { width: w, height: h, provider: this.traceOptions.provider, hitShading: this.hitShading!.shading, timestamps: this.timestamps });
    }
    let history: GPUTexture | undefined;
    const src = o.wantHistory ? o.appHistory ?? frame.textures.lit : undefined;
    if (src) {
      if (!this.mirrorHistory || this.mirrorHistory.format !== src.format || this.mirrorHistory.width !== w || this.mirrorHistory.height !== h) {
        this.mirrorHistory?.destroy();
        this.mirrorHistory = device.createTexture({ label: 'ssr mirror hit-colour history', size, format: src.format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
        this.mirrorHistoryReady = false;
      }
      history = this.mirrorHistory;
      if (o.appHistory) cmd.copyTextureToTexture({ texture: src }, { texture: history }, size);
    }
    const useHistory = o.useHistory && !!history && (this.mirrorHistoryReady || !!o.appHistory);
    const inputs = screenSpaceInputsFromFrame(frame, mc, { history: useHistory ? history : undefined, hitShadingBindGroup: o.hitShadingBindGroup });
    const threshold = Math.min(minRoughness, this.settings.roughnessThreshold ?? DEFAULT_ROUGHNESS_THRESHOLD);
    const out = mc.dispatch(cmd, inputs, {
      frameIndex: frame.frameIndex, ...this.settings, roughnessThreshold: threshold, minRoughness: 0, samplesPerQuad: 4,
      hitColor: useHistory ? 'history' : 'current', fallbackColor: [0, 0, 0], tracedMissRate: 'full', hitLobeFilterMixed: 1,
      missesTraced: !!(this.mirrorRt && this.rayTracing), // W73 (D5043)
    });
    if (this.mirrorRt && this.rayTracing) {
      this.mirrorRt.dispatch(cmd, { tracer: mc, inputs, hitShadingBindGroup: o.hitShadingBindGroup }, {
        ...this.traceSettings, tracedMissRate: 'full', hitColor: useHistory ? 'history' : 'current', hitShading: o.hitShading,
        hitLobeFilter: this.traceSettings.hitLobeFilter ?? this.settings.hitLobeFilter, hitShadeOcclusion: this.traceSettings.hitShadeOcclusion ?? this.settings.hitShadeOcclusion,
        hitLobeFilterMixed: 1, hitLobeFilterGrazing: this.traceSettings.hitLobeFilterGrazing ?? this.settings.hitLobeFilterGrazing, roughnessThreshold: threshold, fallbackColor: [0, 0, 0],
      });
      cmd.copyTextureToTexture({ texture: this.mirrorRt.source }, { texture: this.gpu(t.source) }, size);
      this.mirrorSourceDirty = true;
    } else if (this.mirrorSourceDirty || !this.mirrorRan) {
      cmd.beginRenderPass({ colorAttachments: [{ view: this.gpu(t.source).createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
      this.mirrorSourceDirty = false;
    }
    if (src && !o.appHistory) cmd.copyTextureToTexture({ texture: src }, { texture: history! }, size);
    this.mirrorHistoryReady = !!src;
    cmd.copyTextureToTexture({ texture: out.radiance }, { texture: this.gpu(t.radiance) }, size);
    cmd.copyTextureToTexture({ texture: out.hitDistance }, { texture: this.gpu(t.hitDistance) }, size);
    cmd.copyTextureToTexture({ texture: out.confidence }, { texture: this.gpu(t.confidence) }, size);
  }

  private destroyMirror() {
    this.mirrorCore?.destroy(); this.mirrorCore = null;
    this.mirrorRt?.destroy(); this.mirrorRt = null;
    this.mirrorHistory?.destroy(); this.mirrorHistory = null;
    this.mirrorHistoryReady = false;
  }

  /** Forget last frame's colour (camera cut, scene switch); the next frame's hits use this frame's scene colour. */
  resetHistory() { this.historyValid = false; this.mirrorHistoryReady = false; }

  private historyTexture(format: GPUTextureFormat, w: number, h: number): GPUTexture {
    const t = this.history;
    if (t && t.format === format && t.width === w && t.height === h) return t;
    t?.destroy();
    this.historyValid = false;
    return (this.history = this.device.createTexture({
      label: 'ssr hit-colour history', size: [w, h], format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    }));
  }

  /** With `timestamps`: ms per core pass for the last traced frame ('rt begin', 'rt trace' with `trace`; 'total' sums all). */
  async readTimings(): Promise<ReadonlyMap<string, number>> {
    const t = new Map(await (this.core?.readTimings() ?? Promise.resolve(new Map<string, number>())));
    if (this.mirrorCore && this.mirrorRan) {
      for (const [k, v] of await this.mirrorCore.readTimings()) if (k !== 'total') t.set(`mirror ${k}`, v);
      if (this.mirrorRt && this.rayTracing) for (const [k, v] of await this.mirrorRt.readTimings()) if (k !== 'total') t.set(`mirror ${k}`, v);
      if (t.has('total')) t.set('total', [...t].filter(([k]) => k !== 'total').reduce((a, [, v]) => a + v, 0));
    }
    if (this.halfTimer && this.resolution === 'half') {
      this.halfTimerDone?.(); this.halfTimerDone = undefined;
      await this.halfTimer.read();
      const ms = this.halfTimer.timings.get('half-res sample');
      if (ms !== undefined) { t.set('half-res sample', ms); if (t.has('total')) t.set('total', t.get('total')! + ms); }
    }
    if (this.rt && this.rayTracing) {
      const r = await this.rt.readTimings();
      for (const [k, v] of r) if (k !== 'total') t.set(k, v);
      if (t.has('total') && r.has('total')) t.set('total', t.get('total')! + r.get('total')!);
    }
    return t;
  }

  private gpu(t: THREE.Texture): GPUTexture {
    // allocated lazily (and again after a resize disposed it)
    if (!(this.renderer as N).backend.get(t)?.texture) this.renderer.initTexture(t);
    return getGPUTexture(this.renderer, t);
  }

  private environmentTexture(): THREE.Texture {
    const env = this.traceOptions?.environment !== undefined ? this.traceOptions.environment : this.sceneEnvironment;
    if (env) return env;
    if (!this.blackEnvironment) {
      this.blackEnvironment = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
      this.blackEnvironment.needsUpdate = true;
    }
    return this.blackEnvironment;
  }

  /** Visible directional and hemisphere lights as the hit shading takes them (colour x intensity, world directions). */
  static gatherLights(scene: THREE.Scene): HitLights {
    const lights: Required<HitLights> = { directional: [], hemisphere: [] };
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const rgb = (c: THREE.Color, k: number) => [c.r * k, c.g * k, c.b * k] as [number, number, number];
    scene.traverseVisible((o) => {
      const l = o as THREE.DirectionalLight & THREE.HemisphereLight;
      if (l.isDirectionalLight) {
        l.updateMatrixWorld();
        l.target.updateMatrixWorld();
        a.setFromMatrixPosition(l.matrixWorld).sub(b.setFromMatrixPosition(l.target.matrixWorld)).normalize();
        lights.directional.push({ direction: [a.x, a.y, a.z], color: rgb(l.color, l.intensity) });
      } else if (l.isHemisphereLight) {
        l.updateMatrixWorld();
        a.setFromMatrixPosition(l.matrixWorld).normalize();
        lights.hemisphere.push({ up: [a.x, a.y, a.z], sky: rgb(l.color, l.intensity), ground: rgb(l.groundColor, l.intensity) });
      }
    });
    return lights;
  }

  private hitShadingGroup(): GPUBindGroup {
    return this.hitShading!.bindGroup(this.traceOptions?.environmentIntensity ?? this.sceneEnvironmentIntensity, this.traceOptions && this.traceOptions.lights !== false ? this.sceneLights : {});
  }

  private createTraced(w: number, h: number) {
    const trace = this.traceOptions!;
    this.rt = createTracedReflections(this.device, {
      width: w, height: h, provider: trace.provider, hitShading: this.hitShading!.shading, timestamps: this.options.timestamps ?? false,
    });
  }

  private ensure(w: number, h: number, inverted: boolean) {
    const trace = this.traceOptions;
    // the hit shading is compiled into the trace pipeline and the tracer's intersect (the re-shade,
    // W44): a new source (cube / equirect / probe layout or count) rebuilds both
    this.hitShading ??= new ThreeHitShading(this.device, (t) => this.gpu(t));
    const probes = trace?.probes !== undefined ? trace.probes : this.sceneProbes;
    if (this.hitShading.prepare(this.environmentTexture(), probes)) {
      this.destroyMirror();
      this.rt?.destroy(); this.rt = null;
      this.core?.destroy(); this.core = null;
    }
    // W52 (D3641): the lobe filter where hits mix binds one more texture in intersect: rebuild on a flip
    const wantHitSource = !!trace && (this.settings.hitLobeFilterMixed ?? 1) < 1;
    if (this.core && wantHitSource !== this.coreHitSource) { this.rt?.destroy(); this.rt = null; this.core.destroy(); this.core = null; }
    const c = this.core;
    if (c && c.width === w && c.height === h && c.depthInverted === inverted) {
      if (trace && !this.rt) this.createTraced(w, h);
      return;
    }
    c?.destroy();
    this.rt?.destroy(); this.rt = null;
    const device = this.device;
    const sub = (this.options.subgroups ?? true) && device.features.has('subgroups' as GPUFeatureName);
    this.core = createScreenSpaceReflections(device, {
      width: w, height: h, depthInverted: inverted, variant: sub ? 'subgroups' : 'workgroup',
      missList: (this.options.missList ?? false) || !!this.options.trace || !!trace, timestamps: this.options.timestamps ?? false,
      hitSpecularShading: this.hitShading.shading, hitSource: wantHitSource,
    });
    this.coreHitSource = wantHitSource;
    if (trace) this.createTraced(w, h);
    for (const t of [this.radiance, this.hitDistance, this.confidence, this.source]) (t as unknown as { setSize(w: number, h: number): void }).setSize(w, h);
  }

  dispose() {
    this.core?.destroy();
    this.core = null;
    this.history?.destroy();
    this.history = null;
    this.rt?.destroy();
    this.rt = null;
    this.hitShading?.destroy();
    this.half?.destroy();
    this.halfTimer?.destroy();
    this.destroyMirror();
    if (this.mirrorOut) for (const t of Object.values(this.mirrorOut)) t.dispose();
    this.blackEnvironment?.dispose();
    for (const t of [this.radiance, this.hitDistance, this.confidence, this.source]) t.dispose();
    if (this.ownsGBuffer) this.gbuffer.dispose();
  }
}
