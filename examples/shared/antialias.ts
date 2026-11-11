// Anti-aliasing (and optional upscaling) for the example pages (W36): @pmndrs/upscaler's temporal
// path by default, at ratio 1 (`QualityMode.NativeAA`, temporal AA at display resolution), or at a
// quality preset's ratio, in which case the G-buffer and the reflections run at the render size and the
// upscaler rebuilds the display size. The hand-written resolve of W40 (./taa.ts, D3500) stays selectable.
// The upscaler is an examples-only dev dependency (npm 0.5.0); library code never imports it.
//
//   const aa = new DisplayAA(renderer, ssr.gbuffer, { mode, ratio, displayWidth, displayHeight, tone });
//   await aa.init();
//   // per frame:
//   const j = aa.begin(camera);                     // this mode's jitter (or none), on the camera
//   ssr.render(scene, camera, j);                   // FrameGBuffer: jittered raster, unjittered motion (D405)
//   aa.end(camera);
//   hybrid.update();
//   renderer.setRenderTarget(aa.target); pipeline.render(); renderer.setRenderTarget(null);
//   aa.resolve(dt);                                 // upscale / resolve / stretch -> canvas
//
// One jitter owner per mode: the upscaler's Halton sequence (8 ratio^2 phases) in 'upscaler', TemporalAA's
// own in 'taa', none in 'off'. It reaches the scene only through `FrameGBuffer.render(.., { jitter,
// projection })`: the contract's projection and motion stay unjittered, so the tracer and the denoiser see
// no jitter, and the upscaler is fed the same unjittered motion (converted to NDC) and the G-buffer depth.
//
// Colour: the upscaler wants linear, pre-tone-mapping input (its contract). When the page shows a
// tone-mapped view (`toneView = true`), `linear` reads 1 and the page's display graph outputs the linear
// colour; `resolve()` then tone-maps the upscaled image with the page's `tone`. Debug views (and the
// TemporalAA mode, as before) feed the display-referred image.
//
// Reactive mask (the upscaler favours the current frame there): `setReactive(node)` renders a page node
// (red in [0, 1]) at the render size each frame; the pages mark the reflection's share of the final colour,
// gated by the pixel's motion (D4202).
import * as THREE from 'three/webgpu';
import { texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { QualityMode, Upscaler, getQualityModeRatio, getRenderResolution } from '@pmndrs/upscaler';
import { TemporalAA } from './taa';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export type AAMode = 'upscaler' | 'taa' | 'off';
export const AA_MODES: Record<AAMode, string> = { upscaler: 'Upscaler (@pmndrs/upscaler)', taa: 'TAA (W40)', off: 'Off' };
const PRESETS: Record<string, QualityMode> = {
  native: QualityMode.NativeAA, quality: QualityMode.Quality, balanced: QualityMode.Balanced,
  performance: QualityMode.Performance, ultra: QualityMode.UltraPerformance,
};

/**
 * The upscaler's settings on these pages (D4201), measured on facingMirrors (W36): RCAS off (its default
 * 0.8 sharpens each jitter phase's edge differently: mirror-edge px flickering > 1/255 at rest 0.16% -> 4.2%)
 * and a 128-frame history cap (its default 24 leaves the reflections' residual noise and the edges' jitter
 * at rest: 0.48% vs 0.02%; W40's TAA settled at 128 too). Neither changes the slow orbit.
 */
export const UPSCALER_DEFAULTS = { sharpness: 0, maxAccumulation: 128 };

/**
 * `?aa=upscaler|taa|off` (default `fallback`; `?taa=0` = off, `?taa=1` = the upscaler, for old links),
 * `?upscale=native|quality|balanced|performance|ultra` or a ratio >= 1 (default native, ratio 1), and the
 * upscaler's `?sharpness=` / `?accum=` (maxAccumulation) over UPSCALER_DEFAULTS.
 */
export function aaFromQuery(q: URLSearchParams, fallback: AAMode = 'upscaler'): { mode: AAMode; ratio: number; settings: { sharpness: number; maxAccumulation: number } } {
  let mode: AAMode = fallback;
  if (q.has('taa')) mode = q.get('taa') === '0' ? 'off' : 'upscaler';
  const a = q.get('aa');
  if (a && a in AA_MODES) mode = a as AAMode;
  const u = q.get('upscale') ?? 'native';
  const ratio = u in PRESETS ? getQualityModeRatio(PRESETS[u]) : Math.max(1, Number(u) || 1);
  const settings = { ...UPSCALER_DEFAULTS };
  if (q.has('sharpness')) settings.sharpness = Number(q.get('sharpness'));
  if (q.has('accum')) settings.maxAccumulation = Number(q.get('accum'));
  return { mode, ratio, settings };
}

/** The render (G-buffer) size for a display size at `ratio` (the upscaler's rounding: floored). */
export const renderSize = (displayWidth: number, displayHeight: number, ratio: number) => getRenderResolution(displayWidth, displayHeight, ratio);

/**
 * The pages' reactive mask (D4202): `scale` x the reflection's share of the final colour (luma of
 * weight x specular over the final's) x how far the pixel moved (saturating at 1 px / frame). A
 * reflection does not move with its surface, so where the surface moves the upscaler's reprojection
 * puts the reflected image's history in the wrong place; at rest the gate is 0 and the reflections keep
 * their full history (their residual noise is what the accumulation is there to settle).
 */
export function reflectionReactive(c: { weight: N; specular: N; final: N; geometry: N }, motion: THREE.Texture, scale: number): N {
  const luma = (x: N) => x.dot(vec3(0.2126, 0.7152, 0.0722));
  const share: N = luma(c.weight.mul(c.specular)).div(luma(c.final.rgb).max(1e-4)).clamp(0, 1);
  const m: N = texture(motion);
  const px: N = m.xy.mul(vec2(m.size())).length();
  return c.geometry.select(share.mul(px.clamp(0, 1)).mul(scale), 0);
}

export interface DisplayAAOptions {
  mode: AAMode;
  /** display / render per axis (1 = native). */
  ratio: number;
  /** Upscaler runtime settings over its defaults (UPSCALER_DEFAULTS on the pages). */
  settings?: { sharpness?: number; maxAccumulation?: number };
  displayWidth: number;
  displayHeight: number;
  /** The page's tone mapping + output encoding (applied after the upscaler for tone-mapped views). */
  tone: (c: N) => N;
}

/** The G-buffer pieces the upscaler reads: uv-space motion (current - previous, y down) and the depth texture. */
interface GBufferLike { textures: { motion?: THREE.Texture; depth: THREE.DepthTexture } }

export class DisplayAA {
  readonly upscaler: Upscaler;
  readonly ratio: number;
  /** 1 while the page should output linear colour (upscaler mode and a tone-mapped view). */
  readonly linear = uniform(0);
  /** Set by the page per view: true when the view is a tone-mapped image (final, raw, ...). */
  toneView = true;
  displayWidth: number;
  displayHeight: number;
  renderWidth: number;
  renderHeight: number;
  private modeValue: AAMode;
  private readonly taa: TemporalAA;
  /** The display pipeline's target in 'upscaler' / 'off' at ratio > 1 (render size). */
  private readonly input: THREE.RenderTarget;
  /** TemporalAA's resolve at ratio > 1, stretched to the canvas. */
  private readonly taaOut: THREE.RenderTarget;
  /** The G-buffer motion converted to the upscaler's convention (NDC current - previous, y up). */
  private readonly velocity: THREE.RenderTarget;
  private readonly velocityQuad: THREE.QuadMesh;
  private readonly reactiveRT: THREE.RenderTarget;
  private readonly reactiveMaterial = new THREE.NodeMaterial();
  private readonly reactiveQuad: THREE.QuadMesh;
  private hasReactive = false;
  /** Upscaler output -> canvas (tone-mapped when `linear`); and a plain stretch of a render-size image. */
  private readonly present: THREE.RenderPipeline;
  private readonly presentNode: N;
  private readonly stretch: THREE.RenderPipeline;
  private readonly stretchNode: N;
  private tone: (c: N) => N;
  private pendingReset = true;

  constructor(private readonly renderer: THREE.WebGPURenderer, private readonly gbuffer: GBufferLike, o: DisplayAAOptions) {
    this.modeValue = o.mode;
    this.ratio = o.ratio;
    this.tone = o.tone;
    this.displayWidth = o.displayWidth; this.displayHeight = o.displayHeight;
    const r = getRenderResolution(o.displayWidth, o.displayHeight, o.ratio);
    this.renderWidth = r.width; this.renderHeight = r.height;
    const rt = (w: number, h: number, format: THREE.PixelFormat = THREE.RGBAFormat, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter) => {
      const t = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, format, depthBuffer: false });
      t.texture.minFilter = t.texture.magFilter = filter;
      t.texture.generateMipmaps = false;
      return t;
    };
    const { renderWidth: rw, renderHeight: rh } = this;
    this.input = rt(rw, rh);
    this.input.texture.name = 'aa input';
    this.taaOut = rt(rw, rh);
    this.velocity = rt(rw, rh, THREE.RGFormat, THREE.NearestFilter);
    this.velocity.texture.name = 'aa velocity (ndc)';
    this.reactiveRT = rt(rw, rh, THREE.RedFormat, THREE.NearestFilter);
    this.reactiveRT.texture.name = 'aa reactive';
    this.taa = new TemporalAA(renderer, gbuffer.textures.motion!, rw, rh);

    // ndc = uv x (2, -2) (D401: the G-buffer's motion is uv-space, y down)
    const vm = new THREE.NodeMaterial();
    vm.fragmentNode = vec4((texture(gbuffer.textures.motion!) as N).xy.mul(vec2(2, -2)), 0, 1);
    this.velocityQuad = new THREE.QuadMesh(vm);
    this.reactiveQuad = new THREE.QuadMesh(this.reactiveMaterial);

    this.upscaler = new Upscaler({ renderer, gpuTiming: true });
    Object.assign(this.upscaler.settings, o.settings ?? {});
    this.configure();

    this.present = new THREE.RenderPipeline(renderer);
    this.present.outputColorTransform = false;
    this.presentNode = texture(this.upscaler.outputTexture);
    this.buildPresent();
    this.stretch = new THREE.RenderPipeline(renderer);
    this.stretch.outputColorTransform = false;
    this.stretchNode = texture(this.input.texture);
    this.stretch.outputNode = vec4(this.stretchNode.rgb, 1);
  }

  private configure() {
    this.upscaler.configure({ displayWidth: this.displayWidth, displayHeight: this.displayHeight, renderWidth: this.renderWidth, renderHeight: this.renderHeight, path: 'temporal' });
    this.pendingReset = true;
  }

  private buildPresent() {
    const c: N = this.presentNode;
    this.present.outputNode = vec4((this.linear as N).equal(1).select(this.tone(c.rgb), c.rgb), 1);
    this.present.needsUpdate = true;
  }

  async init() { await this.upscaler.init(); }

  get mode() { return this.modeValue; }
  set mode(m: AAMode) {
    if (m === this.modeValue) return;
    this.modeValue = m;
    this.reset();
  }

  /** Tone mapping changed (showcase's selector): the upscaled image is tone-mapped with this. */
  setTone(tone: (c: N) => N) { this.tone = tone; this.buildPresent(); }

  /** A node (red = reactivity in [0, 1]) rendered at the render size, or null for none. */
  setReactive(node: N | null) {
    this.hasReactive = !!node;
    if (node) { this.reactiveMaterial.fragmentNode = vec4(node, 0, 0, 1); this.reactiveMaterial.needsUpdate = true; }
  }

  /** Display size changed: returns the new render size (the G-buffer's). */
  setSize(displayWidth: number, displayHeight: number) {
    this.displayWidth = displayWidth; this.displayHeight = displayHeight;
    const r = getRenderResolution(displayWidth, displayHeight, this.ratio);
    this.renderWidth = r.width; this.renderHeight = r.height;
    for (const t of [this.input, this.taaOut, this.velocity, this.reactiveRT]) t.setSize(r.width, r.height);
    this.taa.setSize(r.width, r.height);
    this.configure();
    return r;
  }

  /** Drop the history (camera cut, scene switch, view change). */
  reset() { this.taa.reset(); this.pendingReset = true; }

  /** Where the page's display pipeline renders this frame (null: the canvas). */
  get target(): THREE.RenderTarget | null {
    if (this.modeValue === 'taa') return this.taa.input;
    return this.modeValue === 'upscaler' || this.ratio > 1 ? this.input : null;
  }

  /** Apply this mode's jitter to `camera`; returns what `FrameGBuffer.render` / `ssr.render` take (D405). */
  begin(camera: THREE.PerspectiveCamera): { jitter?: readonly [number, number]; projection?: ArrayLike<number> } {
    this.linear.value = this.modeValue === 'upscaler' && this.toneView ? 1 : 0;
    if (this.modeValue === 'taa') { this.taa.enabled = true; return this.taa.jitter(camera, this.renderWidth, this.renderHeight); }
    if (this.modeValue !== 'upscaler') return {};
    this.upscaler.beginFrame(camera);
    const j = this.upscaler.jitter;
    return { jitter: [j.x, j.y], projection: this.upscaler.unjitteredProjectionMatrix.elements.slice() };
  }

  /** Undo `begin()` (the controls and the composite's matrices see the plain camera). */
  end(camera: THREE.PerspectiveCamera) {
    if (this.modeValue === 'taa') this.taa.restore(camera);
    else if (this.modeValue === 'upscaler') this.upscaler.endFrame(camera);
  }

  /** After the display pipeline rendered into `target`: resolve / upscale and present to the canvas. */
  resolve(camera: THREE.PerspectiveCamera, deltaTime = 1 / 60) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    if (this.modeValue === 'taa') {
      this.taa.resolve(this.ratio > 1 ? this.taaOut : null);
      if (this.ratio > 1) this.blit(this.taaOut.texture);
    } else if (this.modeValue === 'upscaler') {
      r.setRenderTarget(this.velocity); this.velocityQuad.render(r);
      if (this.hasReactive) { r.setRenderTarget(this.reactiveRT); this.reactiveQuad.render(r); }
      r.setRenderTarget(prev);
      this.upscaler.dispatch({
        color: this.input.texture, depth: this.gbuffer.textures.depth, velocity: this.velocity.texture,
        reactive: this.hasReactive ? this.reactiveRT.texture : undefined, deltaTime, reset: this.pendingReset,
      }, camera);
      this.pendingReset = false;
      this.presentNode.value = this.upscaler.outputTexture; // reallocated by configure()
      r.setRenderTarget(null);
      this.present.render();
    } else if (this.ratio > 1) this.blit(this.input.texture);
    r.setRenderTarget(prev);
  }

  /** A render-size display image stretched (bilinear) to the canvas: 'taa' / 'off' at ratio > 1. */
  private blit(t: THREE.Texture) {
    this.stretchNode.value = t;
    this.renderer.setRenderTarget(null);
    this.stretch.render();
  }

  /** The upscaler's per-pass GPU ms of the latest timed frame (empty without timestamp-query). */
  get timings(): ReadonlyMap<string, number> { return this.upscaler.gpuTimings; }

  dispose() {
    for (const t of [this.input, this.taaOut, this.velocity, this.reactiveRT]) t.dispose();
    this.taa.dispose();
    this.upscaler.dispose();
  }
}
