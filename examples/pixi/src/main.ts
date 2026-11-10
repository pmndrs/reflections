// A neon arcade on pixi.js v8 (WebGPURenderer) with @pmndrs/reflections/pixi.
//
// Everything that glows is pixi: the signs are Text, Graphics and sprite-like shapes rendered into
// RenderTextures each frame, the floor tiles and the skyline windows are Graphics drawn once. The
// adapter's 3-D layer (pixi has no G-buffer) lights them as emissive panels and props on a tiled floor;
// core's screen-space tracer runs on pixi's device with a core ProbeSet (one probe + the sky) as the
// fallback; a pixi Filter on the view sprite composites and presents it. The inset is a second
// Sprite of the same texture with its own filter set to a debug view, and the HUD is plain pixi Text.
//
//   per frame (ticker, before pixi renders the stage):
//     pixi -> sign RenderTextures       (Text / Graphics, animated)
//     view.render()                     (shadow map, G-buffer, core SSR + probes fallback, repack)
//     pixi stage render                 (view sprite + ReflectionsFilter, inset + filter, HUD)
import { Application, Container, Graphics, RenderTexture, Sprite, Text, UPDATE_PRIORITY } from 'pixi.js';
import {
  GBufferRenderer, Geometry, PixiProbeSet, REFLECTION_VIEWS, ReflectionCamera, ReflectionMaterial, ReflectionMesh, ReflectionScene,
  ReflectionsFilter, ReflectionsView, getDevice, getGPUTexture, requestReflectionsDevice, type ReflectionViewName,
} from '@pmndrs/reflections/pixi';

const q = new URLSearchParams(location.search);
const manual = q.has('manual');
const status = document.getElementById('status')!;
const controls = document.getElementById('controls')!;
const log = (s: string) => { status.textContent = s; };
if (!navigator.gpu) { log('WebGPU is not available in this browser.'); throw new Error('WebGPU unavailable'); }

// pixi on a device that also has 'subgroups' (the tracer's subgroup variant) and core's limits
const W = 960, H = 540;
const app = new Application();
await app.init({
  preference: 'webgpu', gpu: await requestReflectionsDevice(), width: W, height: H, resolution: 1,
  antialias: false, background: '#000000', autoStart: false,
});
document.getElementById('stage')!.append(app.canvas);
const renderer = app.renderer;
const device = getDevice(renderer);
const gpuErrors: string[] = [];
device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('WebGPU validation:', m); });

// ---- pixi content that becomes surfaces ----------------------------------------------------------
const rt = (width: number, height: number, mips = false) => RenderTexture.create({ width, height, resolution: 1, autoGenerateMipmaps: mips });
const draw = (container: Container, target: RenderTexture, clearColor: [number, number, number, number] = [0, 0, 0, 1]) => {
  renderer.render({ container, target, clear: true, clearColor });
};

// The main sign: pixi Text with a glow and a moving scanline.
const signRT = rt(1024, 512);
const sign = new Container();
const signFrame = new Graphics();
const signTitle = new Text({
  text: 'PixiJS',
  style: { fontFamily: 'Arial Black, Arial, sans-serif', fontSize: 210, fontWeight: '900', fill: '#ff4ff0', letterSpacing: 6, dropShadow: { color: '#ff2fd0', blur: 24, distance: 0, alpha: 1, angle: 0 } },
});
signTitle.anchor.set(0.5);
signTitle.position.set(512, 222);
const signSub = new Text({
  text: 'R E F L E C T I O N S',
  style: { fontFamily: 'Arial, sans-serif', fontSize: 54, fontWeight: '700', fill: '#4ff3ff', dropShadow: { color: '#2fe0ff', blur: 16, distance: 0, alpha: 1, angle: 0 } },
});
signSub.anchor.set(0.5);
signSub.position.set(512, 410);
const scan = new Graphics();
sign.addChild(signFrame, signTitle, signSub, scan);
function drawSign(t: number) {
  signFrame.clear()
    .roundRect(18, 18, 988, 476, 40).stroke({ width: 14, color: 0xff4ff0 })
    .roundRect(42, 42, 940, 428, 28).stroke({ width: 4, color: 0x4ff3ff, alpha: 0.8 });
  const flicker = 0.85 + 0.15 * Math.sin(t * 11) * Math.sin(t * 3.7);
  signTitle.alpha = flicker;
  const y = 60 + ((t * 120) % 400);
  scan.clear().rect(48, y, 928, 10).fill({ color: 0xffffff, alpha: 0.18 });
  draw(sign, signRT);
}

// Left panel: an equaliser, Graphics bars.
const eqRT = rt(512, 640);
const eq = new Graphics();
function drawEq(t: number) {
  eq.clear().roundRect(10, 10, 492, 620, 26).stroke({ width: 10, color: 0x4ff3ff });
  const bars = 9;
  for (let i = 0; i < bars; i++) {
    const level = 0.25 + 0.7 * Math.abs(Math.sin(t * (1.3 + i * 0.37) + i * 1.7));
    const segs = Math.round(level * 14);
    for (let s = 0; s < segs; s++) {
      const k = s / 14;
      const color = ((Math.round(80 + 175 * k) << 16) | (Math.round(240 - 200 * k) << 8) | 255) >>> 0;
      eq.rect(44 + i * 48, 590 - s * 38, 36, 28).fill({ color });
    }
  }
  draw(eq, eqRT);
}

// Right panel: a synthwave sun (horizontal Graphics strips) and spinning stars.
const sunRT = rt(512, 640);
const sunPanel = new Container();
const sunG = new Graphics();
const stars = Array.from({ length: 7 }, (_, i) => {
  const g = new Graphics().star(0, 0, 5, 22 + (i % 3) * 8, 9 + (i % 3) * 3).fill({ color: i % 2 ? 0xfff27a : 0x7af7ff });
  g.position.set(60 + ((i * 131) % 400), 70 + ((i * 89) % 150));
  sunPanel.addChild(g);
  return g;
});
sunPanel.addChildAt(sunG, 0);
function drawSun(t: number) {
  sunG.clear().roundRect(10, 10, 492, 620, 26).stroke({ width: 10, color: 0xffa04f });
  const cx = 256, cy = 380, r = 190;
  for (let y = -r; y < r; y += 4) {
    const lower = y > 0;
    const band = Math.floor((y + t * 30) / 26);
    if (lower && band % 2 === 0 && (y + t * 30) % 26 < 8 + y / 18) continue;
    const half = Math.sqrt(r * r - y * y);
    const k = (y + r) / (2 * r);
    const color = ((255 << 16) | (Math.round(230 - 190 * k) << 8) | Math.round(60 + 140 * k)) >>> 0;
    sunG.rect(cx - half, cy + y, half * 2, 4).fill({ color });
  }
  stars.forEach((s, i) => { s.rotation = t * (0.6 + i * 0.15); s.alpha = 0.6 + 0.4 * Math.sin(t * 2 + i); });
  draw(sunPanel, sunRT);
}

// Floor tiles: base colour and a glTF-style roughness map (g = roughness), drawn once, mipmapped.
const tileRT = rt(1024, 1024, true);
const roughRT = rt(1024, 1024, true);
{
  const n = 4, s = 1024 / n, grout = 10;
  const base = new Graphics().rect(0, 0, 1024, 1024).fill({ color: 0x0b0a10 });
  const rough = new Graphics().rect(0, 0, 1024, 1024).fill({ color: 0x008c00 }); // grout: roughness 0.55
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = 0x1a + ((x * 7 + y * 13) % 5) * 3;
    base.rect(x * s + grout / 2, y * s + grout / 2, s - grout, s - grout).fill({ color: (v << 16) | ((v - 4) << 8) | (v + 10) });
    rough.rect(x * s + grout / 2, y * s + grout / 2, s - grout, s - grout).fill({ color: ((x + y) % 2 ? 0x001400 : 0x000a00) }); // 0.08 / 0.04
  }
  draw(base, tileRT);
  draw(rough, roughRT);
  tileRT.source.updateMipmaps();
  roughRT.source.updateMipmaps();
}

// Skyline windows (Graphics), one texture for every building face.
const windowsRT = rt(256, 512, true);
{
  const g = new Graphics().rect(0, 0, 256, 512).fill({ color: 0x000000 });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 16; y < 500; y += 22) for (let x = 14; x < 240; x += 26) {
    const p = rnd();
    if (p < 0.55) continue;
    g.rect(x, y, 14, 12).fill({ color: p > 0.85 ? 0x6ff6ff : p > 0.7 ? 0xffd27a : 0xff7ae6, alpha: 0.5 + 0.5 * rnd() });
  }
  draw(g, windowsRT);
  windowsRT.source.updateMipmaps();
}

// ---- the 3-D layer -------------------------------------------------------------------------------
const scene = new ReflectionScene();
scene.sun = { direction: [-0.45, 0.62, 0.65], color: [1.5, 1.2, 1.6], shadow: { center: [0, 0, -2], radius: 8, size: 2048 } };
scene.ambient = { sky: [0.06, 0.045, 0.11], ground: [0.02, 0.012, 0.025] };
scene.sky = { zenith: [0.006, 0.005, 0.03], horizon: [0.4, 0.07, 0.22], ground: [0.015, 0.01, 0.02], sunDisc: [0, 0, 0], sunSize: 0.02 };

const yAxis = (a: number): [number, number, number] => [0, a, 0];
const mesh = (geometry: Geometry, material: ReflectionMaterial, position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) => {
  const m = new ReflectionMesh(geometry, material);
  m.position = position;
  m.rotation = rotation;
  scene.add(m);
  return m;
};

const floor = mesh(Geometry.plane(30, 30), new ReflectionMaterial({ map: tileRT, roughnessMap: roughRT, roughness: 1, uvScale: [7.5, 7.5] }), [0, 0, 0], [-Math.PI / 2, 0, 0]);
floor.castShadow = false;
const darkMetal = new ReflectionMaterial({ color: [0.03, 0.03, 0.035], metalness: 1, roughness: 0.35 });
const panel = (map: RenderTexture, w: number, h: number, position: [number, number, number], yaw: number, intensity: number) => {
  const n: [number, number, number] = [Math.sin(yaw), 0, Math.cos(yaw)];
  mesh(Geometry.plane(w, h), new ReflectionMaterial({ color: [0, 0, 0], roughness: 0.3, emissive: [1, 1, 1], emissiveMap: map, emissiveIntensity: intensity }), position, yAxis(yaw));
  mesh(Geometry.box(w + 0.16, h + 0.16, 0.1), darkMetal, [position[0] - n[0] * 0.06, position[1], position[2] - n[2] * 0.06], yAxis(yaw));
  const bottom = position[1] - h / 2 - 0.08;
  for (const side of [-1, 1]) {
    const off = side * (w / 2 - 0.25);
    const post = mesh(Geometry.cylinder(0.05, bottom, 16), darkMetal, [position[0] + Math.cos(yaw) * off - n[0] * 0.06, bottom / 2, position[2] - Math.sin(yaw) * off - n[2] * 0.06]);
    post.castShadow = true;
  }
};
panel(signRT, 4.4, 2.2, [0, 1.62, -4.3], 0, 3.2);
panel(eqRT, 1.6, 2.0, [-3.5, 1.25, -3.0], 0.55, 2.6);
panel(sunRT, 1.6, 2.0, [3.5, 1.25, -3.0], -0.55, 2.6);

mesh(Geometry.sphere(0.55), new ReflectionMaterial({ color: [0.95, 0.95, 0.97], metalness: 1, roughness: 0.03 }), [-1.35, 0.55, -1.3]);
const torus = mesh(Geometry.torus(0.42, 0.14), new ReflectionMaterial({ color: [1, 0.72, 0.3], metalness: 1, roughness: 0.22 }), [1.45, 0.82, -1.1]);
mesh(Geometry.box(0.8, 0.2, 0.8), new ReflectionMaterial({ color: [0.7, 0.7, 0.75], roughness: 0.55 }), [1.45, 0.1, -1.1]);
mesh(Geometry.box(0.6, 0.6, 0.6), new ReflectionMaterial({ color: [0.75, 0.05, 0.12], roughness: 0.3 }), [-2.7, 0.3, 0.3], yAxis(0.5));
const windowsMat = new ReflectionMaterial({ color: [0.012, 0.012, 0.02], roughness: 0.6, emissive: [1, 1, 1], emissiveMap: windowsRT, emissiveIntensity: 1.6 });
for (const [x, z, w, h] of [[-9, -14, 3, 7], [-5, -16, 3.5, 10], [-1, -18, 4, 6], [4, -15, 3, 9], [8.5, -13, 3.2, 6.5], [12, -17, 4, 11]]) {
  const b = mesh(Geometry.box(w, h, 3), windowsMat, [x, h / 2, z]);
  b.castShadow = false;
}

const camera = new ReflectionCamera();
camera.fov = 50;
camera.near = 0.05;
camera.far = 120;
const orbit = { yaw: 0, pitch: 0.1, radius: 6.9, target: [0, 1.15, -2.2] as [number, number, number] };
const placeCamera = () => {
  const { yaw, pitch, radius, target } = orbit;
  camera.target = [...target];
  camera.position = [target[0] + Math.sin(yaw) * Math.cos(pitch) * radius, target[1] + Math.sin(pitch) * radius + 0.1, target[2] + Math.cos(yaw) * Math.cos(pitch) * radius];
};
placeCamera();

// ---- reflections -----------------------------------------------------------------------------------
log('baking probes...');
const probes = new PixiProbeSet(renderer, { capacity: 1, sourceSize: 128 });
probes.setProbes([{ position: [0, 1.2, -1.6], influenceSize: [30, 10, 30], fade: 2 }]);
const t0 = performance.now();
for (const t of [0]) { drawSign(t); drawEq(t); drawSun(t); }
await probes.bake(scene);
const bakeMs = performance.now() - t0;
probes.enabled = q.get('probes') !== '0';

const variant = q.get('variant') === 'workgroup' ? 'workgroup' : 'auto';
const view = new ReflectionsView({
  renderer, scene, camera, width: W, height: H, probes, variant, timestamps: true,
  composite: { view: (q.get('view') as ReflectionViewName) ?? 'final', exposure: 1.25 },
});
view.ssrEnabled = q.get('ssr') !== '0';
app.stage.addChild(view);

// Debug inset: the same texture on a second sprite with its own composite filter.
const insetScale = 0.26;
const inset = new Sprite(view.texture);
inset.scale.set(insetScale);
inset.position.set(W - W * insetScale - 14, H - H * insetScale - 14);
const insetFilter = new ReflectionsFilter(view.filterSources(), { view: 'confidence' });
inset.filters = [insetFilter];
const insetBorder = new Graphics().roundRect(inset.x - 3, inset.y - 3, W * insetScale + 6, H * insetScale + 6, 6).stroke({ width: 2, color: 0x4ff3ff, alpha: 0.9 });
const insetLabel = new Text({ text: 'confidence', style: { fontFamily: 'monospace', fontSize: 12, fill: '#4ff3ff' } });
insetLabel.position.set(inset.x, inset.y - 18);
const hud = new Text({ text: '', style: { fontFamily: 'Arial, sans-serif', fontSize: 15, fill: '#f4e9ff', fontWeight: '600', dropShadow: { color: '#000000', blur: 4, distance: 1, alpha: 0.8, angle: Math.PI / 4 } } });
hud.position.set(16, 12);
app.stage.addChild(insetBorder, inset, insetLabel, hud);

// ---- loop, input, UI ---------------------------------------------------------------------------------
let time = 0, frames = 0, animate = !manual, dragging = false;
function update(dt: number) {
  if (animate) {
    time += dt;
    if (!dragging) orbit.yaw = Math.sin(time * 0.15) * 0.55;
  }
  torus.rotation = [time * 0.9, time * 0.6, 0];
  placeCamera();
  drawSign(time); drawEq(time); drawSun(time);
  // the signs animate: refresh the probe every 20 frames (one capture + prefilter, queued, not awaited)
  if (animate && frames % 20 === 19) void probes.bake(scene);
  view.render();
  hud.text = `@pmndrs/reflections × pixi.js ${renderer.name ?? ''}  ·  SSR ${view.ssrEnabled ? 'on' : 'off'}  ·  probes ${probes.enabled ? 'on' : 'off'}  ·  ${view.debugView}`;
  frames++;
}
const frame = () => { update(1 / 60); app.render(); };
app.ticker.add((ticker) => update(Math.min(ticker.deltaMS, 50) / 1000), undefined, UPDATE_PRIORITY.HIGH);
const startLoop = () => { animate = true; app.start(); };
const stopLoop = () => { animate = false; app.stop(); };

app.canvas.addEventListener('pointerdown', (e) => { dragging = true; app.canvas.setPointerCapture(e.pointerId); });
app.canvas.addEventListener('pointerup', () => { dragging = false; });
app.canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbit.yaw -= e.movementX * 0.005;
  orbit.pitch = Math.max(-0.05, Math.min(0.9, orbit.pitch + e.movementY * 0.004));
  if (!app.ticker.started) frame();
});

const row = (label: string, el: HTMLElement) => { const l = document.createElement('label'); l.append(el, label); controls.append(l); };
const box = (label: string, on: boolean, change: (on: boolean) => void) => {
  const b = document.createElement('input'); b.type = 'checkbox'; b.checked = on;
  b.onchange = () => { change(b.checked); if (!app.ticker.started) frame(); };
  row(label, b);
  return b;
};
const ssrBox = box('SSR', view.ssrEnabled, (on) => { view.ssrEnabled = on; });
const probesBox = box('Probes', probes.enabled, (on) => { probes.enabled = on; });
box('Animate', !manual, (on) => (on ? startLoop() : stopLoop()));
const select = (label: string, value: string, change: (v: ReflectionViewName) => void) => {
  const s = document.createElement('select');
  for (const v of REFLECTION_VIEWS) s.append(new Option(v, v));
  s.value = value;
  s.onchange = () => { change(s.value as ReflectionViewName); if (!app.ticker.started) frame(); };
  row(label, s);
  return s;
};
const viewSel = select('View', view.debugView, (v) => { view.debugView = v; });
select('Inset', insetFilter.view, (v) => { insetFilter.view = v; insetLabel.text = v; });

function refreshUI() {
  status.textContent = [
    `pixi.js WebGPURenderer | ${view.pixelWidth}x${view.pixelHeight} | ${manual ? 'manual (loop stopped)' : 'running'} | probe bake ${bakeMs.toFixed(0)} ms`,
    `tracer variant ${view.ssr.variant} | SSR ${view.ssrEnabled ? 'on' : 'off (probes / environment only)'} | probes ${probes.enabled ? 'on (1 probe + sky)' : 'off (sky only)'}`,
    `view ${view.debugView} | frames ${frames} | GPU errors ${gpuErrors.length}`,
  ].join('\n');
}
setInterval(refreshUI, 500);
if (manual) frame(); else startLoop();
refreshUI();

// ---- headless hooks ------------------------------------------------------------------------------------
const idle = () => device.queue.onSubmittedWorkDone();
function f16(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
/** Reads a 2-D r32float / rgba16float texture as floats (1 or 4 channels per texel). */
async function readTexture(tex: GPUTexture): Promise<{ data: Float32Array; channels: number }> {
  const bpp = tex.format === 'r32float' ? 4 : 8;
  const channels = tex.format === 'r32float' ? 1 : 4;
  const bytesPerRow = Math.ceil((tex.width * bpp) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [tex.width, tex.height]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = buf.getMappedRange();
  const out = new Float32Array(tex.width * tex.height * channels);
  for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) {
    const i = (y * tex.width + x) * channels, o = y * bytesPerRow + x * bpp;
    if (channels === 1) out[i] = new Float32Array(raw, o, 1)[0];
    else { const h = new Uint16Array(raw, o, 4); for (let c = 0; c < 4; c++) out[i + c] = f16(h[c]); }
  }
  buf.unmap();
  buf.destroy();
  return { data: out, channels };
}

/** Last frame: rays, finite outputs, confidence on the glossy floor tiles and the mirror sphere. */
async function stats() {
  frame();
  await idle();
  const core = view.ssr.core!;
  const counter = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(core.outputs.rayCounter, 0, counter, 0, 16);
  device.queue.submit([enc.finish()]);
  await counter.mapAsync(GPUMapMode.READ);
  const rays = new Uint32Array(counter.getMappedRange().slice(0))[1];
  counter.destroy();
  const refl = await readTexture(getGPUTexture(renderer, view.ssr.reflection));
  const nr = await readTexture(view.targets.normal.gpu);
  const mo = await readTexture(view.targets.motion.gpu);
  let nonFinite = 0, glossy = 0, glossyConfident = 0, geometryPx = 0, confSum = 0, floorPx = 0;
  const n = nr.data.length / 4;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 4; c++) if (!Number.isFinite(refl.data[i * 4 + c])) nonFinite++;
    if (mo.data[i * 4 + 3] < 0.5) continue;
    geometryPx++;
    const conf = refl.data[i * 4 + 3];
    confSum += conf;
    const rough = nr.data[i * 4 + 3];
    if (nr.data[i * 4 + 1] > 0.9) floorPx++;
    if (rough < 0.1 && nr.data[i * 4 + 1] > 0.9) { glossy++; if (conf >= 0.9) glossyConfident++; }
  }
  return {
    variant: view.ssr.variant, rays, nonFinite, gpuErrors: gpuErrors.length, geometryPx, floorPx,
    glossyFloor: glossy, glossyConfident: glossy ? glossyConfident / glossy : 0, meanConfidence: geometryPx ? confSum / geometryPx : 0,
  };
}

/**
 * Do the adapter's cube captures sample as world directions under a plain `texture_cube` lookup
 * (what core's ProbeSet does)? A test scene puts an emissive box on each axis and a white marker
 * off-centre on each face; the capture is sampled toward each axis (face colour), toward each marker
 * (white) and toward the marker mirrored in either face axis (face colour, not white).
 */
async function orientation() {
  const s = new ReflectionScene();
  s.sun = { direction: [0, 1, 0], color: [0, 0, 0], shadow: null };
  s.ambient = { sky: [0, 0, 0], ground: [0, 0, 0] };
  s.sky = { zenith: [0, 0, 0], horizon: [0, 0, 0], ground: [0, 0, 0], sunDisc: [0, 0, 0], sunSize: 0.01 };
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
  const perp = (a: number[]) => (a[0] ? [[0, 1, 0], [0, 0, 1]] : a[1] ? [[0, 0, 1], [1, 0, 0]] : [[1, 0, 0], [0, 1, 0]]);
  const emissive = (c: number[]) => new ReflectionMaterial({ color: [0, 0, 0], emissive: c as [number, number, number] });
  const dirs: number[][] = [], expect: number[][] = [];
  axes.forEach((a, i) => {
    const wall = new ReflectionMesh(Geometry.box(12, 12, 12), emissive(colors[i]));
    wall.position = [a[0] * 12, a[1] * 12, a[2] * 12];
    const [u, v] = perp(a);
    const mk = new ReflectionMesh(Geometry.box(1, 1, 1), emissive([1, 1, 1]));
    const at = (su: number, sv: number) => [4 * a[0] + 1.5 * (su * u[0] + sv * v[0]), 4 * a[1] + 1.5 * (su * u[1] + sv * v[1]), 4 * a[2] + 1.5 * (su * u[2] + sv * v[2])];
    mk.position = at(1, 1) as [number, number, number];
    s.add(wall, mk);
    dirs.push(a, at(1, 1), at(-1, 1), at(1, -1));
    expect.push(colors[i], [1, 1, 1], colors[i], colors[i]);
  });
  const g = new GBufferRenderer(renderer);
  const cube = device.createTexture({ size: [64, 64, 6], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const depth = device.createTexture({ size: [64, 64], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const capEnc = device.createCommandEncoder();
  g.capture(capEnc, s, [0, 0, 0], cube, depth);
  device.queue.submit([capEnc.finish()]);
  const module = device.createShaderModule({ code: /* wgsl */ `
    @group(0) @binding(0) var cube: texture_cube<f32>;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var<storage, read> dirs: array<vec4f>;
    @group(0) @binding(3) var<storage, read_write> out: array<vec4f>;
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
      out[id.x] = textureSampleLevel(cube, samp, normalize(dirs[id.x].xyz), 0.0);
    }` });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const dirBuf = device.createBuffer({ size: dirs.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(dirBuf, 0, new Float32Array(dirs.flatMap((d) => [d[0], d[1], d[2], 0])));
  const outBuf = device.createBuffer({ size: dirs.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: dirs.length * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  const p = enc.beginComputePass();
  p.setPipeline(pipe);
  p.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: cube.createView({ dimension: 'cube' }) },
    { binding: 1, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
    { binding: 2, resource: { buffer: dirBuf } }, { binding: 3, resource: { buffer: outBuf } }] }));
  p.dispatchWorkgroups(dirs.length);
  p.end();
  enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, dirs.length * 16);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const got = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)));
  readBuf.unmap();
  const rows = dirs.map((d, i) => {
    const gc = got.slice(i * 4, i * 4 + 3).map((x) => Math.round(Math.min(1, x)));
    return { dir: d, expect: expect[i], got: gc, ok: gc.every((x, c) => x === expect[i][c]) };
  });
  g.dispose(); cube.destroy(); depth.destroy();
  return { ok: rows.every((r) => r.ok), failed: rows.filter((r) => !r.ok).length, rows };
}

/**
 * Motion-vector convention check (frame.ts: motionVectorScale [1, 1]): render, move the camera and
 * the torus, render again, and reproject this frame's scene colour into the last one through the
 * motion texture under each candidate scale. [1, 1] must give the smallest error, well below none.
 */
async function motionCheck() {
  stopLoop();
  const saved = { ...orbit, target: [...orbit.target] as [number, number, number] }, savedTime = time;
  frame();
  await idle();
  const a = await readTexture(view.targets.color.gpu);
  orbit.yaw += 0.04; orbit.pitch += 0.02; time += 0.05;
  frame();
  await idle();
  const b = await readTexture(view.targets.color.gpu);
  const m = await readTexture(view.targets.motion.gpu);
  const w = view.pixelWidth, h = view.pixelHeight;
  const scales: [number, number][] = [[1, 1], [-1, -1], [1, -1], [-1, 1], [0, 0]];
  const err = scales.map(() => 0);
  let n = 0;
  for (let y = 4; y < h - 4; y += 3) for (let x = 4; x < w - 4; x += 3) {
    const i = y * w + x;
    if (m.data[i * 4 + 3] < 0.5) continue;
    const mx = m.data[i * 4], my = m.data[i * 4 + 1];
    if (Math.abs(mx) + Math.abs(my) < 1e-4) continue;
    const res = scales.map(([sx, sy]) => {
      const px = Math.floor(((x + 0.5) / w - mx * sx) * w), py = Math.floor(((y + 0.5) / h - my * sy) * h);
      if (px < 0 || py < 0 || px >= w || py >= h) return null;
      const j = py * w + px;
      let e = 0;
      for (let c = 0; c < 3; c++) e += Math.abs(Math.min(b.data[i * 4 + c], 4) - Math.min(a.data[j * 4 + c], 4));
      return e;
    });
    if (res.some((r) => r === null)) continue;
    res.forEach((r, k) => { err[k] += r!; });
    n++;
  }
  Object.assign(orbit, saved);
  time = savedTime;
  view.resetHistory();
  frame();
  await idle();
  const rows = scales.map((sc, k) => ({ scale: sc.join(','), meanError: n ? err[k] / n : NaN }));
  const best = rows.reduce((p, r) => (r.meanError < p.meanError ? r : p));
  return { pixels: n, best: best.scale, rows };
}

Object.assign(window, {
  __p: {
    app, renderer, scene, view, probes, camera, orbit, gpuErrors, views: REFLECTION_VIEWS,
    stop: stopLoop, start: startLoop,
    async step(k = 1) { for (let i = 0; i < k; i++) frame(); await idle(); },
    setView(v: ReflectionViewName) { view.debugView = v; viewSel.value = v; },
    setSSR(on: boolean) { view.ssrEnabled = on; ssrBox.checked = on; },
    setProbes(on: boolean) { probes.enabled = on; probesBox.checked = on; },
    async shot() { frame(); const url = (app.canvas as HTMLCanvasElement).toDataURL('image/png'); await idle(); return url; },
    /** Median GPU ms per core pass over `k` frames (loop stopped). */
    async time(k = 30) {
      stopLoop();
      const per: Record<string, number[]> = {};
      for (let i = 0; i < k + 3; i++) {
        frame();
        await idle();
        const t = await view.ssr.readTimings();
        if (i >= 3) for (const [key, v] of t) (per[key] ??= []).push(v);
      }
      const med = (arr: number[]) => { const s = [...arr].sort((x, y) => x - y); return s[s.length >> 1]; };
      return Object.fromEntries(Object.entries(per).map(([key, v]) => [key, Number(med(v).toFixed(4))]));
    },
    stats, orientation, motionCheck,
  },
});
