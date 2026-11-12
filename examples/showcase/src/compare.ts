// examples/showcase/compare.html: a side-by-side comparison tool for judging the showcase by eye.
//
// Two methods (left / right of a draggable divider), each in its own canvas with its own renderer
// and its own fresh load of the scene; the canvases are stacked and the right one is clipped with
// CSS `clip-path`. One orbit camera drives both (copied into each method's camera every frame).
// "Freeze camera" stops the orbit so the path tracer converges.
//
// Methods: ours raw / denoised / with the RT fallback, probes only, three r187's SSRNode raw / with
// its own denoiser / with the FFX reflection denoiser (the denoiser repo's wiring), and the path
// tracer (three-gpu-pathtracer WebGPU, stopped at a sample cap and OIDN-denoised) as the reference. Every method displays AgX + sRGB at the
// scene's exposure.
//
// "Measure" (a tool readout, not a check): with the camera frozen, path-trace the reference to N
// samples, take the glossy-pixel mask from our G-buffer (geometry with perceptual roughness < 0.447),
// then run each method from reset for `warmup` frames and read `frames` more. Per method, over the
// masked pixels, in display units (8-bit sRGB after AgX, 0-255): MAD = mean |frame - reference|
// (noise included), bias = |temporal mean - reference| (noise averaged out), and the per-pixel
// temporal std of luma (boiling), mean and p99. Then, with no reference, "orbit": the mean
// |second temporal difference| of luma over the mask during a slow orbit (0.05 deg/frame), i.e.
// flicker in motion; 'probes only' (no noise) gives the floor that moving edges leave.
//
// URL: ?scene=<id> ?pose=<name> ?left=<method> ?right=<method> ?split=0.5 ?w=960&h=540 ?freeze ?manual
// Experiment overrides (not product defaults): ?spq=1|2|4 ?tsf=<FFX temporalStabilityFactor>
// ?hit=final|lit|current ?reshade=reshade|off ?specOcc=1 (ours; specOcc: Lagarde specular occlusion from GTAO, W39), ?mirrorBias= ?ssrMaxDistance= ?ssrThickness= (three's SSR), ?ptBounces=
// ?ptMax= ?ptRaw=1 ?ptDenoise=0 ?ptClearcoat=0 (path tracer), ?floorRoughness= (every method's floor, before the bake)
// W45: ?lobeFilter=<k> (ours: hitLobeFilter, D3550), ?keyLight=<scale> and ?paintRoughness=<r> (every method: scale the lights; set
// clear-coated paint to roughness r without its normal map)
// W46: ?specAA=1 (or <strength>) roughness from normal variance on every raster method's glTF materials (ours, three's SSR,
// probes; never the path tracer, the reference), D3570; the glossy mask stays the authored roughness's (?maskSpecAA=1: the adjusted)
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { availableAssets } from '../../shared';
import { SHOWCASE, type ShowcaseEntry } from './scenes';
import { METHOD_IDS, METHOD_LABELS, METHOD_SHORT, type CompareMethod, type MethodContext, type MethodId } from './compare/method';
import { createOurs } from './compare/ours';
import { createThreeSSR, ffxAvailable } from './compare/three-ssr';
import { DEFAULT_MAX_SAMPLES, createPathTracer, oidnAvailable, pathTracerAvailable } from './compare/pathtracer';
import { denoiserAvailable } from '../../shared/denoiser';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 960), H = Number(q.get('h') ?? 540);
const manual = q.has('manual');
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const statusEl = $('#status');
const stage = $('#stage'), layerA = $('#layerA'), layerB = $('#layerB'), input = $('#input'), divider = $('#divider');
const labelA = $('#labelA'), labelB = $('#labelB');
/** The side labels drawn on the image: method name (with its A / B badge) and a status line. */
function setLabel(i: 0 | 1, name: string, stat: string) {
  const l = i === 0 ? labelA : labelB;
  l.querySelector('.name')!.textContent = name;
  l.querySelector('.stat')!.textContent = stat;
}
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const available = (id: MethodId) =>
  id === 'pathtraced' ? pathTracerAvailable : id === 'three-ffx' ? ffxAvailable : (id === 'ours-denoised' || id === 'ours-rt') ? denoiserAvailable || id === 'ours-rt' : true;

async function main() {
  if (!navigator.gpu) { statusEl.textContent = 'WebGPU is not available in this browser.'; return; }
  const have = new Set((await availableAssets()).map((a) => `${a.dir}/${a.file}`));
  const entries = SHOWCASE.filter((e) => have.has(`${e.asset}/${e.asset === 'Sponza' ? 'Sponza.gltf' : e.asset + '.glb'}`) && have.has(`hdri/${e.hdri}`));
  if (!entries.length) {
    statusEl.textContent = 'No showcase assets found. Run `pnpm assets`, then reload.';
    Object.assign(window, { __p: { entries: () => [] } });
    return;
  }

  // ---- state ---------------------------------------------------------------------------------------
  const pick = (v: string | null, d: MethodId): MethodId => (v && (METHOD_IDS as string[]).includes(v) && available(v as MethodId) ? v as MethodId : d);
  const sides: [MethodId, MethodId] = [pick(q.get('left'), 'ours-denoised'), pick(q.get('right'), pathTracerAvailable ? 'pathtraced' : 'three-ffx')];
  let split = Number(q.get('split') ?? 0.5);
  let frozen = q.has('freeze');
  let entry: ShowcaseEntry = entries.find((e) => e.id === q.get('scene')) ?? entries[0];
  let pose = '';
  let exposure = 1;
  let busy = false;
  const instances = new Map<MethodId, Promise<CompareMethod>>();
  const live = new Map<MethodId, CompareMethod>();
  const errors: string[] = [];

  const camera = new THREE.PerspectiveCamera(40, W / H, 0.01, 100);
  const controls = new OrbitControls(camera, input);
  controls.enableDamping = true;

  // ---- layout ----------------------------------------------------------------------------------------
  function layout() {
    const wrap = stage.parentElement!.getBoundingClientRect();
    const s = Math.min(wrap.width / W, wrap.height / H);
    stage.style.width = `${Math.floor(W * s)}px`;
    stage.style.height = `${Math.floor(H * s)}px`;
    layerB.style.clipPath = `inset(0 0 0 ${(split * 100).toFixed(3)}%)`;
    divider.style.left = `${(split * 100).toFixed(3)}%`;
    const single = sides[0] === sides[1];
    layerB.style.display = divider.style.display = labelB.style.display = single ? 'none' : '';
  }
  addEventListener('resize', layout);
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      split = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      layout();
    };
    const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });

  // ---- methods -----------------------------------------------------------------------------------------
  const context = (): MethodContext => ({ entry, width: W, height: H, exposure, params: q });
  function create(id: MethodId): Promise<CompareMethod> {
    const ctx = context();
    switch (id) {
      case 'pathtraced': return createPathTracer(ctx);
      case 'three-raw': case 'three-denoise': case 'three-ffx': return createThreeSSR(id, ctx);
      default: return createOurs(id, ctx);
    }
  }
  function get(id: MethodId): Promise<CompareMethod> {
    let p = instances.get(id);
    if (!p) {
      const forEntry = entry;
      p = create(id).then((m) => {
        if (entry !== forEntry || instances.get(id) !== p) { m.dispose(); throw new Error('stale'); }
        live.set(id, m);
        return m;
      });
      instances.set(id, p);
      p.catch((e) => { if (String(e?.message) !== 'stale') { instances.delete(id); fail(e); } });
    }
    return p;
  }
  function drop(id: MethodId) {
    const m = live.get(id);
    instances.delete(id); live.delete(id);
    if (m) { errors.push(...m.gpuErrors()); m.dispose(); }
  }
  /** Dispose every method no side shows (unless `keep`). */
  function prune(keep: MethodId[] = []) {
    for (const id of [...instances.keys()]) if (!sides.includes(id) && !keep.includes(id)) drop(id);
  }
  async function mountSides() {
    const [a, b] = await Promise.all(sides.map((s) => get(s)));
    layerA.replaceChildren(a.canvas);
    if (b !== a) layerB.replaceChildren(b.canvas); else layerB.replaceChildren();
    layout();
    return [a, b] as const;
  }
  /** Put `a` on side A (left) and `b` on side B (right): pickers, labels, URL (?left= ?right=), canvases. */
  async function setSides(a: MethodId, b: MethodId) {
    sides[0] = a; sides[1] = b;
    sideSel[0].value = a; sideSel[1].value = b;
    for (const i of [0, 1] as const) if (!live.has(sides[i])) setLabel(i, METHOD_SHORT[sides[i]], 'loading...');
    markPreset();
    const u = new URL(location.href); u.searchParams.set('left', a); u.searchParams.set('right', b); history.replaceState(null, '', u);
    await mountSides();
    prune();
  }

  function setPose(name: string) {
    const first = live.get(sides[0]) ?? [...live.values()][0];
    if (!first) return;
    const v = first.scene.views[name] ?? Object.values(first.scene.views)[0];
    pose = first.scene.views[name] ? name : Object.keys(first.scene.views)[0];
    camera.position.set(...v.pos);
    camera.fov = v.fov ?? first.scene.fov;
    camera.near = first.scene.near; camera.far = first.scene.far;
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    controls.target.set(...v.target);
    controls.update();
    for (const m of live.values()) m.reset();
    poseSel.value = pose;
  }

  async function load(id: string) {
    busy = true;
    for (const k of [...instances.keys()]) drop(k);
    entry = entries.find((e) => e.id === id) ?? entries[0];
    statusEl.textContent = `loading ${entry.title}...`;
    setLabel(0, METHOD_SHORT[sides[0]], 'loading...'); setLabel(1, METHOD_SHORT[sides[1]], 'loading...');
    const [a] = await mountSides();
    exposure = a.scene.exposure;
    for (const m of live.values()) m.setExposure(exposure);
    expo.value = String(exposure); expoVal.textContent = exposure.toFixed(2);
    poseSel.replaceChildren(...Object.keys(a.scene.views).map((v) => new Option(v, v)));
    setPose(q.get('pose') && pose === '' ? q.get('pose')! : Object.keys(a.scene.views)[0]);
    sceneSel.value = entry.id;
    busy = false;
    const u = new URL(location.href); u.searchParams.set('scene', entry.id); history.replaceState(null, '', u);
  }

  // ---- frame -------------------------------------------------------------------------------------------
  function visible(): CompareMethod[] {
    const out: CompareMethod[] = [];
    for (const s of sides) { const m = live.get(s); if (m && !out.includes(m)) out.push(m); }
    return out;
  }
  function renderVisible() {
    controls.enabled = !frozen;
    controls.update();
    for (const m of visible()) m.frame(camera);
  }
  function labels() {
    for (const i of [0, 1] as const) { const m = live.get(sides[i]); setLabel(i, METHOD_SHORT[sides[i]], m ? m.status() : 'loading...'); }
  }
  function tick() {
    requestAnimationFrame(tick);
    if (busy) return;
    renderVisible();
    labels();
  }

  // ---- readout ---------------------------------------------------------------------------------------
  const scratch = document.createElement('canvas');
  scratch.width = W; scratch.height = H;
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
  const read = (c: HTMLCanvasElement) => { sctx.clearRect(0, 0, W, H); sctx.drawImage(c, 0, 0); return sctx.getImageData(0, 0, W, H).data; };

  interface Row { method: MethodId; mad: number; bias: number; stdMean: number; stdP99: number; orbit: number | null; frames: number; warmup: number; info: Record<string, unknown> }
  interface Measure { scene: string; pose: string; size: [number, number]; referenceSamples: number; glossyPixels: number; units: string; orbitDegPerFrame: number; rows: Row[]; seconds: number }
  let lastMeasure: Measure | null = null;

  /**
   * Orbit flicker, reference-free: during a slow orbit about the target (`orbitDeg` per frame), the
   * mean over the glossy mask of |l_t - (l_t-1 + l_t+1) / 2| (luma, 0-255). Smooth image motion
   * cancels to first order in the second temporal difference; frame-to-frame noise doesn't. Edges
   * moving across pixels leave a floor common to every method ('probes only' shows it: no noise).
   */
  async function orbitFlicker(m: CompareMethod, mask: number[], orbitDeg: number, frames: number, perPixel?: Float32Array) {
    const pos = camera.position.clone(), quat = camera.quaternion.clone(), target = controls.target.clone();
    const up = new THREE.Vector3(0, 1, 0), off = pos.clone().sub(target);
    const at = (k: number) => {
      camera.position.copy(target).add(off.clone().applyAxisAngle(up, (k * orbitDeg * Math.PI) / 180));
      camera.lookAt(target); camera.updateMatrixWorld();
    };
    const n = mask.length, warm = 16;
    let a: Float32Array | null = null, b: Float32Array | null = null, sum = 0, count = 0;
    try {
      for (let f = 0; f < warm + frames; f++) {
        at(f);
        m.frame(camera);
        if (f >= warm) {
          const d = read(m.canvas);
          const l = new Float32Array(n);
          for (let k = 0; k < n; k++) { const o = mask[k] * 4; l[k] = 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; }
          if (a && b) {
            for (let k = 0; k < n; k++) { const e = Math.abs(b[k] - (a[k] + l[k]) / 2); sum += e; if (perPixel) perPixel[k] += e / (frames - 2); }
            count += n;
          }
          a = b; b = l;
        }
        await m.idle();
        if (f % 8 === 0) await nextFrame();
      }
    } finally {
      camera.position.copy(pos); camera.quaternion.copy(quat); camera.updateMatrixWorld();
    }
    return count ? sum / count : 0;
  }

  /** Path tracer: set its cap to `samples`, then render until it has traced there and denoised (idle). */
  async function accumulate(pt: CompareMethod, samples: number, onStep?: () => void) {
    pt.setMaxSamples?.(samples);
    if (pt.id === 'pathtraced' && sides.includes('pathtraced')) ptMaxIn.value = String(samples);
    const t0 = performance.now();
    while (!(pt.done?.() ?? true) && performance.now() - t0 < 600_000) {
      pt.frame(camera);
      onStep?.();
      labels();
      await pt.idle();
      await nextFrame();
    }
  }

  async function measure(opts: { samples?: number; warmup?: number; frames?: number; methods?: MethodId[]; orbitDeg?: number; orbitFrames?: number } = {}): Promise<Measure> {
    const samples = opts.samples ?? Number(sampIn.value), warmup = opts.warmup ?? Number(warmIn.value), K = opts.frames ?? Number(framesIn.value);
    const orbitDeg = opts.orbitDeg ?? 0.05, orbitFrames = opts.orbitFrames ?? 32;
    const methods = (opts.methods ?? METHOD_IDS.filter((id) => id !== 'pathtraced' && measureBoxes.get(id)?.checked)).filter(available);
    if (!pathTracerAvailable) throw new Error('measure needs the path tracer');
    const t0 = performance.now();
    busy = true;
    frozen = true; freezeBox.checked = true; controls.enabled = false;
    const say = (s: string) => { readoutEl.textContent = s; };
    try {
      // reference
      const pt = await get('pathtraced');
      await accumulate(pt, samples, () => say(`path tracing the reference: ${pt.status()}`));
      pt.present?.();
      const ref = new Uint8ClampedArray(read(pt.canvas));
      const refSamples = pt.samples?.() ?? 0;
      if (!sides.includes('pathtraced')) drop('pathtraced'); // GPU memory for the methods (Sponza)
      // glossy mask from our G-buffer
      const oursId = (METHOD_IDS.find((id) => id.startsWith('ours') && live.has(id)) ?? 'ours-raw') as MethodId;
      const ours = await get(oursId);
      ours.renderMask!(camera);
      const md = read(ours.canvas);
      await ours.idle();
      const mask: number[] = [];
      for (let i = 0; i < W * H; i++) if (md[i * 4] > 127) mask.push(i);
      const rows: Row[] = [];
      for (const id of methods) {
        say(`${METHOD_SHORT[id]}: loading`);
        const m = await get(id);
        m.reset();
        for (let f = 0; f < warmup; f++) { m.frame(camera); await m.idle(); if (f % 8 === 0) { say(`${METHOD_SHORT[id]}: warm-up ${f} / ${warmup}`); await nextFrame(); } }
        const n = mask.length;
        const sumL = new Float64Array(n), sumL2 = new Float64Array(n), sumC = new Float64Array(n * 3);
        let absTotal = 0;
        for (let f = 0; f < K; f++) {
          m.frame(camera);
          const d = read(m.canvas);
          await m.idle();
          for (let k = 0; k < n; k++) {
            const o = mask[k] * 4;
            const r = d[o], g = d[o + 1], b = d[o + 2];
            absTotal += (Math.abs(r - ref[o]) + Math.abs(g - ref[o + 1]) + Math.abs(b - ref[o + 2])) / 3;
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            sumL[k] += l; sumL2[k] += l * l;
            sumC[k * 3] += r; sumC[k * 3 + 1] += g; sumC[k * 3 + 2] += b;
          }
          if (f % 8 === 0) { say(`${METHOD_SHORT[id]}: frame ${f} / ${K}`); await nextFrame(); }
        }
        const std = new Float64Array(n);
        let bias = 0, stdSum = 0;
        for (let k = 0; k < n; k++) {
          const o = mask[k] * 4;
          bias += (Math.abs(sumC[k * 3] / K - ref[o]) + Math.abs(sumC[k * 3 + 1] / K - ref[o + 1]) + Math.abs(sumC[k * 3 + 2] / K - ref[o + 2])) / 3;
          const mean = sumL[k] / K;
          std[k] = Math.sqrt(Math.max(0, sumL2[k] / K - mean * mean));
          stdSum += std[k];
        }
        const sorted = Array.from(std).sort((a, b) => a - b);
        let orbit: number | null = null;
        if (orbitFrames > 0) { say(`${METHOD_SHORT[id]}: orbit`); orbit = await orbitFlicker(m, mask, orbitDeg, orbitFrames); }
        rows.push({ method: id, mad: absTotal / (n * K), bias: bias / n, stdMean: stdSum / n, stdP99: sorted[Math.floor(n * 0.99)] ?? 0, orbit, frames: K, warmup, info: m.info() });
        if (!sides.includes(id) && id !== oursId) drop(id);
        say(table(rows, refSamples, n));
      }
      if (!sides.includes(oursId)) drop(oursId);
      lastMeasure = { scene: entry.id, pose, size: [W, H], referenceSamples: refSamples, glossyPixels: mask.length, units: '8-bit display (sRGB after AgX), 0-255', orbitDegPerFrame: orbitDeg, rows, seconds: (performance.now() - t0) / 1000 };
      say(table(rows, refSamples, mask.length));
      return lastMeasure;
    } finally {
      busy = false;
    }
  }
  function table(rows: Row[], refSamples: number, n: number) {
    const head = `vs path traced (${refSamples} spp${oidnAvailable ? ', OIDN-denoised' : ''}), ${n.toLocaleString()} glossy px\n8-bit display units (0-255), still camera\n\n${'method'.padEnd(20)}${'MAD'.padStart(6)}${'bias'.padStart(6)}${'std'.padStart(6)}${'p99'.padStart(6)}${'orbit'.padStart(6)}\n`;
    return head + rows.map((r) => `${METHOD_SHORT[r.method].padEnd(20)}${r.mad.toFixed(2).padStart(6)}${r.bias.toFixed(2).padStart(6)}${r.stdMean.toFixed(2).padStart(6)}${r.stdP99.toFixed(1).padStart(6)}${(r.orbit ?? NaN).toFixed(2).padStart(6)}`).join('\n') +
      '\n\nMAD: mean |frame - ref| (noise incl.)\nbias: |temporal mean - ref|\nstd: per-pixel temporal std of luma\norbit: |2nd temporal difference| of luma\n  in a 0.05 deg/frame orbit (no reference)';
  }

  // ---- UI ----------------------------------------------------------------------------------------------
  const panel = $('#controls');
  const h2 = (t: string) => { const e = document.createElement('h2'); e.textContent = t; panel.append(e); };
  const row = (label: string, el: HTMLElement, after?: HTMLElement) => { const l = document.createElement('label'); l.append(label, el); if (after) l.append(after); panel.append(l); return l; };
  const select = (opts: [string, string, boolean?][], value: string, on: (v: string) => void) => {
    const s = document.createElement('select');
    for (const [k, v, disabled] of opts) { const o = new Option(v, k); o.disabled = !!disabled; s.append(o); }
    s.value = value; s.onchange = () => on(s.value); return s;
  };
  const check = (label: string, value: boolean, on: (v: boolean) => void, parent: HTMLElement = panel) => {
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = value; c.onchange = () => on(c.checked);
    const l = document.createElement('label'); l.className = 'check'; l.append(c, label); parent.append(l); return c;
  };
  const num = (value: number) => { const i = document.createElement('input'); i.type = 'number'; i.value = String(value); i.min = '1'; return i; };
  const note = (t: string) => { const d = document.createElement('div'); d.className = 'note'; d.textContent = t; panel.append(d); return d; };

  h2('Scene');
  const sceneSel = select(entries.map((e) => [e.id, e.title]), entry.id, (v) => { load(v).catch(fail); });
  row('Scene', sceneSel);
  const poseSel = select([], '', (v) => setPose(v));
  row('Camera', poseSel);
  const freezeBox = check('Freeze camera (path tracer converges)', frozen, (v) => { frozen = v; });
  const expo = document.createElement('input'); expo.type = 'range'; expo.min = '0.2'; expo.max = '3'; expo.step = '0.05';
  const expoVal = document.createElement('span'); expoVal.className = 'val';
  expo.oninput = () => { exposure = Number(expo.value); expoVal.textContent = exposure.toFixed(2); for (const m of live.values()) m.setExposure(exposure); };
  row('Exposure (AgX)', expo, expoVal);

  h2('Path tracer (reference)');
  // the cap and the raw/denoised toggle go into `q` too, so a re-created tracer (scene change) keeps them
  const ptMaxIn = num(Number(q.get('ptMax') ?? DEFAULT_MAX_SAMPLES));
  ptMaxIn.max = '512';
  ptMaxIn.disabled = !pathTracerAvailable;
  ptMaxIn.onchange = () => {
    const n = Math.min(512, Math.max(1, Math.round(Number(ptMaxIn.value) || DEFAULT_MAX_SAMPLES)));
    ptMaxIn.value = String(n); q.set('ptMax', String(n));
    live.get('pathtraced')?.setMaxSamples?.(n);
    const u = new URL(location.href); u.searchParams.set('ptMax', String(n)); history.replaceState(null, '', u);
  };
  row('Max samples (then denoise)', ptMaxIn);
  const ptDenoisedBox = check(oidnAvailable ? 'Show denoised (OIDN, albedo + normal)' : 'Show denoised (OIDN not found)', q.get('ptRaw') !== '1', (v) => {
    q.set('ptRaw', v ? '0' : '1');
    live.get('pathtraced')?.setShowDenoised?.(v);
  });
  ptDenoisedBox.disabled = !oidnAvailable || !pathTracerAvailable;
  note('Traces while the camera moves (restarts on every move), stops at max samples, denoises once and then sits idle.');

  // A | B: A's picker sits over the left half of the image, B's over the right (the bar in compare.html)
  const methodOpts = METHOD_IDS.map((id) => [id, METHOD_LABELS[id] + (available(id) ? '' : ' (unavailable)'), !available(id)] as [string, string, boolean]);
  const sideSel = [
    select(methodOpts, sides[0], (v) => { setSides(v as MethodId, sides[1]).catch(fail); }),
    select(methodOpts, sides[1], (v) => { setSides(sides[0], v as MethodId).catch(fail); }),
  ];
  sideSel[0].title = 'A: the left of the divider'; sideSel[1].title = 'B: the right of the divider';
  $('#pickA').append(sideSel[0]);
  const badgeB = document.createElement('span'); badgeB.className = 'badge b'; badgeB.textContent = 'B';
  $('#pickB').append(sideSel[1], badgeB);
  $('#swapBtn').onclick = () => { setSides(sides[1], sides[0]).catch(fail); };
  // one-click pairs (A vs B); the matching one is highlighted
  const PRESETS: [MethodId, MethodId, string][] = [
    ['ours-rt', 'pathtraced', 'ours + RT vs path traced'],
    ['ours-denoised', 'pathtraced', 'ours vs path traced'],
    ['ours-denoised', 'three-ffx', 'ours vs three SSR + FFX'],
    ['ours-denoised', 'ours-rt', 'ours vs ours + RT'],
  ];
  const presetBtns = PRESETS.filter(([a, b]) => available(a) && available(b)).map(([a, b, text]) => {
    const btn = document.createElement('button'); btn.textContent = text; btn.title = `A: ${METHOD_LABELS[a]}\nB: ${METHOD_LABELS[b]}`;
    btn.onclick = () => { setSides(a, b).catch(fail); };
    $('#presets').append(btn);
    return { a, b, btn };
  });
  function markPreset() { for (const p of presetBtns) p.btn.classList.toggle('on', p.a === sides[0] && p.b === sides[1]); }
  markPreset();

  h2('Split');
  const resetBtn = document.createElement('button'); resetBtn.textContent = 'Reset history';
  resetBtn.onclick = () => { for (const m of live.values()) m.reset(); };
  panel.append(resetBtn);
  note('A shows left of the divider, B right of it: pick them in the bar above the image. Drag the divider. Orbit drives both sides; each method keeps its own copy of the scene and renderer.');

  h2('Readout (still camera)');
  const sampIn = num(Number(q.get('samples') ?? 256)), warmIn = num(Number(q.get('warmup') ?? 48)), framesIn = num(Number(q.get('frames') ?? 32));
  row('Reference samples', sampIn); row('Warm-up frames', warmIn); row('Measured frames', framesIn);
  const boxes = document.createElement('div');
  panel.append(boxes);
  const measureBoxes = new Map<MethodId, HTMLInputElement>();
  for (const id of METHOD_IDS) if (id !== 'pathtraced') { const b = check(METHOD_SHORT[id], available(id), () => {}, boxes); b.disabled = !available(id); measureBoxes.set(id, b); }
  const measureBtn = document.createElement('button'); measureBtn.textContent = 'Measure';
  measureBtn.disabled = !pathTracerAvailable;
  measureBtn.onclick = () => { measureBtn.disabled = true; measure().catch(fail).finally(() => { measureBtn.disabled = false; }); };
  panel.append(measureBtn);
  note('A tool readout for judging by eye, not a check to tune against. Each method runs from reset; methods not on screen are loaded for the run and dropped after.');
  const readoutEl = document.createElement('pre'); readoutEl.id = 'readout'; panel.append(readoutEl);

  function fail(e: unknown) { console.error(e); statusEl.textContent = String((e as Error)?.stack ?? e); busy = false; }
  setInterval(() => {
    const errs = errors.length + [...live.values()].reduce((a, m) => a + m.gpuErrors().length, 0);
    statusEl.textContent = [
      `${entry.title} | ${W}x${H} | three r${THREE.REVISION}`,
      `path tracer: ${pathTracerAvailable ? __PATHTRACER_SOURCE__ + ' (WebGPU)' : 'not found'}; OIDN: ${oidnAvailable ? 'denoiser package' : 'not found'}`,
      `FFX: ${ffxAvailable ? 'denoiser/three ffxReflections + denoiser/ffx' : denoiserAvailable ? 'denoiser/ffx only' : 'not found'}`,
      errs ? `GPU errors: ${errs}` : '',
    ].filter(Boolean).join('\n');
  }, 500);

  // ---- start -------------------------------------------------------------------------------------------
  layout();
  await load(entry.id);
  if (!manual) tick();

  Object.assign(window, {
    __p: {
      THREE, entries: () => entries.map((e) => e.id),
      load, setPose, poses: () => [...poseSel.options].map((o) => o.value),
      /** The orbit camera as [pos, target] (scene units), and setting it (resets every method). */
      view: () => [camera.position.toArray(), controls.target.toArray()],
      setView(pos: [number, number, number], target: [number, number, number]) {
        camera.position.set(...pos); controls.target.set(...target); controls.update();
        for (const m of live.values()) m.reset();
      },
      setSides,
      setSplit: (x: number) => { split = x; layout(); },
      freeze: (v = true) => { frozen = v; freezeBox.checked = v; },
      reset: () => { for (const m of live.values()) m.reset(); },
      async step(n = 1) { for (let i = 0; i < n; i++) { renderVisible(); await Promise.all(visible().map((m) => m.idle())); } labels(); },
      /** The split as on screen (left full, right clipped at the divider, a 1 px line). */
      async shot() {
        renderVisible();
        const [a, b] = sides.map((s) => live.get(s)!);
        a.present?.(); b.present?.(); // an idle path tracer draws nothing new per frame
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d')!;
        g.drawImage(a.canvas, 0, 0);
        if (b !== a) { const x = Math.round(split * W); g.drawImage(b.canvas, x, 0, W - x, H, x, 0, W - x, H); g.fillStyle = '#fff'; g.fillRect(x, 0, 1, H); }
        await Promise.all(visible().map((m) => m.idle()));
        return c.toDataURL('image/png');
      },
      /** One method's canvas after a frame (loads it if needed). */
      async shotOf(id: MethodId, frames = 1) {
        const m = await get(id);
        for (let i = 1; i < frames; i++) { m.frame(camera); await m.idle(); }
        m.frame(camera);
        m.present?.();
        const url = m.canvas.toDataURL('image/png');
        await m.idle();
        return url;
      },
      /** Orbit flicker per pixel (whole frame) as a heat map: black 0, white >= `scale` (8-bit luma). */
      async flickerMap(id: MethodId, frames = 32, orbitDeg = 0.05, scale = 4) {
        const m = await get(id);
        m.reset();
        for (let f = 0; f < 48; f++) { m.frame(camera); await m.idle(); }
        const all = Array.from({ length: W * H }, (_, i) => i);
        const per = new Float32Array(W * H);
        const mean = await orbitFlicker(m, all, orbitDeg, frames, per);
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d')!, img = g.createImageData(W, H);
        for (let i = 0; i < W * H; i++) {
          const t = Math.min(1, per[i] / scale);
          img.data[i * 4] = 255 * Math.min(1, t * 3); img.data[i * 4 + 1] = 255 * Math.min(1, Math.max(0, t * 3 - 1)); img.data[i * 4 + 2] = 255 * Math.max(0, t * 3 - 2); img.data[i * 4 + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        return { mean, url: c.toDataURL('image/png') };
      },
      /** Trace the reference to `samples` (its cap), denoise, and return its info (samples, denoised, ms). */
      async converge(samples?: number) {
        const pt = await get('pathtraced');
        const t = performance.now();
        await accumulate(pt, samples ?? pt.maxSamples?.() ?? 8);
        return { ...pt.info(), status: pt.status(), done: pt.done?.() ?? true, seconds: (performance.now() - t) / 1000 };
      },
      showDenoised: (v = true) => { ptDenoisedBox.checked = v; q.set('ptRaw', v ? '0' : '1'); live.get('pathtraced')?.setShowDenoised?.(v); },
      ptInfo: () => { const m = live.get('pathtraced'); return m ? { ...m.info(), status: m.status(), done: m.done?.() ?? true } : null; },
      measure, get lastMeasure() { return lastMeasure; },
      drop, prune,
      info: () => ({ scene: entry.id, pose, sides: [...sides], split, frozen, live: [...live.keys()], status: Object.fromEntries([...live].map(([k, m]) => [k, m.status()])) }),
      gpuErrors: () => [...errors, ...[...live.values()].flatMap((m) => m.gpuErrors())],
      ready: true,
    },
  });
}

main().catch((e) => { console.error(e); statusEl.textContent = String(e?.stack ?? e); });
