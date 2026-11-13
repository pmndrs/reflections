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
  createScreenSpaceReflections, createTracedReflections, screenSpaceInputsFromFrame,
  type FrameInputs, type HitLights, type ScreenSpaceReflections as CoreTracer,
  type ScreenSpaceReflectionsSettings, type ScreenSpaceVariant, type TraceProvider, type TracedReflections,
  type TracedReflectionsSettings, type TracedReflectionsStats,
} from '@pmndrs/reflections-core';
import { FrameGBuffer, getDevice, getGPUTexture, type FrameGBufferOptions } from '../frame/FrameGBuffer';
import type { ReflectionProbes } from '../probes/ReflectionProbes';
import { ThreeHitShading, sceneLightingProbes } from '../trace/hitShading';

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
  /** Allocate core's miss list (for a ray-traced pass or the miss debug view). Default false; `trace` implies it. */
  missList?: boolean;
  /** Per-pass GPU timestamps (`readTimings()`); needs 'timestamp-query'. Default false. */
  timestamps?: boolean;
  /** Tracer settings (perceptual `roughnessThreshold`, default 0.447). `fallbackColor` is forced to black, see `radiance`. */
  settings?: ScreenSpaceReflectionsSettings;
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
  settings: ScreenSpaceReflectionsSettings;
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
  trace(frame: FrameInputs, camera: THREE.Camera) {
    const device = this.device;
    this.ensure(frame.width, frame.height, frame.conventions.depthInverted);
    const core = this.core!;
    const size = [frame.width, frame.height];
    const cmd = device.createCommandEncoder({ label: 'ssr (three)' });
    // Hit colour from last frame (D69): an app texture is copied before the trace (it still holds
    // last frame's image); the G-buffer's lit target after it (it already holds this frame's).
    const wantHistory = this.settings.hitColor === 'history';
    const source = wantHistory ? (this.historySource ? this.gpu(this.historySource) : frame.textures.lit) : undefined;
    if (wantHistory && !source) throw new Error("ScreenSpaceReflectionsPass: hitColor 'history' needs historySource or the G-buffer's lit target");
    const history = source ? this.historyTexture(source.format, frame.width, frame.height) : undefined;
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
    const out = core.dispatch(cmd, inputs, {
      frameIndex: frame.frameIndex, ...this.settings, hitColor: useHistory ? 'history' : 'current', fallbackColor: [0, 0, 0],
      missesTraced: !!(this.rt && this.rayTracing), // W73 (D5043): rayReuse 'ratio' leaves the traced pass's pixels to it
    });
    if (this.rt && this.rayTracing) {
      // traced misses take black like the tracer's fallback: the composite adds probes /
      // environment for 1 - confidence, exactly the term three's lit image already has
      this.rt.dispatch(cmd, { tracer: core, inputs, hitShadingBindGroup }, { ...this.traceSettings, hitColor: useHistory ? 'history' : 'current', hitShading, hitLobeFilter: this.traceSettings.hitLobeFilter ?? this.settings.hitLobeFilter, hitShadeOcclusion: this.traceSettings.hitShadeOcclusion ?? this.settings.hitShadeOcclusion,
        hitLobeFilterMixed: this.traceSettings.hitLobeFilterMixed ?? this.settings.hitLobeFilterMixed,
        hitLobeFilterGrazing: this.traceSettings.hitLobeFilterGrazing ?? this.settings.hitLobeFilterGrazing, roughnessThreshold: this.settings.roughnessThreshold, fallbackColor: [0, 0, 0] });
      cmd.copyTextureToTexture({ texture: this.rt.source }, { texture: this.gpu(this.source) }, size);
      this.sourceDirty = true;
    } else if (this.sourceDirty) {
      cmd.beginRenderPass({ colorAttachments: [{ view: this.gpu(this.source).createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
      this.sourceDirty = false;
    }
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

  /** Forget last frame's colour (camera cut, scene switch); the next frame's hits use this frame's scene colour. */
  resetHistory() { this.historyValid = false; }

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
    this.blackEnvironment?.dispose();
    for (const t of [this.radiance, this.hitDistance, this.confidence, this.source]) t.dispose();
    if (this.ownsGBuffer) this.gbuffer.dispose();
  }
}
