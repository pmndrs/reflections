// One object that wires the pieces below into a three.js RenderPipeline: the G-buffer render,
// screen-space reflections, the ray-traced fallback (optional), reflection probes (the fallback for
// what the screen cannot see), the denoiser (optional) and the hybrid composite. It is built only
// from this package's own classes (ScreenSpaceReflectionsPass, HybridReflections, ReflectionProbes,
// the trace providers); it adds no maths. Every piece stays reachable (`ssr`, `hybrid`, `probes`,
// `pipeline`) for anything the options do not cover.
//
//   const renderer = await createReflectionsRenderer({ canvas });
//   const reflections = await Reflections.create(renderer, scene, { preset: 'default' });
//   renderer.setAnimationLoop(() => reflections.render(camera));   // instead of renderer.render(scene, camera)
//
// Without a denoiser glossy reflections are one noisy sample per 2x2 quad; pass one (the options) for
// a steady image.
import * as THREE from 'three/webgpu';
import { reflectionsRequiredLimits, type ReflectionsPresetName, type SpecularInputs, type TemporalDenoiser } from '@pmndrs/reflections-core';
import { ReflectionProbe, ReflectionProbes } from './probes/ReflectionProbes';
import { reflectionProbes } from './probes/ReflectionProbesNode';
import { installCubeArraySupport } from './compat/cubeArray';
import { ScreenSpaceReflectionsPass, type ScreenSpaceReflectionsPassSettings } from './sssr/ScreenSpaceReflectionsPass';
import { HybridReflections } from './sssr/HybridReflections';
import { createRaytracerTraceProviderFromObjects } from './trace/RaytracerTraceProvider';

/** The perceptual roughness above which a pixel skips the trace (the denoiser gates at the same value). */
export interface ReflectionsDenoiserInfo { roughnessThreshold: number }

export interface ReflectionsOptions {
  /** A named preset (core `REFLECTION_PRESETS`, docs/SETTINGS.md "Presets"): 'default' or 'performance'. Default 'default'. */
  preset?: ReflectionsPresetName;
  /**
   * What fills the reflection where the screen has no hit. `true` (default): one probe sized to the
   * scene's bounds, baked once at `create()` (call `bake()` after the scene or its environment changes);
   * a {@link ReflectionProbes} set you built and baked yourself is used as is; `false`: the scene's
   * environment alone. A real project usually places a probe per room, `true` is the quick start.
   */
  probes?: boolean | ReflectionProbes;
  /** Cube face size of the automatic probe. Default 256 (128 with the 'performance' preset). */
  probeResolution?: number;
  /**
   * Ray-traced fallback for rays the screen cannot answer, through `@pmndrs/raytracer` and `@pmndrs/bvh` (optional peers: install both).
   * `true`: every visible mesh of the scene, a BVH built once at `create()` (static meshes; for moving
   * ones use `reflections.trace.refit()` each frame). An array: only these objects. Default false.
   * Ray tracing degrades, with one console warning, to screen space + probes when it can't run: the package isn't
   * installed, or the device has too few storage buffers per shader stage for the traced pass (W89, D5451).
   */
  rayTracing?: boolean | THREE.Object3D[];
  /**
   * A temporal reflection denoiser, e.g. `(device, { roughnessThreshold }) => new FfxReflectionDenoiser(device,
   * { roughnessThreshold: roughnessThreshold ** 2 })` from `denoiser/ffx` (FFX compares alpha, perceptual
   * roughness squared). Or an instance made on this renderer's device. Default none.
   */
  denoiser?: TemporalDenoiser<SpecularInputs> | ((device: GPUDevice, info: ReflectionsDenoiserInfo) => TemporalDenoiser<SpecularInputs> | null) | null;
  /** Overrides over the preset's tracer settings (core `ScreenSpaceReflectionsSettings`, docs/SETTINGS.md). */
  settings?: ScreenSpaceReflectionsPassSettings;
  /** Install the cube-array shim for the probes on three r187 (default true; harmless where three has cube arrays). */
  cubeArrays?: boolean;
}

/**
 * A `WebGPURenderer` with the device limits the reflection passes need (`reflectionsRequiredLimits`),
 * initialised. `parameters` are `WebGPURenderer`'s (a `canvas`, ...); R3F's `renderer` prop can call this.
 * A plain `new WebGPURenderer()` works too, at WebGPU's default limits: the G-buffer then renders three's
 * lit image in a second pass (one more scene draw per frame, one console warning, D5480) and ray tracing
 * turns itself off where the device has too few storage buffers (D5451).
 */
export async function createReflectionsRenderer(parameters: { canvas?: HTMLCanvasElement | OffscreenCanvas; antialias?: boolean; [option: string]: unknown } = {}): Promise<THREE.WebGPURenderer> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('createReflectionsRenderer: WebGPU is not available in this browser');
  const requiredLimits = { ...reflectionsRequiredLimits(adapter), ...((parameters as { requiredLimits?: object }).requiredLimits ?? {}) };
  const renderer = new THREE.WebGPURenderer({ ...parameters, requiredLimits } as never);
  await renderer.init();
  return renderer;
}

/**
 * G-buffer + screen-space reflections + (ray-traced fallback) + probes + (denoiser) + hybrid composite
 * on a three scene, drawn through its own `RenderPipeline` in place of `renderer.render(scene, camera)`.
 * Tone mapping and the output colour space are the renderer's (`renderer.toneMapping` as usual).
 */
export class Reflections {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly ssr: ScreenSpaceReflectionsPass;
  readonly hybrid: HybridReflections;
  readonly pipeline: THREE.RenderPipeline;
  /** The probe set in use (null with `probes: false`). */
  readonly probes: ReflectionProbes | null;
  /** The ray-traced fallback's provider and `refit()` (null without `rayTracing`). */
  readonly trace: { provider: { destroy(): void }; refit(): void } | null;
  private readonly ownsProbes: boolean;
  private readonly probeResolution: number;
  private readonly bounds: THREE.Box3 | null;

  private constructor(
    renderer: THREE.WebGPURenderer, scene: THREE.Scene, ssr: ScreenSpaceReflectionsPass, hybrid: HybridReflections,
    pipeline: THREE.RenderPipeline, probes: ReflectionProbes | null, ownsProbes: boolean, probeResolution: number,
    bounds: THREE.Box3 | null, trace: Reflections['trace'],
  ) {
    this.renderer = renderer; this.scene = scene; this.ssr = ssr; this.hybrid = hybrid; this.pipeline = pipeline;
    this.probes = probes; this.ownsProbes = ownsProbes; this.probeResolution = probeResolution; this.bounds = bounds; this.trace = trace;
  }

  /**
   * Build everything for `scene` (async: the cube-array check and the BVH). Call once the scene's
   * meshes and environment are in place; `bake()` again after they change.
   */
  static async create(renderer: THREE.WebGPURenderer, scene: THREE.Scene, options: ReflectionsOptions = {}): Promise<Reflections> {
    const preset = options.preset ?? 'default';
    if (!(renderer as { hasInitialized?(): boolean }).hasInitialized?.()) await renderer.init();
    const wantProbes = options.probes ?? true;
    if (wantProbes && options.cubeArrays !== false) await installCubeArraySupport(renderer);

    const ssr = new ScreenSpaceReflectionsPass(renderer, { preset, settings: options.settings });
    const device = ssr.device;
    const threshold = ssr.settings.roughnessThreshold ?? 0.447;
    const denoiser = typeof options.denoiser === 'function' ? options.denoiser(device, { roughnessThreshold: threshold }) : (options.denoiser ?? null);

    let probes: ReflectionProbes | null = null;
    let bounds: THREE.Box3 | null = null;
    const ownsProbes = wantProbes === true;
    const probeResolution = options.probeResolution ?? (preset === 'performance' ? 128 : 256);
    if (wantProbes instanceof ReflectionProbes) probes = wantProbes;
    else if (wantProbes) {
      // one probe over the scene's bounds, projected onto a box well past them so that the environment
      // behaves like a distant sky, not a room (a real room wants its own probe, box and walls)
      scene.updateMatrixWorld(true);
      bounds = new THREE.Box3().setFromObject(scene);
      probes = new ReflectionProbes();
      scene.add(probes);
    }

    let trace: Reflections['trace'] = null;
    if (options.rayTracing) {
      const meshes: THREE.Object3D[] = [];
      if (Array.isArray(options.rayTracing)) meshes.push(...options.rayTracing);
      else scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && o.userData.noTrace !== true) meshes.push(o); });
      scene.updateMatrixWorld(true);
      try {
        const built = await createRaytracerTraceProviderFromObjects(device, meshes);
        ssr.setTraceProvider(built.provider);
        trace = { provider: built.provider as { destroy(): void }, refit: built.refit };
      } catch (e) {
        // W89 (D5451): no ray tracing (the optional peer is missing or failed to build); SSR + probes go on
        console.warn('Reflections: ray tracing is off (@pmndrs/raytracer / @pmndrs/bvh could not be loaded or built; install both for rayTracing). Screen-space reflections and probes continue.', e);
      }
    }

    const hybrid = new HybridReflections(ssr, { denoiser, preset });
    const self = new Reflections(renderer, scene, ssr, hybrid, new THREE.RenderPipeline(renderer), probes, ownsProbes, probeResolution, bounds, trace);
    if (ownsProbes) self.bake();
    else if (probes) scene.environmentNode = reflectionProbes(probes) as never;
    self.rebuild();
    return self;
  }

  /**
   * (Re)bake the automatic probe (with the scene's current meshes and environment). Needed after the
   * scene changes: the capture is a snapshot. A probe set you passed in is yours to bake.
   */
  bake() {
    if (!this.probes) return;
    if (this.ownsProbes && this.bounds) {
      this.scene.updateMatrixWorld(true);
      const box = this.bounds.setFromObject(this.scene); // meshes only: the probe boxes have no geometry
      const size = box.getSize(new THREE.Vector3()).max(new THREE.Vector3(1, 1, 1));
      let probe = this.probes.children.find((c): c is ReflectionProbe => c instanceof ReflectionProbe);
      if (!probe) this.probes.add(probe = new ReflectionProbe());
      probe.influenceSize.copy(size).multiplyScalar(1.2);
      probe.projectionSize = size.clone().multiplyScalar(6);
      box.getCenter(probe.position);
      probe.updateMatrixWorld(true);
    }
    const far = this.bounds ? Math.max(100, this.bounds.getSize(new THREE.Vector3()).length() * 4) : 100;
    // the captures see the scene lit by its environment alone: the probes' own node is off while they bake
    this.scene.environmentNode = null;
    this.probes.bake(this.renderer, this.scene, { resolution: this.probeResolution, far });
    this.scene.environmentNode = reflectionProbes(this.probes) as never;
    this.scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of ([] as THREE.Material[]).concat(m)) x.needsUpdate = true; });
    this.rebuild();
  }

  /** Rebuild the composite after changing `ssr.settings` between 'full' / 'half' resolution, the environment or the probes. */
  rebuild() {
    Object.assign(this.hybrid.options, {
      probes: this.probes, environment: this.scene.environment, environmentIntensity: this.scene.environmentIntensity,
    });
    this.hybrid.rebuild();
    this.pipeline.outputNode = this.hybrid.composite().final;
    this.pipeline.needsUpdate = true;
    this.hybrid.resetHistory();
    this.ssr.resetHistory();
  }

  /**
   * Draw one frame to the canvas (or the renderer's current target): G-buffer, trace, denoise,
   * composite. Replaces `renderer.render(scene, camera)`. With TAA, pass its `jitter` / `projection`
   * (`ScreenSpaceReflectionsPass.render`).
   */
  render(camera: THREE.Camera, options: { jitter?: readonly [number, number]; projection?: ArrayLike<number> } = {}) {
    this.ssr.render(this.scene, camera, options);
    this.hybrid.update();
    this.pipeline.render();
  }

  dispose() {
    this.pipeline.dispose();
    this.hybrid.dispose();
    this.ssr.dispose();
    this.trace?.provider.destroy();
    if (this.probes) {
      this.scene.environmentNode = null;
      if (this.ownsProbes) { this.scene.remove(this.probes); this.probes.dispose(); }
    }
  }
}
