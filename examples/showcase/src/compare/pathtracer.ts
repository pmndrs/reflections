// Ground truth: three-gpu-pathtracer's WebGLPathTracer (WebGLRenderer, its own canvas and GL
// context) on a fresh load of the same showcase scene: its own glTF load, its own HDRI load, the same
// lights, floor, environment / background intensities and camera. It accumulates while the camera is
// still and resets when it moves. Display: AgX + sRGB at the same exposure as every other method
// (three's WebGL AgX, applied by the path tracer's output quad).
//
// Unbiased settings for a reference: filterGlossyFactor 0 (the default), MIS on, 8 bounces,
// 3x3 tiles per sample. Known differences from the raster methods, not errors: the directional light's
// shadow is a hard ray-traced shadow (the raster methods use PCF), and the blurred studio backdrop is
// blurred by a cone jitter instead of a PMREM mip (backdrop pixels only, never reflective ones).
import * as T from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer-webgl';
import { type CompareMethod, type MethodContext, applySceneParams, freshEnvironment, newCanvas, sceneInfo, syncCamera } from './method';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export const pathTracerAvailable = WebGLPathTracer !== null;

export async function createPathTracer(ctx: MethodContext): Promise<CompareMethod> {
  if (!WebGLPathTracer) throw new Error('no three-gpu-pathtracer checkout found (sibling folder or $PATHTRACER_REPO)');
  const { width: W, height: H, params } = ctx;
  const canvas = newCanvas(W, H);
  const renderer = new T.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.toneMapping = T.AgXToneMapping;
  renderer.toneMappingExposure = ctx.exposure;
  renderer.outputColorSpace = T.SRGBColorSpace;

  const kit = await ctx.entry.build(W / H);
  await freshEnvironment(kit, ctx.entry);
  applySceneParams(kit, params); // its own HDRI, never the WebGPU renderers' texture
  const { scene, camera } = kit;
  // Clearcoat renders black in three-gpu-pathtracer on these assets (ToyCar's and CarConcept's
  // paint; both the local checkout and the upstream build the upscaler pins; any roughness, with or
  // without the clearcoat maps). Not found in the time box (D2303), so the reference drops the
  // clearcoat layer and keeps the base coat. ?ptClearcoat=1 keeps it.
  let clearcoatDropped = 0;
  if (params.get('ptClearcoat') !== '1') {
    scene.traverse((o: N) => { for (const m of [].concat(o.material ?? [])) if ((m as N).clearcoat > 0) { (m as N).clearcoat = 0; clearcoatDropped++; } });
  }
  if (params.has('ptDebug')) {
    const keys = params.get('ptDebug')!.split(',');
    scene.traverse((o: N) => {
      if (o.material) for (const kv of keys) {
        const [k, v] = kv.split('=');
        if (k in o.material && typeof o.material[k] === 'number') o.material[k] = v === undefined ? 0 : (k === 'clearcoatRoughness' ? Math.max(Number(v), o.material[k]) : Number(v));
        else if (k in o.material) o.material[k] = null;
      }
    });
  }

  const pt: N = new WebGLPathTracer(renderer);
  pt.renderDelay = 0; pt.fadeDuration = 0; pt.minSamples = 1; pt.maxSamples = Infinity;
  pt.dynamicLowRes = false; pt.rasterizeScene = false; pt.renderScale = 1;
  // tiles keep each GL draw short (a full-frame Sponza sample is long enough to trip the GPU watchdog)
  const tiles = Number(params.get('ptTiles') ?? 3);
  pt.tiles.set(tiles, tiles);
  pt.bounces = Number(params.get('ptBounces') ?? 8);
  pt.filterGlossyFactor = 0;
  pt.multipleImportanceSampling = true;
  scene.updateMatrixWorld(true);
  const t0 = performance.now();
  pt.setScene(scene, camera);
  const buildMs = performance.now() - t0;

  const last = new T.Matrix4(), lastP = new T.Matrix4();
  const budgetMs = 24;
  return {
    id: 'pathtraced', canvas, scene: sceneInfo(kit),
    frame(cam) {
      syncCamera(camera as N, cam);
      if (!last.equals(camera.matrixWorld) || !lastP.equals(camera.projectionMatrix)) {
        last.copy(camera.matrixWorld); lastP.copy(camera.projectionMatrix);
        pt.updateCamera();
      }
      // as many tiles as fit in the frame budget (each renderSample renders one tile)
      const t = performance.now();
      do { pt.renderSample(); } while (performance.now() - t < budgetMs && !pt.isCompiling);
    },
    async idle() { /* WebGL: drawing buffer preserved, nothing to wait for */ },
    reset() { pt.reset(); },
    setExposure(e) { renderer.toneMappingExposure = e; pt.reset(); },
    samples: () => Math.floor(pt.samples),
    status: () => `${Math.floor(pt.samples)} samples${pt.isCompiling ? ' (compiling)' : ''}`,
    info: () => ({ bounces: pt.bounces, filterGlossyFactor: 0, mis: true, clearcoatDropped, sceneBuildMs: Math.round(buildMs) }),
    gpuErrors: () => [],
    // (the local checkout's dispose() reads an `_albedoNormalPass` it never creates: guarded)
    dispose() { try { pt.dispose(); } catch { /* see above */ } renderer.dispose(); renderer.forceContextLoss(); },
  };
}
