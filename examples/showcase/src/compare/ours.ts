// Our pipeline as the showcase page runs it (main.ts), in its own canvas and renderer: probes baked
// per scene, ScreenSpaceReflectionsPass (hit colour from last frame's final image), HybridReflections
// with the FFX reflection denoiser behind the denoise seam, and the BVH ray-traced fallback for
// 'ours-rt'. Same settings as the showcase defaults; `ctx.params` only carries explicit experiment
// overrides (?spq= samples per quad, ?tsf= the denoiser's temporal stability, ?hit=current|lit|final,
// ?specOcc=1 Lagarde's specular occlusion from GTAO on the probe part, W39 / D4510; ?hitSource=hits|all
// keeps screen-space hits and traced hits (|all: and misses) apart in the denoiser, ?hitDistW=<k> weights
// its neighbours by relative hit distance, W53 / D3660-D3662).
//
// W51 (bench.html): every setting the tuning bench exposes is read here by its URL key (the schema in
// ../bench/schema.ts names the keys), and `set(key, value)` applies the live ones without a rebuild.
// The bench's own defaults (`ctx.defaults`) add display AA (the showcase's @pmndrs/upscaler, `?aa=`) and
// per-pass GPU timestamps; the compare page passes none, so it renders as before (no AA, no timing).
// W51: @pmndrs/bvh is the examples' ray-tracing provider (`?bvh=three-mesh-bvh` for the stopgap; D1705).
import * as THREE from 'three/webgpu';
import { renderOutput, uniform, vec3, vec4 } from 'three/tsl';
import {
  HybridReflections, MeshBVHTraceProvider, ReflectionProbe, ReflectionProbes, ScreenSpaceReflectionsPass, bvhTraceSceneFromObjects,
  createPmndrsBvhTraceProviderFromObjects, createRaytracerTraceProviderFromObjects, installCubeArraySupport, reflectionProbes,
} from '@pmndrs/reflections/three';
import { resolveScreenSpaceSettings } from '@pmndrs/reflections/core';
import { FfxReflectionDenoiser } from '@pmndrs/denoiser-ffx';
import { ScreenSpaceAO } from '../../../shared/ao';
import { LINEAR_VIEWS, VIEW_IDS, buildDebugViews, type View } from '../debugViews';
import { DisplayAA, aaFromQuery, reflectionReactive, renderSize, type AAMode } from '../../../shared/antialias';
import { brdfFromQuery, hitSourceDenoiserOptions, hitSourceFromQuery, syncDenoiserBrdf } from '../../../shared/denoiser';
import { probeLayout, type ProbeLayoutName } from '../../../shared/probeLayouts';
import { setSpecularAA, specAAFromQuery, specAAHitMaterial, specAAStrength } from '../specAA';
import type { FloorKind } from '../scenes';
import { carInteriorProbes, carWheels, type CarProbesMode } from '../carProbes';
import { hybridReaders } from '../../../shared/metrics/three';
import { presetUrlKeys } from '../bench/schema';
import {
  type CompareMethod, type MethodContext, type MethodId, type SetResult, destroyWebGPU, applySceneParams, applySpecAA, applyGeometryRoughness, freshEnvironment, mergedParams, newCanvas, sceneInfo, syncCamera,
} from './method';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const GLOSSY = 0.447;
export const TONES = { agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping } as const;
export type ToneName = keyof typeof TONES;
export const toneOf = (params: URLSearchParams) => TONES[(params.get('tone') as ToneName) ?? 'agx'] ?? THREE.AgXToneMapping;

/** `ScreenSpaceReflectionsPass.settings` fields the bench sets as `s.<field>` (number / boolean / string). */
const SSSR_FIELDS: Record<string, 'n' | 'b' | 's'> = {
  roughnessThreshold: 'n', maxTraversalIntersections: 'n', minTraversalOccupancy: 'n', depthBufferThickness: 'n', thicknessRoughnessFactor: 'n',
  thicknessLengthFactor: 'n', mostDetailedMip: 'n', temporalVarianceGuidedTracing: 'b', varianceThreshold: 'n', iblFactor: 'n', temporalStabilityFactor: 'n',
  missConfidenceThreshold: 'n', missRoughnessThreshold: 'n', fallbackRoughness: 's', mirrorBias: 'n', frameIndex: 'n',
  hitLobeFilterMixed: 'n', hitShadeOcclusion: 's', // W52 (D3641, D3642)
  quadCopy: 's', // W58 (D3740)
  rayReuse: 's', rayReuseTaps: 'n', rayReuseRadius: 'n', rayReuseMixSources: 'b', rayReusePattern: 's', // W73 (D5040, D5047)
  quadBaseRotation: 's', thicknessDepthFactor: 'n', thicknessDepthMode: 's', // W71 (X1, D5000-D5001; W76 removed hitLobeFilterGrazing and historyEdgeConfidence, D5002-D5003)
  hitColorConeGrazing: 'n', // W76 (D5100)
  hitColorFilter: 's', hitColorConeScale: 'n', mirrorBiasCompensate: 'b', // W72 (D5020-D5022)
  maxCandidates: 'n', // W80 (D5180)
};
/** W76: the fields `resolveScreenSpaceSettings` fills (the bench shows their effective value). */
const RESOLVED_KEYS = new Set(['hitColorFilter', 'mirrorBias', 'mirrorBiasCompensate', 'thicknessDepthMode', 'thicknessDepthFactor']);
/** `ScreenSpaceReflectionsPass.traceSettings` fields the bench sets as `t.<field>`. */
const TRACE_FIELDS: Record<string, 'n' | 'b' | 's'> = {
  maxTracedRaysPerFrame: 'n', maxRaysPerTile: 'n', maxRayLength: 'n', rayLengthRoughnessFalloff: 'n', normalOffset: 'n', reuseOnScreenHits: 'b',
  hitShadows: 'b', hitSpecular: 'b', onScreenDepthTolerance: 'n', iblFactor: 'n',
  hitShadeVisibility: 's', // W52 (D3640)
  // W74 (X4, D5060): half-rate glossy misses + the bilateral fill
  tracedMissRate: 's', tracedHalfRateMinRoughness: 'n', fillPlaneTolerance: 'n', fillNormalPower: 'n', fillRoughnessTolerance: 'n', fillSourceMask: 'n', fillMinWeightSum: 'n', fillFootprint: 'n',
};
/** @pmndrs/upscaler runtime settings the bench sets as `aa.<field>` (plus `sharpness` / `accum`, the showcase's keys). */
const UPSCALER_FIELDS: Record<string, 'n' | 'b'> = { rcasDenoise: 'b', exposure: 'n', autoExposure: 'b', lockThinFeatures: 'b', detectShadingChanges: 'b' };
const parse = (t: 'n' | 'b' | 's', v: string) => (t === 'n' ? Number(v) : t === 'b' ? v === '1' || v === 'true' : v);

export async function createOurs(id: Extract<MethodId, 'ours-raw' | 'ours-denoised' | 'ours-rt' | 'probes'>, ctx: MethodContext): Promise<CompareMethod> {
  const { width: W, height: H } = ctx;
  const params = mergedParams(ctx);
  // W77: ?preset=<name> sets the URL keys it names wherever the URL doesn't (explicit keys win; clearing one returns it to the preset's)
  const presetKeys = presetUrlKeys(params.get('preset'));
  for (const [k, v] of Object.entries(presetKeys)) if (!params.has(k)) params.set(k, v);
  const canvas = newCanvas(W, H);
  const adapter = await navigator.gpu.requestAdapter();
  const maxBytes = Math.min(adapter?.limits.maxColorAttachmentBytesPerSample ?? 32, 64);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: {
    maxColorAttachmentBytesPerSample: maxBytes,
    // W61 (D4804): a probe layout of three sizes is three atlas bindings in every Sponza material (18 > the default 16)
    // W82 (D5200, opt-in): the @pmndrs/raytracer provider binds 5 storage buffers; with probe hit shading the traced pass needs 9
    ...(__RAYTRACER_AVAILABLE__ && params.get('rtShade') === '1' && adapter ? { maxStorageBuffersPerShaderStage: Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 10) } : {}),
    ...(params.has('probeLayout') && adapter ? { maxSampledTexturesPerShaderStage: Math.min(adapter.limits.maxSampledTexturesPerShaderStage, 48) } : {}),
  } } as N);
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setSize(W, H, false);
  await renderer.init();
  // cube arrays on stock r187 (W20 shim, self-tested; the 2D array if it fails), as the showcase page. ?shim=0 opts out.
  if (params.get('shim') !== '0') await installCubeArraySupport(renderer);
  renderer.toneMappingExposure = ctx.exposure;

  // W51: display AA / upscaling as the showcase (../../../shared/antialias.ts): `?aa=upscaler|taa|off` (the compare
  // page: off unless asked), `?upscale=<preset|ratio>` (G-buffer and reflections at the render size)
  const aaQ = aaFromQuery(params, 'off');
  const { width: RW, height: RH } = renderSize(W, H, aaQ.ratio);
  const timestamps = params.get('timestamps') === '1';
  const ssr = new ScreenSpaceReflectionsPass(renderer, { missList: true, timestamps, gbufferOptions: { width: RW, height: RH } });
  const device = ssr.device;
  const timestampsOn = timestamps && device.features.has('timestamp-query');
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; errors.push(m); console.error('[ours webgpu]', m); });
  const wantDenoise = id === 'ours-denoised' || id === 'ours-rt';
  // the denoiser's options: ?tsf= (temporalStabilityFactor), W51 `dn.<option>`; its roughness gate follows the
  // tracer's threshold (alpha = perceptual^2) unless `dn.roughnessThreshold` sets it
  const denoiserOptions = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { roughnessThreshold: (ssr.settings.roughnessThreshold ?? GLOSSY) ** 2, timestamps: timestampsOn };
    if (params.has('tsf')) o.temporalStabilityFactor = Number(params.get('tsf'));
    if (params.has('dn.roughnessThreshold')) o.roughnessThreshold = Number(params.get('dn.roughnessThreshold'));
    if (params.has('dn.currentFrameStatistics')) o.currentFrameStatistics = params.get('dn.currentFrameStatistics') === '1';
    if (params.has('dn.missDistance')) o.missDistance = Number(params.get('dn.missDistance'));
    Object.assign(o, hitSourceDenoiserOptions(hitSourceFromQuery(params))); // W53
    return o;
  };
  if (params.has('s.roughnessThreshold')) ssr.settings.roughnessThreshold = Number(params.get('s.roughnessThreshold'));
  let denoiserOpts = denoiserOptions();
  let denoiser: N = wantDenoise && FfxReflectionDenoiser ? new FfxReflectionDenoiser(device, denoiserOpts) : null;
  const hybridOptions: Record<string, unknown> = { denoiser, denoiserHitSource: hitSourceFromQuery(params).hitSource };
  if (params.has('h.denoiserMotion')) hybridOptions.denoiserMotion = params.get('h.denoiserMotion');
  if (params.has('h.denoiserRoughness')) hybridOptions.denoiserRoughness = params.get('h.denoiserRoughness');
  const hybrid = new HybridReflections(ssr, hybridOptions as N);
  hybrid.denoise = !!denoiser && params.get('denoise') !== '0';

  const kit = await ctx.entry.build(W / H);
  await freshEnvironment(kit, ctx.entry);
  const floorRoughness0 = kit.floor.roughness;
  applySceneParams(kit, params);
  const specAA = applySpecAA(kit, params);
  const geoRough = applyGeometryRoughness(kit, params); // W56
  const camera = kit.camera;
  delete ssr.settings.depthBufferThickness; delete ssr.settings.thicknessRoughnessFactor;
  if (kit.thickness) Object.assign(ssr.settings, kit.thickness);
  if (params.has('spq')) ssr.settings.samplesPerQuad = Number(params.get('spq')) as 1 | 2 | 4;
  let hit = (params.get('hit') ?? 'final') as 'final' | 'lit' | 'current';
  // W44 (D3540): ?reshade=reshade|off (default the package's 'reshade')
  ssr.settings.hitShading = (params.get('reshade') ?? 'reshade') as 'reshade' | 'off';
  // W45 (D3550): ?lobeFilter=<k> filtered importance sampling at hits (default: the package's)
  if (params.has('lobeFilter')) ssr.settings.hitLobeFilter = Number(params.get('lobeFilter'));
  // W52 halo options (D3640-D3642): ?shadeVis=all the visibility ray for on-screen re-shaded traced hits,
  // ?lobeMix=<0..1> the lobe filter's scale where traced and screen-space hits mix, ?shadeOcc=screen the
  // re-shade's depth-buffer occlusion march (screen-space hits, and on-screen traced hits without the ray)
  if (params.has('shadeVis')) ssr.traceSettings.hitShadeVisibility = params.get('shadeVis') as 'offscreen' | 'all';
  if (params.has('lobeMix')) ssr.settings.hitLobeFilterMixed = Number(params.get('lobeMix'));
  if (params.has('shadeOcc')) ssr.settings.hitShadeOcclusion = params.get('shadeOcc') as 'off' | 'screen';
  // ?rtLobeFilter=<k>: the traced pass's own hitLobeFilter (default: the tracer's), to split the lobe filter's effect by pass
  if (params.has('rtLobeFilter')) ssr.traceSettings.hitLobeFilter = Number(params.get('rtLobeFilter'));
  const motionScale = Number(params.get('motionScale') ?? 1);
  // the page's settings before any bench override: `set(key, null)` returns a field to this
  const baseSettings = { ...ssr.settings };
  const baseTrace = { ...ssr.traceSettings };
  for (const [f, t] of Object.entries(SSSR_FIELDS)) if (params.has(`s.${f}`)) (ssr.settings as N)[f] = parse(t, params.get(`s.${f}`)!);
  for (const [f, t] of Object.entries(TRACE_FIELDS)) if (params.has(`t.${f}`)) (ssr.traceSettings as N)[f] = parse(t, params.get(`t.${f}`)!);
  // W75 (X5, D5080): half-res reflections; composites are built for one mode, so it is read at creation (Rebuild)
  if (params.has('s.reflectionResolution')) ssr.settings.reflectionResolution = params.get('s.reflectionResolution') as 'full' | 'half';
  // the traced misses take their fallback at the tracer's roughness setting (the adapter doesn't pass it on)
  if (ssr.settings.fallbackRoughness) ssr.traceSettings.fallbackRoughness = ssr.settings.fallbackRoughness;
  let ssrOn = params.get('ssr') !== '0';
  const applySSROn = () => { if (ssrOn) { if (params.has('s.maxTraversalIntersections')) ssr.settings.maxTraversalIntersections = Number(params.get('s.maxTraversalIntersections')); else delete ssr.settings.maxTraversalIntersections; } else ssr.settings.maxTraversalIntersections = 0; };
  applySSROn();

  // probes, as the showcase bakes them; W61: ?probeLayout=few|medium|many|manyCell|mixed (&probeBlend=) bakes
  // that layout at the equal memory budget instead (../../../shared/probeLayouts.ts, Sponza only)
  const layout = params.has('probeLayout') ? probeLayout(kit.id, params.get('probeLayout') as ProbeLayoutName, kit.probes, { blend: Number(params.get('probeBlend') ?? 0.25) }) : null;
  const probes = new ReflectionProbes();
  // W51: ?probeStorage=auto|cube-array|cube2d (ReflectionProbes.layout)
  if (params.has('probeStorage')) probes.layout = params.get('probeStorage') as N;
  for (const v of layout?.volumes ?? kit.probes) {
    const p = new ReflectionProbe(...v.influenceSize);
    p.position.set(...v.position);
    if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
    if (v.originOffset) p.originOffset.set(...v.originOffset);
    if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
    if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
    if (v.resolution !== undefined) p.resolution = v.resolution;
    probes.add(p);
  }
  // W55: ?carProbes=wheels|cabin|both adds carConcept's interior probes (wheel wells, cabin; boxes from the car's
  // geometry, ../carProbes.ts) at ?carProbeRes= px (default 128; the stage probe keeps its size)
  const carVolumes = carInteriorProbes(kit, (params.get('carProbes') ?? 'off') as CarProbesMode, Number(params.get('carProbeRes') ?? 128));
  for (const v of carVolumes) {
    const p = new ReflectionProbe(...v.influenceSize);
    p.name = v.name;
    p.position.set(...v.position);
    p.originOffset.set(...v.originOffset);
    p.blendDistance = v.blendDistance;
    p.resolution = v.resolution;
    probes.add(p);
  }
  kit.scene.add(probes);
  let bakeMs = 0;
  const bake = () => {
    const t0 = performance.now();
    const sc = kit.scene, keep = [sc.backgroundIntensity, sc.backgroundBlurriness] as const;
    if (sc.background === sc.environment) { sc.backgroundIntensity = sc.environmentIntensity; sc.backgroundBlurriness = 0; }
    probes.bake(renderer, kit.scene, {
      ...(params.has('probeRes') ? { resolution: Number(params.get('probeRes')) } : {}),
      ...(layout && layout.name !== 'shipped' ? { resolution: layout.resolution } : {}),
      ...(params.has('bounces') ? { bounces: Number(params.get('bounces')) } : {}), // default 2 (D4300)
      near: kit.bake.near, far: kit.bake.far,
      // W55 experiment: ?carProbeCapture=noWheels leaves the wheels out of every capture (bake's exclude is set-wide)
      ...(params.get('carProbeCapture') === 'noWheels' ? { exclude: carWheels(kit) } : {}),
    });
    [sc.backgroundIntensity, sc.backgroundBlurriness] = keep;
    bakeMs = performance.now() - t0;
  };
  bake();
  // W26 (D53): ?seam=0|1|dist|lerp Lagarde's distanceRoughness / roughnessLerp (lit and composite), default: the package's
  if (params.has('seam')) {
    const v = params.get('seam');
    probes.distanceRoughness = v === '1' || v === 'dist';
    probes.roughnessLerp = v === '1' || v === 'lerp';
  }
  // W51: the set-wide lookup options (ReflectionProbes properties; every lookup of the set reads them)
  if (params.has('pr.distanceRoughness')) probes.distanceRoughness = params.get('pr.distanceRoughness') === '1';
  if (params.has('pr.roughnessLerp')) probes.roughnessLerp = params.get('pr.roughnessLerp') === '1';
  if (params.has('pr.lodMapping')) probes.lodMapping = params.get('pr.lodMapping') as N;
  if (params.has('pr.boxProjection')) probes.boxProjection = params.get('pr.boxProjection') === '1';
  // W51: ?probes=0 lights with the plain environment (no probes in the lit image or the composite)
  const probesOn = params.get('probes') !== '0';
  const envNode: N = probesOn ? reflectionProbes(probes) : null;
  kit.scene.environmentNode = envNode;
  /** Re-bake (a floor or material change the probes should see), as the showcase's `bake()`; nodes keep the set. */
  const rebake = () => { renderer.setRenderTarget(null); bake(); resetAll(); };

  // the ray-traced fallback: @pmndrs/bvh by default (W51, the maintainer's call on D1705), ?bvh=three-mesh-bvh the stopgap
  const bvhKind = params.get('bvh') === 'three-mesh-bvh' ? 'three-mesh-bvh' : 'pmndrs';
  let provider: { destroy(): void } | null = null;
  let providerInfo: { kind: string; triangles: number; builder?: string } | null = null;
  let updateHitMaterials: () => void = () => {};
  const traceMeshes: THREE.Mesh[] = [];
  if (id === 'ours-rt') {
    kit.scene.updateMatrixWorld(true);
    kit.scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.noTrace) traceMeshes.push(o as THREE.Mesh); });
    // W46: ?specAAHits=0 keeps the traced hits' authored roughness with ?specAA on
    const material = params.get('specAAHits') === '0' ? undefined : specAAHitMaterial;
    const shadingNormals = params.get('rtShadingNormals') !== '0';
    if (bvhKind === 'pmndrs' && __RAYTRACER_AVAILABLE__ && params.get('rtShade') === '1') {
      // W82 (T70): the opt-in @pmndrs/raytracer provider and its hit shading (rtShade) instead of the probes
      const built = await createRaytracerTraceProviderFromObjects(device, traceMeshes, { ...(material ? { material } : {}), shadingNormals });
      provider = built.provider;
      providerInfo = { kind: '@pmndrs/raytracer', triangles: built.provider.info.triangles, builder: built.provider.info.builder };
      ssr.setTraceProvider(built.provider);
      ssr.setRaytracerHitShading(true);
      updateHitMaterials = () => { const s = bvhTraceSceneFromObjects(traceMeshes, { ...(material ? { material } : {}), shadingNormals }); if (s.scene.materials) built.provider.setMaterials(s.scene.materials); };
    } else if (bvhKind === 'pmndrs') {
      const builder = (params.get('bvhBuilder') ?? 'auto') as N;
      const built = await createPmndrsBvhTraceProviderFromObjects(device, traceMeshes, { ...(material ? { material } : {}), shadingNormals, ...(builder !== 'auto' ? { builder } : {}) });
      provider = built.provider;
      providerInfo = { kind: '@pmndrs/bvh', triangles: built.provider.info.triangles, builder: built.provider.info.builder };
      ssr.setTraceProvider(built.provider);
      updateHitMaterials = () => { const s = bvhTraceSceneFromObjects(traceMeshes, { ...(material ? { material } : {}), shadingNormals }); if (s.scene.materials) built.provider.setMaterials(s.scene.materials); };
    } else {
      const p = await MeshBVHTraceProvider.fromObjects(device, traceMeshes, { ...(material ? { material } : {}), shadingNormals });
      provider = p;
      providerInfo = { kind: 'three-mesh-bvh', triangles: p.triangles };
      ssr.setTraceProvider(p);
      updateHitMaterials = () => p.updateMaterials();
    }
    ssr.rayTracing = params.get('rt') !== '0';
  }

  // display: the composite, tone-mapped (AgX + sRGB by default, ?tone=) as the showcase's 'final' view; 'probes' = SSR amount 0
  const ao = params.get('specOcc') === '1' ? new ScreenSpaceAO(ssr.gbuffer, camera) : null;
  Object.assign(hybrid.options, {
    probes: probesOn ? probes : null, environment: kit.scene.environment, environmentIntensity: kit.scene.environmentIntensity, ao: ao ? (u: N) => ao.sample(u) : null,
  });
  hybrid.rebuild();
  let amount = id === 'probes' ? 0 : Number(params.get('h.amount') ?? 1);
  if (params.has('h.depthAware')) hybrid.depthAware.value = Number(params.get('h.depthAware'));
  const c = hybrid.composite();
  c.amount.value = amount;
  const tone = toneOf(params);
  const toned = (x: N): N => (renderOutput(x, tone, THREE.SRGBColorSpace) as N).rgb;
  // with the upscaler, the display graph outputs linear colour and the AA tone-maps after it (antialias.ts)
  const linear = uniform(0);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  // W57: the showcase's debug views (?view=), one graph picked by a uniform
  const uView = uniform(Math.max(0, VIEW_IDS.indexOf((params.get('view') ?? 'final') as View)));
  const currentView = (): View => VIEW_IDS[uView.value] ?? 'final';
  const views = buildDebugViews({
    c, ssr, tone: (x: N) => toned(x), T: (x: N) => (linear as N).equal(1).select(x, toned(x)),
    roughnessThreshold: hybrid.roughnessThreshold, probesOn: uniform(probesOn ? 1 : 0), ao: ao ? (u: N) => ao.sample(u) : null,
  });
  let viewOut: N = vec3(0);
  VIEW_IDS.forEach((v, i) => { viewOut = uView.equal(i).select(views[v], viewOut); });
  pipeline.outputNode = vec4(viewOut, 1);
  const maskPipeline = new THREE.RenderPipeline(renderer);
  maskPipeline.outputColorTransform = false;
  maskPipeline.outputNode = vec4(c.geometry.and(c.roughness.lessThan(GLOSSY)).select(vec3(1), vec3(0)), 1);

  // hit colour from last frame's final image (the showcase default)
  const historyRT = new THREE.RenderTarget(RW, RH, { type: THREE.HalfFloatType, depthBuffer: false });
  const historyMaterial = new THREE.MeshBasicNodeMaterial();
  historyMaterial.toneMapped = false;
  const h = hybrid.composite();
  h.amount.value = amount;
  historyMaterial.colorNode = h.final;
  const historyQuad = new THREE.QuadMesh(historyMaterial);
  const setHit = (m: 'final' | 'lit' | 'current') => {
    hit = m;
    ssr.settings.hitColor = m === 'current' ? 'current' : 'history';
    ssr.historySource = m === 'final' ? historyRT.texture : null;
  };
  setHit(hit);

  // display AA: created on first use (the compare page never pays for an upscaler it doesn't run)
  let aa: DisplayAA | null = null;
  let aaMode: AAMode = aaQ.mode;
  const upscalerSettings = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...aaQ.settings };
    for (const [f, t] of Object.entries(UPSCALER_FIELDS)) if (params.has(`aa.${f}`)) o[f] = parse(t, params.get(`aa.${f}`)!);
    return o;
  };
  let reactiveScale = Number(params.get('reactive') ?? 0);
  const applyReactive = () => aa?.setReactive(reactiveScale > 0 ? reflectionReactive(h, ssr.gbuffer.textures.motion!, reactiveScale) : null);
  const makeAA = async () => {
    if (aa) return aa;
    const a = new DisplayAA(renderer, ssr.gbuffer as N, { mode: aaMode, ratio: aaQ.ratio, settings: upscalerSettings() as N, displayWidth: W, displayHeight: H, tone: toned, gpuTiming: false });
    await a.init();
    aa = a;
    a.toneView = LINEAR_VIEWS.includes(currentView());
    applyReactive();
    return a;
  };
  if (aaMode !== 'off' || aaQ.ratio > 1) await makeAA();

  const nextNodeFrame = () => (renderer as N)._nodes.nodeFrame.update();
  // W78 (D5140): ?brdf=replace|combine, BRDF / pdf weights in FFX's prefilter (live key `brdf`)
  let brdfMode = brdfFromQuery(params);
  let keepBlack = params.get('keepBlack') !== '0';
  let brdfMin = params.has('brdfMin') ? Number(params.get('brdfMin')) : undefined;
  const draw = (cam: THREE.PerspectiveCamera, useAA: boolean) => {
    nextNodeFrame();
    syncDenoiserBrdf(ssr, hybrid, brdfMode, keepBlack, brdfMin);
    if (params.get('keepSample') === '1') ssr.settings.sampleDirection = true; // A/B runs: no tracer rebuild between modes
    syncCamera(camera, cam);
    const a = useAA ? aa : null;
    const j = a ? a.begin(camera) : {};
    linear.value = a ? a.linear.value : 0;
    ssr.render(kit.scene, camera, j);
    a?.end(camera);
    if (motionScale !== 1) {
      // experiment (?motionScale=): scale the motion the denoise seam hands the denoiser, to test
      // whether the reprojection is aligned (flicker in motion should be lowest at 1)
      const f = ssr.gbuffer.frame as N;
      const m = f.conventions.motionVectorScale;
      f.conventions = { ...f.conventions, motionVectorScale: [m[0] * motionScale, m[1] * motionScale] };
    }
    hybrid.update();
  };
  const resetAll = () => { ssr.resetHistory(); hybrid.resetHistory(); ssr.gbuffer.resetHistory(); aa?.reset(); };
  ssr.resetHistory(); hybrid.resetHistory();
  let timings: ReadonlyMap<string, number> = new Map();
  let hybridTimings: ReadonlyMap<string, number> = new Map(); // W75: the half-res upsample

  /** Rebuild the FFX denoiser with the current options (it takes them at construction; drops its history). */
  const renewDenoiser = () => {
    if (!wantDenoise || !FfxReflectionDenoiser) return;
    denoiserOpts = denoiserOptions();
    const old = denoiser;
    denoiser = new FfxReflectionDenoiser(device, denoiserOpts);
    hybrid.setDenoiser(denoiser);
    old?.dispose?.();
    resetAll();
  };
  const setParam = (k: string, v: string | null) => { if (v !== null) params.set(k, v); else if (presetKeys[k] !== undefined) params.set(k, presetKeys[k]); else params.delete(k); };
  const setW53 = () => {
    const hs = hitSourceFromQuery(params);
    hybrid.denoiserHitSource = hs.hitSource;
    denoiser?.setOptions?.(hitSourceDenoiserOptions(hs));
    denoiserOpts = denoiserOptions();
    resetAll();
  };

  /** W51: live settings by URL key (the bench); anything else this method reads at creation only. */
  const live: Record<string, (v: string | null) => void> = {
    spq: (v) => { if (v === null) delete ssr.settings.samplesPerQuad; else ssr.settings.samplesPerQuad = Number(v) as 1 | 2 | 4; },
    hit: (v) => setHit((v ?? 'final') as 'final' | 'lit' | 'current'),
    view: (v) => {
      const view = (v ?? 'final') as View;
      uView.value = Math.max(0, VIEW_IDS.indexOf(view));
      if (aa) { aa.toneView = LINEAR_VIEWS.includes(view); aa.reset(); }
    },
    reshade: (v) => { ssr.settings.hitShading = (v ?? 'reshade') as 'reshade' | 'off'; },
    lobeFilter: (v) => { if (v === null) delete ssr.settings.hitLobeFilter; else ssr.settings.hitLobeFilter = Number(v); },
    // W52: the traced pass's own lobe filter (the compare page's ?rtLobeFilter=); unset = the tracer's
    rtLobeFilter: (v) => { if (v === null) delete ssr.traceSettings.hitLobeFilter; else ssr.traceSettings.hitLobeFilter = Number(v); },
    ssr: (v) => { ssrOn = v !== '0'; applySSROn(); },
    rt: (v) => { if (provider) ssr.rayTracing = v !== '0'; },
    denoise: (v) => { hybrid.denoise = !!denoiser && v !== '0'; },
    tsf: () => renewDenoiser(),
    'dn.roughnessThreshold': () => renewDenoiser(),
    'dn.currentFrameStatistics': () => renewDenoiser(),
    'dn.missDistance': () => renewDenoiser(),
    // W53 (D3660-D3662): the hit source / hit-distance weight, changed on the live denoiser (setOptions)
    hitSource: () => setW53(),
    hitMissAny: () => setW53(),
    hitDistW: () => setW53(),
    // W78 (D5140): the tracer rebuilds on an on / off flip (sampleDirection), the denoiser takes setOptions
    brdf: (v) => { brdfMode = brdfFromQuery(new URLSearchParams(v === null ? {} : { brdf: v })); resetAll(); },
    keepBlack: (v) => { keepBlack = v !== '0'; resetAll(); },
    brdfMin: (v) => { brdfMin = v === null ? undefined : Number(v); resetAll(); },
    'h.depthAware': (v) => { hybrid.depthAware.value = v === null ? 1 : Number(v); },
    'h.amount': (v) => { if (id === 'probes') return; amount = v === null ? 1 : Number(v); c.amount.value = h.amount.value = amount; },
    aa: (v) => {
      aaMode = (v ?? (ctx.defaults?.aa as AAMode) ?? 'off') as AAMode;
      if (aa) aa.mode = aaMode; else if (aaMode !== 'off') void makeAA().then((a) => { a.mode = aaMode; });
    },
    reactive: (v) => { reactiveScale = Number(v ?? 0); applyReactive(); },
    sharpness: (v) => { if (aa) aa.upscaler.settings.sharpness = v === null ? aaQ.settings.sharpness : Number(v); },
    accum: (v) => { if (aa) aa.upscaler.settings.maxAccumulation = v === null ? aaQ.settings.maxAccumulation : Number(v); },
    specAA: (v) => {
      const s = v === null ? specAAFromQuery(new URLSearchParams(ctx.defaults ?? {}), 1) : specAAFromQuery(new URLSearchParams({ specAA: v }), 0);
      if (s > 0) specAAStrength.value = s;
      setSpecularAA(kit.scene, s > 0);
      updateHitMaterials();
      rebake();
    },
    floorRoughness: (v) => { kit.floor.setRoughness(v === null ? floorRoughness0 : Number(v)); rebake(); },
    floor: (v) => { kit.floor.setKind?.((v ?? 'mirror') as FloorKind); rebake(); },
    floorPolish: (v) => { kit.floor.setPolished?.(v !== '0'); rebake(); },
    maskSpecAA: () => {},
  };
  for (const f of Object.keys(SSSR_FIELDS)) {
    live[`s.${f}`] = (v) => {
      if (v === null) { if ((baseSettings as N)[f] === undefined) delete (ssr.settings as N)[f]; else (ssr.settings as N)[f] = (baseSettings as N)[f]; }
      else (ssr.settings as N)[f] = parse(SSSR_FIELDS[f], v);
      if (f === 'fallbackRoughness') { if (v === null) delete ssr.traceSettings.fallbackRoughness; else ssr.traceSettings.fallbackRoughness = v as 'mirror' | 'surface'; }
      if (f === 'maxTraversalIntersections') applySSROn();
      if (f === 'roughnessThreshold' && !params.has('dn.roughnessThreshold')) renewDenoiser(); // the denoiser's gate follows it (W34)
    };
  }
  for (const f of Object.keys(TRACE_FIELDS)) {
    live[`t.${f}`] = (v) => {
      if (v === null) { if ((baseTrace as N)[f] === undefined) delete (ssr.traceSettings as N)[f]; else (ssr.traceSettings as N)[f] = (baseTrace as N)[f]; }
      else (ssr.traceSettings as N)[f] = parse(TRACE_FIELDS[f], v);
    };
  }
  for (const f of Object.keys(UPSCALER_FIELDS)) {
    live[`aa.${f}`] = () => { if (aa) Object.assign(aa.upscaler.settings, upscalerSettings()); };
  }
  /** Keys read only at creation (a Rebuild applies them). */
  const REBUILD = new Set(['bvh', 'bvhBuilder', 'rtShade', 'rtShadingNormals', 'specAAHits', 'h.denoiserMotion', 'h.denoiserRoughness', 'probes', 'probeRes', 'bounces', 'probeStorage',
    'probeLayout', 'probeBlend', 'carProbes', 'carProbeRes', 'carProbeCapture', 'specOcc', 'seam', 'pr.distanceRoughness', 'pr.roughnessLerp', 'pr.lodMapping', 'pr.boxProjection', 'upscale', 'tone', 'keyLight', 'paintRoughness', 'geometryRoughness', 'bgBlur', 'bgIntensity', 'envLight', 'background', 'timestamps', 'shim',
    's.reflectionResolution', 'preset']);

  return {
    id, canvas, scene: sceneInfo(kit),
    frame(cam) {
      draw(cam, true);
      const target = aa?.target ?? null;
      renderer.setRenderTarget(target);
      pipeline.render();
      renderer.setRenderTarget(null);
      aa?.resolve(camera);
      if (hit === 'final') {
        renderer.setRenderTarget(historyRT);
        historyQuad.render(renderer);
        renderer.setRenderTarget(null);
      }
      // never blocks: resolves with this frame's timestamps a few ms later (and recycles the readback buffer)
      if (timestampsOn) ssr.readTimings().then((t) => { timings = t; }).catch(() => {});
      if (timestampsOn) hybrid.readTimings().then((t) => { hybridTimings = t; }).catch(() => {});
    },
    renderMask(cam) {
      // W46: the glossy mask from the authored roughness, so Measure compares ?specAA off and on over
      // the same pixels (?maskSpecAA=1: from the adjusted roughness)
      const authored = specAA.strength > 0 && params.get('maskSpecAA') !== '1';
      if (authored) setSpecularAA(kit.scene, false);
      draw(cam, false); renderer.setRenderTarget(null); maskPipeline.render();
      if (authored) setSpecularAA(kit.scene, true);
    },
    idle: () => device.queue.onSubmittedWorkDone(),
    // X0 (W70): linear readbacks for examples/shared/metrics (energy, raw speckle, the raw 2x2 energy)
    ...hybridReaders(renderer, ssr, hybrid),
    setDenoise(on) { const was = hybrid.denoise; hybrid.denoise = on && !!denoiser; return was; },
    jitterPhases: () => (aa && aa.mode === 'upscaler' ? aa.upscaler.jitterPhaseCount : null),
    reset: resetAll,
    setExposure(e) { renderer.toneMappingExposure = e; },
    status: () => (denoiser ? 'denoiser ffx-reflections' : wantDenoise ? 'no denoiser found' : '') + (providerInfo ? ` | ${providerInfo.kind} ${providerInfo.triangles.toLocaleString()} tris` : '') +
      (aa && aa.mode !== 'off' ? ` | AA ${aa.mode}${aa.ratio > 1 ? ` x${aa.ratio.toFixed(2)}` : ''}` : ''),
    info: () => ({
      samplesPerQuad: ssr.settings.samplesPerQuad ?? 1, hitColor: hit, hitShading: ssr.settings.hitShading,
      hitShadeVisibility: ssr.traceSettings.hitShadeVisibility ?? 'offscreen', hitLobeFilterMixed: ssr.settings.hitLobeFilterMixed ?? 1, hitShadeOcclusion: ssr.settings.hitShadeOcclusion ?? 'off', denoiser: denoiser ? { ...denoiserOpts } : null,
      thickness: kit.thickness ?? 'default', rayTracing: ssr.rayTracing, provider: providerInfo, probes: probes.bakedProbes.length, probeLayout: layout?.name ?? null, carProbes: carVolumes.map((v) => v.name), atlases: probes.bakedResolutions, specAA, geometryRoughness: geoRough,
      aa: aa ? { mode: aa.mode, ratio: aa.ratio, renderSize: [RW, RH] } : 'off', bakeMs,
      varianceGuidedTracing: 'off (the seam passes no variance back to the tracer)',
    }),
    set(key, value) {
      const f = live[key];
      if (f) { setParam(key, value); f(value); if (!/^(aa|reactive|sharpness|accum|aa\..*|maskSpecAA)$/.test(key)) ssr.resetHistory(); return 'live'; }
      if (REBUILD.has(key)) { setParam(key, value); return 'rebuild'; }
      return 'ignored';
    },
    get(key) {
      if (key.startsWith('s.')) {
        // W76: unset fields show what the tracer resolves them to (the cone / compensation defaults, and with RT
        // on the 'relative' thickness), so the bench shows the effective value
        const eff = resolveScreenSpaceSettings({ ...ssr.settings, missesTraced: ssr.rayTracing && !!ssr.traced });
        const v = (ssr.settings as N)[key.slice(2)] ?? (RESOLVED_KEYS.has(key.slice(2)) ? (eff as N)[key.slice(2)] : undefined);
        return v === undefined ? undefined : String(typeof v === 'boolean' ? +v : v);
      }
      if (key.startsWith('t.')) { const v = (ssr.traceSettings as N)[key.slice(2)]; return v === undefined ? undefined : String(typeof v === 'boolean' ? +v : v); }
      if (key === 'floorRoughness') return String(kit.floor.roughness);
      return undefined;
    },
    timings() {
      const out = new Map<string, number>();
      for (const [k, v] of timings) out.set(k === 'total' ? 'reflections total' : k, v);
      for (const [k, v] of hybridTimings) if (k !== 'total') out.set(k, v);
      const dn = hybrid.denoise ? (denoiser?.gpuTimings as ReadonlyMap<string, number> | undefined) : undefined;
      if (dn) for (const [k, v] of dn) out.set(k === 'total' ? 'denoise total' : `denoise ${k}`, v);
      if (aa && aa.mode === 'upscaler') for (const [k, v] of aa.timings) out.set(`upscaler ${k}`, v);
      return out;
    },
    traceStats: () => (ssr.rayTracing ? ssr.readTraceStats() : Promise.resolve(null)),
    gpuErrors: () => errors,
    dispose() {
      provider?.destroy();
      aa?.dispose();
      hybrid.dispose();
      probes.dispose();
      historyRT.dispose();
      destroyWebGPU(renderer as N);
    },
  } satisfies CompareMethod & { set(key: string, value: string | null): SetResult };
}
