// examples/showcase/bench.html (W51): the tuning bench. Every setting from ./bench/schema.ts on one
// panel, any two of the compare page's methods (./compare/*.ts: ours raw / denoised / + RT, probes only,
// three's SSRNode raw / + its denoiser / + FFX, the path tracer) on one camera, as a split, side by
// side, or an absolute-difference heat map, and Measure: the MAD against the path tracer over the whole
// frame, the glossy px and named or dragged regions.
//
// Settings: each schema entry is a URL key. A change goes into the URL and to every live method it
// applies to (`method.set(key, value)`); keys a method takes only at creation mark it for the Rebuild
// button, which recreates those methods with the current URL. A link therefore reproduces the view.
// "Copy as code" prints the package options for the current values; presets live in localStorage
// (optional: the page works without it). The bench passes the methods its own defaults: display AA
// (@pmndrs/upscaler, as the showcase) and per-pass GPU timestamps.
//
// URL (besides the settings): ?scene= ?pose= ?left= ?right= ?mode=split|side|diff ?split=0.5 ?diffScale=
// ?diffKind=abs|luma ?freeze ?regions=name:x,y,w,h;... ?manual (no rAF loop; window.__p drives it).
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { availableAssets } from '../../shared';
import { SHOWCASE, type ShowcaseEntry } from './scenes';
import { METHOD_IDS, METHOD_LABELS, METHOD_SHORT, type CompareMethod, type MethodContext, type MethodId } from './compare/method';
import { createOurs } from './compare/ours';
import { createThreeSSR, ffxAvailable } from './compare/three-ssr';
import { createPathTracer, oidnAvailable, pathTracerAvailable } from './compare/pathtracer';
import { denoiserAvailable } from '../../shared/denoiser';
import { GROUPS, SETTINGS, decodeValue, effectiveDefault, encodeValue, settingById, type Setting, type Value } from './bench/schema';
import { appliesText } from './bench/settingsDoc';
import { EXTRA_VIEWS, NAMED_REGIONS, decodeRegions, encodeRegions, regionPixels, type Region } from './bench/regions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type Mode = 'split' | 'side' | 'diff';

const q = new URLSearchParams(location.search);
const [W, H] = (() => {
  if (q.has('w') && q.has('h')) return [Number(q.get('w')), Number(q.get('h'))];
  const s = q.get('size'); const m = s?.match(/^(\d+)x(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [960, 540];
})();
const manual = q.has('manual');
/** The bench's own method defaults (the URL overrides them): the showcase's AA, GPU timing. */
const BENCH_DEFAULTS: Record<string, string> = { aa: 'upscaler', timestamps: '1' };
const PRESET_KEY = 'pmndrs-reflections-bench-presets';
const PAGE_KEYS = new Set(['scene', 'pose', 'size', 'exposure']);

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const statusEl = $('#status');
const stage = $('#stage'), layerA = $('#layerA'), layerB = $('#layerB'), input = $('#input'), divider = $('#divider');
const diffLayer = $('#diffLayer'), diffCanvas = $<HTMLCanvasElement>('#diff'), overlay = document.querySelector<SVGSVGElement>('#overlay')!;
const labelA = $('#labelA'), labelB = $('#labelB'), legend = $('#legend');
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const available = (id: MethodId) =>
  id === 'pathtraced' ? pathTracerAvailable : id === 'three-ffx' ? ffxAvailable : (id === 'ours-denoised' || id === 'ours-rt') ? denoiserAvailable || id === 'ours-rt' : true;

function setLabel(i: 0 | 1, name: string, stat: string) {
  const l = i === 0 ? labelA : labelB;
  l.querySelector('.name')!.textContent = name;
  l.querySelector('.stat')!.textContent = stat;
}
const urlSync = () => history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
const storage = {
  read(): Record<string, string> { try { return JSON.parse(localStorage.getItem(PRESET_KEY) ?? '{}') ?? {}; } catch { return {}; } },
  write(v: Record<string, string>) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(v)); return true; } catch { return false; } },
};

/** Inferno-like ramp for the heat map (t in 0..1). */
const RAMP: [number, number, number][] = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
function ramp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

async function main() {
  if (!navigator.gpu) { statusEl.textContent = 'WebGPU is not available in this browser.'; return; }
  const have = new Set((await availableAssets()).map((a) => `${a.dir}/${a.file}`));
  const entries = SHOWCASE.filter((e) => have.has(`${e.asset}/${e.asset === 'Sponza' ? 'Sponza.gltf' : e.asset + '.glb'}`) && have.has(`hdri/${e.hdri}`));
  if (!entries.length) {
    statusEl.textContent = 'No showcase assets found. Run `pnpm assets`, then reload.';
    Object.assign(window, { __p: { entries: () => [], ready: true } });
    return;
  }

  // ---- state ---------------------------------------------------------------------------------------
  const pick = (v: string | null, d: MethodId): MethodId => (v && (METHOD_IDS as string[]).includes(v) && available(v as MethodId) ? v as MethodId : d);
  const sides: [MethodId, MethodId] = [pick(q.get('left'), 'ours-rt'), pick(q.get('right'), pathTracerAvailable ? 'pathtraced' : 'three-denoise')];
  let mode: Mode = (['split', 'side', 'diff'] as const).find((m) => m === q.get('mode')) ?? 'split';
  let split = Number(q.get('split') ?? 0.5);
  let diffScale = Number(q.get('diffScale') ?? 32);
  let diffKind: 'abs' | 'luma' = q.get('diffKind') === 'luma' ? 'luma' : 'abs';
  let frozen = q.has('freeze');
  let entry: ShowcaseEntry = entries.find((e) => e.id === q.get('scene')) ?? entries.find((e) => e.id === 'carConcept') ?? entries[0];
  let pose = '';
  let sceneExposure = 1;
  let busy = false;
  let regions: Region[] = decodeRegions(q.get('regions'));
  let showRegions = true, drawing = false;
  /** Regions left out of the overlay and of Measure (?hideRegions=a,b): named ones can't be deleted, only hidden. */
  const hiddenRegions = new Set((q.get('hideRegions') ?? '').split(',').filter(Boolean));
  /** The region being edited (selected on the overlay or in the list). */
  let selected: string | null = null;
  /** A still copy of A shown as B (see takeSnapshot). */
  let snapshot: { canvas: HTMLCanvasElement; label: string } | null = null;
  const instances = new Map<MethodId, Promise<CompareMethod>>();
  const live = new Map<MethodId, CompareMethod>();
  const errors: string[] = [];
  /** Methods whose creation-time settings changed (the Rebuild button recreates them), and page-level changes. */
  const pending = new Set<MethodId>();
  let pagePending = false;

  const camera = new THREE.PerspectiveCamera(40, W / H, 0.01, 100);
  const controls = new OrbitControls(camera, input);
  controls.enableDamping = true;

  // ---- layout ----------------------------------------------------------------------------------------
  function layout() {
    const wrap = stage.parentElement!.getBoundingClientRect();
    const cols = mode === 'side' ? 2 : 1, gap = mode === 'side' ? 6 : 0;
    const s = Math.min((wrap.width - gap) / (W * cols), wrap.height / H);
    const iw = Math.floor(W * s);
    stage.style.width = `${iw * cols + gap}px`;
    stage.style.height = `${Math.floor(H * s)}px`;
    const single = sides[0] === sides[1] && !snapshot;
    const diff = mode === 'diff';
    layerA.style.display = diff ? 'none' : '';
    layerB.style.display = diff || single ? 'none' : '';
    diffLayer.style.display = diff ? 'block' : 'none';
    legend.style.display = diff ? 'block' : 'none';
    if (mode === 'side') {
      layerA.style.left = '0'; layerA.style.width = `${iw}px`;
      layerB.style.left = `${iw + gap}px`; layerB.style.width = `${iw}px`;
      layerB.style.clipPath = '';
    } else {
      layerA.style.left = layerB.style.left = '0'; layerA.style.width = layerB.style.width = '100%';
      layerB.style.clipPath = `inset(0 0 0 ${(split * 100).toFixed(3)}%)`;
    }
    divider.style.display = mode === 'split' && !single ? '' : 'none';
    divider.style.left = `${(split * 100).toFixed(3)}%`;
    labelB.style.display = single && !diff ? 'none' : '';
    drawOverlay();
  }
  addEventListener('resize', layout);
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      split = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      q.set('split', split.toFixed(3)); layout();
    };
    const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); urlSync(); };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });

  // ---- regions overlay (drag a rectangle with "Add region") -------------------------------------------
  const sceneRegions = () => (NAMED_REGIONS[entry.id] ?? []).filter((r) => !r.aspect || Math.abs(r.aspect - W / H) < 0.01); // W54: 1:1 regions at 1:1 only
  /** A user region named like a scene region overrides its rect (an edited named region keeps its mask and pose). */
  const effective = (): (Region & { user: boolean })[] => {
    const named = sceneRegions().map((r) => { const u = regions.find((x) => x.name === r.name); return { ...r, ...(u ? { rect: u.rect } : {}), user: false }; });
    const own = regions.filter((u) => !named.some((n) => n.name === u.name)).map((u) => ({ ...u, user: true }));
    return [...named, ...own];
  };
  const allRegions = (): Region[] => effective().filter((r) => !hiddenRegions.has(r.name));
  const onPose = (r: Region) => !r.pose || r.pose === pose;
  /** Image-space (0..1) point of a pointer event, in the image half it falls on (side by side: either half). */
  function imagePoint(ev: PointerEvent): [number, number] {
    const r = stage.getBoundingClientRect();
    let x = (ev.clientX - r.left) / r.width;
    if (mode === 'side') { const half = (r.width - 6) / 2 / r.width; x = x > 0.5 ? (x - (half + 6 / r.width)) / half : x / half; }
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
  }
  function drawOverlay(live?: [number, number, number, number]) {
    const r = stage.getBoundingClientRect();
    overlay.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    const halves = mode === 'side' ? [[0, (r.width - 6) / 2], [(r.width + 6) / 2, (r.width - 6) / 2]] : [[0, r.width]];
    const parts: string[] = [];
    const show = (rc: [number, number, number, number], color: string, name: string, dashed: boolean, sel = false) => {
      for (const [x0, w] of halves) {
        const x = x0 + rc[0] * w, y = rc[1] * r.height, rw = rc[2] * w, rh = rc[3] * r.height;
        parts.push(`<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${sel ? 'rgba(255,255,255,0.06)' : 'none'}" stroke="${color}" stroke-width="${sel ? 2.5 : 1.5}" ${dashed && !sel ? 'stroke-dasharray="4 3"' : ''}/>`);
        parts.push(`<text x="${x + 3}" y="${y + 11}" fill="${color}" font-size="11" style="paint-order:stroke;stroke:#000;stroke-width:3px">${name}</text>`);
        if (sel) for (const [hx, hy] of [[x, y], [x + rw, y], [x, y + rh], [x + rw, y + rh]]) parts.push(`<rect x="${hx - 4}" y="${hy - 4}" width="8" height="8" fill="${color}" stroke="#000"/>`);
      }
    };
    if (showRegions || drawing) {
      for (const g of effective()) {
        if (!onPose(g) || hiddenRegions.has(g.name)) continue;
        const own = g.user || regions.some((u) => u.name === g.name);
        show(g.rect, own ? '#ffd166' : '#7fe3ff', g.name, !g.user, drawing && g.name === selected);
      }
    }
    if (live) show(live, '#fff', 'new', false);
    overlay.innerHTML = parts.join('');
    overlay.classList.toggle('drawing', drawing);
  }
  /** Write a region's rect: a user region in place, a named one as a user override of the same name. */
  function setRect(name: string, rect: [number, number, number, number]) {
    const u = regions.find((x) => x.name === name);
    if (u) u.rect = rect; else regions.push({ name, rect });
    q.set('regions', encodeRegions(regions)); urlSync();
  }
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  // Edit mode (the "regions: edit" button): drag on empty image = new region; drag inside one = move it;
  // drag a corner = resize; click = select; Delete / Backspace = delete (yours) or hide (named); Esc = done.
  overlay.addEventListener('pointerdown', (e) => {
    if (!drawing) return;
    try { overlay.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const a = imagePoint(e);
    const sr = stage.getBoundingClientRect();
    const tolX = 8 / (mode === 'side' ? (sr.width - 6) / 2 : sr.width), tolY = 8 / sr.height;
    const visible = effective().filter((g) => onPose(g) && !hiddenRegions.has(g.name));
    // corner hit first (the selected region wins), then inside (smallest first)
    const order = [...visible].sort((x, y) => (x.name === selected ? -1 : y.name === selected ? 1 : x.rect[2] * x.rect[3] - y.rect[2] * y.rect[3]));
    let target: (Region & { user: boolean }) | undefined, corner: [number, number] | null = null;
    for (const g of order) {
      const [x, y, w, h] = g.rect;
      for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
        if (Math.abs(a[0] - (x + cx * w)) <= tolX && Math.abs(a[1] - (y + cy * h)) <= tolY) { target = g; corner = [cx, cy]; break; }
      }
      if (target) break;
    }
    if (!target) target = order.find((g) => a[0] >= g.rect[0] && a[0] <= g.rect[0] + g.rect[2] && a[1] >= g.rect[1] && a[1] <= g.rect[1] + g.rect[3]);
    let up: () => void;
    let move: (ev: PointerEvent) => void;
    if (target) {
      selected = target.name;
      const r0 = [...target.rect] as [number, number, number, number];
      const name = target.name;
      let moved = false;
      move = (ev) => {
        const b = imagePoint(ev); const dx = b[0] - a[0], dy = b[1] - a[1];
        if (!moved && Math.abs(dx) < tolX / 4 && Math.abs(dy) < tolY / 4) return;
        moved = true;
        let rect: [number, number, number, number];
        if (corner) {
          const fx = corner[0] ? r0[0] : r0[0] + r0[2], fy = corner[1] ? r0[1] : r0[1] + r0[3]; // the fixed corner
          const px = clamp01((corner[0] ? r0[0] + r0[2] : r0[0]) + dx), py = clamp01((corner[1] ? r0[1] + r0[3] : r0[1]) + dy);
          rect = [Math.min(fx, px), Math.min(fy, py), Math.abs(px - fx), Math.abs(py - fy)];
        } else {
          rect = [clamp01(Math.min(r0[0] + dx, 1 - r0[2])), clamp01(Math.min(r0[1] + dy, 1 - r0[3])), r0[2], r0[3]];
        }
        if (rect[2] * W >= 2 && rect[3] * H >= 2) { setRect(name, rect); drawOverlay(); }
      };
      up = () => { refreshRegionList(); drawOverlay(); };
    } else {
      let rect: [number, number, number, number] = [a[0], a[1], 0, 0];
      move = (ev) => { const b = imagePoint(ev); rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])]; drawOverlay(rect); };
      up = () => {
        if (rect[2] * W >= 2 && rect[3] * H >= 2) { let n = regions.length + 1; while (effective().some((g) => g.name === `r${n}`)) n++; addRegion(`r${n}`, rect); selected = `r${n}`; }
        else selected = null;
        refreshRegionList(); drawOverlay();
      };
    }
    const done = () => { overlay.removeEventListener('pointermove', move); overlay.removeEventListener('pointerup', done); up(); };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', done);
    refreshRegionList(); drawOverlay();
  });
  window.addEventListener('keydown', (e) => {
    if (!drawing || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'Escape') { setDrawing(false); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      const g = effective().find((x) => x.name === selected);
      if (g?.user) removeRegion(regions.findIndex((x) => x.name === selected)); else if (g) hideRegion(g.name, true);
      selected = null; refreshRegionList(); drawOverlay();
    }
  });
  function addRegion(name: string, rect: [number, number, number, number]) {
    regions.push({ name, rect });
    q.set('regions', encodeRegions(regions)); urlSync();
    refreshRegionList(); drawOverlay();
  }
  function removeRegion(i: number) {
    if (i < 0) return;
    regions.splice(i, 1);
    if (regions.length) q.set('regions', encodeRegions(regions)); else q.delete('regions');
    urlSync(); refreshRegionList(); drawOverlay();
  }
  function hideRegion(name: string, hide: boolean) {
    if (hide) hiddenRegions.add(name); else hiddenRegions.delete(name);
    if (hiddenRegions.size) q.set('hideRegions', [...hiddenRegions].join(',')); else q.delete('hideRegions');
    urlSync(); refreshRegionList(); drawOverlay();
  }
  function renameRegion(from: string, to: string) {
    to = to.trim().replace(/[;:,]/g, '');
    if (!to || to === from || effective().some((g) => g.name === to)) return false;
    const u = regions.find((x) => x.name === from);
    if (!u) return false;
    u.name = to;
    if (selected === from) selected = to;
    q.set('regions', encodeRegions(regions)); urlSync();
    return true;
  }

  // ---- methods -----------------------------------------------------------------------------------------
  const context = (): MethodContext => ({ entry, width: W, height: H, exposure: Number(q.get('exposure') ?? sceneExposure), params: new URLSearchParams(q), defaults: BENCH_DEFAULTS });
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
        m.setExposure(Number(q.get('exposure') ?? sceneExposure));
        return m;
      });
      instances.set(id, p);
      p.catch((e) => { if (String(e?.message) !== 'stale') { instances.delete(id); fail(e); } });
    }
    return p;
  }
  function drop(id: MethodId) {
    const m = live.get(id);
    instances.delete(id); live.delete(id); pending.delete(id);
    if (m) { errors.push(...m.gpuErrors()); m.dispose(); }
  }
  function prune(keep: MethodId[] = []) { for (const id of [...instances.keys()]) if (!sides.includes(id) && !keep.includes(id)) drop(id); }
  async function mountSides() {
    const [a, b] = await Promise.all(sides.map((s) => get(s)));
    layerA.replaceChildren(a.canvas);
    if (snapshot) layerB.replaceChildren(snapshot.canvas); else if (b !== a) layerB.replaceChildren(b.canvas); else layerB.replaceChildren();
    layout();
    return [a, b] as const;
  }
  /**
   * B = a still copy of A as it is now (the setting A/B: snapshot, change a setting, compare live A with
   * the snapshot in the split or the heat map; freeze the camera first). `clearSnapshot()` puts B back.
   */
  function takeSnapshot() {
    const a = live.get(sides[0]);
    if (!a) return null;
    a.present?.();
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    c.getContext('2d')!.drawImage(a.canvas, 0, 0);
    const qs = settingsQuery().replace(/(^|&)(scene|pose)=[^&]*/g, '').replace(/^&/, '');
    snapshot = { canvas: c, label: `${METHOD_SHORT[sides[0]]}${qs ? ' | ' + decodeURIComponent(qs) : ' | defaults'}` };
    layerB.replaceChildren(c);
    snapBtn.classList.add('on'); liveBBtn.disabled = false;
    layout();
    return snapshot.label;
  }
  function clearSnapshot() {
    snapshot = null; snapBtn.classList.remove('on'); liveBBtn.disabled = true;
    mountSides().catch(fail);
  }
  async function setSides(a: MethodId, b: MethodId) {
    sides[0] = a; sides[1] = b;
    sideSel[0].value = a; sideSel[1].value = b;
    for (const i of [0, 1] as const) if (!live.has(sides[i])) setLabel(i, METHOD_SHORT[sides[i]], 'loading...');
    markPreset();
    q.set('left', a); q.set('right', b); urlSync();
    await mountSides();
    prune();
    refreshControls();
  }
  const viewsOf = (m: CompareMethod) => ({ ...m.scene.views, ...(EXTRA_VIEWS[entry.id] ?? {}) });
  function setPose(name: string) {
    const first = live.get(sides[0]) ?? [...live.values()][0];
    if (!first) return;
    const views = viewsOf(first);
    pose = views[name] ? name : Object.keys(views)[0];
    const v = views[pose];
    camera.position.set(...v.pos);
    camera.fov = v.fov ?? first.scene.fov;
    camera.near = first.scene.near; camera.far = first.scene.far;
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    controls.target.set(...v.target);
    controls.update();
    for (const m of live.values()) m.reset();
    poseSel.value = pose;
    q.set('pose', pose); urlSync();
    drawOverlay();
  }
  async function load(id: string) {
    busy = true;
    try {
      for (const k of [...instances.keys()]) drop(k);
      entry = entries.find((e) => e.id === id) ?? entries[0];
      statusEl.textContent = `loading ${entry.title}...`;
      setLabel(0, METHOD_SHORT[sides[0]], 'loading...'); setLabel(1, METHOD_SHORT[sides[1]], 'loading...');
      q.set('scene', entry.id); urlSync();
      const [a] = await mountSides();
      sceneExposure = a.scene.exposure;
      poseSel.replaceChildren(...Object.keys(viewsOf(a)).map((v) => new Option(v, v)));
      const want = q.get('pose');
      setPose(want && viewsOf(a)[want] ? want : Object.keys(viewsOf(a))[0]);
      sceneSel.value = entry.id;
      pagePending = false;
      refreshControls(); refreshRegionList();
    } finally { busy = false; }
  }
  /** Recreate every live method that has a creation-time change pending (and the page for a size change). */
  async function rebuild() {
    if (pagePending) { location.search = q.toString(); return; }
    busy = true;
    try {
      for (const id of [...pending]) drop(id);
      await mountSides();
      for (const m of live.values()) m.reset();
    } finally { busy = false; }
    refreshControls();
  }

  // ---- settings ----------------------------------------------------------------------------------------
  const valueOf = (s: Setting): Value | null => (q.has(s.id) ? decodeValue(s, q.get(s.id)!) : null);
  /** The value shown when the URL has none: the first live method's own reading, else the page / package default. */
  function shownDefault(s: Setting): Value | null {
    for (const id of sides) {
      const m = live.get(id);
      const v = m?.get?.(s.id);
      if (v !== undefined) return decodeValue(s, v);
    }
    if (s.id === 'exposure') return sceneExposure;
    if (s.id === 'size') return `${W}x${H}`;
    return effectiveDefault(s);
  }
  const appliesToId = (s: Setting, id: MethodId) => s.appliesTo !== 'page' && s.appliesTo.includes(id);
  /** Set (or with null clear) one setting: URL, live methods, Rebuild marks. */
  function setSetting(id: string, value: Value | null) {
    const s = settingById.get(id);
    if (!s) throw new Error(`no setting ${id}`);
    if (s.planned) return;
    const str = value === null ? null : encodeValue(s, value);
    if (str === null) q.delete(id); else q.set(id, str);
    urlSync();
    if (s.appliesTo === 'page') {
      if (id === 'scene') { if (str && str !== entry.id) load(str).catch(fail); }
      else if (id === 'pose') setPose(str ?? Object.keys(viewsOf(live.get(sides[0])!))[0]);
      else if (id === 'size') { q.delete('w'); q.delete('h'); pagePending = (str ?? '960x540') !== `${W}x${H}`; }
    } else if (id === 'exposure') {
      for (const m of live.values()) m.setExposure(value === null ? sceneExposure : Number(value));
    } else {
      for (const [mid, m] of live) {
        if (!appliesToId(s, mid)) continue;
        const r = m.set ? m.set(id, str) : 'rebuild';
        if (r === 'rebuild' || (s.apply === 'rebuild' && r !== 'live')) pending.add(mid);
      }
    }
    refreshRow(id); refreshActions();
  }

  // ---- frame -------------------------------------------------------------------------------------------
  function visible(): CompareMethod[] {
    const out: CompareMethod[] = [];
    for (const s of snapshot ? [sides[0]] : sides) { const m = live.get(s); if (m && !out.includes(m)) out.push(m); }
    return out;
  }
  function renderVisible() {
    controls.enabled = !frozen && !drawing;
    controls.update();
    for (const m of visible()) m.frame(camera);
    if (mode === 'diff') renderDiff();
  }
  function labels() {
    if (mode === 'diff') {
      setLabel(0, `|A - B|  ${METHOD_SHORT[sides[0]]} vs ${snapshot ? 'snapshot of A' : METHOD_SHORT[sides[1]]}`, lastDiff ? `mean ${lastDiff.mean.toFixed(2)}, p99 ${lastDiff.p99.toFixed(1)} (8-bit${diffKind === 'luma' ? ' luma' : ''})` : '');
      setLabel(1, '', ''); labelB.style.display = 'none';
      return;
    }
    for (const i of [0, 1] as const) { const m = live.get(sides[i]); setLabel(i, METHOD_SHORT[sides[i]], m ? m.status() : 'loading...'); }
    if (snapshot) setLabel(1, 'snapshot of A', snapshot.label);
  }
  function tick() {
    requestAnimationFrame(tick);
    if (busy) return;
    renderVisible();
    labels();
  }

  // ---- readback, difference --------------------------------------------------------------------------
  const scratch = document.createElement('canvas');
  scratch.width = W; scratch.height = H;
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
  const read = (c: HTMLCanvasElement) => { sctx.clearRect(0, 0, W, H); sctx.drawImage(c, 0, 0); return sctx.getImageData(0, 0, W, H).data; };
  diffCanvas.width = W; diffCanvas.height = H;
  const dctx = diffCanvas.getContext('2d')!;
  const diffImg = dctx.createImageData(W, H);
  let lastDiff: { mean: number; p99: number } | null = null;
  function renderDiff() {
    const [a, b] = sides.map((s) => live.get(s));
    if (!a || (!b && !snapshot)) return;
    a.present?.(); if (!snapshot) b!.present?.();
    const da = new Uint8ClampedArray(read(a.canvas)), db = read(snapshot ? snapshot.canvas : b!.canvas);
    const o = diffImg.data;
    const hist = new Uint32Array(256);
    let sum = 0;
    for (let i = 0, n = W * H; i < n; i++) {
      const k = i * 4;
      let d: number, t: number;
      if (diffKind === 'luma') {
        const la = 0.2126 * da[k] + 0.7152 * da[k + 1] + 0.0722 * da[k + 2], lb = 0.2126 * db[k] + 0.7152 * db[k + 1] + 0.0722 * db[k + 2];
        d = la - lb; t = d / diffScale;
        // signed: A brighter = orange (A's colour), B brighter = blue
        const m = Math.min(1, Math.abs(t));
        if (d >= 0) { o[k] = 255 * m; o[k + 1] = 154 * m; o[k + 2] = 60 * m; } else { o[k] = 79 * m; o[k + 1] = 140 * m; o[k + 2] = 255 * m; }
        d = Math.abs(d);
      } else {
        d = (Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2])) / 3;
        const c = ramp(d / diffScale); o[k] = c[0]; o[k + 1] = c[1]; o[k + 2] = c[2];
      }
      o[k + 3] = 255;
      sum += d; hist[Math.min(255, Math.round(d))]++;
    }
    dctx.putImageData(diffImg, 0, 0);
    let acc = 0, p99 = 0; const lim = W * H * 0.99;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lim) { p99 = v; break; } }
    lastDiff = { mean: sum / (W * H), p99 };
  }
  function refreshLegend() {
    legend.querySelector('.title')!.textContent = diffKind === 'luma' ? 'luma A - B (8-bit): orange A brighter, blue B brighter' : 'mean |A - B| over RGB (8-bit display units)';
    const bar = legend.querySelector<HTMLElement>('.bar')!;
    bar.style.background = diffKind === 'luma' ? 'linear-gradient(90deg, rgb(79,140,255), #000 50%, rgb(255,154,60))'
      : `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(',')})`).join(', ')})`;
    const ticks = diffKind === 'luma' ? [-diffScale, -diffScale / 2, 0, diffScale / 2, diffScale] : [0, diffScale / 4, diffScale / 2, (3 * diffScale) / 4, diffScale];
    legend.querySelector('.ticks')!.innerHTML = ticks.map((t) => `<span>${+t.toFixed(1)}${t === ticks[ticks.length - 1] ? '+' : ''}</span>`).join('');
  }

  // ---- measure -----------------------------------------------------------------------------------------
  interface RegionRow { region: string; px: number; refLuma: number; methods: Record<string, { mad: number; luma: number; frameMad: number }> }
  interface Measure { scene: string; pose: string; size: [number, number]; referenceSamples: number; frames: number; warmup: number; rows: RegionRow[]; settings: string; seconds: number; methods: MethodId[] }
  let lastMeasure: Measure | null = null;
  async function accumulate(pt: CompareMethod, samples: number, onStep?: () => void) {
    pt.setMaxSamples?.(samples);
    const t0 = performance.now();
    while (!(pt.done?.() ?? true) && performance.now() - t0 < 600_000) { pt.frame(camera); onStep?.(); await pt.idle(); await nextFrame(); }
  }
  async function measure(opts: { samples?: number; warmup?: number; frames?: number; methods?: MethodId[] } = {}): Promise<Measure> {
    if (!pathTracerAvailable) throw new Error('Measure needs the path tracer (the sibling Denoiser repo\'s three-gpu-pathtracer)');
    const samples = opts.samples ?? Number(sampIn.value), warmup = opts.warmup ?? Number(warmIn.value), K = opts.frames ?? Number(framesIn.value);
    // the ticked methods, else the shown sides (not the reference)
    const ticked = METHOD_IDS.filter((id) => id !== 'pathtraced' && measureBoxes.get(id)?.checked);
    const methods = (opts.methods ?? (ticked.length ? ticked : [...new Set(sides)].filter((id) => id !== 'pathtraced'))).filter(available);
    if (!methods.length) throw new Error('Measure: pick a method (A or B other than the path tracer, or tick one)');
    const t0 = performance.now();
    busy = true;
    frozen = true; freezeBox.checked = true; controls.enabled = false; q.set('freeze', ''); urlSync();
    const say = (s: string) => { readoutEl.textContent = s; };
    try {
      const pt = await get('pathtraced');
      await accumulate(pt, samples, () => say(`path tracing the reference: ${pt.status()}`));
      pt.present?.();
      const ref = new Uint8ClampedArray(read(pt.canvas));
      const refSamples = pt.samples?.() ?? 0;
      if (!sides.includes('pathtraced')) drop('pathtraced');
      // regions: whole frame, glossy (from our G-buffer), the scene's named ones at this pose, the user's
      const sets: { name: string; px: number[] }[] = [{ name: 'frame', px: Array.from({ length: W * H }, (_, i) => i) }];
      const oursId = (methods.find((id) => id.startsWith('ours') || id === 'probes') ?? null) as MethodId | null;
      if (oursId) {
        const ours = await get(oursId);
        ours.renderMask!(camera);
        const md = read(ours.canvas);
        await ours.idle();
        const mask: number[] = [];
        for (let i = 0; i < W * H; i++) if (md[i * 4] > 127) mask.push(i);
        sets.push({ name: 'glossy', px: mask });
      }
      for (const r of allRegions()) {
        if (r.pose && r.pose !== pose) continue;
        sets.push({ name: r.name, px: regionPixels(r, W, H, ref) });
      }
      const rows: RegionRow[] = sets.map((s) => {
        let l = 0; for (const i of s.px) l += 0.2126 * ref[i * 4] + 0.7152 * ref[i * 4 + 1] + 0.0722 * ref[i * 4 + 2];
        return { region: s.name, px: s.px.length, refLuma: s.px.length ? l / s.px.length : 0, methods: {} };
      });
      for (const id of methods) {
        const m = await get(id);
        m.reset();
        for (let f = 0; f < warmup; f++) { m.frame(camera); await m.idle(); if (f % 8 === 0) { say(`${METHOD_SHORT[id]}: warm-up ${f} / ${warmup}`); await nextFrame(); } }
        const sum = new Float64Array(W * H * 3);
        const frameMad = new Float64Array(sets.length);
        for (let f = 0; f < K; f++) {
          m.frame(camera); m.present?.();
          const d = read(m.canvas);
          await m.idle();
          for (let i = 0, n = W * H; i < n; i++) { sum[i * 3] += d[i * 4]; sum[i * 3 + 1] += d[i * 4 + 1]; sum[i * 3 + 2] += d[i * 4 + 2]; }
          sets.forEach((s, j) => {
            let a = 0; for (const i of s.px) a += (Math.abs(d[i * 4] - ref[i * 4]) + Math.abs(d[i * 4 + 1] - ref[i * 4 + 1]) + Math.abs(d[i * 4 + 2] - ref[i * 4 + 2])) / 3;
            frameMad[j] += s.px.length ? a / s.px.length / K : 0;
          });
          if (f % 8 === 0) { say(`${METHOD_SHORT[id]}: frame ${f} / ${K}`); await nextFrame(); }
        }
        sets.forEach((s, j) => {
          let mad = 0, lum = 0;
          for (const i of s.px) {
            const r = sum[i * 3] / K, g = sum[i * 3 + 1] / K, b = sum[i * 3 + 2] / K;
            mad += (Math.abs(r - ref[i * 4]) + Math.abs(g - ref[i * 4 + 1]) + Math.abs(b - ref[i * 4 + 2])) / 3;
            lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
          }
          const n = s.px.length || 1;
          rows[j].methods[id] = { mad: mad / n, luma: lum / n, frameMad: frameMad[j] };
        });
        if (!sides.includes(id)) drop(id);
        say(table(rows, methods.filter((x) => rows[0].methods[x]), refSamples, K));
      }
      lastMeasure = { scene: entry.id, pose, size: [W, H], referenceSamples: refSamples, frames: K, warmup, rows, settings: settingsQuery(), seconds: (performance.now() - t0) / 1000, methods };
      say(table(rows, methods, refSamples, K));
      return lastMeasure;
    } finally { busy = false; }
  }
  function table(rows: RegionRow[], methods: MethodId[], refSamples: number, K: number) {
    const head = `vs path traced (${refSamples} spp${oidnAvailable ? ', OIDN' : ''}), mean of ${K} frames, 8-bit display\nMAD of the mean / luma (PT luma)\n\n`;
    const col = (s: string, w: number) => s.padStart(w);
    const lines = [`${'region'.padEnd(12)}${col('px', 7)}${col('PT', 6)}${methods.map((m) => col(METHOD_SHORT[m].slice(0, 13), 14)).join('')}`];
    for (const r of rows) {
      lines.push(`${r.region.slice(0, 11).padEnd(12)}${col(String(r.px), 7)}${col(r.refLuma.toFixed(1), 6)}${methods.map((m) => { const v = r.methods[m]; return col(v ? `${v.mad.toFixed(1)} / ${v.luma.toFixed(1)}` : '-', 14); }).join('')}`);
    }
    return head + lines.join('\n') + '\n\nMAD: mean over the region of |mean frame - PT| (RGB)\nluma: the method\'s mean luma there (the PT\'s in column PT)\nregions defined at another pose are skipped';
  }

  // ---- code / presets ------------------------------------------------------------------------------------
  /** The settings part of the URL (no page-only keys). */
  const settingsQuery = () => {
    const out = new URLSearchParams();
    for (const s of SETTINGS) if (q.has(s.id)) out.set(s.id, q.get(s.id)!);
    return out.toString();
  };
  /** The package options for the current values (set ones, plus example choices that differ from the package default). */
  function copyAsCode(): string {
    const val = (id: string): Value | null => {
      const s = settingById.get(id)!;
      const v = valueOf(s);
      if (v !== null) return v;
      if (s.pageDefault !== undefined && s.pageDefault !== s.default) return s.pageDefault;
      const shown = shownDefault(s);
      return shown !== null && shown !== s.default && s.default !== null ? shown : null; // e.g. the scene's thickness
    };
    const lit = (v: Value) => (typeof v === 'string' ? `'${v}'` : String(v));
    const settings: string[] = [], trace: string[] = [], dn: string[] = [], hybrid: string[] = [], after: string[] = [], bake: string[] = [], probes: string[] = [], example: string[] = [];
    for (const s of SETTINGS) {
      if (s.planned || s.appliesTo === 'page') continue;
      const v = val(s.id);
      if (v === null) continue;
      const field = s.id.split('.').pop()!;
      if (s.id.startsWith('s.')) settings.push(`${field}: ${lit(v)}`);
      else if (s.id.startsWith('t.')) trace.push(`${field}: ${lit(v)}`);
      else if (s.id === 'spq') settings.push(`samplesPerQuad: ${v}`);
      else if (s.id === 'reshade') settings.push(`hitShading: ${lit(v)}`);
      else if (s.id === 'lobeFilter') settings.push(`hitLobeFilter: ${v}`);
      else if (s.id === 'rtLobeFilter') trace.push(`hitLobeFilter: ${v}`);
      else if (s.id === 'hit') { settings.push(`hitColor: '${v === 'current' ? 'current' : 'history'}'`); if (v === 'final') after.push('ssr.historySource = lastFrameFinal.texture; // render the final image into it after each frame'); }
      else if (s.id === 'ssr' && v === false) settings.push('maxTraversalIntersections: 0 // SSR off');
      else if (s.id === 'tsf') dn.push(`temporalStabilityFactor: ${v}`);
      else if (s.id.startsWith('dn.')) dn.push(`${field}: ${lit(v)}`);
      else if (s.id === 'h.depthAware') after.push(`hybrid.depthAware.value = ${v};`);
      else if (s.id === 'h.amount') after.push(`composite.amount.value = ${v};`);
      else if (s.id.startsWith('h.')) hybrid.push(`${field}: ${lit(v)}`);
      else if (s.id === 'denoise' && v === false) after.push('hybrid.denoise = false;');
      else if (s.id === 'probeRes') bake.push(`resolution: ${v}`);
      else if (s.id === 'bounces') bake.push(`bounces: ${v}`);
      else if (s.id === 'probeStorage') probes.push(`probes.layout = ${lit(v)};`);
      else if (s.id.startsWith('pr.')) probes.push(`probes.${field} = ${lit(v)};`);
      else if (s.id === 'rt' && v === false) after.push('ssr.rayTracing = false;');
      else if (s.group !== 'three' && s.group !== 'pathtracer') example.push(`${s.id}=${encodeValue(s, v)}`);
    }
    const bvh = val('bvh') ?? 'pmndrs';
    const block = (xs: string[], ind = '    ') => xs.map((x) => `${ind}${x},`).join('\n');
    return [
      `// @pmndrs/reflections options for this bench view (${entry.id}, ${METHOD_SHORT[sides[0]]} | ${METHOD_SHORT[sides[1]]})`,
      `const ssr = new ScreenSpaceReflectionsPass(renderer, {`,
      `  missList: true,`,
      settings.length ? `  settings: {\n${block(settings)}\n  },` : '  // settings: package defaults',
      `});`,
      trace.length ? `Object.assign(ssr.traceSettings, {\n${block(trace, '  ')}\n});` : '',
      `// ray-traced misses (${bvh === 'pmndrs' ? '@pmndrs/bvh' : 'three-mesh-bvh'})`,
      bvh === 'pmndrs'
        ? `const { provider } = await createPmndrsBvhTraceProviderFromObjects(ssr.device, meshes${val('bvhBuilder') && val('bvhBuilder') !== 'auto' ? `, { builder: '${val('bvhBuilder')}' }` : ''});`
        : 'const provider = await MeshBVHTraceProvider.fromObjects(ssr.device, meshes);',
      'ssr.setTraceProvider(provider); ssr.rayTracing = true;',
      `const denoiser = new FfxReflectionDenoiser(ssr.device, {\n${block([...dn.some((x) => x.startsWith('roughnessThreshold')) ? [] : [`roughnessThreshold: ${(Number(val('s.roughnessThreshold') ?? 0.447) ** 2).toFixed(4)} // the tracer's threshold, squared`], ...dn], '  ')}\n});`,
      `const probes = new ReflectionProbes(); /* add ReflectionProbe volumes */`,
      ...probes,
      `probes.bake(renderer, scene${bake.length ? `, { ${bake.join(', ')} }` : ''});`,
      'scene.environmentNode = reflectionProbes(probes);',
      `const hybrid = new HybridReflections(ssr, {\n${block(['probes', 'environment: scene.environment', 'environmentIntensity: scene.environmentIntensity', 'denoiser', ...hybrid], '  ')}\n});`,
      'const composite = hybrid.composite();',
      ...after,
      example.length ? `// examples-side (not package API; see examples/showcase): ${example.join(' ')}` : '',
    ].filter(Boolean).join('\n');
  }

  // ---- UI ----------------------------------------------------------------------------------------------
  const panel = $('#controls');
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...kids: (Node | string)[]) => {
    const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e;
  };
  const h2 = (t: string, parent: HTMLElement = panel) => parent.appendChild(el('h2', { textContent: t }));
  const note = (t: string, parent: HTMLElement = panel) => parent.appendChild(el('div', { className: 'note', textContent: t }));
  const btn = (t: string, on: () => void, parent?: HTMLElement, title = '') => { const b = el('button', { textContent: t, title }); b.onclick = on; parent?.append(b); return b; };

  // A | B pickers and the toolbar
  const methodOpts = METHOD_IDS.map((id) => { const o = new Option(METHOD_LABELS[id] + (available(id) ? '' : ' (unavailable)'), id); o.disabled = !available(id); return o; });
  const sideSel = [0, 1].map((i) => {
    const s = el('select');
    s.append(...methodOpts.map((o) => o.cloneNode(true) as HTMLOptionElement));
    s.value = sides[i];
    s.onchange = () => { (i === 0 ? setSides(s.value as MethodId, sides[1]) : setSides(sides[0], s.value as MethodId)).catch(fail); };
    return s;
  });
  $('#pickA').append(sideSel[0]);
  $('#pickB').append(sideSel[1], el('span', { className: 'badge b', textContent: 'B' }));
  $('#swapBtn').onclick = () => { setSides(sides[1], sides[0]).catch(fail); };
  const toolbar = $('#toolbar');
  const modeSeg = el('span', { className: 'seg' });
  const modeBtns = (['split', 'side', 'diff'] as const).map((m) => btn({ split: 'Split', side: 'Side by side', diff: '|A - B| heat map' }[m], () => setMode(m), modeSeg));
  toolbar.append(modeSeg);
  const scaleIn = el('input', { type: 'range', min: '2', max: '128', step: '1', value: String(diffScale), title: 'Heat-map scale: the 8-bit difference shown at full colour' });
  const scaleVal = el('span', { textContent: String(diffScale) });
  scaleIn.oninput = () => { diffScale = Number(scaleIn.value); scaleVal.textContent = scaleIn.value; q.set('diffScale', scaleIn.value); urlSync(); refreshLegend(); };
  const kindSel = el('select', { title: 'Heat map: mean |A - B| over RGB, or signed luma (A brighter orange, B brighter blue)' });
  kindSel.append(new Option('abs RGB', 'abs'), new Option('signed luma', 'luma'));
  kindSel.value = diffKind;
  kindSel.onchange = () => { diffKind = kindSel.value as 'abs' | 'luma'; q.set('diffKind', diffKind); urlSync(); refreshLegend(); };
  const diffTools = el('span', {}, ' scale ', scaleIn, scaleVal, ' ', kindSel);
  toolbar.append(diffTools);
  const snapBtn = btn('Snapshot A as B', () => { takeSnapshot(); }, toolbar, 'B shows a still copy of A as it is now: change a setting and compare live A with it (split or heat map). Freeze the camera first.');
  const liveBBtn = btn('B live', () => clearSnapshot(), toolbar, 'Back to the B method');
  liveBBtn.disabled = true;
  const regionBtn = btn('edit regions', () => setDrawing(!drawing), toolbar, 'Edit Measure regions on the image: drag on empty image to add one, drag inside one to move it, drag a corner to resize, click to select; Delete removes yours or hides a named one; Esc when done. The list under Measure renames, hides, deletes and resets.');
  const regionsBox = el('input', { type: 'checkbox', checked: true });
  regionsBox.onchange = () => { showRegions = regionsBox.checked; drawOverlay(); };
  toolbar.append(el('label', {}, regionsBox, ' regions'));
  const PAIRS: [MethodId, MethodId, string][] = [
    ['ours-rt', 'pathtraced', 'ours + RT | PT'], ['ours-denoised', 'pathtraced', 'ours | PT'], ['ours-denoised', 'three-denoise', 'ours | three SSR + denoise'],
    ['ours-raw', 'three-raw', 'raw | three raw'], ['three-denoise', 'pathtraced', 'three SSR | PT'],
  ];
  const pairBtns = PAIRS.filter(([a, b]) => available(a) && available(b)).map(([a, b, t]) => ({ a, b, btn: btn(t, () => { setSides(a, b).catch(fail); }, toolbar, `A: ${METHOD_LABELS[a]}\nB: ${METHOD_LABELS[b]}`) }));
  function markPreset() { for (const p of pairBtns) p.btn.classList.toggle('on', p.a === sides[0] && p.b === sides[1]); }
  function setMode(m: Mode) {
    mode = m; q.set('mode', m); urlSync();
    modeBtns.forEach((b, i) => b.classList.toggle('on', ['split', 'side', 'diff'][i] === m));
    diffTools.style.display = m === 'diff' ? '' : 'none';
    refreshLegend(); layout();
  }
  function setDrawing(v: boolean) { drawing = v; if (!v) selected = null; regionBtn.classList.toggle('on', v); regionBtn.textContent = v ? 'done editing' : 'edit regions'; refreshRegionList(); drawOverlay(); }

  // panel: view + actions
  h2('View');
  const sceneSel = el('select'); sceneSel.append(...entries.map((e) => new Option(e.title, e.id)));
  sceneSel.onchange = () => setSetting('scene', sceneSel.value);
  const poseSel = el('select'); poseSel.onchange = () => setSetting('pose', poseSel.value);
  // render size up top (W52, D3643: carConcept's skirt halo is mostly a 960x540 effect); applies on Rebuild (a reload)
  const sizeSel = el('select', { title: 'Each method\'s canvas. W52: the skirt halo is mostly a 960x540 effect (lip 48 vs PT 46 at 1920x1080). Applies on Rebuild (reloads the page).' });
  const sizeChoices = settingById.get('size')!.choices!;
  sizeSel.append(...sizeChoices.map(([v, l]) => new Option(l, v)));
  if (!sizeChoices.some(([v]) => v === `${W}x${H}`)) sizeSel.append(new Option(`${W} x ${H}`, `${W}x${H}`));
  sizeSel.value = `${W}x${H}`;
  sizeSel.onchange = () => setSetting('size', sizeSel.value);
  panel.append(el('label', { className: 'inline' }, 'Scene', sceneSel), el('label', { className: 'inline' }, 'Camera', poseSel), el('label', { className: 'inline' }, 'Render size', sizeSel));
  const freezeBox = el('input', { type: 'checkbox', checked: frozen });
  freezeBox.onchange = () => { frozen = freezeBox.checked; if (frozen) q.set('freeze', ''); else q.delete('freeze'); urlSync(); };
  panel.append(el('label', { className: 'inline' }, el('span', {}, freezeBox, ' Freeze camera (the path tracer converges)')));
  const actions = el('div', { className: 'actions' }); panel.append(actions);
  const rebuildBtn = btn('Rebuild', () => { rebuild().catch(fail); }, actions, 'Recreate the methods whose creation-time settings changed');
  btn('Reset history', () => { for (const m of live.values()) m.reset(); }, actions);
  btn('Reset all', () => resetAll(false), actions, 'Every setting back to the bench\'s default (the package\'s, except the example choices: AA, hit colour, specAA, ...)');
  btn('Package defaults', () => resetAll(true), actions, 'Every setting to the package\'s own default (AA off, hit colour current, specAA off, ...)');
  const codeEl = el('pre', { id: 'code' });
  btn('Copy as code', () => {
    const t = copyAsCode(); codeEl.textContent = t; codeEl.style.display = 'block';
    navigator.clipboard?.writeText(t).catch(() => { /* the text is shown below */ });
  }, actions);
  btn('Copy link', () => { navigator.clipboard?.writeText(location.href).catch(() => {}); }, actions);
  panel.append(codeEl);
  // presets (localStorage; the page works without it)
  const presetSel = el('select'); const presetName = el('input', { type: 'text', placeholder: 'preset name', size: 12 });
  const refreshPresets = () => { const p = storage.read(); presetSel.replaceChildren(new Option('presets...', ''), ...Object.keys(p).map((k) => new Option(k, k))); };
  presetSel.onchange = () => { const p = storage.read()[presetSel.value]; if (p !== undefined) applyQuery(p); };
  const presetRow = el('div', { className: 'actions' }, presetSel, presetName);
  btn('Save', () => { const n = presetName.value.trim() || `preset ${Object.keys(storage.read()).length + 1}`; const p = storage.read(); p[n] = settingsQuery(); if (!storage.write(p)) statusEl.textContent = 'presets: localStorage unavailable'; refreshPresets(); presetSel.value = n; }, presetRow);
  btn('Delete', () => { const p = storage.read(); delete p[presetSel.value]; storage.write(p); refreshPresets(); }, presetRow);
  panel.append(presetRow);
  refreshPresets();

  h2('Measure (vs path traced)');
  const sampIn = el('input', { type: 'number', value: q.get('samples') ?? '64', min: '1' }), warmIn = el('input', { type: 'number', value: q.get('warmup') ?? '48', min: '0' }), framesIn = el('input', { type: 'number', value: q.get('frames') ?? '16', min: '1' });
  panel.append(el('label', { className: 'inline' }, 'Reference samples', sampIn), el('label', { className: 'inline' }, 'Warm-up frames', warmIn), el('label', { className: 'inline' }, 'Measured frames (mean)', framesIn));
  const boxes = el('div', { className: 'actions' }); panel.append(boxes);
  const measureBoxes = new Map<MethodId, HTMLInputElement>();
  for (const id of METHOD_IDS) if (id !== 'pathtraced') {
    const b = el('input', { type: 'checkbox', checked: false, disabled: !available(id) });
    measureBoxes.set(id, b);
    boxes.append(el('label', {}, b, ` ${METHOD_SHORT[id]}`));
  }
  const measureBtn = btn('Measure', () => { measureBtn.disabled = true; measure().catch(fail).finally(() => { measureBtn.disabled = false; }); }, panel);
  measureBtn.disabled = !pathTracerAvailable;
  note('Freezes the camera, path-traces the reference, then runs each ticked method from reset (the shown sides by default) and reads the mean of the measured frames. Regions: whole frame, glossy px, the scene\'s named ones at this pose (carConcept: W50\'s lip / band / wheel / door / car at pose w50; W54\'s hub / wheelFace / cabin / floorWheel at 1:1), and yours. \"edit regions\" on the toolbar adds, moves, resizes and deletes them; the list below hides, renames, deletes and resets.');
  const regionListEl = el('div', { id: 'regionList' }); panel.append(regionListEl);
  const readoutEl = el('pre', { id: 'readout' }); panel.append(readoutEl);
  function refreshRegionList() {
    regionListEl.replaceChildren(...effective().map((g) => {
      const named = !g.user, edited = named && regions.some((u) => u.name === g.name);
      const shown = el('input', { type: 'checkbox', checked: !hiddenRegions.has(g.name), title: 'Shown and measured' });
      shown.onchange = () => hideRegion(g.name, !shown.checked);
      const name = el('input', { value: g.name, size: 10, title: named ? 'A named region (W50 / W54): its name is fixed' : 'Rename' });
      name.disabled = named;
      name.onchange = () => { if (!renameRegion(g.name, name.value)) name.value = g.name; refreshRegionList(); drawOverlay(); };
      const info = el('span', { textContent: `${named ? `named${edited ? ', edited' : ''}${g.pose ? ` @${g.pose}` : ''}` : g.rect.map((v) => v.toFixed(2)).join(' ')}`, title: g.note ?? '' });
      const row = el('div', {}, el('span', {}, shown, ' ', name), info);
      row.style.outline = g.name === selected ? '1px solid #ffd166' : '';
      row.onclick = (e) => { if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'BUTTON') return; selected = g.name; if (!drawing) setDrawing(true); else { refreshRegionList(); drawOverlay(); } };
      if (g.user) btn('delete', () => removeRegion(regions.indexOf(regions.find((u) => u.name === g.name)!)), row, 'Delete this region');
      if (edited) btn('reset', () => removeRegion(regions.findIndex((u) => u.name === g.name)), row, 'Back to the named rect');
      return row;
    }));
  }


  h2('GPU time (visible methods)');
  const timingsEl = el('pre', { id: 'timings' }); panel.append(timingsEl);

  h2('Settings');
  const filter = el('input', { id: 'filter', type: 'search', placeholder: 'filter settings (name, key, trade-off)...' });
  panel.append(filter);
  const rows = new Map<string, { row: HTMLElement; set(v: Value | null): void; s: Setting }>();
  const groupEls = new Map<string, { det: HTMLDetailsElement; count: HTMLElement }>();
  for (const g of GROUPS) {
    const det = el('details', { open: g.id === 'aa' || g.id === 'sssr' }) as HTMLDetailsElement;
    if (g.id === 'aa') det.className = 'aa';
    const count = el('span', { className: 'count' });
    det.append(el('summary', {}, el('span', { textContent: g.title }), count), el('div', { className: 'blurb', textContent: g.blurb }));
    panel.append(det);
    groupEls.set(g.id, { det, count });
    for (const s of SETTINGS.filter((x) => x.group === g.id)) det.append(makeRow(s));
  }
  filter.oninput = () => {
    const f = filter.value.trim().toLowerCase();
    for (const { row, s } of rows.values()) row.style.display = !f || `${s.label} ${s.id} ${s.tradeoff}`.toLowerCase().includes(f) ? '' : 'none';
    if (f) for (const { det } of groupEls.values()) det.open = true;
  };
  function makeRow(s: Setting): HTMLElement {
    const row = el('div', { className: 'row' + (s.planned ? ' planned' : '') });
    row.title = [s.tradeoff, s.cost ? `GPU: ${s.cost}` : '', s.api ? `API: ${s.api}` : '', s.planned ?? ''].filter(Boolean).join('\n\n');
    const fmtV = (v: Value | null) => (v === null ? '-' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));
    const def = el('div', { className: 'def' });
    const defText = () => {
      const pkg = s.default === null ? (s.defaultNote ?? 'none') : fmtV(s.default);
      const page = s.pageDefault !== undefined && s.pageDefault !== s.default ? `, bench ${fmtV(s.pageDefault)}` : '';
      const note2 = s.default !== null && s.defaultNote ? ` (${s.defaultNote})` : '';
      return `default ${pkg}${page}${note2} · ${appliesText(s.appliesTo)}${s.cost ? ' · GPU ' + s.cost : ''}`;
    };
    def.textContent = defText();
    const tags = el('span', { className: 'tags' });
    if (s.apply === 'rebuild') tags.append(el('span', { className: 'tag rb', textContent: 'rebuild' }));
    if (s.planned) tags.append(el('span', { className: 'tag', textContent: 'planned' }));
    const name = el('span', { className: 'name' }, el('span', { textContent: s.label }), tags);
    const ctl = el('span', { className: 'ctl' });
    let setUI: (v: Value | null) => void;
    if (s.type === 'bool') {
      const c = el('input', { type: 'checkbox', disabled: !!s.planned });
      c.onchange = () => setSetting(s.id, c.checked);
      ctl.append(c);
      setUI = (v) => { c.checked = !!v; };
    } else if (s.type === 'select') {
      const c = el('select', { disabled: !!s.planned });
      c.append(...(s.choices ?? []).map(([v, l]) => new Option(l, v)));
      c.onchange = () => setSetting(s.id, c.value);
      ctl.append(c);
      setUI = (v) => { c.value = v === null ? '' : String(v); };
    } else {
      const r = el('input', { type: 'range', min: String(s.min), max: String(s.max), step: String(s.step), disabled: !!s.planned });
      const n = el('input', { type: 'number', min: String(s.min), max: String(s.max), step: String(s.step), disabled: !!s.planned });
      // light settings follow the slider; ones that re-bake, rebuild the denoiser or change materials apply on release
      const heavy = ['specAA', 'floorRoughness', 's.roughnessThreshold', 'tsf'].includes(s.id) || s.id.startsWith('dn.');
      r.oninput = () => { n.value = r.value; if (!heavy) setSetting(s.id, Number(r.value)); };
      r.onchange = () => { if (heavy) setSetting(s.id, Number(r.value)); };
      n.onchange = () => { r.value = n.value; setSetting(s.id, Number(n.value)); };
      ctl.append(r, n);
      setUI = (v) => { r.value = n.value = v === null ? '' : String(v); };
    }
    const reset = el('button', { className: 'reset', textContent: '↺', title: 'Back to the default', disabled: !!s.planned });
    reset.onclick = () => setSetting(s.id, null);
    ctl.append(reset);
    row.append(name, ctl, def);
    rows.set(s.id, { row, s, set: setUI });
    return row;
  }
  function refreshRow(id: string) {
    const r = rows.get(id);
    if (!r) return;
    const v = valueOf(r.s);
    r.row.classList.toggle('mod', v !== null);
    r.set(v ?? shownDefault(r.s));
    if (id === 'scene') sceneSel.value = String(v ?? entry.id);
  }
  function refreshControls() {
    for (const id of rows.keys()) refreshRow(id);
    for (const [g, { count }] of groupEls) { const n = SETTINGS.filter((s) => s.group === g && q.has(s.id)).length; count.textContent = n ? `${n} changed` : ''; }
    refreshActions();
  }
  function refreshActions() {
    const n = [...pending].filter((id) => live.has(id)).length;
    rebuildBtn.textContent = pagePending ? 'Rebuild (reload: size)' : n ? `Rebuild (${n} method${n > 1 ? 's' : ''})` : 'Rebuild';
    rebuildBtn.classList.toggle('warn', pagePending || n > 0);
    for (const [g, { count }] of groupEls) { const k = SETTINGS.filter((s) => s.group === g && q.has(s.id)).length; count.textContent = k ? `${k} changed` : ''; }
  }
  function resetAll(pkg: boolean) {
    for (const s of SETTINGS) {
      if (s.planned || PAGE_KEYS.has(s.id)) continue;
      const target = pkg && s.default !== null && s.pageDefault !== undefined && s.pageDefault !== s.default ? s.default : null;
      if (target === null && !q.has(s.id)) continue;
      setSetting(s.id, target);
    }
    refreshControls();
  }
  /** Apply a saved preset (a settings query string). */
  function applyQuery(qs: string) {
    const p = new URLSearchParams(qs);
    for (const s of SETTINGS) {
      if (s.planned || PAGE_KEYS.has(s.id)) continue;
      const v = p.get(s.id);
      if (v === q.get(s.id)) continue;
      setSetting(s.id, v === null ? null : decodeValue(s, v));
    }
    refreshControls();
  }

  function fail(e: unknown) { console.error(e); statusEl.textContent = String((e as Error)?.stack ?? e); busy = false; }
  setInterval(() => {
    const errs = errors.length + [...live.values()].reduce((a, m) => a + m.gpuErrors().length, 0);
    const lines: string[] = [];
    for (const id of sides) {
      const m = live.get(id); const t = m?.timings?.();
      if (!t || !t.size) continue;
      lines.push(`${METHOD_SHORT[id]}:`);
      for (const [k, v] of t) lines.push(`  ${k.padEnd(26)}${v.toFixed(3).padStart(7)} ms`);
    }
    timingsEl.textContent = lines.length ? lines.join('\n') + '\n(G-buffer and composite not timed; live loop, not a measurement)' : '(no timed method shown: ours methods time their passes when timestamp-query exists)';
    statusEl.textContent = [
      `${entry.title} | ${W}x${H} | three r${THREE.REVISION}`,
      `path tracer: ${pathTracerAvailable ? 'three-gpu-pathtracer (WebGPU)' : 'not found'}; OIDN: ${oidnAvailable ? 'yes' : 'not found'}; FFX: ${denoiserAvailable ? 'yes' : 'not found'}`,
      errs ? `GPU errors: ${errs}` : '',
    ].filter(Boolean).join('\n');
  }, 500);

  // ---- start -------------------------------------------------------------------------------------------
  setMode(mode);
  markPreset();
  await load(entry.id);
  if (!manual) tick();

  Object.assign(window, {
    __p: {
      THREE, camera, controls, entries: () => entries.map((e) => e.id), load, setPose, poses: () => [...poseSel.options].map((o) => o.value),
      view: () => [camera.position.toArray(), controls.target.toArray()],
      setView(pos: [number, number, number], target: [number, number, number]) { camera.position.set(...pos); controls.target.set(...target); controls.update(); for (const m of live.values()) m.reset(); },
      setSides, setMode, snapshot: () => takeSnapshot(), clearSnapshot, setSplit: (x: number) => { split = x; layout(); },
      setDiff(scale: number, kind: 'abs' | 'luma' = 'abs') { diffScale = scale; diffKind = kind; scaleIn.value = String(scale); kindSel.value = kind; refreshLegend(); },
      freeze: (v = true) => { frozen = v; freezeBox.checked = v; },
      reset: () => { for (const m of live.values()) m.reset(); },
      async step(n = 1) { for (let i = 0; i < n; i++) { renderVisible(); await Promise.all(visible().map((m) => m.idle())); } labels(); },
      /** The stage as shown (split / side by side / heat map), as a PNG data URL. */
      async shot() {
        renderVisible();
        const [a, b0] = sides.map((s) => live.get(s)!);
        const b = snapshot ? { canvas: snapshot.canvas } as CompareMethod : b0;
        a.present?.(); if (!snapshot) b.present?.();
        const c = document.createElement('canvas');
        const side = mode === 'side';
        c.width = side ? W * 2 : W; c.height = H;
        const g = c.getContext('2d')!;
        if (mode === 'diff') g.drawImage(diffCanvas, 0, 0);
        else if (side) { g.drawImage(a.canvas, 0, 0); g.drawImage(b.canvas, W, 0); }
        else { g.drawImage(a.canvas, 0, 0); if (b !== a) { const x = Math.round(split * W); g.drawImage(b.canvas, x, 0, W - x, H, x, 0, W - x, H); g.fillStyle = '#fff'; g.fillRect(x, 0, 1, H); } }
        await Promise.all(visible().map((m) => m.idle()));
        return c.toDataURL('image/png');
      },
      settings: () => SETTINGS.map((s) => ({ id: s.id, type: s.type, min: s.min, max: s.max, step: s.step, choices: s.choices?.map(([v]) => v), apply: s.apply, appliesTo: s.appliesTo, planned: !!s.planned, page: s.appliesTo === 'page' })),
      setSetting, getSetting: (id: string) => q.get(id),
      /** Move one control through the DOM (as a user would): a number to `value` (or 37% of its range), a checkbox toggled, a select to its next choice. */
      moveControl(id: string, value?: number | string) {
        const r = rows.get(id);
        if (!r || r.s.planned) return null;
        const s = r.s;
        if (s.type === 'bool') { const c = r.row.querySelector<HTMLInputElement>('input[type=checkbox]')!; c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
        else if (s.type === 'select') {
          const c = r.row.querySelector<HTMLSelectElement>('select')!;
          const i = c.selectedIndex < 0 ? 0 : c.selectedIndex;
          c.value = value !== undefined ? String(value) : c.options[(i + 1) % c.options.length].value; c.dispatchEvent(new Event('change'));
        } else {
          const n = r.row.querySelector<HTMLInputElement>('input[type=number]')!;
          const v = value !== undefined ? Number(value) : Math.round((s.min! + (s.max! - s.min!) * 0.37) / s.step!) * s.step!;
          n.value = String(+v.toFixed(6)); n.dispatchEvent(new Event('change'));
        }
        return q.get(id);
      },
      resetControl(id: string) { rows.get(id)?.row.querySelector<HTMLButtonElement>('button.reset')?.click(); },
      rebuild, pending: () => ({ methods: [...pending], page: pagePending }),
      resetAll, applyQuery, copyAsCode, settingsQuery,
      addRegion, regions: () => allRegions().map((r) => ({ ...r })), regionPixels: (name: string) => { const r = allRegions().find((x) => x.name === name); return r ? regionPixels(r, W, H, null).length : 0; },
      measure, get lastMeasure() { return lastMeasure; },
      get lastDiff() { return lastDiff; },
      timings: () => Object.fromEntries(sides.map((id) => [id, Object.fromEntries(live.get(id)?.timings?.() ?? [])])),
      info: () => ({ scene: entry.id, pose, sides: [...sides], mode, split, frozen, size: [W, H], live: [...live.keys()], status: Object.fromEntries([...live].map(([k, m]) => [k, m.status()])), info: Object.fromEntries([...live].map(([k, m]) => [k, m.info()])) }),
      gpuErrors: () => [...errors, ...[...live.values()].flatMap((m) => m.gpuErrors())],
      presets: { read: storage.read, write: storage.write },
      ready: true,
    },
  });
}

main().catch((e) => { console.error(e); statusEl.textContent = String(e?.stack ?? e); });
