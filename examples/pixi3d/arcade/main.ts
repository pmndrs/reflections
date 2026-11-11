// A neon arcade built with pixi-3d (`@pixi/3d`, closed beta) and @pmndrs/reflections/pixi.
//
// Everything that glows is pixi: the signs are Text and Graphics containers shown through pixi-3d
// ContainerTextures (re-rendered each frame) as the emissive maps of 3-D planes; the skyline windows
// are Graphics captured once.
// pixi-3d draws the scene (its PBR, a sun with shadows, the hemisphere sky), DepthOutputPass and
// MotionVectorPass hand over depth and motion, ReflectionsGBufferPass (../shared/reflections.ts) the
// normals and material values pixi-3d has no output for. The adapter unpacks them into the frame
// contract, core's tracer reflects, a pixi Filter on a Sprite composites. The probe is captured by
// six pixi-3d cameras; the environment slot is the view's Hemisphere.
//
//   per frame (ticker, before pixi renders the stage):
//     pixi -> sign ContainerTextures          (Text / Graphics, animated)
//     pixi-3d -> reflections.colorTarget      (scene colour, depth, motion, G-buffer)
//     reflections.render(...)                 (unpack, core SSR + probes fallback, repack)
//     pixi stage render                       (view sprite + ReflectionsFilter, inset + filter, HUD)
import {
  ContainerTexture, CubeGeometry, CylinderGeometry, DepthOutputPass, DirectionalLight, Material3D, MotionVectorPass, Mesh3D, PlaneGeometry, SphereGeometry, TorusGeometry, View3D,
  writeHemisphere, type Geometry3D, type Hemisphere, type Material3DOptions,
} from '@pixi/3d';
import { Application, Container, Graphics, RenderTexture, Sprite, Text, UPDATE_PRIORITY, type WebGPURenderer } from 'pixi.js';
import {
  PixiProbeSet, REFLECTION_VIEWS, ReflectionsFilter, ReflectionsView, getDevice, getGPUTexture, requestReflectionsDevice, type ReflectionViewName,
} from '@pmndrs/reflections/pixi';
import { createReflectionDenoiser, denoiserAvailable } from '../../shared/denoiser';
import { ProbeCapture, ReflectionsGBufferPass, reflectiveMaterial } from '../shared/reflections';

// Not top-level await: pixi-3d's renderer hook imports its backend chunk during app.init(), and in a
// production build that chunk imports back from this entry; awaiting at module level deadlocks them.
async function main() {
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
  const renderer = app.renderer as WebGPURenderer;
  const device = getDevice(renderer);
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('WebGPU validation:', m); });

  // ---- pixi content that becomes surfaces --------------------------------------------------------
  // pixi-3d's ContainerTexture: a live 2-D container as a texture, stored upright for 3-D UVs
  const live = (container: Container, width: number, height: number) => new ContainerTexture({ container, width, height, resolution: 1, renderer, firstRender: false });

  // The main sign: pixi Text with a glow and a moving scanline.
  const sign = new Container();
  const signRT = live(sign, 1024, 512);
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
    signTitle.alpha = 0.85 + 0.15 * Math.sin(t * 11) * Math.sin(t * 3.7);
    const y = 60 + ((t * 120) % 400);
    scan.clear().rect(48, y, 928, 10).fill({ color: 0xffffff, alpha: 0.18 });
    signRT.render();
  }

  // Left panel: an equaliser, Graphics bars.
  const eq = new Graphics();
  const eqRT = live(eq, 512, 640);
  function drawEq(t: number) {
    eq.clear().roundRect(10, 10, 492, 620, 26).stroke({ width: 10, color: 0x4ff3ff });
    for (let i = 0; i < 9; i++) {
      const segs = Math.round((0.25 + 0.7 * Math.abs(Math.sin(t * (1.3 + i * 0.37) + i * 1.7))) * 14);
      for (let s = 0; s < segs; s++) {
        const k = s / 14;
        eq.rect(44 + i * 48, 590 - s * 38, 36, 28).fill({ color: ((Math.round(80 + 175 * k) << 16) | (Math.round(240 - 200 * k) << 8) | 255) >>> 0 });
      }
    }
    eqRT.render();
  }

  // Right panel: a synthwave sun (horizontal Graphics strips) and spinning stars.
  const sunPanel = new Container();
  const sunRT = live(sunPanel, 512, 640);
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
      const band = Math.floor((y + t * 30) / 26);
      if (y > 0 && band % 2 === 0 && (y + t * 30) % 26 < 8 + y / 18) continue;
      const half = Math.sqrt(r * r - y * y);
      const k = (y + r) / (2 * r);
      sunG.rect(cx - half, cy + y, half * 2, 4).fill({ color: ((255 << 16) | (Math.round(230 - 190 * k) << 8) | Math.round(60 + 140 * k)) >>> 0 });
    }
    stars.forEach((s, i) => { s.rotation = t * (0.6 + i * 0.15); s.alpha = 0.6 + 0.4 * Math.sin(t * 2 + i); });
    sunRT.render();
  }

  // Skyline windows (Graphics), one texture for every building face.
  const windowsG = new Graphics().rect(0, 0, 256, 512).fill({ color: 0x000000 });
  {
    const g = windowsG;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 16; y < 500; y += 22) for (let x = 14; x < 240; x += 26) {
      const p = rnd();
      if (p < 0.55) continue;
      g.rect(x, y, 14, 12).fill({ color: p > 0.85 ? 0x6ff6ff : p > 0.7 ? 0xffd27a : 0xff7ae6, alpha: 0.5 + 0.5 * rnd() });
    }
  }
  const windowsRT = live(windowsG, 256, 512);
  windowsRT.render();

  // ---- the pixi-3d scene ---------------------------------------------------------------------------
  const sky: Hemisphere = { skyColor: 0x2a1450, groundColor: 0x0a0610, intensity: 0.6 };
  const depthPass = new DepthOutputPass();
  const motionPass = new MotionVectorPass();
  const gbufferPass = new ReflectionsGBufferPass();
  // linear HDR out (the composite tone-maps), the frame's passes on
  const view3d = new View3D({ environment: sky, background: sky, toneMapping: 'custom', passes: [depthPass, motionPass, gbufferPass] });
  view3d.setSize(W, H);
  const camera = view3d.camera;
  camera.fov = 50;
  camera.near = 0.05;
  camera.far = 120;

  const sun = new DirectionalLight({ color: 0xffd6f4, intensity: 1.4, castShadow: true });
  sun.position.set(-4.5, 6.2, 6.5);
  sun.lookAt({ x: 0, y: 0, z: -2 });
  view3d.root.addChild(sun);

  const mesh = (geometry: Geometry3D, material: Material3DOptions, position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) => {
    const m = new Mesh3D({ geometry, material: reflectiveMaterial(material) });
    m.position.set(...position);
    m.rotation.set(...rotation);
    view3d.root.addChild(m);
    return m;
  };

  // the glossy floor: dark, near-mirror lacquer
  mesh(new PlaneGeometry({ width: 30, height: 30 }), { baseColor: 0x15121c, roughness: 0.06, metallic: 0 }, [0, 0, 0], [-Math.PI / 2, 0, 0]);
  const darkMetal: Material3DOptions = { baseColor: 0x08080a, metallic: 1, roughness: 0.35 };
  const panel = (map: ContainerTexture, w: number, h: number, position: [number, number, number], yaw: number, strength: number) => {
    const n = [Math.sin(yaw), 0, Math.cos(yaw)];
    mesh(new PlaneGeometry({ width: w, height: h }), { baseColor: 0x000000, roughness: 0.3, emissive: { color: 0xffffff, texture: map, strength } }, position, [0, yaw, 0]);
    mesh(new CubeGeometry({ width: w + 0.16, height: h + 0.16, depth: 0.1 }), darkMetal, [position[0] - n[0] * 0.06, position[1], position[2] - n[2] * 0.06], [0, yaw, 0]);
    const bottom = position[1] - h / 2 - 0.08;
    for (const side of [-1, 1]) {
      const off = side * (w / 2 - 0.25);
      mesh(new CylinderGeometry({ radiusTop: 0.05, radiusBottom: 0.05, height: bottom }), darkMetal,
        [position[0] + Math.cos(yaw) * off - n[0] * 0.06, bottom / 2, position[2] - Math.sin(yaw) * off - n[2] * 0.06]);
    }
  };
  panel(signRT, 4.4, 2.2, [0, 1.62, -4.3], 0, 3.2);
  panel(eqRT, 1.6, 2.0, [-3.5, 1.25, -3.0], 0.55, 2.6);
  panel(sunRT, 1.6, 2.0, [3.5, 1.25, -3.0], -0.55, 2.6);

  mesh(new SphereGeometry({ radius: 0.55, widthSegments: 48, heightSegments: 32 }), { baseColor: 0xf2f2f7, metallic: 1, roughness: 0.02 }, [-1.35, 0.55, -1.3]);
  const torus = mesh(new TorusGeometry({ radius: 0.42, tube: 0.14, radialSegments: 24, tubularSegments: 64 }), { baseColor: 0xffb84d, metallic: 1, roughness: 0.22 }, [1.45, 0.82, -1.1]);
  mesh(new CubeGeometry({ width: 0.8, height: 0.2, depth: 0.8 }), { baseColor: 0xb3b3bf, roughness: 0.55 }, [1.45, 0.1, -1.1]);
  mesh(new CubeGeometry({ width: 0.6, height: 0.6, depth: 0.6 }), { baseColor: 0xbf0d1f, roughness: 0.3 }, [-2.7, 0.3, 0.3], [0, 0.5, 0]);
  const windows: Material3DOptions = { baseColor: 0x030305, roughness: 0.6, emissive: { color: 0xffffff, texture: windowsRT, strength: 1.6 } };
  for (const [x, z, w, h] of [[-9, -14, 3, 7], [-5, -16, 3.5, 10], [-1, -18, 4, 6], [4, -15, 3, 9], [8.5, -13, 3.2, 6.5], [12, -17, 4, 11]]) {
    mesh(new CubeGeometry({ width: w, height: h, depth: 3 }), windows, [x, h / 2, z]);
  }

  const orbit = { yaw: 0, pitch: 0.1, radius: 6.9, target: [0, 1.15, -2.2] as [number, number, number] };
  const placeCamera = () => {
    const { yaw, pitch, radius, target } = orbit;
    camera.position.set(target[0] + Math.sin(yaw) * Math.cos(pitch) * radius, target[1] + Math.sin(pitch) * radius + 0.1, target[2] + Math.cos(yaw) * Math.cos(pitch) * radius);
    camera.lookAt({ x: target[0], y: target[1], z: target[2] });
  };
  placeCamera();

  // ---- reflections -----------------------------------------------------------------------------------
  log('capturing the probe...');
  const probes = new PixiProbeSet(renderer, { capacity: 1, sourceSize: 128 });
  const probePosition: [number, number, number] = [0, 1.2, -1.6];
  probes.setProbes([{ position: probePosition, influenceSize: [30, 10, 30], fade: 2 }]);
  const skyLinear = { sky: new Float32Array(3), ground: new Float32Array(3), up: new Float32Array(3) };
  writeHemisphere(sky, skyLinear.sky, skyLinear.ground, skyLinear.up);
  probes.captureHemisphere(skyLinear);
  // the probe sees the sky behind the geometry (W33, D2104); ?probeSky=0 keeps the black-sky capture
  const capture = new ProbeCapture(view3d, probes.faceSize, { background: q.get('probeSky') !== '0' });
  for (const t of [0]) { drawSign(t); drawEq(t); drawSun(t); }
  const t0 = performance.now();
  capture.capture(renderer, probes, 0, probePosition);
  await device.queue.onSubmittedWorkDone();
  const bakeMs = performance.now() - t0;
  probes.enabled = q.get('probes') !== '0';

  const variant = q.get('variant') === 'workgroup' ? 'workgroup' : 'auto';
  // the FFX reflection denoiser through core's denoise seam, when the sibling Denoiser repo is there
  const denoiser = denoiserAvailable ? createReflectionDenoiser(device) : null;
  const view = new ReflectionsView({
    renderer, width: W, height: H, resolution: 1, probes, variant, timestamps: true, denoiser,
    composite: { view: (q.get('view') as ReflectionViewName) ?? 'final', exposure: 1.25 },
  });
  view3d.setSize(view.pixelWidth, view.pixelHeight);
  view.ssrEnabled = q.get('ssr') !== '0';
  view.ssr.denoise = q.get('denoise') !== '0';
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

  // ---- loop, input, UI -------------------------------------------------------------------------------
  let time = 0, frames = 0, animate = !manual, dragging = false;
  function render3d() {
    renderer.render({ container: view3d, target: view.colorTarget });
    view.render({ depth: depthPass.texture, motion: motionPass.texture, gbuffer: gbufferPass.texture }, camera);
  }
  function update(dt: number) {
    if (animate) {
      time += dt;
      if (!dragging) orbit.yaw = Math.sin(time * 0.15) * 0.55;
    }
    torus.rotation.set(time * 0.9, time * 0.6, 0);
    placeCamera();
    drawSign(time); drawEq(time); drawSun(time);
    render3d();
    hud.text = `@pmndrs/reflections × pixi-3d  ·  SSR ${view.ssrEnabled ? 'on' : 'off'}  ·  probes ${probes.enabled ? 'on' : 'off'}  ·  denoise ${view.ssr.denoising ? 'on' : 'off'}  ·  ${view.debugView}`;
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
  const denoiseBox = box(denoiser ? 'Denoise (FFX)' : 'Denoise (no denoiser found)', view.ssr.denoising, (on) => { view.ssr.denoise = on; });
  denoiseBox.disabled = !denoiser;
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
      `pixi-3d on pixi.js WebGPURenderer | ${view.pixelWidth}x${view.pixelHeight} | ${manual ? 'manual (loop stopped)' : 'running'} | probe capture ${bakeMs.toFixed(0)} ms`,
      `tracer variant ${view.ssr.variant} | SSR ${view.ssrEnabled ? 'on' : 'off (probes / environment only)'} | probes ${probes.enabled ? 'on (1 probe + sky)' : 'off (sky only)'}`,
      `denoise ${denoiser ? (view.ssr.denoising ? `on (${denoiser.name})` : 'off') : 'unavailable (no sibling Denoiser repo)'} | view ${view.debugView} | frames ${frames} | GPU errors ${gpuErrors.length}`,
    ].join('\n');
  }
  setInterval(refreshUI, 500);
  if (manual) frame(); else startLoop();
  refreshUI();

  // ---- headless hooks ----------------------------------------------------------------------------------
  const idle = () => device.queue.onSubmittedWorkDone();
  function f16(h: number) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * 2 ** (e - 15);
  }
  /** Reads a 2-D (or 2-D array: every layer, in order) r32float / rgba16float / rgba32float / rgba8unorm texture as floats. */
  async function readTexture(tex: GPUTexture): Promise<{ data: Float32Array; channels: number }> {
    const fmt = tex.format;
    const channels = fmt === 'r32float' ? 1 : 4;
    const bpp = fmt === 'r32float' ? 4 : fmt === 'rgba32float' ? 16 : fmt === 'rgba8unorm' ? 4 : 8;
    const bytesPerRow = Math.ceil((tex.width * bpp) / 256) * 256;
    const rows = tex.height * tex.depthOrArrayLayers;
    const buf = device.createBuffer({ size: bytesPerRow * rows, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow, rowsPerImage: tex.height }, [tex.width, tex.height, tex.depthOrArrayLayers]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const raw = buf.getMappedRange();
    const out = new Float32Array(tex.width * rows * channels);
    for (let y = 0; y < rows; y++) for (let x = 0; x < tex.width; x++) {
      const i = (y * tex.width + x) * channels, o = y * bytesPerRow + x * bpp;
      if (fmt === 'r32float') out[i] = new Float32Array(raw, o, 1)[0];
      else if (fmt === 'rgba32float') out.set(new Float32Array(raw, o, 4), i);
      else if (fmt === 'rgba8unorm') { const b = new Uint8Array(raw, o, 4); for (let c = 0; c < 4; c++) out[i + c] = b[c] / 255; }
      else { const h = new Uint16Array(raw, o, 4); for (let c = 0; c < 4; c++) out[i + c] = f16(h[c]); }
    }
    buf.unmap();
    buf.destroy();
    return { data: out, channels };
  }

  /** Last frame: rays, finite outputs, confidence on the glossy floor and the material values the G-buffer carries. */
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
    const mat = await readTexture(view.targets.material.gpu);
    const mo = await readTexture(view.targets.motion.gpu);
    let nonFinite = 0, glossy = 0, glossyConfident = 0, geometryPx = 0, confSum = 0, floorPx = 0, mirrorPx = 0, goldPx = 0;
    const n = nr.data.length / 4;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) if (!Number.isFinite(refl.data[i * 4 + c])) nonFinite++;
      if (mo.data[i * 4 + 3] < 0.5) continue;
      geometryPx++;
      const conf = refl.data[i * 4 + 3];
      confSum += conf;
      const rough = nr.data[i * 4 + 3], metal = mat.data[i * 4 + 3];
      if (nr.data[i * 4 + 1] > 0.9) floorPx++;
      if (rough < 0.1 && nr.data[i * 4 + 1] > 0.9) { glossy++; if (conf >= 0.9) glossyConfident++; }
      if (metal > 0.99 && rough < 0.04) mirrorPx++;
      // the gold torus: metal, roughness 0.22, albedo r > g > b
      if (metal > 0.99 && Math.abs(rough - 0.22) < 0.01 && mat.data[i * 4] > mat.data[i * 4 + 1] && mat.data[i * 4 + 1] > mat.data[i * 4 + 2]) goldPx++;
    }
    return {
      variant: view.ssr.variant, rays, nonFinite, gpuErrors: gpuErrors.length, geometryPx, floorPx, mirrorPx, goldPx,
      glossyFloor: glossy, glossyConfident: glossy ? glossyConfident / glossy : 0, meanConfidence: geometryPx ? confSum / geometryPx : 0,
    };
  }

  /**
   * Is the frame contract's camera the one pixi-3d rasterised with? For geometry pixels, the world
   * position from the unpacked depth through the contract's inverse view-projection is re-projected
   * with pixi-3d's own `camera.viewProjection` (GL clip) and must land on the same pixel; and the
   * G-buffer normal must agree with the normal of the reconstructed surface (depth derivatives).
   */
  async function cameraCheck() {
    stopLoop();
    frame();
    await idle();
    const d = await readTexture(view.targets.depth.gpu);
    const nr = await readTexture(view.targets.normal.gpu);
    const f = view.lastFrame!;
    const w = view.pixelWidth, h = view.pixelHeight;
    const mul = (m: ArrayLike<number>, p: number[]) => [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);
    const { mat4Invert } = await import('@pmndrs/reflections/pixi');
    const { mat4Multiply } = await import('@pmndrs/reflections/core');
    const inv = mat4Invert(mat4Multiply(f.camera.projectionJittered ?? f.camera.projection, f.camera.view));
    const vpGL = camera.viewProjection.elements;
    const world = (x: number, y: number) => {
      const z = d.data[y * w + x];
      const p = mul(inv, [((x + 0.5) / w) * 2 - 1, 1 - ((y + 0.5) / h) * 2, z, 1]);
      return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
    };
    let n = 0, pxErr = 0, normalDot = 0, normalN = 0;
    for (let y = 8; y < h - 8; y += 7) for (let x = 8; x < w - 8; x += 7) {
      const z = d.data[y * w + x];
      if (z >= 1) continue;
      const p = world(x, y);
      const c = mul(vpGL, [...p, 1]);
      const px = ((c[0] / c[3]) * 0.5 + 0.5) * w - 0.5, py = (0.5 - (c[1] / c[3]) * 0.5) * h - 0.5;
      pxErr += Math.hypot(px - x, py - y);
      n++;
      // surface normal from neighbours, where the depth is smooth
      const zx = d.data[y * w + x + 1], zy = d.data[(y + 1) * w + x];
      if (zx >= 1 || zy >= 1 || Math.abs(zx - z) > 2e-4 || Math.abs(zy - z) > 2e-4) continue;
      const a = world(x + 1, y), b = world(x, y + 1);
      const e1 = [a[0] - p[0], a[1] - p[1], a[2] - p[2]], e2 = [b[0] - p[0], b[1] - p[1], b[2] - p[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(...cr);
      if (len < 1e-9) continue;
      const i = (y * w + x) * 4;
      // e1 runs +x (right), e2 +y (down): e1 x e2 points away from the camera, so the surface normal is -cr
      normalDot += -(cr[0] * nr.data[i] + cr[1] * nr.data[i + 1] + cr[2] * nr.data[i + 2]) / len;
      normalN++;
    }
    return { pixels: n, meanPixelError: n ? pxErr / n : NaN, normals: normalN, meanNormalDot: normalN ? normalDot / normalN : NaN };
  }

  /**
   * Do the probe captures sample as world directions under a plain `texture_cube` lookup (what core's
   * ProbeSet does)? A test view puts an emissive box on each axis and a white marker off-centre on
   * each face; the capture (six pixi-3d cameras through ProbeCapture, stacked by
   * PixiProbeSet.captureFaces) is sampled toward each axis (face colour), toward each marker (white)
   * and toward the marker mirrored in either face axis (face colour, not white).
   */
  async function orientation() {
    const test = new View3D({ environment: null, background: null, toneMapping: 'custom' });
    const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
    const hex = (c: number[]) => (c[0] * 255 << 16) | (c[1] * 255 << 8) | (c[2] * 255);
    const perp = (a: number[]) => (a[0] ? [[0, 1, 0], [0, 0, 1]] : a[1] ? [[0, 0, 1], [1, 0, 0]] : [[1, 0, 0], [0, 1, 0]]);
    const emissive = (c: number[]) => reflectiveMaterial({ baseColor: 0x000000, emissive: { color: hex(c), strength: 1 } });
    const dirs: number[][] = [], expect: number[][] = [];
    axes.forEach((a, i) => {
      const wall = new Mesh3D({ geometry: new CubeGeometry({ width: 12, height: 12, depth: 12 }), material: emissive(colors[i]) });
      wall.position.set(a[0] * 12, a[1] * 12, a[2] * 12);
      const [u, v] = perp(a);
      const at = (su: number, sv: number) => [4 * a[0] + 1.5 * (su * u[0] + sv * v[0]), 4 * a[1] + 1.5 * (su * u[1] + sv * v[1]), 4 * a[2] + 1.5 * (su * u[2] + sv * v[2])];
      const mk = new Mesh3D({ geometry: new CubeGeometry({ width: 1, height: 1, depth: 1 }), material: emissive([1, 1, 1]) });
      mk.position.set(...(at(1, 1) as [number, number, number]));
      test.root.addChild(wall, mk);
      dirs.push(a, at(1, 1), at(-1, 1), at(1, -1));
      expect.push(colors[i], [1, 1, 1], colors[i], colors[i]);
    });
    const testProbes = new PixiProbeSet(renderer, { capacity: 1, sourceSize: 64, environment: false });
    const cap = new ProbeCapture(test, 64);
    cap.capture(renderer, testProbes, 0, [0, 0, 0]);
    const cube = testProbes.captureTexture;
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
    device.queue.writeBuffer(dirBuf, 0, new Float32Array(dirs.flatMap((dd) => [dd[0], dd[1], dd[2], 0])));
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
    const rows = dirs.map((dd, i) => {
      const gc = got.slice(i * 4, i * 4 + 3).map((x) => Math.round(Math.min(1, x)));
      return { dir: dd, expect: expect[i], got: gc, ok: gc.every((x, c) => x === expect[i][c]) };
    });
    cap.destroy();
    testProbes.dispose();
    test.destroy({ children: true });
    return { ok: rows.every((r) => r.ok), failed: rows.filter((r) => !r.ok).length, rows };
  }

  /**
   * Do local probes see the sky (D2104, W33)? (1) A view with the arcade's Hemisphere as its
   * background and nothing visible in it, captured by ProbeCapture, must equal the environment slot's
   * sky (captureHemisphere) texel for texel: same colours, same up. (The view holds one sub-texel
   * speck: a pixi-3d view with no mesh at all draws nothing into its pass cameras, sky included.) (2) The arcade's probe captured without the sky (faces
   * cleared to black) and with it: the sky texels are the ones that differ; how many are black in
   * each. (3) The composite (the canvas, 0-255) with the black-sky probe vs the sky probe, after
   * `frames` frames from a reset history each, with and without SSR; an A / A pair (sky twice) gives
   * the floor. Restores the page's own setting at the end.
   */
  async function probeSkyCheck(frames = 12) {
    stopLoop();
    // (1)
    const test = new View3D({ environment: sky, background: sky, toneMapping: 'custom' });
    const speck = new Mesh3D({ geometry: new CubeGeometry({ width: 0.001, height: 0.001, depth: 0.001 }), material: reflectiveMaterial({ baseColor: 0x000000 }) });
    speck.position.set(0, -50, 0);
    test.root.addChild(speck);
    const testProbes = new PixiProbeSet(renderer, { capacity: 1, sourceSize: 64 });
    testProbes.captureHemisphere(skyLinear);
    const hemi = await readTexture(testProbes.captureTexture);
    const cap = new ProbeCapture(test, 64);
    cap.capture(renderer, testProbes, 0, [0, 0, 0]);
    const drawn = await readTexture(testProbes.captureTexture);
    let skyMax = 0, skySum = 0, skyRef = 0;
    for (let i = 0; i < hemi.data.length; i += 4) for (let c = 0; c < 3; c++) {
      const e = Math.abs(drawn.data[i + c] - hemi.data[i + c]);
      skyMax = Math.max(skyMax, e); skySum += e; skyRef = Math.max(skyRef, hemi.data[i + c]);
    }
    cap.destroy();
    testProbes.dispose();
    test.destroy({ children: true });

    // (2)
    const initial = capture.background;
    const recapture = async (bg: boolean) => {
      capture.background = bg;
      capture.capture(renderer, probes, 0, probePosition);
      await idle();
      return (await readTexture(probes.captureTexture)).data;
    };
    const black = await recapture(false), lit = await recapture(true);
    const texels = black.length / 4;
    const isBlack = (d: Float32Array, i: number) => Math.max(d[i], d[i + 1], d[i + 2]) <= 1e-6;
    let skyTexels = 0, blackBefore = 0, blackAfter = 0, skyBlackBefore = 0, skyBlackAfter = 0;
    for (let i = 0; i < black.length; i += 4) {
      const isSky = Math.abs(lit[i] - black[i]) + Math.abs(lit[i + 1] - black[i + 1]) + Math.abs(lit[i + 2] - black[i + 2]) > 0;
      if (isSky) skyTexels++;
      if (isBlack(black, i)) { blackBefore++; if (isSky) skyBlackBefore++; }
      if (isBlack(lit, i)) { blackAfter++; if (isSky) skyBlackAfter++; }
    }

    // (3)
    const pixels = async () => {
      const url = (app.canvas as HTMLCanvasElement).toDataURL('image/png');
      const img = new Image();
      img.src = url;
      await img.decode();
      const c2 = document.createElement('canvas');
      c2.width = img.width; c2.height = img.height;
      const g = c2.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height).data;
    };
    const render = async (bg: boolean | null) => {
      if (bg !== null) await recapture(bg);
      view.resetHistory();
      for (let i = 0; i < frames - 1; i++) frame();
      await idle();
      frame();
      const px = await pixels();
      await idle();
      return px;
    };
    // glossy geometry (roughness < 0.25) of the 3-D view, outside the inset
    const nr = await readTexture(view.targets.normal.gpu);
    const mo = await readTexture(view.targets.motion.gpu);
    const w = view.pixelWidth, h = view.pixelHeight;
    const inInset = (x: number, y: number) => x >= inset.x - 4 && y >= inset.y - 22 && x < inset.x + W * insetScale + 4 && y < inset.y + H * insetScale + 4;
    const glossy: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mo.data[i * 4 + 3] >= 0.5 && nr.data[i * 4 + 3] < 0.25 && !inInset(x, y) && y > 40) glossy.push(i);
    }
    const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      const d = glossy.map((i) => Math.max(Math.abs(a[i * 4] - b[i * 4]), Math.abs(a[i * 4 + 1] - b[i * 4 + 1]), Math.abs(a[i * 4 + 2] - b[i * 4 + 2])));
      const changed = d.filter((x) => x >= 2);
      const sorted = [...d].sort((x, y) => x - y), cs = [...changed].sort((x, y) => x - y);
      const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
      const p99 = (v: number[]) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.99))] : 0);
      return { glossyPx: d.length, mean: mean(d), p99: p99(sorted), max: sorted[sorted.length - 1] ?? 0, changedPx: changed.length, changedMean: mean(changed), changedP99: p99(cs) };
    };
    const ssrWas = view.ssrEnabled;
    const composite: Record<string, ReturnType<typeof diff>> = {};
    for (const ssr of [true, false]) {
      view.ssrEnabled = ssr;
      const a = await render(false), b = await render(true), c = await render(null);
      composite[ssr ? 'ssr' : 'ssrOff'] = diff(a, b);
      composite[ssr ? 'ssrAA' : 'ssrOffAA'] = diff(b, c);
    }
    view.ssrEnabled = ssrWas;
    await recapture(initial);
    view.resetHistory();
    frame();
    await idle();
    return {
      sky: { texels: hemi.data.length / 4, maxError: skyMax, meanError: skySum / (hemi.data.length * 0.75), maxValue: skyRef },
      probe: { texels, skyTexels, blackBefore, blackAfter, skyBlackBefore, skyBlackAfter },
      composite, frames,
    };
  }

  /**
   * Does REFLECTIONS_SCENE_COLOR_BIT take the environment's specular out (D2102)? Two white metal
   * planes (roughness 0.1, no lights, a white hemisphere: all they show is the environment's
   * specular) face the camera, the left with the bit, the right without. The left must
   * keep only a sliver of the right (the multiple-scattering term the bit leaves in).
   */
  async function sceneColorCheck() {
    const white: Hemisphere = { skyColor: 0xffffff, groundColor: 0xffffff };
    const test = new View3D({ environment: white, background: null, toneMapping: 'custom' });
    test.setSize(64, 32);
    const opts: Material3DOptions = { baseColor: 0xffffff, roughness: 0.1, metallic: 1 };
    const geometry = new PlaneGeometry({ width: 1, height: 1 });
    const left = new Mesh3D({ geometry, material: reflectiveMaterial(opts) });
    const right = new Mesh3D({ geometry, material: new Material3D(opts) });
    left.position.set(-0.55, 0, 0);
    right.position.set(0.55, 0, 0);
    test.root.addChild(left, right);
    test.camera.fov = 60;
    test.camera.position.set(0, 0, 1.2);
    test.camera.lookAt({ x: 0, y: 0, z: 0 });
    const target = RenderTexture.create({ width: 64, height: 32, resolution: 1, format: 'rgba16float', antialias: false });
    renderer.render({ container: test, target, clearColor: [0, 0, 0, 0] });
    await idle();
    const px = await readTexture(getGPUTexture(renderer, target));
    const at = (x: number) => px.data[(16 * 64 + x) * 4 + 1];
    const result = { withBit: at(16), without: at(48) };
    target.destroy(true);
    test.destroy({ children: true });
    return result;
  }

  /**
   * Motion-vector convention check (frame.ts: pixi-3d's NDC motion unpacked to uv, motionVectorScale
   * [1, 1]): render, move the camera and the torus, render again, and reproject this frame's scene
   * colour into the last one through the motion texture under each candidate scale. [1, 1] must give
   * the smallest error, well below none.
   */
  async function motionCheck() {
    stopLoop();
    const saved = { ...orbit, target: [...orbit.target] as [number, number, number] }, savedTime = time;
    frame();
    await idle();
    const colorGpu = getGPUTexture(renderer, view.colorTarget);
    const a = await readTexture(colorGpu);
    orbit.yaw += 0.04; orbit.pitch += 0.02; time += 0.05;
    frame();
    await idle();
    const b = await readTexture(colorGpu);
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
    const best = rows.reduce((pp, r) => (r.meanError < pp.meanError ? r : pp));
    return { pixels: n, best: best.scale, rows };
  }

  Object.assign(window, {
    __p: {
      app, renderer, view3d, view, probes, camera, orbit, gpuErrors, views: REFLECTION_VIEWS, depthPass, motionPass, gbufferPass,
      stop: stopLoop, start: startLoop,
      async step(k = 1) { for (let i = 0; i < k; i++) frame(); await idle(); },
      setView(v: ReflectionViewName) { view.debugView = v; viewSel.value = v; },
      setSSR(on: boolean) { view.ssrEnabled = on; ssrBox.checked = on; },
      setProbes(on: boolean) { probes.enabled = on; probesBox.checked = on; },
      setDenoise(on: boolean) { view.ssr.denoise = on; denoiseBox.checked = view.ssr.denoising; },
      get denoiserName() { return denoiser?.name ?? null; },
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
      stats, orientation, motionCheck, cameraCheck, sceneColorCheck, probeSkyCheck,
    },
  });
}

void main();
