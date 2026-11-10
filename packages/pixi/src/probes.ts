// Reflection probes for pixi: core's ProbeSet (atlas, volume table, prefilter, WGSL lookup) on pixi's
// device, captured by the adapter's own 3-D layer. SPEC "Capture stays in the adapter": the G-buffer
// renderer (./gbuffer.ts) draws six colour faces in WebGPU's cube orientation, core does the rest.
// The environment slot is a sky-only capture, so the radiance fallback for what no probe covers is
// the same procedural sky the view draws.
//
//   const probes = new PixiProbeSet(app.renderer, { capacity: 1 });
//   probes.setProbes([{ position: [0, 1.5, 0], influenceSize: [20, 6, 20], projectionSize: [20, 6, 20] }]);
//   await probes.bake(scene);
//   new ReflectionsView({ renderer: app.renderer, scene, probes, ... })
import type { Renderer } from 'pixi.js';
import { ProbeSet, type ProbeSetOptions, type ProbeVolume } from '@pmndrs/reflections-core';
import { GBufferRenderer } from './gbuffer';
import { getDevice } from './internal/pixiWebGPU';
import type { Vec3 } from './math';
import type { ReflectionScene } from './scene';

/** One probe: capture point (and influence-box centre) and the box it lights, world units. */
export interface PixiProbe {
  position: Vec3;
  influenceSize: Vec3;
  /** Box-projection size (parallax). Default: no box projection. */
  projectionSize?: Vec3;
  /** Influence fade distance. Default 1. */
  fade?: number;
  priority?: number;
}

export interface PixiProbeSetOptions extends Partial<Pick<ProbeSetOptions, 'sourceSize' | 'format' | 'dominantDirection' | 'lodMapping'>> {
  /** Probe slots. Default 2. */
  capacity?: number;
  /** Capture the sky into the environment slot. Default true. */
  environment?: boolean;
}

export class PixiProbeSet {
  readonly renderer: Renderer;
  readonly set: ProbeSet;
  private probes: PixiProbe[] = [];
  private readonly gbuffer: GBufferRenderer;
  private readonly cube: GPUTexture;
  private readonly depth: GPUTexture;

  constructor(renderer: Renderer, options: PixiProbeSetOptions = {}) {
    this.renderer = renderer;
    const device = getDevice(renderer);
    this.set = new ProbeSet(device, {
      capacity: options.capacity ?? 2,
      sourceSize: options.sourceSize ?? 128,
      format: options.format,
      dominantDirection: options.dominantDirection,
      lodMapping: options.lodMapping,
      environment: options.environment ?? true,
    });
    this.gbuffer = new GBufferRenderer(renderer);
    const n = this.set.sourceSize;
    this.cube = device.createTexture({
      label: 'pixi probe capture', size: [n, n, 6], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.depth = device.createTexture({ label: 'pixi probe capture depth', size: [n, n], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  /** Local probes contribute (off: the environment slot only). */
  get enabled() { return this.set.enabled; }
  set enabled(on: boolean) { this.set.enabled = on; this.set.update(); }

  setProbes(probes: readonly PixiProbe[]) {
    if (probes.length > this.set.capacity) throw new Error(`PixiProbeSet: ${probes.length} probes, capacity ${this.set.capacity}`);
    this.probes = [...probes];
    const volumes: ProbeVolume[] = this.probes.map((p, slot) => ({
      slot, center: p.position, halfSize: [p.influenceSize[0] / 2, p.influenceSize[1] / 2, p.influenceSize[2] / 2],
      fade: p.fade ?? 1, priority: p.priority,
      ...(p.projectionSize ? { boxProjection: true, projectionSize: p.projectionSize } : { boxProjection: false }),
    }));
    this.set.setVolumes(volumes);
    this.set.update();
  }

  getProbes(): readonly PixiProbe[] { return this.probes; }

  /**
   * Captures every probe (meshes with `inCaptures`, the sky behind them) and the environment (sky
   * only), prefilters them into the atlas and uploads the table. Call again after the scene changes.
   */
  async bake(scene: ReflectionScene, options: { near?: number; far?: number } = {}): Promise<void> {
    const device = this.set.device;
    const jobs = this.probes.map((p, slot) => ({ slot, position: p.position, skyOnly: false }));
    if (this.set.environmentSlot >= 0) jobs.push({ slot: this.set.environmentSlot, position: [0, 0, 0], skyOnly: true });
    // one capture texture: each job is captured, prefiltered and submitted before the next
    for (const job of jobs) {
      const encoder = device.createCommandEncoder({ label: `pixi probe capture ${job.slot}` });
      this.gbuffer.capture(encoder, scene, job.position, this.cube, this.depth, { ...options, skyOnly: job.skyOnly });
      this.set.capture(encoder, job.slot, this.cube);
      device.queue.submit([encoder.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
  }

  /** @internal the capture renderer (the example's orientation check). */
  get captureRenderer() { return this.gbuffer; }
  /** @internal the last capture (rgba16float, 6 layers). */
  get captureTexture() { return this.cube; }

  dispose() {
    this.gbuffer.dispose();
    this.cube.destroy();
    this.depth.destroy();
    this.set.dispose();
  }
}
