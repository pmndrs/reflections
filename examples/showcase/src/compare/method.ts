// The compare page's methods: each one renders the same showcase scene, loaded fresh for it, in its
// own canvas with its own renderer (so nothing is shared with another method's renderer), from the
// page's one orbit camera.
import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { assetUrl } from '../../../shared';
import type { ShowcaseEntry, ShowcaseScene } from '../scenes';
import type { CameraView } from '../../../shared';

export type MethodId = 'ours-raw' | 'ours-denoised' | 'ours-rt' | 'probes' | 'three-raw' | 'three-denoise' | 'three-ffx' | 'pathtraced';

export const METHOD_LABELS: Record<MethodId, string> = {
  'ours-raw': 'ours: raw (SSR + probes, no denoiser)',
  'ours-denoised': 'ours: denoised (SSR + probes + FFX)',
  'ours-rt': 'ours: hybrid with RT (SSR + BVH + probes + FFX)',
  probes: 'probes only (ours, no SSR / RT)',
  'three-raw': 'three SSRNode, raw (stochastic)',
  'three-denoise': 'three SSRNode + its denoiser',
  'three-ffx': 'three SSRNode + FFX (denoiser repo wiring)',
  pathtraced: 'path traced (three-gpu-pathtracer)',
};
export const METHOD_SHORT: Record<MethodId, string> = {
  'ours-raw': 'ours raw', 'ours-denoised': 'ours denoised', 'ours-rt': 'ours + RT', probes: 'probes only',
  'three-raw': 'three SSR raw', 'three-denoise': 'three SSR + denoise', 'three-ffx': 'three SSR + FFX', pathtraced: 'path traced',
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
}

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
  /** Path tracer only: raise the sample cap (the reference stops tracing at it). */
  setMaxSamples?(n: number): void;
  /** Ours only: render the glossy-pixel mask (geometry with perceptual roughness < 0.447) into the canvas. */
  renderMask?(camera: THREE.PerspectiveCamera): void;
  /** Settings actually used (for the readout and the write-up). */
  info(): Record<string, unknown>;
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
}
