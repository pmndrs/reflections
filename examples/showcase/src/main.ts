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
// Display: temporal anti-aliasing (../../shared/taa.ts, W40) after the composite, as the FFX sample and the
// denoiser repo's demo run TRAA: without it every edge, normal-mapped highlight and the reflections of them
// crawl in motion, and the denoised reflections keep a 1-3/255 shimmer at rest. ?taa=0 turns it off.
//
// URL: ?scene=<id> ?pose=<name> ?rt=1 ?ssr=0 ?probes=0 ?denoise=0 ?taa=0 ?off ?view=<view> ?w=&h= (fixed size) ?manual
// `window.__p` drives the page headlessly (scripts/run-headless.mjs, section `showcase`).
import * as THREE from 'three/webgpu';
import { mix, renderOutput, uniform, uv, vec3, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  HybridReflections, MeshBVHTraceProvider, ReflectionProbe, ReflectionProbes, ReflectionProbesHelper, ScreenSpaceReflectionsPass, installCubeArraySupport, reflectionProbes,
} from '@pmndrs/reflections/three';
import { availableAssets } from '../../shared';
import { createReflectionDenoiser, denoiserAvailable } from '../../shared/denoiser';
import { TemporalAA } from '../../shared/taa';
import { SHOWCASE, type FloorKind, type ShowcaseEntry, type ShowcaseScene } from './scenes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const q = new URLSearchParams(location.search);
const fixed = q.has('w') && q.has('h');
const manual = q.has('manual');

const VIEWS = {
  final: 'Final (hybrid)',
  split: 'Raw | denoised',
  off: 'Reflections off',
  ibl: 'Probes / environment only',
  reflections: 'Reflection term only',
  source: 'Source per pixel',
  rtSource: 'Ray-traced pass per pixel',
  confidence: 'Screen-space confidence',
  hitDistance: 'Hit distance',
} as const;
type View = keyof typeof VIEWS;
const VIEW_IDS = Object.keys(VIEWS) as View[];
type HitMode = 'current' | 'lit' | 'final';
const HIT_MODES: Record<HitMode, string> = { final: "last frame's image", lit: "last frame's lit (no SSR)", current: 'this frame, no specular' };
const TONE = { agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping } as const;
type Tone = keyof typeof TONE;

async function main() {
  const status = document.querySelector<HTMLElement>('#status')!;
  const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
  if (!navigator.gpu) { status.textContent = 'WebGPU is not available in this browser.'; return; }
  const adapter = await navigator.gpu.requestAdapter();
  // the composite reads the G-buffer's lit target: 36 bytes per sample
  const maxBytes = Math.min(adapter?.limits.maxColorAttachmentBytesPerSample ?? 32, 64);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: { maxColorAttachmentBytesPerSample: maxBytes } } as N);
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  if (fixed) document.body.classList.add('fixed');
  const size = () => fixed ? [Number(q.get('w')), Number(q.get('h'))] : [Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)];
  let [W, H] = size();
  renderer.setSize(W, H, false);
  await renderer.init();
  // cube arrays on stock r187 (W20 shim, self-tested; patches nothing and probes keep the 2D array if it fails). ?shim=0 opts out.
  if (q.get('shim') !== '0') await installCubeArraySupport(renderer);

  const ssr = new ScreenSpaceReflectionsPass(renderer, { missList: true, timestamps: true });
  const device = ssr.device;
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('[webgpu uncapturederror]', m); });
  const timestampsOn = device.features.has('timestamp-query');
  // hybrid resolve + denoise seam: FFX's reflection denoiser gated at the tracer's roughness threshold
  const denoiser = denoiserAvailable ? createReflectionDenoiser(device, 0.447, timestampsOn) : null;
  const hybrid = new HybridReflections(ssr, { denoiser });
  hybrid.denoise = q.get('denoise') !== '0' && !!denoiser;
  const nextNodeFrame = () => (renderer as N)._nodes.nodeFrame.update();

  // ---- state ---------------------------------------------------------------------------------------
  const state = {
    probes: q.get('probes') !== '0',
    ssr: q.get('ssr') !== '0',
    rt: q.get('rt') === '1',
    view: (q.has('off') ? 'off' : (q.get('view') as View) ?? 'final') as View,
    hit: ((q.get('hit') as HitMode) ?? 'final') as HitMode,
    tone: ((q.get('tone') as Tone) ?? 'agx') as Tone,
    exposure: 1,
    helpers: false,
  };
  let kit: ShowcaseScene | null = null;
  let entry: ShowcaseEntry | null = null;
  let probes: ReflectionProbes | null = null;
  let helper: ReflectionProbesHelper | null = null;
  let provider: MeshBVHTraceProvider | null = null;
  let bvhInfo: { triangles: number; ms: number } | null = null;
  let building = false;
  let bakeMs = 0;

  // ---- display: composite + debug views, one RenderPipeline -----------------------------------------
  const uView = uniform(0);
  const uProbes = uniform(1);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  let composite: ReturnType<HybridReflections['composite']> | null = null;
  const historyRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
  historyRT.texture.name = 'showcase final history';
  const historyMaterial = new THREE.MeshBasicNodeMaterial();
  historyMaterial.toneMapped = false;
  const historyQuad = new THREE.QuadMesh(historyMaterial);
  const taa = new TemporalAA(renderer, ssr.gbuffer.textures.motion!, W, H);
  taa.enabled = q.get('taa') !== '0';

  function buildDisplay() {
    const tone = (c: N) => (renderOutput(c, TONE[state.tone], THREE.SRGBColorSpace) as N).rgb;
    Object.assign(hybrid.options, { probes: state.probes ? probes : null, environment: kit!.scene.environment, environmentIntensity: kit!.scene.environmentIntensity });
    hybrid.rebuild();
    const c = composite = hybrid.composite();
    c.amount.value = state.ssr || state.rt ? 1 : 0;
    const off: N = c.geometry.select(c.lit.sub(c.weight.mul(c.probeSpecular)).max(0), c.lit);
    const raw: N = c.geometry.select(c.lit.add(c.weight.mul(c.signal.sub(c.probeSpecular)).mul(c.amount)).max(0), c.lit);
    const dim: N = tone(off).mul(0.25);
    const at: N = uv();
    const views: Record<View, N> = {
      final: tone(c.final.rgb),
      split: at.x.sub(0.5).abs().lessThan(0.0008).select(vec3(1), at.x.lessThan(0.5).select(tone(raw), tone(c.final.rgb))),
      off: tone(off),
      ibl: tone(c.lit),
      reflections: tone(c.specular.mul(c.weight).mul(c.amount)),
      // SSR green, traced blue, probe orange, environment magenta, rough (probe/env, untraced) grey
      source: c.geometry.select(dim.add(HybridReflections.sourceColor(c, hybrid.roughnessThreshold).mul(0.75)), vec3(0)),
      rtSource: (() => {
        // traced hit blue, traced hit coloured from the screen cyan, traced miss magenta, capped
        // orange; untouched: SSR hit green (by confidence), else probe amber / environment grey
        const src: N = c.source.add(0.5).floor();
        const fallback: N = uProbes.equal(1).select(vec3(0.85, 0.6, 0.15), vec3(0.4));
        const ssrHit: N = mix(fallback, vec3(0.15, 0.85, 0.25), c.confidence.clamp(0, 1));
        const col: N = src.equal(1).select(vec3(0.2, 0.4, 1), src.equal(4).select(vec3(0.2, 0.9, 0.95),
          src.equal(2).select(vec3(0.95, 0.2, 0.85), src.equal(3).select(vec3(1, 0.55, 0.1), ssrHit))));
        return c.geometry.select(dim.add(col.mul(0.75)), vec3(0));
      })(),
      confidence: c.geometry.select(vec3(c.confidence), vec3(0.02, 0.03, 0.08)),
      hitDistance: (() => { const d: N = c.hitDistance; return d.greaterThan(0).select((vec3(1, 0.8, 0.5) as N).mul(d.div(d.add(2))), vec3(0)); })(),
    };
    let out: N = vec3(0);
    VIEW_IDS.forEach((v, i) => { out = uView.equal(i).select(views[v], out); });
    pipeline.outputNode = vec4(out, 1);
    pipeline.needsUpdate = true;
    const h = hybrid.composite();
    h.amount.value = c.amount.value;
    historyMaterial.colorNode = h.final;
    historyMaterial.needsUpdate = true;
    historyAmount = h.amount;
  }
  let historyAmount: N = null;

  // ---- sources -------------------------------------------------------------------------------------
  function setHit(m: HitMode) {
    state.hit = m;
    ssr.settings.hitColor = m === 'current' ? 'current' : 'history';
    ssr.historySource = m === 'final' ? historyRT.texture : null;
    ssr.resetHistory();
    taa.reset();
  }
  function applySources() {
    // SSR off + RT on: no screen-space march, so every traced pixel is a miss and goes to the ray tracer
    if (state.ssr) delete ssr.settings.maxTraversalIntersections; else ssr.settings.maxTraversalIntersections = 0;
    ssr.rayTracing = state.rt && !!provider;
    const amount = state.ssr || state.rt ? 1 : 0;
    if (composite) composite.amount.value = amount;
    if (historyAmount) historyAmount.value = amount;
    uProbes.value = state.probes && probes ? 1 : 0;
    ssr.resetHistory();
    taa.reset();
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
    const p = await MeshBVHTraceProvider.fromObjects(device, meshes);
    building = false;
    if (kit !== forKit) { p.destroy(); return; }
    provider = p;
    bvhInfo = { triangles: p.triangles, ms: performance.now() - t0 };
    ssr.setTraceProvider(provider);
  }
  async function setRT(on: boolean) {
    state.rt = on;
    if (on) await ensureBVH();
    applySources();
  }

  // ---- probes ----------------------------------------------------------------------------------------
  function bake() {
    if (!probes || !kit) return;
    const t0 = performance.now();
    if (helper) helper.visible = false;
    // capture the background as the materials see the environment (a dimmed, blurred backdrop in
    // the probes would make the floor near the model darker than the floor outside the probe box)
    const sc = kit.scene, keep = [sc.backgroundIntensity, sc.backgroundBlurriness] as const;
    if (sc.background === sc.environment) { sc.backgroundIntensity = sc.environmentIntensity; sc.backgroundBlurriness = 0; }
    probes.bake(renderer, kit.scene, { ...(q.has('probeRes') ? { resolution: Number(q.get('probeRes')) } : {}), near: kit.bake.near, far: kit.bake.far });
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
    provider = null; bvhInfo = null; probes = null; helper = null;
    ssr.setTraceProvider(null);
    kit = next; entry = e;
    controls.object = kit.camera;
    setPose(Object.keys(kit.views)[0]);
    state.exposure = kit.exposure;
    delete ssr.settings.depthBufferThickness; delete ssr.settings.thicknessRoughnessFactor;
    if (kit.thickness) Object.assign(ssr.settings, kit.thickness);
    renderer.toneMappingExposure = state.exposure;
    // probes: one box per region, as the scene suggests
    probes = new ReflectionProbes();
    for (const v of kit.probes) {
      const p = new ReflectionProbe(...v.influenceSize);
      p.position.set(...v.position);
      if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
      if (v.originOffset) p.originOffset.set(...v.originOffset);
      if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
      if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
      probes.add(p);
    }
    kit.scene.add(probes);
    bake();
    if (state.helpers) setHelpers(true);
    setProbes(state.probes);
    if (state.rt) await ensureBVH();
    applySources();
    ssr.gbuffer.resetHistory();
    ssr.resetHistory();
    hybrid.resetHistory();
    taa.reset();
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
    taa.reset();
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
      historyRT.setSize(W, H);
      taa.setSize(W, H);
      ssr.resetHistory();
      hybrid.resetHistory();
    }
    controls.update();
    kit.camera.aspect = W / H; kit.camera.updateProjectionMatrix(); kit.camera.updateMatrixWorld();
    ssr.render(kit.scene, kit.camera, taa.jitter(kit.camera, W, H));
    taa.restore(kit.camera);
    hybrid.update();
    if (taa.enabled) {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(taa.input);
      pipeline.render();
      renderer.setRenderTarget(prev);
      taa.resolve();
    } else pipeline.render();
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
  const denoiseBox = check(denoiser ? `Denoise (${denoiser.name})` : 'Denoise (no denoiser found)', hybrid.denoise, (v) => { hybrid.denoise = v && !!denoiser; taa.reset(); });
  denoiseBox.disabled = !denoiser;
  const taaBox = check('Temporal anti-aliasing', taa.enabled, (v) => { taa.enabled = v; taa.reset(); });
  row('Hit colour', select(HIT_MODES, state.hit, (v) => setHit(v as HitMode)));
  check('Show probe volumes', state.helpers, (v) => setHelpers(v));

  h2('Floor');
  const kindSel = select({ mirror: 'Mirror (metal)', lacquer: 'Black lacquer' }, 'mirror', (v) => { kit?.floor.setKind?.(v as FloorKind); ssr.resetHistory(); taa.reset(); });
  const kindRow = row('Material', kindSel);
  const polishBox = check('Polished floor override', true, (v) => { kit?.floor.setPolished?.(v); bake(); ssr.resetHistory(); taa.reset(); });
  const polishRow = polishBox.parentElement!;
  const rough = slider('Roughness', 0, 0.6, 0.01, 0.03, (v) => { kit?.floor.setRoughness(v); taa.reset(); });
  rough.input.onchange = () => bake();

  h2('Debug view');
  const viewSel = select(VIEWS, state.view, (v) => setView(v as View));
  row('Show', viewSel);
  const legendOf = (items: [string, string][]) => {
    const l = document.createElement('div'); l.className = 'legend';
    for (const [c, t] of items) { const i = document.createElement('i'); i.style.background = c; const sp = document.createElement('span'); sp.textContent = t; l.append(i, sp); }
    panel.append(l); return l;
  };
  const legends: Partial<Record<View, HTMLElement>> = {
    source: legendOf([['#26d940', 'screen-space hit'], ['#3373ff', 'ray-traced hit'], ['#ff8c1a', 'probe'], ['#d933d9', 'environment'], ['#595959', 'rough: probe / environment only']]),
    rtSource: legendOf([['#3366ff', 'ray-traced hit'], ['#33e6f2', 'ray-traced, colour from screen'], ['#f233d9', 'ray-traced miss'], ['#ff8c1a', 'over the ray budget'], ['#26d940', 'screen-space hit'], ['#d99926', 'probe (grey: environment)']]),
  };

  h2('Image');
  row('Tone mapping', select({ agx: 'AgX', neutral: 'Neutral (Khronos PBR)', aces: 'ACES filmic' }, state.tone, (v) => { state.tone = v as Tone; buildDisplay(); applySources(); }));
  const expo = slider('Exposure', 0.2, 3, 0.05, state.exposure, (v) => { state.exposure = v; renderer.toneMappingExposure = v; });

  h2('GPU time');
  const timingsEl = document.createElement('div'); timingsEl.id = 'timings'; panel.append(timingsEl);

  function setView(v: View) {
    state.view = v;
    taa.reset();
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
        (bvhInfo ? ` | BVH ${bvhInfo.triangles.toLocaleString()} triangles, ${bvhInfo.ms.toFixed(0)} ms` : ''),
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
      entries: () => entries.map((e) => e.id),
      load: (id: string) => load(id),
      poses: () => Object.keys(kit!.views),
      setPose,
      setView: (v: View) => setView(v),
      async setSources(s: { probes?: boolean; ssr?: boolean; rt?: boolean; denoise?: boolean }) {
        if (s.probes !== undefined && s.probes !== state.probes) setProbes(s.probes);
        if (s.ssr !== undefined) state.ssr = s.ssr;
        if (s.rt !== undefined) await setRT(s.rt); else applySources();
        if (s.denoise !== undefined) { hybrid.denoise = s.denoise && !!denoiser; denoiseBox.checked = hybrid.denoise; }
        refreshUI();
      },
      setHit: (m: HitMode) => setHit(m),
      taa, setTAA(on: boolean) { taa.enabled = on; taa.reset(); taaBox.checked = on; },
      stop: stopLoop, start: startLoop,
      async step(n = 1) { for (let i = 0; i < n; i++) { frame(); await idle(); } },
      async shot() { frame(); const url = canvas.toDataURL('image/png'); await idle(); return url; },
      async info() {
        await idle();
        return { scene: kit!.id, denoiser: hybrid.denoise ? denoiser?.name ?? null : null, taa: taa.enabled, size: [W, H], probes: probes?.bakedProbes.length ?? 0, bakeMs, bvh: bvhInfo, rt: ssr.rayTracing, gpuErrors: gpuErrors.length, timings: Object.fromEntries(timings), trace: await ssr.readTraceStats() };
      },
    },
  });
}

main().catch((e) => {
  console.error(e);
  document.querySelector<HTMLElement>('#status')!.textContent = String(e?.stack ?? e);
});
