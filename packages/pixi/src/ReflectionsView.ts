// A pixi Sprite that shows a reflective 3-D view: the G-buffer pass (./gbuffer.ts) draws the scene,
// core's screen-space tracer (and probes) reflect it, and a ReflectionsFilter on the sprite composites
// and presents it. Put it on the stage like any sprite, draw pixi UI over it, add more filters.
//
//   const view = new ReflectionsView({ renderer: app.renderer, scene, camera, width: 960, height: 540, probes });
//   app.stage.addChild(view);
//   app.ticker.add(() => view.render(), undefined, UPDATE_PRIORITY.HIGH);   // before pixi renders the stage
//
// `render()` records and submits the G-buffer, the tracer and the repack in one command buffer on
// pixi's queue; pixi's next stage render (the filter) samples the results. Textures that pixi itself
// renders into (RenderTextures used as material maps) must be rendered before `render()`.
import { Sprite, type Renderer } from 'pixi.js';
import type { FrameInputs, ScreenSpaceReflectionsSettings, ScreenSpaceVariant } from '@pmndrs/reflections-core';
import { PixiFrame } from './frame';
import { GBufferRenderer, GBufferTargets } from './gbuffer';
import { getDevice } from './internal/pixiWebGPU';
import { mat4Mul } from './math';
import type { PixiProbeSet } from './probes';
import { ReflectionsFilter, type ReflectionsFilterOptions, type ReflectionViewName } from './ReflectionsFilter';
import { ScreenSpaceReflections } from './ScreenSpaceReflections';
import type { ReflectionCamera, ReflectionScene } from './scene';

export interface ReflectionsViewOptions {
  /** An initialized pixi WebGPURenderer. */
  renderer: Renderer;
  scene: ReflectionScene;
  camera: ReflectionCamera;
  /** Size on the stage (pixi units). */
  width: number;
  height: number;
  /** G-buffer pixels per pixi unit. Default: the renderer's resolution. */
  resolution?: number;
  /** Probes + environment for misses and rough pixels (bake them first). Default: none. */
  probes?: PixiProbeSet | null;
  /** Tracer variant. Default 'auto'. */
  variant?: 'auto' | ScreenSpaceVariant;
  /** Tracer settings (live: `view.ssr.settings`). */
  settings?: ScreenSpaceReflectionsSettings;
  /** Composite options (live: `view.composite`). */
  composite?: ReflectionsFilterOptions;
  timestamps?: boolean;
}

export class ReflectionsView extends Sprite {
  readonly pixiRenderer: Renderer;
  readonly device: GPUDevice;
  scene: ReflectionScene;
  camera: ReflectionCamera;
  readonly gbuffer: GBufferRenderer;
  readonly frame = new PixiFrame();
  readonly ssr: ScreenSpaceReflections;
  readonly composite: ReflectionsFilter;
  /** The frame handed to core by the last `render()` (debug, the denoise seam). */
  lastFrame: FrameInputs | null = null;
  private gtargets: GBufferTargets;
  private viewResolution: number;
  private prevViewProj: Float32Array | null = null;

  constructor(o: ReflectionsViewOptions) {
    super();
    this.pixiRenderer = o.renderer;
    this.device = getDevice(o.renderer);
    this.scene = o.scene;
    this.camera = o.camera;
    this.viewResolution = o.resolution ?? o.renderer.resolution;
    this.gbuffer = new GBufferRenderer(o.renderer);
    this.ssr = new ScreenSpaceReflections({ renderer: o.renderer, probes: o.probes, variant: o.variant, settings: o.settings, timestamps: o.timestamps });
    this.gtargets = this.allocate(o.width, o.height);
    this.composite = new ReflectionsFilter(this.filterSources(), o.composite);
    this.filters = [this.composite];
  }

  private allocate(width: number, height: number) {
    const w = Math.max(16, Math.round(width * this.viewResolution)), h = Math.max(16, Math.round(height * this.viewResolution));
    const targets = new GBufferTargets(this.pixiRenderer, w, h);
    this.ssr.configure(w, h);
    this.texture = targets.color.texture;
    this.scale.set(1 / this.viewResolution);
    return targets;
  }

  /** The textures a ReflectionsFilter reads (for a second filtered sprite, e.g. a debug inset). */
  filterSources() {
    const t = this.gtargets;
    return {
      sceneColor: t.color.texture, normal: t.normal.texture, material: t.material.texture, motion: t.motion.texture,
      reflection: this.ssr.reflection, aux: this.ssr.aux,
    };
  }

  /** The G-buffer targets (pixi textures + raw handles). */
  get targets(): GBufferTargets { return this.gtargets; }
  /** G-buffer size in pixels. */
  get pixelWidth() { return this.gtargets.width; }
  get pixelHeight() { return this.gtargets.height; }

  /** Resizes the view (pixi units); reallocates the G-buffer and the tracer. */
  resize(width: number, height: number, resolution = this.viewResolution) {
    this.viewResolution = resolution;
    const old = this.gtargets;
    this.gtargets = this.allocate(width, height);
    this.composite.setSources(this.filterSources());
    old.destroy();
    this.resetHistory();
  }

  /** The next frame has no previous one (camera cut). */
  resetHistory() {
    this.prevViewProj = null;
    this.frame.resetHistory();
    this.gbuffer.resetHistory(this.scene);
  }

  /** Screen-space tracing on / off (off: probes / environment only). */
  get ssrEnabled() { return this.ssr.enabled; }
  set ssrEnabled(on: boolean) { this.ssr.enabled = on; }

  /** The composite's debug view. */
  get debugView(): ReflectionViewName { return this.composite.view; }
  set debugView(v: ReflectionViewName) { this.composite.view = v; }

  /** Draws the G-buffer and runs the reflections (one submit). Call once per frame, before pixi renders the stage. */
  render() {
    const t = this.gtargets;
    const view = this.camera.view();
    const projection = this.camera.projection(t.width / t.height);
    const eye = this.camera.position;
    const encoder = this.device.createCommandEncoder({ label: 'pixi reflections' });
    this.gbuffer.render(encoder, this.scene, view, projection, eye, t, this.prevViewProj ?? undefined);
    const frame = this.frame.build(t, { view, projection, eye, near: this.camera.near, far: this.camera.far });
    this.lastFrame = frame;
    this.ssr.dispatch(encoder, frame);
    this.device.queue.submit([encoder.finish()]);
    this.gbuffer.commitHistory(this.scene);
    this.prevViewProj = mat4Mul(projection, view);
  }

  override destroy(options?: Parameters<Sprite['destroy']>[0]) {
    super.destroy(options);
    this.composite.destroy();
    this.ssr.dispose();
    this.gbuffer.dispose();
    this.gtargets.destroy();
  }
}
