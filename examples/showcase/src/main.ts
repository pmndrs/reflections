// examples/showcase: the whole pipeline on real assets. Pick a scene; the page bakes the scene's
// suggested reflection probes, renders ScreenSpaceReflectionsPass (G-buffer + screen-space trace,
// hit colour from last frame's image) and resolves with HybridReflections (SSR -> RT -> probes ->
// environment, denoised through the denoise seam by denoiser/ffx when the sibling Denoiser repo is
// there); the ray-traced fallback (three-mesh-bvh behind core's trace seam) is a toggle that builds
// the BVH on first use.
//
// Sources: probes on/off swaps `scene.environmentNode` (and the composite's probe term) between the
// probes and the plain environment; SSR off with RT on traces every ray (the screen-space march gets
// zero steps, so every ray lands in the miss list); both off is three's own image-based lighting.
// "Reflections off" is the composite minus its whole specular image-based term (direct-light
// highlights stay).
//
// Display: anti-aliasing after the composite (../../shared/antialias.ts, W36), as the FFX sample and the
// denoiser repo's demo run a TAA: without it every edge, normal-mapped highlight and the reflections of them
// crawl in motion, and the denoised reflections keep a 1-3/255 shimmer at rest. Default: @pmndrs/upscaler's
// temporal path at ratio 1 (NativeAA); ?aa=taa is W40's resolve (D3500), ?aa=off (or ?taa=0) none.
// ?upscale=quality|balanced|performance|ultra|<ratio>: G-buffer and reflections at the render size, upscaled.
//
// Specular occlusion (W39, D66 / D4510): ?specOcc=1 (default off) hands the composite a screen-space AO (three's GTAO
// on the G-buffer, ../../shared/ao.ts) for Lagarde's specular occlusion on the probe / environment part; also a
// checkbox, and the 'ao' / 'specularOcclusion' views.
//
// Roughness from normal variance (W46, D3570): on by default (SPEC_AA_DEFAULT; ?specAA=0 turns it off) raises every glTF material's
// roughness by its normal map's variance at the sampled mip (Toksvig, vMF form; ./specAA.ts), in three's lit term, the
// G-buffer and traced hits alike; ?specAA=<k> scales the added variance. Also a checkbox under "Materials".
//
// W51: ?lobeFilter=<k> (`settings.hitLobeFilter`, D3550; default the package's 1; also a slider), ?bvh=three-mesh-bvh (the RT
// stopgap; @pmndrs/bvh is the default), and every other knob on ./bench.html (the tuning bench; docs/SETTINGS.md).
// URL: ?scene=<id> ?pose=<name> ?rt=1 ?ssr=0 ?probes=0 ?specOcc=1 ?specAA=0|1|<k> ?probeRes=<px> ?bounces=<n> (probe bake passes, default 2) ?denoise=0 ?shadeVis=all ?lobeMix=<0..1> ?shadeOcc=screen ?lobeFilter=<k> (W52) ?hitSource=hits|all ?hitDistW=<k> (W53: the denoiser keeps hit sources apart / weights by hit distance) ?aa=upscaler|taa|off ?upscale=<preset> ?reactive=<0..1> ?off ?view=<view> ?w=&h= (fixed size) ?manual
// `window.__p` drives the page headlessly (scripts/run-headless.mjs, section `showcase`).
import * as THREE from 'three/webgpu';
import { mix, renderOutput, uniform, uv, vec3, vec4 } from 'three/tsl';
import * as TSL from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  HybridReflections, MeshBVHTraceProvider, ReflectionProbe, ReflectionProbes, ReflectionProbesHelper, ScreenSpaceReflectionsPass, bvhTraceSceneFromObjects,
  createPmndrsBvhTraceProviderFromObjects, installCubeArraySupport, reflectionProbes, sampleReflectionProbes,
  applyReflectionsPreset, reflectionsPreset, type ReflectionsPresetName,
} from '@pmndrs/reflections/three';
import { availableAssets, probeAtlasBytes } from '../../shared';
import { createReflectionDenoiser, denoiserAvailable, hitSourceDenoiserOptions, hitSourceFromQuery, setDenoiserHitSource, type DenoiserHitSourceSettings } from '../../shared/denoiser';
import { AA_MODES, DisplayAA, aaFromQuery, reflectionReactive, renderSize, type AAMode } from '../../shared/antialias';
import { ScreenSpaceAO } from '../../shared/ao';
import { LINEAR_VIEWS, VIEWS, VIEW_IDS, VIEW_LEGENDS, buildDebugViews, type View } from './debugViews';
import { SHOWCASE, type FloorKind, type ShowcaseEntry, type ShowcaseScene } from './scenes';
import { geometryRoughnessFromQuery, setGeometryRoughness } from './geometryRoughness';
import { SPEC_AA_DEFAULT, setSpecularAA, specAAFromQuery, specAAHitMaterial, specAAStrength } from './specAA';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const q = new URLSearchParams(location.search);
const fixed = q.has('w') && q.has('h');
const manual = q.has('manual');
const aaQuery = aaFromQuery(q);
const reactiveScale = Number(q.get('reactive') ?? 0);

type HitMode = 'current' | 'lit' | 'final';
const HIT_MODES: Record<HitMode, string> = { final: "last frame's image", lit: "last frame's lit (no SSR)", current: 'this frame, no specular' };
/** W44 (D3540): how a screen-space hit accounts for the view direction (`ssr.settings.hitShading`). `?reshade=` */
type HitShadingMode = 'reshade' | 'off';
const HIT_SHADING_MODES: Record<HitShadingMode, string> = { reshade: 'specular along the ray (re-shade)', off: 'screen colour as is' };
const TONE = { agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping } as const;
type Tone = keyof typeof TONE;

async function main() {
  const status = document.querySelector<HTMLElement>('#status')!;
  const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
  if (!navigator.gpu) { status.textContent = 'WebGPU is not available in this browser.'; return; }
  const adapter = await navigator.gpu.requestAdapter();
  // the composite reads the G-buffer's lit target: 36 bytes per sample
  const maxBytes = Math.min(adapter?.limits.maxColorAttachmentBytesPerSample ?? 32, 64);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, trackTimestamp: q.has('gpuTime'), requiredLimits: { maxColorAttachmentBytesPerSample: maxBytes } } as N);
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  if (fixed) document.body.classList.add('fixed');
  const size = () => fixed ? [Number(q.get('w')), Number(q.get('h'))] : [Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)];
  // W x H: display (canvas); RW x RH: render (G-buffer, reflections, denoiser), smaller when upscaling
  let [W, H] = size();
  let { width: RW, height: RH } = renderSize(W, H, aaQuery.ratio);
  renderer.setSize(W, H, false);
  await renderer.init();
  // cube arrays on stock r187 (W20 shim, self-tested; patches nothing and probes keep the 2D array if it fails). ?shim=0 opts out.
  if (q.get('shim') !== '0') await installCubeArraySupport(renderer);

  // W75 (X5, D5080): ?res=half traces, denoises at half res and upsamples
  // W77: ?preset=performance|default (core REFLECTION_PRESETS); ?res= / ?hitSource= given explicitly win
  const presetName = (q.get('preset') as ReflectionsPresetName | null) ?? null;
  const ssr = new ScreenSpaceReflectionsPass(renderer, {
    missList: true, timestamps: true, gbufferOptions: { width: RW, height: RH }, ...(presetName ? { preset: presetName } : {}),
    ...(q.get('res') === 'half' || q.get('res') === 'mixed' ? { settings: { reflectionResolution: 'half' as const, halfResMinRoughness: q.get('res') === 'mixed' ? Number(q.get('halfResMin') ?? 0.05) : 0 } } : {}),
    ...(q.get('res') === 'full' ? { settings: { reflectionResolution: 'full' as const } } : {}),
  });
  const device = ssr.device;
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('[webgpu uncapturederror]', m); });
  const timestampsOn = device.features.has('timestamp-query');
  // hybrid resolve + denoise seam: FFX's reflection denoiser gated at the tracer's roughness threshold
  // W53 (D3660): ?hitSource=hits|all / ?hitDistW=<k>, off by default
  const hs = hitSourceFromQuery(q);
  const syncHitSource = (mode: 'off' | 'hits' | 'all') => { hs.hitSource = mode !== 'off'; hs.missesMatchAnySource = mode === 'hits'; };
  if (presetName && !q.has('hitSource')) syncHitSource(reflectionsPreset(presetName).denoiser.hitSource ?? 'off'); // W77
  const denoiser = denoiserAvailable ? createReflectionDenoiser(device, 0.447, timestampsOn, hitSourceDenoiserOptions(hs)) : null;
  const hybrid = new HybridReflections(ssr, { denoiser, denoiserHitSource: hs.hitSource });
  hybrid.denoise = q.get('denoise') !== '0' && !!denoiser;
  const nextNodeFrame = () => (renderer as N)._nodes.nodeFrame.update();

  // ---- state ---------------------------------------------------------------------------------------
  const state = {
    probes: q.get('probes') !== '0',
    ssr: q.get('ssr') !== '0',
    rt: q.get('rt') === '1',
    view: (q.has('off') ? 'off' : (q.get('view') as View) ?? 'final') as View,
    hit: ((q.get('hit') as HitMode) ?? 'final') as HitMode,
    reshade: ((q.get('reshade') as HitShadingMode) ?? 'reshade') as HitShadingMode,
    tone: ((q.get('tone') as Tone) ?? 'agx') as Tone,
    exposure: 1,
    helpers: false,
    /** W39: Lagarde's specular occlusion from GTAO on the composite's probe part (D66, D4510). */
    specOcc: q.get('specOcc') === '1',
    /** W46: roughness from normal-map variance on every glTF material with a normal map (D3570); 0 = off, else its strength. */
    specAA: specAAFromQuery(q, SPEC_AA_DEFAULT),
  };
  let ssao: ScreenSpaceAO | null = null;
  let kit: ShowcaseScene | null = null;
  let entry: ShowcaseEntry | null = null;
  let probes: ReflectionProbes | null = null;
  let helper: ReflectionProbesHelper | null = null;
  /** W51: @pmndrs/bvh is the examples' provider (the maintainer's call on D1705); `?bvh=three-mesh-bvh` the stopgap. */
  const bvhKind = q.get('bvh') === 'three-mesh-bvh' ? 'three-mesh-bvh' : 'pmndrs';
  let provider: { destroy(): void } | null = null;
  let updateHitMaterials: () => void = () => {};
  let bvhInfo: { kind: string; triangles: number; ms: number } | null = null;
  let building = false;
  let bakeMs = 0;

  // ---- display: composite + debug views, one RenderPipeline -----------------------------------------
  const uView = uniform(0);
  const uProbes = uniform(1);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  let composite: ReturnType<HybridReflections['composite']> | null = null;
  const historyRT = new THREE.RenderTarget(RW, RH, { type: THREE.HalfFloatType, depthBuffer: false });
  historyRT.texture.name = 'showcase final history';
  const historyMaterial = new THREE.MeshBasicNodeMaterial();
  historyMaterial.toneMapped = false;
  const historyQuad = new THREE.QuadMesh(historyMaterial);
  const toneOf = (t: Tone) => (c: N) => (renderOutput(c, TONE[t], THREE.SRGBColorSpace) as N).rgb;
  const aa = new DisplayAA(renderer, ssr.gbuffer, { ...aaQuery, displayWidth: W, displayHeight: H, tone: toneOf(state.tone) });
  await aa.init();

  function buildDisplay() {
    const tone = toneOf(state.tone);
    aa.setTone(tone);
    // tone-mapped views: linear while the upscaler runs, which tone-maps after it
    const T = (x: N): N => aa.linear.equal(1).select(x, tone(x));
    ssao?.dispose();
    const ao = ssao = new ScreenSpaceAO(ssr.gbuffer, kit!.camera);
    Object.assign(hybrid.options, {
      probes: state.probes ? probes : null, environment: kit!.scene.environment, environmentIntensity: kit!.scene.environmentIntensity,
      ao: state.specOcc ? (u: N) => ao.sample(u) : null,
    });
    hybrid.rebuild();
    const c = composite = hybrid.composite();
    c.amount.value = state.ssr || state.rt ? 1 : 0;
    const views = buildDebugViews({ c, ssr, tone, T, roughnessThreshold: hybrid.roughnessThreshold, probesOn: uProbes, ao: (u: N) => ao.sample(u) });
    let out: N = vec3(0);
    VIEW_IDS.forEach((v, i) => { out = uView.equal(i).select(views[v], out); });
    pipeline.outputNode = vec4(out, 1);
    pipeline.needsUpdate = true;
    const h = hybrid.composite();
    h.amount.value = c.amount.value;
    historyMaterial.colorNode = h.final;
    historyMaterial.needsUpdate = true;
    historyAmount = h.amount;
    // reactive (D4202): the reflection's share of the final colour where the pixel moves
    aa.setReactive(reactiveScale > 0 ? reflectionReactive(h, ssr.gbuffer.textures.motion!, reactiveScale) : null);
  }
  let historyAmount: N = null;

  // ---- sources -------------------------------------------------------------------------------------
  function setHit(m: HitMode) {
    state.hit = m;
    ssr.settings.hitColor = m === 'current' ? 'current' : 'history';
    ssr.historySource = m === 'final' ? historyRT.texture : null;
    ssr.resetHistory();
    aa.reset();
  }
  function setReshade(m: HitShadingMode) {
    state.reshade = m;
    ssr.settings.hitShading = m;
    ssr.resetHistory();
    aa.reset();
  }
  ssr.settings.hitShading = state.reshade;
  // W52 halo options (D3640-D3642), URL only (the bench, examples/showcase/bench.html, has the knobs):
  // ?shadeVis=all ?lobeMix=<0..1> ?shadeOcc=screen; ?lobeFilter=<k> the lobe filter itself (D3550)
  if (q.has('shadeVis')) ssr.traceSettings.hitShadeVisibility = q.get('shadeVis') as 'offscreen' | 'all';
  if (q.has('lobeMix')) ssr.settings.hitLobeFilterMixed = Number(q.get('lobeMix'));
  if (q.has('shadeOcc')) ssr.settings.hitShadeOcclusion = q.get('shadeOcc') as 'off' | 'screen';
  if (q.has('lobeFilter')) ssr.settings.hitLobeFilter = Number(q.get('lobeFilter'));
  function applySources() {
    // SSR off + RT on: no screen-space march, so every traced pixel is a miss and goes to the ray tracer
    if (state.ssr) delete ssr.settings.maxTraversalIntersections; else ssr.settings.maxTraversalIntersections = 0;
    ssr.rayTracing = state.rt && !!provider;
    const amount = state.ssr || state.rt ? 1 : 0;
    if (composite) composite.amount.value = amount;
    if (historyAmount) historyAmount.value = amount;
    uProbes.value = state.probes && probes ? 1 : 0;
    ssr.resetHistory();
    aa.reset();
  }
  function setProbes(on: boolean) {
    state.probes = on;
    if (!kit) return;
    kit.scene.environmentNode = on && probes ? (reflectionProbes(probes) as N) : null;
    kit.scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of ([] as THREE.Material[]).concat(m)) x.needsUpdate = true; });
    buildDisplay();
    applySources();
  }
  async function ensureBVH() {
    if (provider || !kit || building) return;
    building = true;
    status.textContent = 'building the BVH for ray-traced reflections...';
    const meshes: THREE.Mesh[] = [];
    kit.scene.updateMatrixWorld(true);
    kit.scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.noTrace) meshes.push(o as THREE.Mesh); });
    const t0 = performance.now();
    const forKit = kit;
    let p: { destroy(): void }, tp: N, triangles: number, update: () => void;
    if (bvhKind === 'pmndrs') {
      const built = await createPmndrsBvhTraceProviderFromObjects(device, meshes, { material: specAAHitMaterial });
      p = tp = built.provider; triangles = built.provider.info.triangles;
      update = () => { const s = bvhTraceSceneFromObjects(meshes, { material: specAAHitMaterial }); if (s.scene.materials) built.provider.setMaterials(s.scene.materials); };
    } else {
      const m = await MeshBVHTraceProvider.fromObjects(device, meshes, { material: specAAHitMaterial });
      p = tp = m; triangles = m.triangles; update = () => m.updateMaterials();
    }
    building = false;
    if (kit !== forKit) { p.destroy(); return; }
    provider = p;
    updateHitMaterials = update;
    bvhInfo = { kind: bvhKind === 'pmndrs' ? '@pmndrs/bvh' : 'three-mesh-bvh', triangles, ms: performance.now() - t0 };
    ssr.setTraceProvider(tp);
  }
  async function setRT(on: boolean) {
    state.rt = on;
    if (on) await ensureBVH();
    applySources();
  }

  /** W46 (D3570): roughness from normal variance on (strength > 0) or off; re-bakes, so the probes see the same materials. */
  function setSpecAA(strength: number) {
    state.specAA = strength;
    if (strength > 0) specAAStrength.value = strength;
    if (!kit) return;
    setSpecularAA(kit.scene, strength > 0);
    updateHitMaterials();
    bake();
    ssr.gbuffer.resetHistory(); ssr.resetHistory(); hybrid.resetHistory(); aa.reset();
  }

  // ---- probes ----------------------------------------------------------------------------------------
  /** `?bounces=` (default the package's 2, D4300; 1 halves the bake where no mirror or glossy surface faces another). */
  let bounces: number | undefined = q.has('bounces') ? Number(q.get('bounces')) : undefined;
  function bake() {
    if (!probes || !kit) return;
    const t0 = performance.now();
    if (helper) helper.visible = false;
    // capture the background as the materials see the environment (a dimmed, blurred backdrop in
    // the probes would make the floor near the model darker than the floor outside the probe box)
    const sc = kit.scene, keep = [sc.backgroundIntensity, sc.backgroundBlurriness] as const;
    if (sc.background === sc.environment) { sc.backgroundIntensity = sc.environmentIntensity; sc.backgroundBlurriness = 0; }
    probes.bake(renderer, kit.scene, { ...(q.has('probeRes') ? { resolution: Number(q.get('probeRes')) } : {}), ...(bounces !== undefined ? { bounces } : {}), near: kit.bake.near, far: kit.bake.far });
    [sc.backgroundIntensity, sc.backgroundBlurriness] = keep;
    nextNodeFrame();
    if (helper) helper.visible = state.helpers;
    bakeMs = performance.now() - t0;
  }
  function setHelpers(on: boolean) {
    state.helpers = on;
    if (!helper && probes && kit) {
      helper = new ReflectionProbesHelper(probes, kit.bake.far / 400);
      helper.traverse((o) => { o.userData.noTrace = true; });
      kit.scene.add(helper);
    }
    if (helper) helper.visible = on;
  }

  function makeProbes(volumes: ShowcaseScene['probes']) {
    const set = new ReflectionProbes();
    for (const v of volumes) {
      const p = new ReflectionProbe(...v.influenceSize);
      p.position.set(...v.position);
      if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
      if (v.originOffset) p.originOffset.set(...v.originOffset);
      if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
      if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
      if (v.resolution !== undefined) p.resolution = v.resolution;
      set.add(p);
    }
    return set;
  }
  /** W38: bytes of the probe atlases (rgba16float, 6 faces per slot incl. the environment slot, every mip; every atlas, W60). */
  const probeBytes = () => probeAtlasBytes(probes as N);

  // ---- scene loading ---------------------------------------------------------------------------------
  const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas);
  controls.enableDamping = true;
  async function load(id: string) {
    const e = entries.find((x) => x.id === id);
    if (!e) throw new Error(`scene ${id} is not available (run \`pnpm assets\`)`);
    status.textContent = `loading ${e.title}...`;
    const next = await e.build(W / H);
    probes?.dispose();
    provider?.destroy();
    provider = null; updateHitMaterials = () => {}; bvhInfo = null; probes = null; helper = null;
    ssr.setTraceProvider(null);
    kit = next; entry = e;
    controls.object = kit.camera;
    setPose(Object.keys(kit.views)[0]);
    state.exposure = kit.exposure;
    if (state.specAA > 0) { specAAStrength.value = state.specAA; setSpecularAA(kit.scene, true); }
    setGeometryRoughness(kit.scene, geometryRoughnessFromQuery(q)); // W56: ?geometryRoughness=three|off|<scale> (URL only)
    delete ssr.settings.depthBufferThickness; delete ssr.settings.thicknessRoughnessFactor;
    if (kit.thickness) Object.assign(ssr.settings, kit.thickness);
    renderer.toneMappingExposure = state.exposure;
    // probes: one box per region, as the scene suggests
    probes = makeProbes(kit.probes);
    kit.scene.add(probes);
    bake();
    if (state.helpers) setHelpers(true);
    setProbes(state.probes);
    if (state.rt) await ensureBVH();
    applySources();
    ssr.gbuffer.resetHistory();
    ssr.resetHistory();
    hybrid.resetHistory();
    aa.reset();
    refreshUI();
    const u = new URL(location.href); u.searchParams.set('scene', id); history.replaceState(null, '', u);
    return { id, probes: probes.bakedProbes.length, bakeMs, layout: probes.bakedLayout };
  }
  function setPose(name: string) {
    const v = kit!.views[name];
    if (!v) throw new Error(`no pose ${name} in ${kit!.id}`);
    kit!.camera.position.set(...v.pos);
    if (v.fov) kit!.camera.fov = v.fov;
    kit!.camera.updateProjectionMatrix();
    controls.target.set(...v.target);
    controls.update();
    ssr.resetHistory();
    hybrid.resetHistory();
    aa.reset();
    currentPose = name;
  }
  let currentPose = '';

  // ---- frame -----------------------------------------------------------------------------------------
  let timings: ReadonlyMap<string, number> = new Map();
  let frameMs = 0, lastT = 0;
  function frame() {
    if (!kit) return;
    if (manual || !looping) nextNodeFrame();
    const [w, h] = size();
    if (w !== W || h !== H) {
      W = w; H = h;
      renderer.setSize(W, H, false);
      ({ width: RW, height: RH } = aa.setSize(W, H));
      ssr.gbuffer.setSize(RW, RH);
      historyRT.setSize(RW, RH);
      ssr.resetHistory();
      hybrid.resetHistory();
    }
    controls.update();
    kit.camera.aspect = W / H; kit.camera.updateProjectionMatrix(); kit.camera.updateMatrixWorld();
    ssr.render(kit.scene, kit.camera, aa.begin(kit.camera));
    aa.end(kit.camera);
    hybrid.update();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(aa.target);
    pipeline.render();
    renderer.setRenderTarget(prev);
    aa.resolve(kit.camera);
    if (state.hit === 'final') {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(historyRT);
      historyQuad.render(renderer);
      renderer.setRenderTarget(prev);
    }
    // never blocks: resolves with this frame's timestamps a few ms later (and recycles the readback buffer)
    if (timestampsOn) ssr.readTimings().then((t) => { timings = t; }).catch(() => {});
    const now = performance.now();
    if (lastT) frameMs = frameMs * 0.9 + (now - lastT) * 0.1;
    lastT = now;
  }
  let looping = false;
  const startLoop = () => { looping = true; renderer.setAnimationLoop(frame); };
  const stopLoop = () => { looping = false; renderer.setAnimationLoop(null); };

  // ---- UI --------------------------------------------------------------------------------------------
  const panel = document.querySelector<HTMLElement>('#controls')!;
  const h2 = (t: string) => { const e = document.createElement('h2'); e.textContent = t; panel.append(e); };
  const row = (label: string, el: HTMLElement, after?: HTMLElement) => {
    const l = document.createElement('label'); l.append(label, el); if (after) l.append(after); panel.append(l); return l;
  };
  const select = (opts: Record<string, string>, value: string, on: (v: string) => void) => {
    const s = document.createElement('select');
    for (const [k, v] of Object.entries(opts)) s.append(new Option(v, k));
    s.value = value; s.onchange = () => on(s.value); return s;
  };
  const check = (label: string, value: boolean, on: (v: boolean) => void) => {
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = value; c.onchange = () => on(c.checked);
    const l = document.createElement('label'); l.className = 'check'; l.append(c, label); panel.append(l); return c;
  };
  const slider = (label: string, min: number, max: number, step: number, value: number, on: (v: number) => void, fmt = (v: number) => v.toFixed(2)) => {
    const s = document.createElement('input'); s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(value);
    const v = document.createElement('span'); v.className = 'val'; v.textContent = fmt(value);
    s.oninput = () => { v.textContent = fmt(Number(s.value)); on(Number(s.value)); };
    row(label, s, v); return { input: s, set(x: number) { s.value = String(x); v.textContent = fmt(x); } };
  };

  const entries: ShowcaseEntry[] = [];
  const have = new Set((await availableAssets()).map((a) => `${a.dir}/${a.file}`));
  for (const e of SHOWCASE) if (have.has(`${e.asset}/${e.asset === 'Sponza' ? 'Sponza.gltf' : e.asset + '.glb'}`) && have.has(`hdri/${e.hdri}`)) entries.push(e);

  h2('Scene');
  const sceneSel = select(Object.fromEntries(entries.map((e) => [e.id, e.title])), entries[0]?.id ?? '', (v) => { load(v).catch(fail); });
  row('Scene', sceneSel);
  const poseSel = select({}, '', (v) => setPose(v));
  row('Camera', poseSel);

  h2('Reflections');
  const seg = document.createElement('div'); seg.className = 'seg';
  const onBtn = document.createElement('button'); onBtn.textContent = 'On';
  const offBtn = document.createElement('button'); offBtn.textContent = 'Off (baseline)';
  seg.append(onBtn, offBtn); panel.append(seg);
  onBtn.onclick = () => setView('final');
  offBtn.onclick = () => setView('off');
  const probesBox = check('Reflection probes', state.probes, (v) => setProbes(v));
  const ssrBox = check('Screen-space (SSR)', state.ssr, (v) => { state.ssr = v; applySources(); });
  const rtBox = check('Ray-traced fallback (BVH)', state.rt, (v) => { setRT(v).catch(fail); });
  const denoiseBox = check(denoiser ? `Denoise (${denoiser.name})` : 'Denoise (no denoiser found)', hybrid.denoise, (v) => { hybrid.denoise = v && !!denoiser; aa.reset(); });
  denoiseBox.disabled = !denoiser;
  // W53: off | screen-space vs traced hits apart | hits and misses apart
  const HIT_SOURCE_MODES = { off: 'off', hits: 'screen vs traced hits', all: 'hits and misses' } as const;
  const hitSourceMode = () => (!hybrid.denoiserHitSource ? 'off' : hs.missesMatchAnySource ? 'hits' : 'all');
  const hitSourceSel = select(HIT_SOURCE_MODES, hitSourceMode(), (v) => {
    hs.hitSource = v !== 'off'; hs.missesMatchAnySource = v === 'hits';
    setDenoiserHitSource(hybrid, hs); aa.reset();
  });
  hitSourceSel.disabled = !denoiser;
  row('Denoiser: keep hit sources apart', hitSourceSel);
  const aaSel = select(AA_MODES, aa.mode, (v) => setAA(v as AAMode));
  row(aa.ratio > 1 ? `Anti-aliasing (upscale x${aa.ratio})` : 'Anti-aliasing', aaSel);
  function setAA(m: AAMode) { aa.mode = m; aaSel.value = m; }
  row('Hit colour', select(HIT_MODES, state.hit, (v) => setHit(v as HitMode)));
  const reshadeSel = select(HIT_SHADING_MODES, state.reshade, (v) => setReshade(v as HitShadingMode));
  row('Hit specular', reshadeSel);
  // W51 (settings guide): filtered importance sampling at re-shaded / traced hits (D3550); 0 = the hit's own roughness
  const lobe = slider('Hit lobe filter', 0, 2, 0.05, ssr.settings.hitLobeFilter ?? 1, (v) => { ssr.settings.hitLobeFilter = v; ssr.resetHistory(); aa.reset(); });
  lobe.input.parentElement!.title = 'hitLobeFilter (D3550): 0 = the hit\'s own roughness, 1 = default (a softbox seen through a mirror floor no longer fireflies; W50: lifts the carConcept skirt lip with the re-shade), 1.5 = wider. docs/SETTINGS.md';
  const soBox = check('Specular occlusion (GTAO)', state.specOcc, (v) => setSpecOcc(v));
  function setSpecOcc(on: boolean) { state.specOcc = on; soBox.checked = on; buildDisplay(); hybrid.resetHistory(); aa.reset(); }
  check('Show probe volumes', state.helpers, (v) => setHelpers(v));

  h2('Materials');
  const specAABox = check('Roughness from normal variance', state.specAA > 0, (v) => setSpecAA(v ? (state.specAA || 1) : 0));
  specAABox.parentElement!.title = 'Toksvig: raise each normal-mapped material\'s roughness by the normal map\'s variance at the sampled mip (W46)';

  h2('Floor');
  const kindSel = select({ mirror: 'Mirror (metal)', lacquer: 'Black lacquer' }, 'mirror', (v) => { kit?.floor.setKind?.(v as FloorKind); ssr.resetHistory(); aa.reset(); });
  const kindRow = row('Material', kindSel);
  const polishBox = check('Polished floor override', true, (v) => { kit?.floor.setPolished?.(v); bake(); ssr.resetHistory(); aa.reset(); });
  const polishRow = polishBox.parentElement!;
  const rough = slider('Roughness', 0, 0.6, 0.01, 0.03, (v) => { kit?.floor.setRoughness(v); aa.reset(); });
  rough.input.onchange = () => bake();

  h2('Debug view');
  const viewSel = select(VIEWS, state.view, (v) => setView(v as View));
  row('Show', viewSel);
  const legendOf = (items: [string, string][]) => {
    const l = document.createElement('div'); l.className = 'legend';
    for (const [c, t] of items) { const i = document.createElement('i'); i.style.background = c; const sp = document.createElement('span'); sp.textContent = t; l.append(i, sp); }
    panel.append(l); return l;
  };
  const legends: Partial<Record<View, HTMLElement>> = Object.fromEntries(Object.entries(VIEW_LEGENDS).map(([k, items]) => [k, legendOf(items!)]));

  h2('Image');
  row('Tone mapping', select({ agx: 'AgX', neutral: 'Neutral (Khronos PBR)', aces: 'ACES filmic' }, state.tone, (v) => { state.tone = v as Tone; buildDisplay(); applySources(); }));
  const expo = slider('Exposure', 0.2, 3, 0.05, state.exposure, (v) => { state.exposure = v; renderer.toneMappingExposure = v; });

  h2('GPU time');
  const timingsEl = document.createElement('div'); timingsEl.id = 'timings'; panel.append(timingsEl);

  function setView(v: View) {
    state.view = v;
    aa.reset();
    aa.toneView = LINEAR_VIEWS.includes(v);
    uView.value = VIEW_IDS.indexOf(v);
    viewSel.value = v;
    onBtn.classList.toggle('on', v !== 'off');
    offBtn.classList.toggle('on', v === 'off');
    for (const [k, l] of Object.entries(legends)) l!.style.display = k === v ? '' : 'none';
  }
  function refreshUI() {
    if (!kit) return;
    sceneSel.value = kit.id;
    poseSel.replaceChildren(...Object.keys(kit.views).map((v) => new Option(v, v)));
    poseSel.value = currentPose;
    kindRow.style.display = kit.floor.kinds ? '' : 'none';
    polishRow.style.display = kit.floor.polishable ? '' : 'none';
    rough.set(kit.floor.roughness);
    expo.set(state.exposure);
    probesBox.checked = state.probes; ssrBox.checked = state.ssr; rtBox.checked = state.rt;
  }
  function fail(e: unknown) { console.error(e); status.textContent = String((e as Error)?.stack ?? e); }

  setInterval(() => {
    if (!kit) return;
    const lines: string[] = [];
    if (!timestampsOn) lines.push('(no timestamp-query on this device)');
    else {
      const total = timings.get('total');
      for (const [k, v] of timings) if (k !== 'total') lines.push(`${k.padEnd(22)}${v.toFixed(3).padStart(7)} ms`);
      const dn = hybrid.denoise ? denoiser?.gpuTimings : undefined;
      if (dn) for (const [k, v] of dn) if (k !== 'total') lines.push(`${('denoise ' + k).padEnd(22)}${v.toFixed(3).padStart(7)} ms`);
      const sum = (total ?? 0) + (dn?.get('total') ?? 0);
      if (total !== undefined) lines.push(`${'reflections total'.padEnd(22)}${sum.toFixed(3).padStart(7)} ms`);
      lines.push('(G-buffer and composite not timed)');
    }
    lines.push(`${'frame (CPU interval)'.padEnd(22)}${frameMs.toFixed(1).padStart(7)} ms`);
    timingsEl.textContent = lines.join('\n');
    if (building) return;
    status.textContent = [
      `${kit.title} | ${W}x${H} | three r${THREE.REVISION} | ${ssr.variant ?? ''} | ${probes?.bakedProbes.length ?? 0} probes (${probes?.bakedLayout ?? '-'}) baked in ${bakeMs.toFixed(0)} ms` +
        (bvhInfo ? ` | BVH (${bvhInfo.kind}) ${bvhInfo.triangles.toLocaleString()} triangles, ${bvhInfo.ms.toFixed(0)} ms` : ''),
      kit.credit,
      gpuErrors.length ? `GPU errors: ${gpuErrors.length} (${gpuErrors[0].slice(0, 120)})` : '',
    ].filter(Boolean).join('\n');
  }, 250);

  // ---- start -----------------------------------------------------------------------------------------
  if (!entries.length) {
    status.textContent = 'No showcase assets found. Run `pnpm assets` (downloads the Khronos models and two Poly Haven HDRIs into examples/assets/), then reload.';
    Object.assign(window, { __p: { entries: () => [], gpuErrors } });
    return;
  }
  setHit(state.hit);
  const first = entries.find((e) => e.id === q.get('scene'))?.id ?? entries[0].id;
  await load(first);
  if (q.get('pose') && kit!.views[q.get('pose')!]) { setPose(q.get('pose')!); refreshUI(); }
  setView(state.view);
  if (manual) frame(); else startLoop();

  // ---- headless hooks ----------------------------------------------------------------------------------
  const idle = () => device.queue.onSubmittedWorkDone();
  Object.assign(window, {
    __p: {
      THREE, renderer, ssr, gpuErrors,
      get kit() { return kit; }, get entry() { return entry; },
      /** The display composite's nodes (W45: linear readbacks of its terms in measurement scripts). */
      get composite() { return composite; }, hybrid, get probes() { return probes; }, TSL, sampleReflectionProbes,
      entries: () => entries.map((e) => e.id),
      load: (id: string) => load(id),
      poses: () => Object.keys(kit!.views),
      setPose,
      setView: (v: View) => setView(v),
      /**
       * W75 (X5): reflection resolution, rebuilding the composites ('mixed' = half with the full-res mirror
       * path below `minRoughness`, step 2).
       */
      async setResolution(r: 'full' | 'half' | 'mixed', minRoughness = 0.05) {
        ssr.settings.reflectionResolution = r === 'full' ? 'full' : 'half';
        ssr.settings.halfResMinRoughness = r === 'mixed' ? minRoughness : 0;
        hybrid.rebuild(); buildDisplay();
        ssr.resetHistory(); hybrid.resetHistory();
      },
      /** W77: apply a named preset at runtime (three `applyReflectionsPreset`; `overrides` win), rebuilding the composites. */
      setPreset(name: ReflectionsPresetName, overrides: Parameters<typeof applyReflectionsPreset>[2] = {}) {
        const r = applyReflectionsPreset({ ssr, hybrid }, name, overrides);
        syncHitSource(r.denoiser.hitSource ?? 'off'); hitSourceSel.value = hitSourceMode();
        hybrid.rebuild(); buildDisplay(); aa.reset();
        return r;
      },
      /** The orbit camera as [pos, target] (scene units), and setting it (same convention as compare.html's `view()` / `setView()`). */
      camera: () => [kit!.camera.position.toArray(), controls.target.toArray()],
      setCamera(pos: [number, number, number], target: [number, number, number]) {
        kit!.camera.position.set(...pos); controls.target.set(...target); controls.update();
        ssr.resetHistory(); hybrid.resetHistory(); aa.reset();
      },
      async setSources(s: { probes?: boolean; ssr?: boolean; rt?: boolean; denoise?: boolean }) {
        if (s.probes !== undefined && s.probes !== state.probes) setProbes(s.probes);
        if (s.ssr !== undefined) state.ssr = s.ssr;
        if (s.rt !== undefined) await setRT(s.rt); else applySources();
        if (s.denoise !== undefined) { hybrid.denoise = s.denoise && !!denoiser; denoiseBox.checked = hybrid.denoise; }
        refreshUI();
      },
      setHit: (m: HitMode) => setHit(m),
      /** W53 (D3660): the denoiser keeps screen-space hits, traced hits and misses apart / weights by hit distance (k; 0 = off). */
      setHitSource(s: Partial<DenoiserHitSourceSettings>) { Object.assign(hs, s); setDenoiserHitSource(hybrid, hs); hitSourceSel.value = hitSourceMode(); aa.reset(); },
      /** W44: 'reshade' (default) | 'off'. */
      setReshade: (m: HitShadingMode) => { setReshade(m); reshadeSel.value = m; },
      /** W39: Lagarde's specular occlusion from GTAO on the composite's probe part (D66, D4510). */
      setSpecOcc: (on: boolean) => setSpecOcc(on),
      /** W46: roughness from normal variance, 0 = off, else its strength (1 = the formula); re-bakes. */
      setSpecAA(strength: number) { setSpecAA(strength); specAABox.checked = strength > 0; },
      aa,
      /** W36: 'upscaler' (default) | 'taa' (W40's resolve) | 'off'. */
      setAA: (m: AAMode) => setAA(m),
      /** Old switch (W40): on = the default anti-aliasing (the upscaler), off = none. */
      setTAA(on: boolean) { setAA(on ? 'upscaler' : 'off'); },
      stop: stopLoop, start: startLoop,
      async step(n = 1) { for (let i = 0; i < n; i++) { frame(); await idle(); } },
      /**
       * W37 (D4300): re-bake with `n` bounces (undefined = the package default) and time it: wall
       * clock from an idle queue to the queue draining again, loop stopped, median of `repeat`.
       */
      async bakeTime(n?: number, repeat = 5) {
        stopLoop();
        bounces = n;
        const ms: number[] = [];
        for (let i = 0; i < repeat; i++) { await idle(); const t0 = performance.now(); bake(); await idle(); ms.push(performance.now() - t0); }
        ms.sort((a, b) => a - b);
        return { bounces: n ?? 'default', probes: probes?.bakedProbes.length ?? 0, ms: ms[ms.length >> 1], all: ms };
      },
      async shot() { frame(); const url = canvas.toDataURL('image/png'); await idle(); return url; },
      /**
       * W38: replace the probe set with `volumes` (null: the scene's own) and bake it; returns the
       * probe count, the bake's wall-clock ms (idle to idle, loop stopped) and the atlas's bytes.
       */
      async setProbeVolumes(volumes: ShowcaseScene['probes'] | null) {
        if (!kit) return null;
        stopLoop();
        const old = probes;
        if (old) kit.scene.remove(old);
        if (helper) { kit.scene.remove(helper); helper = null; }
        const next = probes = makeProbes(volumes ?? kit.probes);
        kit.scene.add(next);
        // bake as on a fresh load: the previous set left on the scene would light the first pass's captures
        kit.scene.environmentNode = null;
        await idle();
        bake();
        await idle();
        setProbes(state.probes);
        frame(); await idle();
        old?.dispose();
        return { probes: next.bakedProbes.length, ms: bakeMs, bytes: probeBytes() };
      },
      /** W38: the stage's model in (true, the default) or out of the probe captures; re-bakes. */
      async setHeroCapture(on: boolean) {
        if (!kit?.hero) return false;
        kit.hero.traverse((o) => { o.userData.reflectionProbeExclude = !on; });
        stopLoop(); bake(); await idle();
        ssr.resetHistory(); hybrid.resetHistory(); aa.reset();
        return true;
      },
      probeBytes: () => probeBytes(),
      /** W38: GPU ms of three's render passes per frame (`?gpuTime`), median of `n` frames, loop stopped. */
      async renderTime(n = 30) {
        stopLoop();
        if (!(renderer as N).backend.trackTimestamp) return null;
        const v: number[] = [];
        for (let i = 0; i < n + 3; i++) {
          frame(); await idle();
          const ms = await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
          if (i >= 3 && typeof ms === 'number') v.push(ms);
        }
        v.sort((a, b) => a - b);
        return { frames: v.length, ms: v[v.length >> 1], p10: v[Math.floor(v.length * 0.1)], p90: v[Math.floor(v.length * 0.9)] };
      },
      async info() {
        await idle();
        return { scene: kit!.id, denoiser: hybrid.denoise ? denoiser?.name ?? null : null, aa: aa.mode, size: [W, H], renderSize: [RW, RH], probes: probes?.bakedProbes.length ?? 0, bakeMs, bvh: bvhInfo, rt: ssr.rayTracing, gpuErrors: gpuErrors.length, timings: Object.fromEntries(timings), trace: await ssr.readTraceStats() };
      },
    },
  });
}

main().catch((e) => {
  console.error(e);
  document.querySelector<HTMLElement>('#status')!.textContent = String(e?.stack ?? e);
});
