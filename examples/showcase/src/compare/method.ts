// The compare page's methods: each one renders the same showcase scene, loaded fresh for it, in its
// own canvas with its own renderer (so nothing is shared with another method's renderer), from the
// page's one orbit camera.
import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { assetUrl } from '../../../shared';
import type { ShowcaseEntry, ShowcaseScene } from '../scenes';
import type { CameraView } from '../../../shared';
import { SPEC_AA_DEFAULT, setSpecularAA, specAAFromQuery, specAAStrength } from '../specAA';
import { geometryRoughnessFromQuery, setGeometryRoughness } from '../geometryRoughness';

export type MethodId = 'ours-raw' | 'ours-denoised' | 'ours-rt' | 'probes' | 'three-raw' | 'three-denoise' | 'three-ffx' | 'pathtraced';

export const METHOD_LABELS: Record<MethodId, string> = {
  'ours-raw': 'ours: raw (SSR + probes, no denoiser)',
  'ours-denoised': 'ours: denoised (SSR + probes + FFX)',
  'ours-rt': 'ours: hybrid with RT (SSR + BVH + probes + FFX)',
  probes: 'probes only (ours, no SSR / RT)',
  'three-raw': 'three SSRNode, raw (stochastic)',
  'three-denoise': 'three SSRNode + its denoiser',
  'three-ffx': 'three SSRNode + FFX (denoiser repo wiring)',
  pathtraced: 'path traced + OIDN (three-gpu-pathtracer WebGPU)',
};
export const METHOD_SHORT: Record<MethodId, string> = {
  'ours-raw': 'ours raw', 'ours-denoised': 'ours denoised', 'ours-rt': 'ours + RT', probes: 'probes only',
  'three-raw': 'three SSR raw', 'three-denoise': 'three SSR + denoise', 'three-ffx': 'three SSR + FFX', pathtraced: 'path traced + OIDN',
};
export const METHOD_IDS = Object.keys(METHOD_LABELS) as MethodId[];

export interface MethodContext {
  entry: ShowcaseEntry;
  width: number;
  height: number;
  /** Tone-mapping exposure (the scene's own unless the page overrides it). AgX for every method. */
  exposure: number;
  /** Experiment overrides from the URL (?spq=, ?tsf=, ...); never product defaults. */
  params: URLSearchParams;
  /**
   * W51 (bench.html): the page's own defaults for keys the URL leaves out (e.g. `aa: 'upscaler'`,
   * `timestamps: '1'`); `params` wins. The compare page passes none.
   */
  defaults?: Record<string, string>;
}

/** `ctx.params` over `ctx.defaults` (W51): what a method reads its settings from. */
export function mergedParams(ctx: MethodContext): URLSearchParams {
  const out = new URLSearchParams(ctx.defaults ?? {});
  for (const [k, v] of ctx.params) out.set(k, v);
  return out;
}

/**
 * How a method took a setting change (W51, bench.html): 'live' = applied now; 'rebuild' = the method
 * reads it at creation only (the bench recreates it on Rebuild); 'ignored' = not this method's.
 */
export type SetResult = 'live' | 'rebuild' | 'ignored';

/** What the page needs from a method's own copy of the scene: camera presets and the camera. */
export interface SceneInfo {
  views: Record<string, CameraView>;
  near: number; far: number; fov: number;
  exposure: number;
}

export interface CompareMethod {
  readonly id: MethodId;
  readonly canvas: HTMLCanvasElement;
  readonly scene: SceneInfo;
  /** Render one frame from `camera` (the page's orbit camera; copied, never shared). */
  frame(camera: THREE.PerspectiveCamera): void;
  /** Resolves once the GPU has finished the submitted frames. */
  idle(): Promise<void>;
  /** Drop temporal history / accumulated samples. */
  reset(): void;
  setExposure(e: number): void;
  /** One status line (e.g. the path tracer's sample count). */
  status(): string;
  /** Path tracer only: accumulated samples. */
  samples?(): number;
  /** Path tracer only: the sample cap (it stops tracing there and denoises once). */
  setMaxSamples?(n: number): void;
  maxSamples?(): number;
  /** Path tracer only: at the cap and the denoise (if any) finished; the GPU is idle until something changes. */
  done?(): boolean;
  /** Path tracer only: show the denoised frame (true) or the raw accumulation. */
  setShowDenoised?(v: boolean): void;
  /** Redraw the frame on show into the canvas without new work (for a readback of an idle method). */
  present?(): void;
  /** Ours only: render the glossy-pixel mask (geometry with perceptual roughness < 0.447) into the canvas. */
  renderMask?(camera: THREE.PerspectiveCamera): void;
  /** Settings actually used (for the readout and the write-up). */
  info(): Record<string, unknown>;
  /**
   * W51 (bench.html): apply one setting by its URL key (`value` null = back to the page's default).
   * Keys the method reads only at creation return 'rebuild'; keys it doesn't know, 'ignored'.
   */
  set?(key: string, value: string | null): SetResult;
  /** W51: the value a setting has on this method now (for the bench's controls when unset), if it can tell. */
  get?(key: string): string | undefined;
  /** X0 (W70, examples/shared/metrics): ours only, the raw signal (the denoiser's input) as linear RGBA floats at the render size. */
  readSignal?(): Promise<{ data: Float32Array; width: number; height: number }>;
  /** X0: ours only, the denoised output (null while the denoiser isn't running). */
  readDenoised?(): Promise<{ data: Float32Array; width: number; height: number } | null>;
  /** X0: ours only, the display AA's jitter period in frames (null: no jitter). */
  jitterPhases?(): number | null;
  /** X0: ours only, the denoiser on / off without a rebuild; returns the previous state. */
  setDenoise?(on: boolean): boolean;
  /** W51: GPU ms per pass of the last timed frame (ours with `timestamps=1`). */
  timings?(): ReadonlyMap<string, number>;
  gpuErrors(): string[];
  dispose(): void;
}

export function syncCamera(dst: THREE.PerspectiveCamera, src: THREE.PerspectiveCamera) {
  dst.position.copy(src.position);
  dst.quaternion.copy(src.quaternion);
  dst.fov = src.fov; dst.aspect = src.aspect; dst.near = src.near; dst.far = src.far;
  dst.updateProjectionMatrix();
  dst.updateMatrixWorld(true);
}

export function newCanvas(width: number, height: number) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  return c;
}

/** Drop a WebGPU renderer and its device (each method requested its own). */
export function destroyWebGPU(renderer: { dispose(): void; backend: unknown }) {
  const device = (renderer.backend as { device?: GPUDevice }).device;
  try { renderer.dispose(); } catch { /* already gone */ }
  try { device?.destroy(); } catch { /* noop */ }
}

export const sceneInfo = (kit: ShowcaseScene): SceneInfo => ({ views: kit.views, near: kit.camera.near, far: kit.camera.far, fov: kit.camera.fov, exposure: kit.exposure });

/**
 * Give a method's scene its own HDRI (a fresh load, same file, intensities and blur). Required, not
 * just tidy: the showcase caches one HDR texture for every scene build, and three's CubeMapNode caches
 * its equirect-to-cube conversion per texture, not per renderer. A second renderer then reuses a cube
 * render target the first renderer drew, which is empty on its device: its probe bake (background
 * unblurred, so through CubeMapNode) captures a black sky and every mirror reads black.
 */
export async function freshEnvironment(kit: ShowcaseScene, entry: ShowcaseEntry) {
  const hdr = await new HDRLoader().loadAsync(assetUrl('hdri', entry.hdri));
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const { scene } = kit;
  if (scene.background === scene.environment) scene.background = hdr;
  scene.environment = hdr;
  return hdr;
}

/** Scene overrides every method applies the same way, before baking or rendering: ?floorRoughness=. */
export function applySceneParams(kit: ShowcaseScene, params: URLSearchParams) {
  if (params.has('floorRoughness')) kit.floor.setRoughness(Number(params.get('floorRoughness')));
  // W51 (bench): ?floor=mirror|lacquer (the stages) and ?floorPolish=0 (Sponza's polished override off)
  if (params.has('floor') && kit.floor.kinds?.includes(params.get('floor') as never)) kit.floor.setKind?.(params.get('floor') as never);
  if (params.get('floorPolish') === '0') kit.floor.setPolished?.(false);
  // Background display, every method alike. The blurred backdrop is blurred two different ways (three: a
  // PMREM mip at roughness = blurriness; the path tracer: a cone jitter per camera ray, which smears the
  // studio's key light into a big bright disc the PMREM blur doesn't show). The compare page therefore
  // shows the HDRI sharp (bgBlur 0) on every side by default, for a like-for-like background and
  // like-for-like reflections of it; ?bgBlur=0.35 restores the showcase look. Lighting is never affected.
  kit.scene.backgroundBlurriness = Number(params.get('bgBlur') ?? 0);
  if (params.has('bgIntensity')) kit.scene.backgroundIntensity = Number(params.get('bgIntensity'));
  // W58: ?envLight=<scale> scales the image-based light (scene.environmentIntensity: three's IBL, the probe bake
  // and the path tracer's environment) every method alike; ?background=black shows a black backdrop (camera rays
  // only: reflections and lighting keep the environment).
  if (params.has('envLight')) kit.scene.environmentIntensity *= Number(params.get('envLight'));
  if (params.get('background') === 'black') kit.scene.backgroundIntensity = 0;
  // ?keyLight=<scale> scales every directional / spot / point light, every method alike (W45: what share of
  // a reference's brightness is the key light, e.g. its glint in a mirror floor seen in the car's paint)
  if (params.has('keyLight')) {
    const s = Number(params.get('keyLight'));
    kit.scene.traverse((o) => { if ((o as THREE.Light).isLight && !(o as THREE.Light & { isAmbientLight?: boolean }).isAmbientLight) (o as THREE.Light).intensity *= s; });
  }
  // W54: ?glass=noShadow|black|hidden isolates the transmissive glass (carConcept's cabin): noShadow lets the key
  // light through (three's shadow map blocks it, the path tracer doesn't); black = opaque black, its own
  // reflection only; hidden = no glass (the cabin as lit without it)
  const glass = params.get('glass');
  if (glass && glass !== 'authored') {
    kit.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const ms = ([] as THREE.Material[]).concat(mesh.material ?? []) as THREE.MeshPhysicalMaterial[];
      if (!ms.some((m) => m.transmission > 0)) return;
      if (glass === 'hidden') { mesh.visible = false; mesh.userData.noTrace = true; mesh.userData.reflectionProbeExclude = true; }
      else if (glass === 'noShadow') mesh.castShadow = false;
      else if (glass === 'black') for (const m of ms) if (m.transmission > 0) { m.transmission = 0; m.color.set(0); m.needsUpdate = true; }
    });
  }
  // ?paintRoughness=<r> sets every clear-coated material's roughness and drops its normal map (W45: what a paint lobe sees)
  if (params.has('paintRoughness')) {
    const r = Number(params.get('paintRoughness'));
    kit.scene.traverse((o) => {
      for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? [])) {
        const p = m as THREE.MeshPhysicalMaterial;
        if (p.clearcoat > 0) { p.roughness = r; p.roughnessMap = null; p.normalMap = null; p.needsUpdate = true; }
      }
    });
  }
}

/**
 * W46 (D3570): roughness from normal variance (default on, ?specAA=0 off, ?specAA=<k> its strength) for a raster method's
 * scene (ours, three's SSR, probes), before the bake; the path tracer never calls this (it is the
 * reference and supersamples the normal maps itself). Returns the strength (0 = off) and the number of
 * materials changed.
 */
/**
 * W56 (D3720): three's geometry roughness off / scaled for a raster method's scene (`?geometryRoughness=three|off|<scale>`),
 * after specAA and before the bake. The path tracer never calls this. Returns the mode and the number of materials changed.
 */
export function applyGeometryRoughness(kit: ShowcaseScene, params: URLSearchParams) {
  const mode = geometryRoughnessFromQuery(params);
  return { mode, materials: setGeometryRoughness(kit.scene, mode) };
}

export function applySpecAA(kit: ShowcaseScene, params: URLSearchParams) {
  const strength = specAAFromQuery(params, SPEC_AA_DEFAULT);
  if (strength <= 0) return { strength: 0, materials: 0 };
  specAAStrength.value = strength;
  return { strength, materials: setSpecularAA(kit.scene, true) };
}
