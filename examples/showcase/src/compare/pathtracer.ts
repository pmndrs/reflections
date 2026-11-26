// Ground truth (W89): @pmndrs/pathtracer's megakernel (`PtMegakernel`, 0.1.0 from npm) over @pmndrs/raytracer's scene copy and
// @pmndrs/bvh trees, plus the OIDN denoiser (`denoiser` 2.x), on one GPUDevice in this method's own canvas and WebGPURenderer,
// on a fresh load of the same showcase scene (its own glTF and HDRI load, the same lights, floor, environment / background
// intensities and camera). The three scene becomes a raytracer scene in ./ptScene.ts (textures, OpenPBR materials, sun,
// equirect environment; what it approximates is in its `notes` and DIVERGES D5453). Before W89 this was another project's
// WebGPUPathTracer.
//
//   camera moved   -> restart the accumulation (the raw, noisy frame shows while it moves)
//   at rest        -> accumulate until every pixel has `maxSamples` (default 8)
//   at the cap     -> stop tracing, rasterize albedo + view normal (aux), denoise ONCE with OIDN (hdr, linear out), show the
//                     denoised frame; the GPU is idle for this layer until the camera, the cap or the raw/denoised toggle changes
//
// The path tracer has one environment for every ray; three draws the background at its own intensity / blur. A resolve pass
// puts three's background where camera rays missed: radiance + (1 - coverage) x (background - environment as seen by the
// camera), both rasterized by three at the pixel centre (coverage = the share of a pixel's samples whose camera ray hit, the
// kernel's AOVs).
//
// Display: AgX + sRGB at the same exposure as every other method (the renderer's output transform over a full-screen quad),
// raw and denoised alike. Reference settings: 8 bounces (`?ptBounces=`), next-event estimation with MIS, environment importance
// sampling, Russian roulette from the third vertex, no clamp. Known differences from the raster methods, not errors: the
// directional light's shadow is a hard traced shadow (the raster methods use PCF), and image-based diffuse is occluded here only.
import * as THREE from 'three/webgpu';
import { mrt, diffuseColor, normalView, screenUV, texture } from 'three/tsl';
import { buildCaps, buildSceneCopy, createMaterial, sceneFormatOf, uploadSceneCopy } from '@pmndrs/raytracer';
import { assembleTraceScene, createMeshLayoutBuilder, uploadTraceScene } from '@pmndrs/bvh';
import { PtMegakernel, ptMaterialFeatures } from '@pmndrs/pathtracer';
import { Denoiser } from 'denoiser';
import { type CompareMethod, type MethodContext, applySceneParams, destroyWebGPU, freshEnvironment, mergedParams, newCanvas, sceneInfo, syncCamera } from './method';
import { ptSceneFromThree } from './ptScene';
import { toneOf } from './ours';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type OidnDenoiser = Awaited<ReturnType<typeof Denoiser.create>>;

export const pathTracerAvailable = true; // @pmndrs/pathtracer from npm (W89)
export const oidnAvailable = true; // `denoiser` 2.x from npm (W89)
export const DEFAULT_MAX_SAMPLES = 8;

/** A device with the adapter's max limits and every feature: the kernel and the scene copy's texture arrays want more than the defaults. */
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

const RESOLVE_WGSL = /* wgsl */ `
struct Params { width: u32, height: u32, background: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> acc: array<vec4f>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var envSeen: texture_2d<f32>;
@group(0) @binding(3) var backgroundSeen: texture_2d<f32>;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let i = id.y * params.width + id.x;
  let s = acc[i];
  let n = max(s.w, 1.0);
  var c = s.rgb / n;
  if (params.background == 1u) {
    // AOVs after the radiance: vec4 n + 2i + 1 = (normal sum, samples whose camera ray hit)
    let hits = acc[params.width * params.height + 2u * i + 1u].w;
    let miss = clamp(1.0 - hits / n, 0.0, 1.0);
    c += miss * (textureLoad(backgroundSeen, id.xy, 0).rgb - textureLoad(envSeen, id.xy, 0).rgb);
  }
  textureStore(outTex, id.xy, vec4f(max(c, vec3f(0.0)), 1.0));
}`;

export async function createPathTracer(ctx: MethodContext): Promise<CompareMethod> {
  const { width: W, height: H } = ctx;
  const params = mergedParams(ctx);
  const canvas = newCanvas(W, H);
  const device = await maxDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; errors.push(m); console.error('[pathtraced webgpu]', m); });
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, device } as N);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  await renderer.init();
  renderer.toneMapping = toneOf(params); // AgX (W51: ?tone=)
  renderer.toneMappingExposure = ctx.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // OIDN on the renderer's device (zero copy: resolved radiance -> denoiser -> three StorageTexture)
  let oidn: OidnDenoiser | null = null, oidnError = '';
  if (params.get('ptDenoise') !== '0') {
    try { oidn = await Denoiser.create({ device }); } // weights: the denoiser's DEFAULT_TZA_URL
    catch (e) { oidnError = String((e as Error)?.message ?? e); console.error('[pathtraced] OIDN', e); }
  }

  const kit = await ctx.entry.build(W / H);
  await freshEnvironment(kit, ctx.entry); // its own HDRI, never another renderer's texture
  applySceneParams(kit, params);
  const { scene, camera } = kit;
  // ?ptClearcoat=0 drops the clearcoat layer (an A/B of the coat, D2303)
  let clearcoatDropped = 0;
  if (params.get('ptClearcoat') === '0') {
    scene.traverse((o: N) => { for (const m of [].concat(o.material ?? [])) if ((m as N).clearcoat > 0) { (m as N).clearcoat = 0; clearcoatDropped++; } });
  }

  // ---- the scene on the GPU: @pmndrs/bvh trees + @pmndrs/raytracer's scene copy (what 0.1.0's missing buildGpuScene does)
  const t0 = performance.now();
  const input = ptSceneFromThree(scene);
  const builder = await createMeshLayoutBuilder(device, { label: 'pathtraced' });
  const built = await builder.buildLayouts(input.meshes.map((m) => ({ positions: m.positions, indices: m.indices, triangleMaterials: m.triangleMaterials })) as N);
  const data = assembleTraceScene(built.map((b: N) => b.layout), input.instances.map((i) => ({ meshIndex: i.meshIndex, instanceIndex: i.instanceIndex, objectToWorld: i.objectToWorld, material: i.material })) as N);
  const trace = uploadTraceScene(device, data, 'pathtraced');
  const copy = buildSceneCopy({
    meshes: input.meshes, instances: input.instances, materials: input.materials as N, textures: input.textures as N,
    sun: input.sun, environment: input.environment as N, options: { surface: { positions: true } },
  } as N);
  const sceneBuffers = uploadSceneCopy(device, copy, { label: 'pathtraced copy', packing: 'packed' });
  const records = input.materials.map((m: N) => createMaterial(m.roughnessMetalTexture !== undefined && (m.metalness ?? 0) > 0 ? { ...m, metalness: 0.5 } : m));
  const alphaMask = !!copy.textureLayout && records.some((m) => m.alphaMode === 1);
  const envMap = !!(input.environment && 'map' in input.environment);
  const layering = params.get('ptLayering') === 'internal' ? 'internal' : 'openpbr';
  const caps = buildCaps({ features: device.features as unknown as ReadonlySet<string>, limits: device.limits as unknown as Record<string, unknown> }, (navigator.gpu as N).wgslLanguageFeatures);
  const pt = await PtMegakernel.create(device, caps, {
    format: sceneFormatOf(trace as N), layout: copy.layout, textures: copy.textureLayout ?? null, scenePacking: sceneBuffers.packing,
    // ?ptLayering=internal: the pathtracer's own default for a dielectric over a diffuse base (Weidlich-Wilkie, light the
    // interface sends back down: darker, more saturated diffuse); 'openpbr' (here the default): base x (1 - E_spec), the
    // OpenPBR spec's scaling, the closest to three's / glTF's model that the raster methods render (D5453)
    integrator: { envMap, envSampling: envMap ? 'importance' : 'uniform', ...(alphaMask ? { alphaMask } : {}), aovs: true, materials: { features: ptMaterialFeatures(records), layered: { albedoBase: layering } } },
    label: 'pathtraced',
  } as N);
  pt.setScene(trace as N, sceneBuffers);
  pt.setFilm(W, H);
  const bounces = Number(params.get('ptBounces') ?? 8);
  pt.setLimits({ maxDepth: bounces, rrStartDepth: 3 });
  const buildMs = performance.now() - t0;
  if (input.notes.length) console.info(`[pathtraced] scene: ${input.notes.join('; ')}`);

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

  // The camera rays' background (three's, at its intensity / blur) and the environment the tracer returns on a miss, both
  // linear at the pixel centre, rendered once per view. Skipped when they are the same picture.
  const sameBackground = scene.background === scene.environment && scene.backgroundIntensity === scene.environmentIntensity && !scene.backgroundBlurriness
    && scene.backgroundRotation.equals(scene.environmentRotation);
  const envSeenRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType });
  const bgSeenRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType });
  const backgroundScene = new THREE.Scene();
  const renderBackgrounds = () => {
    if (sameBackground) return;
    const draw = (target: THREE.RenderTarget, bg: THREE.Scene['background'], intensity: number, blur: number, rotation: THREE.Euler) => {
      backgroundScene.background = bg; backgroundScene.backgroundIntensity = intensity; backgroundScene.backgroundBlurriness = blur; backgroundScene.backgroundRotation.copy(rotation);
      renderer.setRenderTarget(target);
      renderer.render(backgroundScene, camera);
    };
    const tone = renderer.toneMapping;
    try {
      renderer.toneMapping = THREE.NoToneMapping;
      draw(envSeenRT, scene.environment, scene.environmentIntensity, 0, scene.environmentRotation);
      draw(bgSeenRT, scene.background, scene.backgroundIntensity, scene.backgroundBlurriness, scene.backgroundRotation);
    } finally {
      renderer.setRenderTarget(null);
      renderer.toneMapping = tone;
    }
  };

  // the resolved radiance (rgba32float: the denoiser's input) and the denoised frame; three's output transform tone-maps both
  const rawTex = new THREE.StorageTexture(W, H);
  rawTex.type = THREE.FloatType;
  rawTex.minFilter = rawTex.magFilter = THREE.NearestFilter;
  rawTex.generateMipmaps = false;
  rawTex.colorSpace = THREE.LinearSRGBColorSpace;
  (renderer as N).initTexture(rawTex);
  const denoisedTex = new THREE.StorageTexture(W, H);
  denoisedTex.type = THREE.HalfFloatType;
  denoisedTex.generateMipmaps = false;
  denoisedTex.colorSpace = THREE.LinearSRGBColorSpace;
  (renderer as N).initTexture(denoisedTex);
  (renderer as N).initRenderTarget?.(envSeenRT); (renderer as N).initRenderTarget?.(bgSeenRT);
  const present = (t: THREE.Texture) => { const m = new THREE.MeshBasicNodeMaterial(); m.colorNode = texture(t, screenUV); return new THREE.QuadMesh(m); };
  const rawQuad = present(rawTex), denQuad = present(denoisedTex);

  const resolveBgl = device.createBindGroupLayout({
    label: 'pathtraced resolve', entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
    ],
  });
  const resolvePipe = device.createComputePipeline({ label: 'pathtraced resolve', layout: device.createPipelineLayout({ bindGroupLayouts: [resolveBgl] }), compute: { module: device.createShaderModule({ code: RESOLVE_WGSL }), entryPoint: 'main' } });
  const resolveParams = device.createBuffer({ label: 'pathtraced resolve', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(resolveParams, 0, new Uint32Array([W, H, sameBackground ? 0 : 1, 0]));
  let resolveGroup: GPUBindGroup | null = null;
  const resolve = (enc: GPUCommandEncoder) => {
    resolveGroup ??= device.createBindGroup({
      label: 'pathtraced resolve', layout: resolveBgl, entries: [
        { binding: 0, resource: { buffer: pt.accumulator! } }, { binding: 1, resource: { buffer: resolveParams } },
        { binding: 2, resource: gpuTex(envSeenRT.texture)!.createView() }, { binding: 3, resource: gpuTex(bgSeenRT.texture)!.createView() },
        { binding: 4, resource: gpuTex(rawTex)!.createView() },
      ],
    });
    const pass = enc.beginComputePass({ label: 'pathtraced resolve' });
    pass.setPipeline(resolvePipe); pass.setBindGroup(0, resolveGroup); pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); pass.end();
  };

  // Warm the denoiser while the first samples trace: its first call loads the weights and builds the pipelines (seconds).
  const warm: Promise<unknown> = oidn ? (async () => {
    renderGBuffer();
    const color = gpuTex(rawTex), albedo = gpuTex(albedoRT.texture), normal = gpuTex(normalRT.texture), output = gpuTex(denoisedTex);
    if (color && albedo && normal && output) await oidn.denoiseTextures({ color, albedo, normal, hdr: true, inputFlipY: false, auxInputFlipY: false, transfer: 'linear', output });
  })().catch((e) => console.warn('[pathtraced] denoiser warm-up', e)) : Promise.resolve();

  type State = 'tracing' | 'denoising' | 'done';
  let state: State = 'tracing';
  let epoch = 0, denoised = false, showDenoised = params.get('ptRaw') !== '1', needReset = true;
  let dispatches = 0, dirty = false, denoiseMs = 0, traceStart = performance.now(), traceMs = 0, readyMs = 0, denoiseError = '';
  let maxSamples = Math.max(1, Math.round(Number(params.get('ptMax') ?? DEFAULT_MAX_SAMPLES)));
  const last = new THREE.Matrix4(), lastP = new THREE.Matrix4();
  const fwd = new THREE.Vector3(), up = new THREE.Vector3(), pos = new THREE.Vector3();

  const restart = () => {
    epoch++; denoised = false; state = 'tracing'; traceStart = performance.now(); needReset = true;
    oidn?.abort();
  };
  const show = () => {
    renderer.setRenderTarget(null);
    (denoised && showDenoised ? denQuad : rawQuad).render(renderer as N);
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
      const color = gpuTex(rawTex), albedo = gpuTex(albedoRT.texture), normal = gpuTex(normalRT.texture), out = gpuTex(denoisedTex);
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

  const method: CompareMethod = {
    id: 'pathtraced', canvas, scene: sceneInfo(kit),
    frame(cam) {
      syncCamera(camera as N, cam);
      if (!last.equals(camera.matrixWorld) || !lastP.equals(camera.projectionMatrix)) {
        last.copy(camera.matrixWorld); lastP.copy(camera.projectionMatrix);
        camera.getWorldPosition(pos); camera.getWorldDirection(fwd); up.set(0, 1, 0).applyQuaternion(camera.quaternion);
        pt.setCamera({ position: [pos.x, pos.y, pos.z], target: [pos.x + fwd.x, pos.y + fwd.y, pos.z + fwd.z], up: [up.x, up.y, up.z], yFovDeg: camera.getEffectiveFOV() });
        renderBackgrounds();
        restart();
      }
      if (state === 'tracing') {
        const enc = device.createCommandEncoder({ label: 'pathtraced' });
        if (needReset) { pt.reset(enc); needReset = false; }
        const n = Math.min(maxSamples - pt.samples, 1);
        if (n > 0) { pt.encode(enc, n); dispatches += n; }
        resolve(enc);
        device.queue.submit([enc.finish()]);
        show(); // the raw accumulation
        if (pt.samples >= maxSamples) void denoise();
      } else if (dirty) show(); // at the cap: nothing to trace, only a redraw when the view changed
    },
    idle: () => device.queue.onSubmittedWorkDone(),
    reset() { restart(); },
    present: show,
    done: () => state === 'done',
    setExposure(e) { renderer.toneMappingExposure = e; dirty = true; },
    samples: () => Math.min(pt.samples, maxSamples),
    maxSamples: () => maxSamples,
    setMaxSamples(n: number) {
      n = Math.max(1, Math.round(n));
      if (n === maxSamples) return;
      const lower = n < pt.samples;
      maxSamples = n;
      epoch++; denoised = false; state = 'tracing'; oidn?.abort();
      if (lower) needReset = true; // fewer than it has: start over; more: keep the samples and resume
      traceStart = performance.now();
    },
    setShowDenoised(v: boolean) { showDenoised = v; dirty = true; },
    /** W51 (bench): the reference's live settings; a scene / floor / material change rebuilds it. */
    set(key, value) {
      if (key === 'ptMax') { method.setMaxSamples!(Number(value ?? DEFAULT_MAX_SAMPLES)); return 'live'; }
      if (key === 'ptRaw') { showDenoised = value !== '1'; dirty = true; return 'live'; }
      if (['ptBounces', 'ptDenoise', 'ptClearcoat', 'floorRoughness', 'floor', 'floorPolish', 'tone', 'keyLight', 'paintRoughness', 'bgBlur', 'bgIntensity', 'envLight', 'background'].includes(key)) return 'rebuild';
      return 'ignored';
    },
    status: () => {
      const spp = `${Math.min(pt.samples, maxSamples)} / ${maxSamples} spp`;
      if (state === 'tracing') return `${spp}, tracing`;
      if (state === 'denoising') return `${spp}, denoising...`;
      if (!oidn) return `${spp}, raw (no OIDN${oidnError ? ': ' + oidnError : ''})`;
      if (denoiseError) return `${spp}, raw (denoise failed)`;
      return `${spp}, ${showDenoised ? `denoised (OIDN ${denoiseMs.toFixed(0)} ms)` : 'raw (denoiser off)'}`;
    },
    info: () => ({
      tracer: '@pmndrs/pathtracer PtMegakernel', bounces, rrStartDepth: 3, nee: true, envSampling: envMap ? 'importance' : 'uniform', clamp: null,
      maxSamples, samples: Math.min(pt.samples, maxSamples), dispatches, denoised, denoiser: oidn ? `OIDN (${(oidn.runtime as { lastChoice?: string }).lastChoice ?? oidn.runtime.name}), albedo + normal aux` : null,
      traceMs: Math.round(traceMs), denoiseMs: Math.round(denoiseMs), readyMs: Math.round(readyMs), clearcoatDropped, sceneBuildMs: Math.round(buildMs),
      scene: { meshes: input.meshes.length, instances: input.instances.length, materials: input.materials.length, textures: input.textures.length, lights: copy.lights.length, kernelBytes: pt.wgslBytes, backgroundComposite: !sameBackground, notes: input.notes },
    }),
    gpuErrors: () => errors,
    dispose() {
      epoch++;
      oidn?.abort();
      try { pt.destroy(); } catch { /* noop */ }
      try { trace.destroy(); sceneBuffers.destroy(); } catch { /* noop */ }
      albedoRT.dispose(); normalRT.dispose(); envSeenRT.dispose(); bgSeenRT.dispose(); rawTex.dispose(); denoisedTex.dispose();
      try { oidn?.dispose?.(); } catch { /* noop */ }
      destroyWebGPU(renderer as N);
    },
  };
  return method;
}
