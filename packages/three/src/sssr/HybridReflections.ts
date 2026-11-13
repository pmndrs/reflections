// Hybrid resolve (docs/SPEC.md section 5) for three: SSR -> ray-traced hits (optional) -> local
// probes (by coverage) -> environment, by confidence and coverage, with the noisy part denoised
// through the denoise seam (core `createReflectionDenoiseSeam`, any denoiser-core-shaped
// `TemporalDenoiser<SpecularInputs>`, e.g. `FfxReflectionDenoiser` from `denoiser/ffx`).
//
//   const ssr = new ScreenSpaceReflectionsPass(renderer);
//   const hybrid = new HybridReflections(ssr, { probes, environment, environmentIntensity,
//     denoiser: new FfxReflectionDenoiser(ssr.device, { roughnessThreshold: 0.447 ** 2 }) });
//   pipeline.outputNode = renderOutput(hybrid.composite().final);
//   // per frame:
//   ssr.render(scene, camera); hybrid.update(); pipeline.render();
//
// Per frame `update()` renders the composite's raw specular signal (hit x w + (1 - w) x SO x
// probe/env, w the composite's `ssrWeight`: the confidence, depth-aware by default, D2400) into an
// rgba16float target, runs the seam on it with the tracer's hit distance and the
// frame's guides, and copies the denoiser's output into `denoised`. Composites built by
// `composite()` read it where `denoise` is on. Without a denoiser the composite is the raw signal
// (SPEC: "with no denoiser, the resolve falls back to the probe term for rough pixels and to the raw
// trace for mirrors", which is what the raw signal already is).
import * as THREE from 'three/webgpu';
import { float, uniform, uv, vec3, vec4 } from 'three/tsl';
import {
  createReflectionDenoiseSeam, createReflectionUpsample, PassTimer,
  type FrameInputs, type ReflectionDenoiseSeam, type ReflectionUpsample, type ReflectionUpsampleSettings, type SpecularInputs, type TemporalDenoiser,
} from '@pmndrs/reflections-core';
import { getGPUTexture } from '../frame/FrameGBuffer';
import { screenSpaceComposite, type ScreenSpaceComposite, type ScreenSpaceCompositeOptions } from './composite';
import type { ScreenSpaceReflectionsPass } from './ScreenSpaceReflectionsPass';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface HybridReflectionsOptions extends Omit<ScreenSpaceCompositeOptions, 'uv' | 'denoised' | 'denoise' | 'depthAware'> {
  /**
   * A denoiser-core `TemporalDenoiser<SpecularInputs>` on the pass's device. Its roughness gate
   * should match the tracer's (FFX: `roughnessThreshold` in alpha, 0.447^2 for our default). Null:
   * no denoising.
   */
  denoiser?: TemporalDenoiser<SpecularInputs> | null;
  /** Motion convention the denoiser reads: 'ndc' (default, denoiser-core / FFX) or 'uv'. */
  denoiserMotion?: 'ndc' | 'uv';
  /** Roughness space the denoiser reads in `guides.roughness`: 'perceptual' (default, FFX's default) or 'alpha'. */
  denoiserRoughness?: 'perceptual' | 'alpha';
  /** Initial value of `HybridReflections.denoiserHitSource`. Default false. */
  denoiserHitSource?: boolean;
}

/** A three StorageTexture for the upsample's full-res outputs (W75). */
const storage = (name: string, w: number, h: number, type: THREE.TextureDataType, format: THREE.AnyPixelFormat) => {
  const t = new THREE.StorageTexture(w, h);
  t.name = name;
  t.type = type;
  t.format = format;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
};

type Upsampled = { residual: THREE.StorageTexture; confidence: THREE.StorageTexture; hitDistance: THREE.StorageTexture; source: THREE.StorageTexture };

/** Source codes of `sourceIndex()` (debug view): what filled each pixel's reflection. */
export const HYBRID_SOURCE = {
  background: 0, ssr: 1, traced: 2, probe: 3, environment: 4, rough: 5,
} as const;

export class HybridReflections {
  readonly ssr: ScreenSpaceReflectionsPass;
  readonly options: HybridReflectionsOptions;
  /** The denoiser's output (rgba16float, render size), copied each frame `update()` denoises. */
  readonly denoised: THREE.StorageTexture;
  /** The raw signal as handed to the denoiser (rgba16float render target). */
  readonly signalTarget: THREE.RenderTarget;
  /** 1 while composites use the denoised radiance (set by `update()`; read by every composite). */
  readonly denoiseActive = uniform(0);
  /**
   * Depth-aware blend (W22, D2400; the composite's `depthAware`), shared by the signal pass and every
   * composite: 1 (default) keeps the probe off hits it lies behind, 0 = FFX's confidence blend.
   */
  readonly depthAware = uniform(1);
  /** The tracer's perceptual roughness threshold, for the source view. */
  readonly roughnessThreshold = uniform(0.447);
  /** Denoise when a denoiser is attached. Default true. */
  denoise = true;
  /**
   * W53 (D3660): hand the denoiser a per-pixel hit source (screen-space hit / traced hit / miss,
   * core `HIT_SOURCE`, built by the seam from the tracer's confidence and the ray-traced pass's
   * codes), so a denoiser that supports it keeps them apart (FFX: `separateHitSources: true`, set on
   * the denoiser itself). Default false: the denoiser gets what it got before.
   */
  denoiserHitSource = false;
  /**
   * W75 (X5): the joint bilateral upsample's weights (core `ReflectionUpsampleSettings`: plane
   * tolerance, normal power, roughness tolerance, source mask, min weight sum, wide fallback), read
   * every frame with `ssr.settings.reflectionResolution: 'half'`.
   */
  upsampleSettings: ReflectionUpsampleSettings = {};
  /**
   * W75: the half-res path's full-res targets (null until a composite is built in 'half' mode): the
   * upsampled residual (rgba16float, rgb = specular - (1 - ssrWeight) x SO x probeSpecular of the
   * half-res samples, a = their ssrWeight; D5081),
   * confidence, hit distance and source (r32float), read by composites built in 'half' mode.
   */
  get upsampled(): Upsampled | null { return this.up; }
  private seam: ReflectionDenoiseSeam | null = null;
  private readonly quad: THREE.QuadMesh;
  private readonly signalMaterial = new THREE.NodeMaterial();
  private ran = false;
  /** W75: the mode the signal material was built for ('mixed': half with the full-res mirror path); the half-res residual pass and its targets. */
  private builtMode: 'full' | 'half' | 'mixed' = 'full';
  private get builtHalf(): boolean { return this.builtMode !== 'full'; }
  /** W75 (X5 step 2): `ssr.settings.halfResMinRoughness`, read by composites built in 'mixed' mode. */
  private readonly mirrorMinRoughness = uniform(0);
  private up: Upsampled | null = null;
  private upsample: ReflectionUpsample | null = null;
  private residualTarget: THREE.RenderTarget | null = null;
  private readonly residualMaterial = new THREE.NodeMaterial();
  private residualQuad: THREE.QuadMesh | null = null;
  /** Maps a half-res target's uv to the full-res uv of its sample pixel (2x, 2y): uv x scale - offset. */
  private readonly halfUVScale = uniform(new THREE.Vector2(1, 1));
  private readonly halfUVOffset = uniform(new THREE.Vector2(0, 0));
  private timer: PassTimer | null = null;
  private timerDone: (() => void) | undefined;

  constructor(ssr: ScreenSpaceReflectionsPass, options: HybridReflectionsOptions = {}) {
    this.ssr = ssr;
    this.options = options;
    const { width: w, height: h } = ssr.gbuffer;
    this.denoised = new THREE.StorageTexture(w, h);
    this.denoised.name = 'hybrid denoised specular';
    this.denoised.type = THREE.HalfFloatType;
    this.denoised.minFilter = this.denoised.magFilter = THREE.NearestFilter;
    this.denoised.generateMipmaps = false;
    this.signalTarget = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    this.signalTarget.texture.name = 'hybrid specular signal';
    this.quad = new THREE.QuadMesh(this.signalMaterial);
    this.denoiserHitSource = options.denoiserHitSource ?? false;
    this.setDenoiser(options.denoiser ?? null);
  }

  /** The attached denoiser (null: none). */
  get denoiser(): TemporalDenoiser<SpecularInputs> | null { return this.seam?.denoiser ?? null; }
  /** The seam (guides of the last frame, for debug). */
  get denoiseSeam(): ReflectionDenoiseSeam | null { return this.seam; }

  /** Attach or swap the denoiser (null detaches). The old one is not disposed. */
  setDenoiser(denoiser: TemporalDenoiser<SpecularInputs> | null) {
    this.seam?.destroy();
    this.seam = denoiser ? createReflectionDenoiseSeam(this.ssr.device, {
      denoiser, motion: this.options.denoiserMotion, roughness: this.options.denoiserRoughness,
    }) : null;
    this.rebuild();
  }

  /**
   * Rebuild the signal pass after changing `options` (probes, environment, ao: e.g. on a scene
   * switch); composites built before keep their old sources, so rebuild those too. Drops history.
   */
  rebuild() {
    this.builtMode = this.wantMode;
    if (this.builtHalf) {
      // W75 (X5): at half res, each texel composites its sample pixel (2x, 2y) of the full-res G-buffer
      const at = uv().mul(this.halfUVScale).sub(this.halfUVOffset);
      this.signalMaterial.fragmentNode = vec4(this.compositeAt({ uv: at, signalOnly: true }).signal, 1);
      const c = this.compositeAt({ uv: at });
      // the hit part of the half-res specular and its weight (D5081): the probe part is redone per full-res pixel
      this.residualMaterial.fragmentNode = vec4(c.specular.sub(c.ssrWeight.oneMinus().mul(c.specularOcclusion).mul(c.probeSpecular)), c.ssrWeight);
      this.residualMaterial.needsUpdate = true;
    } else {
      // the signal as rendered: full screen, no denoised input
      this.signalMaterial.fragmentNode = vec4(this.composite({ signalOnly: true }).signal, 1);
    }
    this.signalMaterial.needsUpdate = true;
    this.ran = false;
  }

  /** W75: the tracer's settings ask for half-res reflections. */
  private get wantHalf(): boolean { return (this.ssr.settings.reflectionResolution ?? 'full') === 'half'; }
  /** W75: 'full', 'half', or 'mixed' (half with mirrors on the full-res path, step 2). */
  private get wantMode(): 'full' | 'half' | 'mixed' {
    return !this.wantHalf ? 'full' : (this.ssr.settings.halfResMinRoughness ?? 0) > 0 ? 'mixed' : 'half';
  }

  /**
   * Build a composite (TSL nodes) that uses the denoised radiance while the denoiser runs. Pass a
   * `uv` to composite at another screen uv (e.g. a debug grid cell).
   */
  composite(opts: { uv?: N; signalOnly?: boolean } = {}): ScreenSpaceComposite {
    // W75: in 'half' mode composites read the upsampled residual (the mode at call time is built in)
    if (this.wantHalf && !opts.signalOnly) {
      const m = this.wantMode === 'mixed' ? { ...this.ssr.mirrorTargets(), minRoughness: this.mirrorMinRoughness } : null;
      return this.compositeAt({ uv: opts.uv ?? uv(), upsampled: { ...this.ensureUpsampled(), mirror: m } });
    }
    return this.compositeAt(opts);
  }

  private compositeAt(opts: { uv?: N; signalOnly?: boolean; upsampled?: ScreenSpaceCompositeOptions['upsampled'] }): ScreenSpaceComposite {
    const { denoiser: _d, denoiserMotion: _m, denoiserRoughness: _r, denoiserHitSource: _h, ...rest } = this.options;
    return screenSpaceComposite(this.ssr, {
      ...rest, uv: opts.uv ?? uv(),
      denoised: opts.signalOnly ? null : this.denoised, denoise: this.denoiseActive, depthAware: this.depthAware,
      ...(opts.upsampled ? { upsampled: opts.upsampled } : {}),
    });
  }

  /** W75: the upsample's full-res three targets, sized to the G-buffer. */
  private ensureUpsampled(): Upsampled {
    const { width: w, height: h } = this.ssr.gbuffer;
    this.up ??= {
      residual: storage('hybrid upsampled residual', w, h, THREE.HalfFloatType, THREE.RGBAFormat),
      confidence: storage('hybrid upsampled confidence', w, h, THREE.FloatType, THREE.RedFormat),
      hitDistance: storage('hybrid upsampled hit distance', w, h, THREE.FloatType, THREE.RedFormat),
      source: storage('hybrid upsampled source', w, h, THREE.FloatType, THREE.RedFormat),
    };
    return this.up;
  }

  /** With the pass's `timestamps`: GPU ms of the last half-res frame's upsample ('upsample'); empty in 'full' mode. */
  async readTimings(): Promise<ReadonlyMap<string, number>> {
    if (!this.timer || !this.builtHalf) return new Map();
    this.timerDone?.(); this.timerDone = undefined;
    await this.timer.read();
    return new Map(this.timer.timings);
  }

  /** Per frame, after `ssr.render()` (or `ssr.trace()`): render the signal and denoise it. */
  update() {
    const frame = this.ssr.gbuffer.frame;
    const tracer = this.ssr.tracer;
    this.roughnessThreshold.value = this.ssr.settings.roughnessThreshold ?? 0.447;
    // W75: a mode change rebuilds the signal pass; composites the app built keep theirs (rebuild them)
    if (this.wantMode !== this.builtMode) this.rebuild();
    this.mirrorMinRoughness.value = this.ssr.settings.halfResMinRoughness ?? 0;
    if (this.builtHalf && frame && tracer && this.ssr.resolution === 'half') { this.updateHalf(frame); return; }
    if (!this.seam || !this.denoise || !frame || !tracer) { this.denoiseActive.value = 0; this.ran = false; return; }
    const { renderer } = this.ssr;
    const { width: w, height: h } = frame;
    if (this.signalTarget.width !== w || this.signalTarget.height !== h) {
      this.signalTarget.setSize(w, h);
      (this.denoised as unknown as { setSize(w: number, h: number): void }).setSize(w, h);
    }
    if (!this.ran) this.seam.resetHistory(); // re-enabled after a pause: stale history
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.signalTarget);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    const out = this.seam.dispatch(frame, {
      radiance: getGPUTexture(renderer, this.signalTarget.texture),
      hitDistance: tracer.outputs.hitDistance,
    }, this.denoiserHitSource ? {
      confidence: tracer.outputs.confidence,
      traceSource: this.ssr.rayTracing ? getGPUTexture(renderer, this.ssr.source) : null,
    } : null);
    if (!(renderer as N).backend.get(this.denoised)?.texture) renderer.initTexture(this.denoised);
    const device = this.ssr.device;
    const enc = device.createCommandEncoder({ label: 'hybrid denoised copy' });
    enc.copyTextureToTexture({ texture: out }, { texture: getGPUTexture(renderer, this.denoised) }, [w, h]);
    device.queue.submit([enc.finish()]);
    this.denoiseActive.value = 1;
    this.ran = true;
  }

  /**
   * W75 (X5) 'half': the signal at half res (each texel at its sample pixel), the seam on the half
   * frame, the hit part `specular - (1 - ssrWeight) SO probeSpecular` and ssrWeight at half res (D5081), then core's joint bilateral upsample
   * of the residual, confidence, hit distance and source into the full-res targets composites read.
   */
  private updateHalf(frame: FrameInputs) {
    const { renderer } = this.ssr;
    const device = this.ssr.device;
    const half = this.ssr.traceFrame!;
    const { width: hw, height: hh } = half;
    const { width: w, height: h } = frame;
    this.halfUVScale.value.set(2 * hw / w, 2 * hh / h);
    this.halfUVOffset.value.set(0.5 / w, 0.5 / h);
    const sizeTo = (t: { width: number; height: number }, x: number, y: number) => {
      if (t.width !== x || t.height !== y) (t as unknown as { setSize(w: number, h: number): void }).setSize(x, y);
    };
    const init = (t: THREE.Texture) => { if (!(renderer as N).backend.get(t)?.texture) renderer.initTexture(t); };
    sizeTo(this.signalTarget, hw, hh);
    sizeTo(this.denoised, hw, hh);
    this.residualTarget ??= new THREE.RenderTarget(hw, hh, { type: THREE.HalfFloatType, depthBuffer: false });
    this.residualTarget.texture.name = 'hybrid half-res residual';
    sizeTo(this.residualTarget, hw, hh);
    const up = this.ensureUpsampled();
    for (const t of Object.values(up)) sizeTo(t, w, h);
    const prev = renderer.getRenderTarget();
    const denoising = !!this.seam && this.denoise;
    if (denoising) {
      if (!this.ran) this.seam!.resetHistory();
      renderer.setRenderTarget(this.signalTarget);
      this.quad.render(renderer);
      const out = this.seam!.dispatch(half, {
        radiance: getGPUTexture(renderer, this.signalTarget.texture),
        hitDistance: this.ssr.tracer!.outputs.hitDistance,
      }, this.denoiserHitSource ? {
        confidence: this.ssr.tracer!.outputs.confidence,
        traceSource: this.ssr.rayTracing ? getGPUTexture(renderer, this.ssr.source) : null,
      } : null);
      init(this.denoised);
      const enc = device.createCommandEncoder({ label: 'hybrid denoised copy (half)' });
      enc.copyTextureToTexture({ texture: out }, { texture: getGPUTexture(renderer, this.denoised) }, [hw, hh]);
      device.queue.submit([enc.finish()]);
    } else init(this.denoised);
    this.denoiseActive.value = denoising ? 1 : 0;
    this.ran = denoising;
    // the residual of the half-res samples (denoised, or the raw signal without the denoiser)
    this.residualQuad ??= new THREE.QuadMesh(this.residualMaterial);
    renderer.setRenderTarget(this.residualTarget);
    this.residualQuad.render(renderer);
    renderer.setRenderTarget(prev);
    if (!this.upsample || this.upsample.width !== w || this.upsample.height !== h) {
      this.upsample?.destroy();
      this.upsample = createReflectionUpsample(device, { width: w, height: h });
    }
    for (const t of Object.values(up)) init(t);
    if (this.ssr.timestamps && !this.timer && PassTimer.supported(device)) this.timer = new PassTimer(device, 2);
    const enc = device.createCommandEncoder({ label: 'hybrid upsample' });
    this.timer?.begin();
    this.upsample.dispatch(enc, {
      frame,
      radiance: getGPUTexture(renderer, this.residualTarget.texture),
      hitDistance: getGPUTexture(renderer, this.ssr.hitDistance),
      confidence: getGPUTexture(renderer, this.ssr.confidence),
      source: this.ssr.rayTracing && this.ssr.traced ? getGPUTexture(renderer, this.ssr.source) : null,
      targets: {
        radiance: getGPUTexture(renderer, up.residual), confidence: getGPUTexture(renderer, up.confidence),
        hitDistance: getGPUTexture(renderer, up.hitDistance), source: getGPUTexture(renderer, up.source),
      },
    }, { minRoughness: this.ssr.mirrorPath ? this.ssr.settings.halfResMinRoughness ?? 0 : 0, ...this.upsampleSettings }, this.timer?.pass('upsample'));
    this.timerDone = this.timer?.end(enc);
    device.queue.submit([enc.finish()]);
  }

  /** Drop the denoiser's history (camera cut, scene switch). */
  resetHistory() { this.seam?.resetHistory(); }

  /**
   * Debug: which source filled each pixel (HYBRID_SOURCE): background, SSR hit (the composite's
   * `ssrWeight` >= 0.5; FFX's confidence with the depth-aware blend off),
   * traced hit, rough (above the threshold, probe/env only), else the miss's fallback (probe where
   * local coverage >= 0.5, environment otherwise).
   */
  static sourceIndex(c: ScreenSpaceComposite, roughnessThreshold: N): N {
    const src = c.source.add(0.5).floor();
    const traced = src.equal(1).or(src.equal(4));
    const fallback = c.coverage.greaterThanEqual(0.5).select(float(HYBRID_SOURCE.probe), float(HYBRID_SOURCE.environment));
    const rough = c.roughness.greaterThanEqual(roughnessThreshold);
    return c.geometry.not().select(float(HYBRID_SOURCE.background),
      traced.select(float(HYBRID_SOURCE.traced),
        c.ssrWeight.greaterThanEqual(0.5).select(float(HYBRID_SOURCE.ssr),
          rough.select(float(HYBRID_SOURCE.rough), fallback))));
  }

  /** Debug colours for `sourceIndex`: SSR green, traced blue, probe orange, environment magenta, rough grey. */
  static sourceColor(c: ScreenSpaceComposite, roughnessThreshold: N): N {
    const s = HybridReflections.sourceIndex(c, roughnessThreshold);
    return s.equal(HYBRID_SOURCE.ssr).select(vec3(0.15, 0.85, 0.25),
      s.equal(HYBRID_SOURCE.traced).select(vec3(0.2, 0.45, 1),
        s.equal(HYBRID_SOURCE.probe).select(vec3(1, 0.55, 0.1),
          s.equal(HYBRID_SOURCE.environment).select(vec3(0.85, 0.2, 0.85),
            s.equal(HYBRID_SOURCE.rough).select(vec3(0.35), vec3(0.02, 0.03, 0.08))))));
  }

  dispose() {
    this.seam?.destroy();
    this.seam = null;
    this.upsample?.destroy();
    this.residualTarget?.dispose();
    this.residualMaterial.dispose();
    if (this.up) for (const t of Object.values(this.up)) t.dispose();
    this.timer?.destroy();
    this.denoised.dispose();
    this.signalTarget.dispose();
    this.signalMaterial.dispose();
  }
}
