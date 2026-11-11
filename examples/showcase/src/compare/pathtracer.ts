// Ground truth: three-gpu-pathtracer's WebGPUPathTracer (0.0.28, the first release for three r187; a devDependency)
// plus the OIDN denoiser (the Denoiser repo's `denoiser` package), on one GPUDevice in this method's own
// canvas and WebGPURenderer, on a fresh load of the same showcase scene (its own glTF and HDRI load, the
// same lights, floor, environment / background intensities and camera). The pattern is the Denoiser
// repo's examples/ldraw-eiffel and three-pathtracer-webgpu:
//
//   camera moved   -> restart the accumulation (the raw, noisy frame shows while it moves)
//   at rest        -> accumulate until every pixel has `maxSamples` (default 8; the tracer's own cap)
//   at the cap     -> stop tracing, rasterize albedo + view normal (aux), denoise ONCE with OIDN
//                     (hdr, linear out), show the denoised frame; the GPU is idle for this layer until
//                     the camera, the cap or the raw/denoised toggle changes
//
// Display: AgX + sRGB at the same exposure as every other method (the renderer's output transform over
// the tracer's own present material), raw and denoised alike. Reference settings: MIS on, 8 bounces,
// filterGlossyFactor 0; the tracer's default indirect clamp (10) stays (D2303). Known differences from
// the raster methods, not errors: the directional light's shadow is a hard traced shadow (the raster
// methods use PCF), and image-based diffuse is occluded here only.
import * as THREE from 'three/webgpu';
import { mrt, diffuseColor, normalView } from 'three/tsl';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { WebGPUPathTracer, RenderToScreenNodeMaterial } from 'three-gpu-pathtracer-webgpu';
import { Denoiser, type OidnDenoiser } from '@pmndrs/denoiser-oidn';
import { type CompareMethod, type MethodContext, applySceneParams, destroyWebGPU, freshEnvironment, newCanvas, sceneInfo, syncCamera } from './method';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export const pathTracerAvailable = WebGPUPathTracer !== null && RenderToScreenNodeMaterial !== null;
export const oidnAvailable = Denoiser !== null;
export const DEFAULT_MAX_SAMPLES = 8;

/** A device with the adapter's max limits and every feature: the tracer's kernels need more than the defaults. */
async function maxDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const requiredLimits: Record<string, number> = {};
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(adapter.limits))) {
    const v = (adapter.limits as unknown as Record<string, unknown>)[name];
    if (typeof v === 'number') requiredLimits[name] = v;
  }
  return adapter.requestDevice({ requiredFeatures: [...adapter.features] as GPUFeatureName[], requiredLimits });
}

export async function createPathTracer(ctx: MethodContext): Promise<CompareMethod> {
  if (!WebGPUPathTracer || !RenderToScreenNodeMaterial) throw new Error('three-gpu-pathtracer/webgpu not found (the Denoiser repo\'s node_modules, or $PATHTRACER_REPO)');
  const { width: W, height: H, params } = ctx;
  const canvas = newCanvas(W, H);
  const device = await maxDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; errors.push(m); console.error('[pathtraced webgpu]', m); });
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, device } as N);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  await renderer.init();
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = ctx.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // OIDN on the renderer's device (zero copy: tracer texture -> denoiser -> three StorageTexture)
  let oidn: OidnDenoiser | null = null, oidnError = '';
  if (Denoiser && params.get('ptDenoise') !== '0') {
    try { oidn = await Denoiser.create({ device, tzaUrl: import.meta.env.DEV ? '/tzas' : undefined }); }
    catch (e) { oidnError = String((e as Error)?.message ?? e); console.error('[pathtraced] OIDN', e); }
  }

  const kit = await ctx.entry.build(W / H);
  await freshEnvironment(kit, ctx.entry); // its own HDRI, never another renderer's texture
  applySceneParams(kit, params);
  const { scene, camera } = kit;
  // ?ptClearcoat=0 drops the clearcoat layer (the WebGL tracer rendered it black, D2303; this one doesn't)
  let clearcoatDropped = 0;
  if (params.get('ptClearcoat') === '0') {
    scene.traverse((o: N) => { for (const m of [].concat(o.material ?? [])) if ((m as N).clearcoat > 0) { (m as N).clearcoat = 0; clearcoatDropped++; } });
  }

  const pt: N = new WebGPUPathTracer(renderer);
  pt.dynamicLowRes = false; pt.renderDelay = 0; pt.fadeDuration = 0; pt.minSamples = 0;
  pt.renderScale = 1; pt.adaptiveFrameBudget = false; // (needs timestamp queries)
  pt.maxBounces = Number(params.get('ptBounces') ?? 8);
  pt.filterGlossyFactor = 0;
  pt.multipleImportanceSampling = true;
  let maxSamples = Math.max(1, Math.round(Number(params.get('ptMax') ?? DEFAULT_MAX_SAMPLES)));
  pt.maxSamples = maxSamples;
  scene.updateMatrixWorld(true);
  const t0 = performance.now();
  pt.setScene(scene, camera);
  const buildMs = performance.now() - t0;
  // renderSample dispatches `frameBudget` paths: call it often enough for about one sample per frame
  const perFrame = Math.max(1, Math.ceil((W * H) / (pt.frameBudget || W * H)));

  // aux: albedo (base colour) and view normal, rasterized once per settled view (noise-free -> calb_cnrm)
  const albedoRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType });
  const normalRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType });
  albedoRT.texture.name = 'albedo'; normalRT.texture.name = 'normal'; // MRT outputs bind by texture name
  const renderGBuffer = () => {
    try {
      renderer.setMRT(mrt({ albedo: diffuseColor }) as N);
      renderer.setRenderTarget(albedoRT);
      renderer.render(scene, camera);
      const bg = scene.background;
      scene.background = null; // background pixels: normal 0
      renderer.setMRT(mrt({ normal: normalView }) as N);
      renderer.setRenderTarget(normalRT);
      renderer.render(scene, camera);
      scene.background = bg;
    } finally {
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
    }
  };
  const gpuTex = (t: THREE.Texture): GPUTexture | undefined => (renderer.backend as N).get(t)?.texture;

  // the denoiser writes linear HDR into this (three's output transform tone-maps it like the raw frame)
  const denoisedTex = new THREE.StorageTexture(W, H);
  denoisedTex.type = THREE.HalfFloatType;
  denoisedTex.generateMipmaps = false;
  denoisedTex.colorSpace = THREE.LinearSRGBColorSpace;
  (renderer as N).initTexture(denoisedTex);
  // present quads: the tracer's own present material (top-down rows), one per source texture
  const rawMat: N = new RenderToScreenNodeMaterial();
  const denMat: N = new RenderToScreenNodeMaterial();
  denMat.texture = denMat.fromTexture = denoisedTex;
  // (the tracer's FullScreenQuad, not QuadMesh: the material reads rows top-down against its uv)
  const rawQuad = new FullScreenQuad(rawMat), denQuad = new FullScreenQuad(denMat);

  // Warm the denoiser while the first samples trace: its first call loads the weights and builds the
  // pipelines (seconds), so run one on a blank frame of the same size and formats now, not at the cap.
  const warm: Promise<unknown> = oidn ? (async () => {
    const blank = new THREE.StorageTexture(W, H);
    blank.type = THREE.FloatType; // rgba32float, as the tracer's target
    (renderer as N).initTexture(blank);
    renderGBuffer();
    const color = gpuTex(blank), albedo = gpuTex(albedoRT.texture), normal = gpuTex(normalRT.texture), output = gpuTex(denoisedTex);
    if (color && albedo && normal && output) await oidn.denoiseTextures({ color, albedo, normal, hdr: true, inputFlipY: false, auxInputFlipY: false, transfer: 'linear', output });
    blank.dispose();
  })().catch((e) => console.warn('[pathtraced] denoiser warm-up', e)) : Promise.resolve();

  type State = 'tracing' | 'denoising' | 'done';
  let state: State = 'tracing';
  let epoch = 0, reached = 0, counting = false, denoised = false, showDenoised = params.get('ptRaw') !== '1';
  let dispatches = 0, dirty = false, denoiseMs = 0, traceStart = performance.now(), traceMs = 0, readyMs = 0, denoiseError = '';
  const last = new THREE.Matrix4(), lastP = new THREE.Matrix4();

  const restart = () => {
    epoch++; reached = 0; denoised = false; state = 'tracing'; traceStart = performance.now();
    oidn?.abort();
  };
  const poll = () => {
    if (counting) return;
    counting = true;
    const e = epoch;
    pt.getSampleCountsAsync()
      .then((c: N) => { if (e === epoch) reached = Math.floor(c?.min ?? 0); })
      .catch(() => { /* not ready yet: the next poll retries */ })
      .finally(() => { counting = false; });
  };
  const present = () => {
    const useDenoised = denoised && showDenoised;
    if (!useDenoised) { if (!pt.target) return; rawMat.texture = rawMat.fromTexture = pt.target; }
    renderer.setRenderTarget(null);
    (useDenoised ? denQuad : rawQuad).render(renderer as N);
    dirty = false;
  };
  async function denoise() {
    const e = epoch;
    traceMs = performance.now() - traceStart;
    if (!oidn) { state = 'done'; dirty = true; return; }
    state = 'denoising';
    try {
      await warm;
      if (e !== epoch) return;
      renderGBuffer();
      const color = pt.target && gpuTex(pt.target), albedo = gpuTex(albedoRT.texture), normal = gpuTex(normalRT.texture), out = gpuTex(denoisedTex);
      if (!color || !albedo || !normal || !out) throw new Error('denoise: GPU textures unavailable');
      const t = performance.now();
      const res = await oidn.denoiseTextures({ color, albedo, normal, hdr: true, inputFlipY: false, auxInputFlipY: false, transfer: 'linear', output: out });
      await device.queue.onSubmittedWorkDone();
      if (e !== epoch || !res) return; // camera moved: a newer accumulation owns the state
      denoiseMs = performance.now() - t;
      denoised = true;
      readyMs = performance.now() - traceStart; // still -> denoised frame on screen
    } catch (err) {
      if (e !== epoch) return;
      denoiseError = String((err as Error)?.message ?? err);
      console.error('[pathtraced] denoise', err);
    }
    state = 'done'; dirty = true;
  }

  return {
    id: 'pathtraced', canvas, scene: sceneInfo(kit),
    frame(cam) {
      syncCamera(camera as N, cam);
      if (!last.equals(camera.matrixWorld) || !lastP.equals(camera.projectionMatrix)) {
        last.copy(camera.matrixWorld); lastP.copy(camera.projectionMatrix);
        pt.updateCamera(); // resets the accumulation
        restart();
      }
      if (state === 'tracing') {
        for (let i = 0; i < perFrame; i++) { pt.renderSample(); dispatches++; } // presents the raw accumulation
        poll();
        if (reached >= maxSamples) void denoise();
      } else if (dirty) present(); // at the cap: nothing to trace, only a redraw when the view changed
    },
    idle: () => device.queue.onSubmittedWorkDone(),
    reset() { pt.reset(); restart(); },
    present,
    done: () => state === 'done',
    setExposure(e) { renderer.toneMappingExposure = e; dirty = true; },
    samples: () => reached,
    maxSamples: () => maxSamples,
    setMaxSamples(n: number) {
      n = Math.max(1, Math.round(n));
      if (n === maxSamples) return;
      const lower = n < reached;
      maxSamples = n; pt.maxSamples = n;
      if (lower) pt.reset();
      restart(); // keeps the samples it has when raising the cap (the tracer resumes), re-denoises at the new cap
      if (!lower) traceStart = performance.now();
    },
    setShowDenoised(v: boolean) { showDenoised = v; dirty = true; },
    status: () => {
      const spp = `${Math.min(reached, maxSamples)} / ${maxSamples} spp`;
      if (state === 'tracing') return `${spp}, tracing`;
      if (state === 'denoising') return `${spp}, denoising...`;
      if (!oidn) return `${spp}, raw (no OIDN${oidnError ? ': ' + oidnError : ''})`;
      if (denoiseError) return `${spp}, raw (denoise failed)`;
      return `${spp}, ${showDenoised ? `denoised (OIDN ${denoiseMs.toFixed(0)} ms)` : 'raw (denoiser off)'}`;
    },
    info: () => ({
      tracer: 'three-gpu-pathtracer WebGPUPathTracer', bounces: pt.maxBounces, filterGlossyFactor: 0, mis: true, clampIndirect: pt.clampIndirect,
      maxSamples, samples: reached, dispatches, denoised, denoiser: oidn ? `OIDN (${oidn.runtime.lastChoice ?? oidn.runtime.name}), albedo + normal aux` : null,
      traceMs: Math.round(traceMs), denoiseMs: Math.round(denoiseMs), readyMs: Math.round(readyMs), clearcoatDropped, sceneBuildMs: Math.round(buildMs),
    }),
    gpuErrors: () => errors,
    dispose() {
      epoch++;
      oidn?.abort();
      try { pt.dispose?.(); } catch { /* noop */ }
      albedoRT.dispose(); normalRT.dispose(); denoisedTex.dispose(); rawQuad.dispose(); denQuad.dispose();
      try { oidn?.dispose?.(); } catch { /* noop */ }
      destroyWebGPU(renderer as N);
    },
  };
}
