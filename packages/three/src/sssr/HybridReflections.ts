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
  createReflectionDenoiseSeam, type ReflectionDenoiseSeam, type SpecularInputs, type TemporalDenoiser,
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
}

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
  private seam: ReflectionDenoiseSeam | null = null;
  private readonly quad: THREE.QuadMesh;
  private readonly signalMaterial = new THREE.NodeMaterial();
  private ran = false;

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
    // the signal as rendered: full screen, no denoised input
    this.signalMaterial.fragmentNode = vec4(this.composite({ signalOnly: true }).signal, 1);
    this.signalMaterial.needsUpdate = true;
    this.ran = false;
  }

  /**
   * Build a composite (TSL nodes) that uses the denoised radiance while the denoiser runs. Pass a
   * `uv` to composite at another screen uv (e.g. a debug grid cell).
   */
  composite(opts: { uv?: N; signalOnly?: boolean } = {}): ScreenSpaceComposite {
    const { denoiser: _d, denoiserMotion: _m, denoiserRoughness: _r, ...rest } = this.options;
    return screenSpaceComposite(this.ssr, {
      ...rest, uv: opts.uv ?? uv(),
      denoised: opts.signalOnly ? null : this.denoised, denoise: this.denoiseActive, depthAware: this.depthAware,
    });
  }

  /** Per frame, after `ssr.render()` (or `ssr.trace()`): render the signal and denoise it. */
  update() {
    const frame = this.ssr.gbuffer.frame;
    const tracer = this.ssr.tracer;
    this.roughnessThreshold.value = this.ssr.settings.roughnessThreshold ?? 0.447;
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
    });
    if (!(renderer as N).backend.get(this.denoised)?.texture) renderer.initTexture(this.denoised);
    const device = this.ssr.device;
    const enc = device.createCommandEncoder({ label: 'hybrid denoised copy' });
    enc.copyTextureToTexture({ texture: out }, { texture: getGPUTexture(renderer, this.denoised) }, [w, h]);
    device.queue.submit([enc.finish()]);
    this.denoiseActive.value = 1;
    this.ran = true;
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
    this.denoised.dispose();
    this.signalTarget.dispose();
    this.signalMaterial.dispose();
  }
}
