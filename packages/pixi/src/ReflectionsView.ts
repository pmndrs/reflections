// A pixi Sprite that shows a reflective pixi-3d view: pixi-3d draws the scene (colour, depth, motion,
// the reflections G-buffer pass), the adapter unpacks it into the frame contract (./frame.ts), core's
// screen-space tracer (and probes) reflect it, and a ReflectionsFilter on the sprite composites and
// presents it. Put it on the stage like any sprite, draw pixi UI over it, add more filters.
//
//   const reflections = new ReflectionsView({ renderer: app.renderer, width: 960, height: 540, probes });
//   view3d.setSize(reflections.pixelWidth, reflections.pixelHeight);
//   view3d.passes = [depthPass, motionPass, gbufferPass];
//   app.stage.addChild(reflections);
//   app.ticker.add(() => {
//     renderer.render({ container: view3d, target: reflections.colorTarget });
//     reflections.render({ depth: depthPass.texture, motion: motionPass.texture, gbuffer: gbufferPass.texture }, view3d.camera);
//   }, undefined, UPDATE_PRIORITY.HIGH);   // before pixi renders the stage
//
// `render()` records the unpack, the tracer and the repack on pixi's queue; pixi's next stage
// render (the filter) samples the results.
import { RenderTexture, Sprite, type Renderer } from 'pixi.js';
import type { FrameInputs, ScreenSpaceReflectionsSettings, ScreenSpaceVariant } from '@pmndrs/reflections-core';
import { Pixi3DFrame, Pixi3DFrameTargets, type Pixi3DFrameSources } from './frame';
import { getDevice } from './internal/pixiWebGPU';
import type { Pixi3DCameraLike } from './pixi3d';
import type { PixiProbeSet } from './probes';
import { ReflectionsFilter, type ReflectionsFilterOptions, type ReflectionViewName } from './ReflectionsFilter';
import { ScreenSpaceReflections, type ScreenSpaceReflectionsOptions } from './ScreenSpaceReflections';

export interface ReflectionsViewOptions {
  /** An initialized pixi WebGPURenderer. */
  renderer: Renderer;
  /** Size on the stage (pixi units). */
  width: number;
  height: number;
  /** Frame pixels per pixi unit. Default: the renderer's resolution. */
  resolution?: number;
  /** Probes + environment for misses and rough pixels. Default: none (constant fallback). */
  probes?: PixiProbeSet | null;
  /** Tracer variant. Default 'auto'. */
  variant?: 'auto' | ScreenSpaceVariant;
  /** Tracer settings (live: `view.ssr.settings`). */
  settings?: ScreenSpaceReflectionsSettings;
  /** Composite options (live: `view.composite`). */
  composite?: ReflectionsFilterOptions;
  timestamps?: boolean;
  /** A denoiser-core `TemporalDenoiser<SpecularInputs>` on pixi's device (see ScreenSpaceReflections). */
  denoiser?: ScreenSpaceReflectionsOptions['denoiser'];
}

export class ReflectionsView extends Sprite {
  readonly pixiRenderer: Renderer;
  readonly device: GPUDevice;
  readonly frame: Pixi3DFrame;
  readonly ssr: ScreenSpaceReflections;
  readonly composite: ReflectionsFilter;
  /** The frame handed to core by the last `render()` (debug, the denoise seam). */
  lastFrame: FrameInputs | null = null;
  private targetsNow: Pixi3DFrameTargets;
  private color: RenderTexture;
  private viewResolution: number;

  constructor(o: ReflectionsViewOptions) {
    super();
    this.pixiRenderer = o.renderer;
    this.device = getDevice(o.renderer);
    this.viewResolution = o.resolution ?? o.renderer.resolution;
    this.frame = new Pixi3DFrame(o.renderer);
    this.ssr = new ScreenSpaceReflections({ renderer: o.renderer, probes: o.probes, variant: o.variant, settings: o.settings, timestamps: o.timestamps, denoiser: o.denoiser });
    [this.targetsNow, this.color] = this.allocate(o.width, o.height);
    this.composite = new ReflectionsFilter(this.filterSources(), o.composite);
    this.filters = [this.composite];
  }

  private allocate(width: number, height: number): [Pixi3DFrameTargets, RenderTexture] {
    const w = Math.max(16, Math.round(width * this.viewResolution)), h = Math.max(16, Math.round(height * this.viewResolution));
    const targets = new Pixi3DFrameTargets(this.pixiRenderer, w, h);
    // linear HDR, single-sampled (pixi-3d's DepthOutputPass can't read a multisampled depth)
    const color = RenderTexture.create({ width: w, height: h, resolution: 1, format: 'rgba16float', antialias: false, autoGenerateMipmaps: false });
    this.ssr.configure(w, h);
    this.texture = color;
    this.scale.set(1 / this.viewResolution);
    return [targets, color];
  }

  /** Render the View3D here (`renderer.render({ container: view3d, target: view.colorTarget })`): rgba16float, the frame's size. */
  get colorTarget(): RenderTexture { return this.color; }

  /** The textures a ReflectionsFilter reads (for a second filtered sprite, e.g. a debug inset). */
  filterSources() {
    const t = this.targetsNow;
    return {
      sceneColor: this.color, normal: t.normal.texture, material: t.material.texture, motion: t.motion.texture,
      reflection: this.ssr.reflection, aux: this.ssr.aux,
    };
  }

  /** The unpacked frame (pixi textures + raw handles). */
  get targets(): Pixi3DFrameTargets { return this.targetsNow; }
  /** Frame size in pixels: size the View3D to it. */
  get pixelWidth() { return this.targetsNow.width; }
  get pixelHeight() { return this.targetsNow.height; }

  /** Resizes the view (pixi units); reallocates the frame and the tracer. Size the View3D again after. */
  resize(width: number, height: number, resolution = this.viewResolution) {
    this.viewResolution = resolution;
    const [oldTargets, oldColor] = [this.targetsNow, this.color];
    [this.targetsNow, this.color] = this.allocate(width, height);
    this.composite.setSources(this.filterSources());
    oldTargets.destroy();
    oldColor.source.unload();
    this.resetHistory();
  }

  /** The next frame has no previous one (camera cut). */
  resetHistory() {
    this.frame.resetHistory();
    this.ssr.resetHistory();
  }

  /** Screen-space tracing on / off (off: probes / environment only). */
  get ssrEnabled() { return this.ssr.enabled; }
  set ssrEnabled(on: boolean) { this.ssr.enabled = on; }

  /** The composite's debug view. */
  get debugView(): ReflectionViewName { return this.composite.view; }
  set debugView(v: ReflectionViewName) { this.composite.view = v; }

  /**
   * Unpacks this frame's pixi-3d outputs and runs the reflections (submits). Call once per frame
   * after pixi rendered the View3D into `colorTarget` and before pixi renders the stage.
   */
  render(sources: Omit<Pixi3DFrameSources, 'color'> & { color?: Pixi3DFrameSources['color'] }, camera: Pixi3DCameraLike) {
    const encoder = this.device.createCommandEncoder({ label: 'pixi reflections' });
    const frame = this.frame.build(encoder, { ...sources, color: sources.color ?? this.color }, camera, this.targetsNow);
    this.lastFrame = frame;
    this.ssr.dispatch(encoder, frame); // submits (and denoises when a denoiser is set)
  }

  override destroy(options?: Parameters<Sprite['destroy']>[0]) {
    super.destroy(options);
    this.composite.destroy();
    this.ssr.dispose();
    this.frame.dispose();
    this.targetsNow.destroy();
    this.color.destroy(true);
  }
}
