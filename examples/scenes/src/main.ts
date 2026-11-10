// examples/scenes: the scene kit (examples/shared) viewed through the frame-contract G-buffer.
//
// Each frame: FrameGBuffer renders the scene once with MRT, then a fullscreen pass shows one target
// (or all of them in a grid). `window.__p` drives the page headlessly: load a scene, step a frame,
// read every target back from the GPU (stats per channel), take a screenshot.
import * as THREE from 'three/webgpu';
import { float, perspectiveDepthToViewZ, renderOutput, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FrameGBuffer, getDevice } from '@pmndrs/reflections/three';
import { ASSET_SCENES, SCENES, availableAssets, type KitScene } from '../../shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 960), H = Number(q.get('h') ?? 540);
const manual = q.has('manual');

const VIEWS = ['lit', 'sceneColor', 'depth', 'normal', 'roughness', 'metalness', 'albedo', 'motion', 'grid'] as const;
type View = (typeof VIEWS)[number];
const GRID: View[] = ['lit', 'sceneColor', 'depth', 'normal', 'roughness', 'metalness', 'albedo', 'motion'];

// ---- GPU readback (for the headless check) -----------------------------------------------------
function halfToFloat(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
const FORMAT_INFO: Record<string, { bytes: number; channels: number; read: (dv: DataView, o: number, c: number) => number }> = {
  rgba16float: { bytes: 8, channels: 4, read: (dv, o, c) => halfToFloat(dv.getUint16(o + c * 2, true)) },
  rg16float: { bytes: 4, channels: 2, read: (dv, o, c) => halfToFloat(dv.getUint16(o + c * 2, true)) },
  rgba8unorm: { bytes: 4, channels: 4, read: (dv, o, c) => dv.getUint8(o + c) / 255 },
  depth32float: { bytes: 4, channels: 1, read: (dv, o) => dv.getFloat32(o, true) },
};
async function readTexture(device: GPUDevice, tex: GPUTexture) {
  const info = FORMAT_INFO[tex.format];
  if (!info) throw new Error(`readback: unsupported format ${tex.format}`);
  const bpr = Math.ceil((tex.width * info.bytes) / 256) * 256;
  const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, aspect: tex.format.startsWith('depth') ? 'depth-only' : 'all' }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const dv = new DataView(buf.getMappedRange());
  const out = new Float32Array(tex.width * tex.height * info.channels);
  for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) for (let c = 0; c < info.channels; c++) {
    out[(y * tex.width + x) * info.channels + c] = info.read(dv, y * bpr + x * info.bytes, c);
  }
  buf.unmap(); buf.destroy();
  return { data: out, channels: info.channels, width: tex.width, height: tex.height, format: tex.format };
}

async function main() {
  const status = document.querySelector<HTMLElement>('#status')!;
  const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
  if (!navigator.gpu) { status.textContent = 'WebGPU is not available in this browser.'; return; }

  // ask for room for the optional `lit` target (36 bytes/sample); FrameGBuffer drops it if refused
  const adapter = await navigator.gpu.requestAdapter();
  const maxBytes = Math.min(adapter?.limits.maxColorAttachmentBytesPerSample ?? 32, 64);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: { maxColorAttachmentBytesPerSample: maxBytes } } as N);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  const device = getDevice(renderer);
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('[webgpu uncapturederror]', m); });

  const gbuffer = new FrameGBuffer(renderer, { width: W, height: H });
  const tx = gbuffer.textures;

  // ---- debug display: one shader, the view picked by a uniform ----------------------------------
  const uView = uniform(0);
  const uNear = uniform(0.05), uFar = uniform(100);
  const uMotionGain = uniform(40);
  const viewColor = (v: View, at: N): N => {
    const s = (t: THREE.Texture) => texture(t, at);
    switch (v) {
      case 'lit': return tx.lit ? (renderOutput(s(tx.lit).rgb, THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace) as N).rgb : vec3(1, 0, 1);
      case 'sceneColor': return (renderOutput(s(tx.output!).rgb, THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace) as N).rgb;
      case 'depth': {
        const d = s(tx.depth).x;
        const z = (perspectiveDepthToViewZ as N)(d, uNear, uFar).negate();
        // log-scaled view distance: near = white, far = black, sky = dark blue
        const k = float(1).sub(z.div(uNear).log().div(uFar.div(uNear).log()));
        return d.greaterThanEqual(1).select(vec3(0.02, 0.03, 0.08), vec3(k));
      }
      case 'normal': return s(tx.normalRoughness!).xyz.mul(0.5).add(0.5);
      case 'roughness': return vec3(s(tx.normalRoughness!).w);
      case 'metalness': return vec3(s(tx.albedoMetalness!).w);
      case 'albedo': return s(tx.albedoMetalness!).rgb.pow(1 / 2.2);
      case 'motion': { const m = s(tx.motion!).xy.mul(uMotionGain); return vec3(m.x.add(0.5), m.y.add(0.5), m.length().min(1).mul(0.5)); }
      default: return vec3(0);
    }
  };
  const full = (at: N) => {
    let c: N = vec3(0);
    VIEWS.forEach((v, i) => { if (v !== 'grid') c = uView.equal(i).select(viewColor(v, at), c); });
    return c;
  };
  // grid: 3 x 3 tiles, row-major from the top left
  const gridColor = () => {
    const p = uv().mul(3);
    const cell = p.floor();
    const local = p.fract();
    const idx = cell.y.mul(3).add(cell.x);
    let c: N = vec3(0.06);
    GRID.forEach((v, i) => { c = idx.equal(i).select(viewColor(v, local), c); });
    const edge = local.x.lessThan(0.004).or(local.y.lessThan(0.006));
    return edge.select(vec3(0.15), c);
  };
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = vec4(uView.equal(VIEWS.indexOf('grid')).select(gridColor(), full(uv())), 1);

  // ---- scene state -------------------------------------------------------------------------------
  const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas);
  let kit: KitScene | null = null;
  let time = 0, paused = false;
  const overlay = new THREE.Scene();
  let showVolumes = q.has('volumes');
  const assets = await availableAssets();
  const assetIds = assets.map((a) => ASSET_SCENES[a.dir]).filter(Boolean).map((s) => s.id);

  async function load(id: string) {
    const factory = SCENES[id] ?? Object.values(ASSET_SCENES).find((s) => s.id === id)?.factory;
    if (!factory) throw new Error(`unknown scene ${id}`);
    kit?.dispose?.();
    status.textContent = `loading ${id}...`;
    kit = await factory({ aspect: W / H });
    controls.object = kit.camera;
    controls.target.copy(kit.target);
    controls.update();
    uNear.value = kit.camera.near; uFar.value = kit.camera.far;
    time = 0; kit.update?.(0);
    overlay.clear();
    for (const v of kit.probes) {
      const size = new THREE.Vector3(...v.influenceSize);
      const c = new THREE.Vector3(...v.position);
      overlay.add(new THREE.Box3Helper(new THREE.Box3().setFromCenterAndSize(c, size), 0xffcc00));
      if (v.projectionSize) overlay.add(new THREE.Box3Helper(new THREE.Box3().setFromCenterAndSize(c, new THREE.Vector3(...v.projectionSize)), 0x00ccff));
    }
    gbuffer.resetHistory();
    refreshUI();
    return { id: kit.id, views: Object.keys(kit.views), probes: kit.probes.length, animated: !!kit.update };
  }

  function setPose(name: string) {
    const v = kit!.views[name];
    if (!v) throw new Error(`no view ${name} in ${kit!.id}`);
    kit!.camera.position.set(...v.pos);
    if (v.fov) { kit!.camera.fov = v.fov; kit!.camera.updateProjectionMatrix(); }
    controls.target.set(...v.target);
    controls.update();
  }

  function frame() {
    if (!kit) return;
    kit.camera.aspect = W / H; kit.camera.updateProjectionMatrix();
    gbuffer.render(kit.scene, kit.camera);
    pipeline.render();
    if (showVolumes) {
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(overlay, kit.camera);
      renderer.autoClear = ac;
    }
  }

  const timer = new THREE.Timer();
  function animate() {
    timer.update();
    if (kit?.update && !paused) { time += Math.min(timer.getDelta(), 0.1); kit.update(time); }
    frame();
  }

  // ---- UI ----------------------------------------------------------------------------------------
  const panel = document.querySelector<HTMLElement>('#controls')!;
  const row = (label: string, el: HTMLElement) => { const l = document.createElement('label'); l.textContent = `${label} `; l.append(el); panel.append(l); return el; };
  const sceneSel = document.createElement('select');
  const viewSel = document.createElement('select');
  const poseSel = document.createElement('select');
  for (const id of [...Object.keys(SCENES), ...assetIds]) sceneSel.append(new Option(id, id));
  for (const v of VIEWS) viewSel.append(new Option(v, v));
  sceneSel.onchange = () => { const u = new URL(location.href); u.searchParams.set('scene', sceneSel.value); u.searchParams.delete('pose'); history.replaceState(null, '', u); load(sceneSel.value).then(() => manual && frame()); };
  viewSel.onchange = () => { setView(viewSel.value as View); if (manual) frame(); };
  poseSel.onchange = () => { setPose(poseSel.value); if (manual) frame(); };
  row('Scene', sceneSel); row('Show', viewSel); row('Camera', poseSel);
  const pauseBox = document.createElement('input'); pauseBox.type = 'checkbox'; pauseBox.onchange = () => { paused = pauseBox.checked; };
  row('Pause', pauseBox);
  const volBox = document.createElement('input'); volBox.type = 'checkbox'; volBox.checked = showVolumes; volBox.onchange = () => { showVolumes = volBox.checked; if (manual) frame(); };
  row('Probe volumes', volBox);
  function refreshUI() {
    sceneSel.value = kit!.id;
    poseSel.replaceChildren(...Object.keys(kit!.views).map((v) => new Option(v, v)));
    const c = gbuffer.conventions;
    status.textContent = [
      `three r${THREE.REVISION} | ${kit!.title} | ${W}x${H}${manual ? ' | manual (loop stopped)' : ''}`,
      `targets: ${Object.keys(tx).filter((k) => (tx as N)[k]).join(', ')} (lit target ${gbuffer.lit ? 'on' : 'off: device limit ' + device.limits.maxColorAttachmentBytesPerSample + ' B/sample'})`,
      `conventions: depthInverted=${c.depthInverted} normal*${c.normalUnpackMul}+${c.normalUnpackAdd} roughnessIsPerceptual=${c.roughnessIsPerceptual} motionVectorScale=[${c.motionVectorScale}] sceneColorSpecular=${c.sceneColorSpecular}`,
      `probe volumes suggested: ${kit!.probes.length}${assets.length ? '' : ' | no assets downloaded (pnpm assets)'}`,
    ].join('\n');
  }
  function setView(v: View) { uView.value = VIEWS.indexOf(v); viewSel.value = v; }

  await load(q.get('scene') ?? 'mirrorWall');
  if (q.get('pose')) setPose(q.get('pose')!);
  setView((q.get('view') as View) ?? 'grid');
  if (manual) frame(); else renderer.setAnimationLoop(animate);

  // ---- headless hooks ----------------------------------------------------------------------------
  const idle = () => device.queue.onSubmittedWorkDone();
  Object.assign(window, {
    __p: {
      THREE, renderer, gbuffer, controls, get kit() { return kit; }, gpuErrors,
      scenes: () => ({ procedural: Object.keys(SCENES), assets: assetIds }),
      load: (id: string) => load(id),
      setPose, setView: (v: View) => setView(v),
      setTime(t: number) { time = t; kit?.update?.(t); },
      stop() { renderer.setAnimationLoop(null); },
      start() { renderer.setAnimationLoop(animate); },
      /** Render one frame (G-buffer + display), wait for the GPU. */
      async step(n = 1) { for (let i = 0; i < n; i++) frame(); await idle(); return gbuffer.frame?.frameIndex; },
      /** Move the camera by a world offset (for camera-motion checks). */
      nudge(dx: number, dy: number, dz: number) { kit!.camera.position.add(new THREE.Vector3(dx, dy, dz)); kit!.camera.updateMatrixWorld(); },
      conventions: () => gbuffer.conventions,
      camera: () => { const c = gbuffer.frame!.camera; return { ...c, view: [...c.view as N], projection: [...c.projection as N], prevViewProjection: [...c.prevViewProjection as N] }; },
      /**
       * Per-target stats read back from the GPU textures FrameGBuffer hands out:
       * per channel min/max/mean, `nonzero` (fraction of pixels with any channel != 0), and a few
       * contract checks (unit normals on geometry, no specular in scene colour on mirrors).
       */
      async stats() {
        await idle();
        const t = gbuffer.gpuTextures();
        const read = async (g: GPUTexture) => readTexture(device, g);
        const targets: Record<string, Awaited<ReturnType<typeof read>>> = {
          depth: await read(t.depth), normalRoughness: await read(t.normal), albedoMetalness: await read(t.albedo),
          motion: await read(t.motion), sceneColor: await read(t.sceneColor),
        };
        if (t.lit) targets.lit = await read(t.lit);
        const out: Record<string, N> = {};
        for (const [name, r] of Object.entries(targets)) {
          const n = r.width * r.height, ch = r.channels;
          const min = Array(ch).fill(Infinity), max = Array(ch).fill(-Infinity), sum = Array(ch).fill(0);
          let nonzero = 0, nan = 0;
          for (let i = 0; i < n; i++) {
            let any = false;
            for (let c = 0; c < ch; c++) {
              const v = r.data[i * ch + c];
              if (Number.isNaN(v)) { nan++; continue; }
              if (v < min[c]) min[c] = v; if (v > max[c]) max[c] = v; sum[c] += v;
              if (v !== 0) any = true;
            }
            if (any) nonzero++;
          }
          out[name] = { format: r.format, min, max, mean: sum.map((s) => s / n), nonzero: nonzero / n, nan };
        }
        // contract checks over geometry pixels (depth < 1)
        const d = targets.depth.data, nr = targets.normalRoughness.data, am = targets.albedoMetalness.data, sc = targets.sceneColor.data, lit = targets.lit?.data;
        let geo = 0, badNormal = 0, mirrors = 0, mirrorScene = 0, mirrorLit = 0;
        for (let i = 0; i < d.length; i++) {
          if (d[i] >= 1) continue;
          geo++;
          const len = Math.hypot(nr[i * 4], nr[i * 4 + 1], nr[i * 4 + 2]);
          if (Math.abs(len - 1) > 0.02) badNormal++;
          if (am[i * 4 + 3] > 0.99 && nr[i * 4 + 3] < 0.05) {
            mirrors++;
            mirrorScene += (sc[i * 4] + sc[i * 4 + 1] + sc[i * 4 + 2]) / 3;
            if (lit) mirrorLit += (lit[i * 4] + lit[i * 4 + 1] + lit[i * 4 + 2]) / 3;
          }
        }
        out.checks = {
          geometry: geo / d.length, badNormals: geo ? badNormal / geo : 0,
          mirrorPixels: mirrors / d.length, mirrorSceneColor: mirrors ? mirrorScene / mirrors : 0, mirrorLit: mirrors && lit ? mirrorLit / mirrors : null,
        };
        return out;
      },
      /** Render once and return the canvas as a PNG data URL. */
      async shot() { frame(); const url = canvas.toDataURL('image/png'); await idle(); return url; },
    },
  });
}

main().catch((e) => {
  console.error(e);
  document.querySelector<HTMLElement>('#status')!.textContent = String(e?.stack ?? e);
});
