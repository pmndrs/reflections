// examples/ssr: the scene kit with screen-space reflections on (ScreenSpaceReflectionsPass +
// screenSpaceComposite from @pmndrs/reflections/three).
//
// Each frame: the pass renders the frame-contract G-buffer, traces with the core SSR on three's
// device and copies radiance / hit distance / confidence into three textures; a RenderPipeline
// shows the composite or a debug view. The probes suggested by each kit scene are baked and lit
// with (`scene.environmentNode = reflectionProbes(probes)`) unless `?probes=0`; the composite then
// reads them with `sampleReflectionProbesLocal` and falls back to `scene.environment` by coverage.
//
// `?rt=1` attaches a ray-traced fallback for the misses (three-mesh-bvh behind core's trace seam,
// MeshBVHTraceProvider), rebuilt per scene and refitted per frame for animated scenes.
//
// `?denoise=1|0` (default on when a denoiser is available): the hybrid resolve (HybridReflections)
// hands the specular signal to denoiser/ffx's FfxReflectionDenoiser through the denoise seam. The
// denoiser comes from the sibling Denoiser repo's source (examples/vite.config.ts) when present.
//
// `window.__p` drives the page headlessly (scripts/run-headless.mjs, section `ssr`).
import * as THREE from 'three/webgpu';
import { renderOutput, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  HybridReflections, MeshBVHTraceProvider, ReflectionProbe, ReflectionProbes, ScreenSpaceReflectionsPass, getGPUTexture, reflectionProbes,
} from '@pmndrs/reflections/three';
import { HIT_WGSL } from '@pmndrs/reflections/core';
import { SCENES, type KitScene } from '../../shared';
import { createReflectionDenoiser, denoiserAvailable, denoiserSource } from '../../shared/denoiser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 960), H = Number(q.get('h') ?? 540);
const manual = q.has('manual');
const useProbes = q.get('probes') !== '0';
/**
 * Hit colour (D69): 'current' = this frame's scene colour without specular (FFX, default); 'lit' =
 * last frame's G-buffer lit target (three's lighting incl. its probe/env specular); 'final' = last
 * frame's composite (SSR included), so reflections of reflections deepen one bounce per frame.
 */
type HitColorMode = 'current' | 'lit' | 'final';
const HIT_MODES: HitColorMode[] = ['current', 'lit', 'final'];
const useRT = q.get('rt') === '1';
const wantDenoise = q.has('denoise') ? q.get('denoise') !== '0' : true;

const VIEWS = ['final', 'raw', 'split', 'noSSR', 'ssr', 'confidence', 'hitDistance', 'rays', 'misses', 'specular', 'signal', 'probeSpecular', 'source', 'rtSource', 'grid'] as const;
type View = (typeof VIEWS)[number];
const GRID: View[] = ['final', 'raw', 'noSSR', 'confidence', 'hitDistance', 'misses', 'specular', 'signal', useRT ? 'rtSource' : 'source'];

// ---- GPU readback ------------------------------------------------------------------------------
function halfToFloat(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
const FORMATS: Record<string, { bytes: number; channels: number; read: (dv: DataView, o: number, c: number) => number }> = {
  rgba16float: { bytes: 8, channels: 4, read: (dv, o, c) => halfToFloat(dv.getUint16(o + c * 2, true)) },
  rgba8unorm: { bytes: 4, channels: 4, read: (dv, o, c) => dv.getUint8(o + c) / 255 },
  r32float: { bytes: 4, channels: 1, read: (dv, o) => dv.getFloat32(o, true) },
  rgba32float: { bytes: 16, channels: 4, read: (dv, o, c) => dv.getFloat32(o + c * 4, true) },
  depth32float: { bytes: 4, channels: 1, read: (dv, o) => dv.getFloat32(o, true) },
};
async function readTexture(device: GPUDevice, tex: GPUTexture) {
  const info = FORMATS[tex.format];
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
  return out;
}
async function readU32(device: GPUDevice, b: GPUBuffer, size = 16, offset = 0) {
  const r = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(b, offset, r, 0, size);
  device.queue.submit([enc.finish()]);
  await r.mapAsync(GPUMapMode.READ);
  const out = Array.from(new Uint32Array(r.getMappedRange().slice(0)));
  r.unmap(); r.destroy();
  return out;
}

// ---- ray-list / miss-list coverage (debug): lists -> per-pixel bits -> rgba8 texture ------------
const MASK_WGSL = /* wgsl */ `
struct U { size: vec2u, pad: vec2u };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> rayList: array<u32>;
@group(0) @binding(2) var<storage, read> rayCounter: array<u32, 4>;
@group(0) @binding(3) var<storage, read> missList: array<vec2u>;
@group(0) @binding(4) var<storage, read> missCounter: array<u32, 4>;
@group(0) @binding(5) var<storage, read_write> bits: array<atomic<u32>>;
@group(0) @binding(6) var mask: texture_storage_2d<rgba8unorm, write>;
fn coords(p: u32) -> vec2u { return vec2u(p & 32767u, (p >> 15u) & 16383u); }
fn mark(c: vec2u, b: u32) { if (all(c < u.size)) { atomicOr(&bits[c.y * u.size.x + c.x], b); } }
@compute @workgroup_size(8, 8) fn clear(@builtin(global_invocation_id) id: vec3u) {
  if (all(id.xy < u.size)) { atomicStore(&bits[id.y * u.size.x + id.x], 0u); }
}
// one invocation per list entry, indexed over the pixel grid (entries <= pixels)
@compute @workgroup_size(8, 8) fn markLists(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= u.size)) { return; }
  let i = id.y * u.size.x + id.x;
  if (i < rayCounter[1]) {
    let p = rayList[i];
    let c = coords(p);
    mark(c, 1u);
    if (((p >> 29u) & 1u) != 0u) { mark(vec2u(c.x ^ 1u, c.y), 2u); }
    if (((p >> 30u) & 1u) != 0u) { mark(vec2u(c.x, c.y ^ 1u), 2u); }
    if (((p >> 31u) & 1u) != 0u) { mark(c ^ vec2u(1u), 2u); }
  }
  if (i < min(missCounter[1], arrayLength(&missList))) { mark(coords(missList[i].x), 4u); }
}
@compute @workgroup_size(8, 8) fn resolve(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= u.size)) { return; }
  let b = atomicLoad(&bits[id.y * u.size.x + id.x]);
  textureStore(mask, id.xy, vec4f(select(0.0, 1.0, (b & 1u) != 0u), select(0.0, 1.0, (b & 2u) != 0u), select(0.0, 1.0, (b & 4u) != 0u), 1.0));
}
`;

async function main() {
  const status = document.querySelector<HTMLElement>('#status')!;
  const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
  if (!navigator.gpu) { status.textContent = 'WebGPU is not available in this browser.'; return; }
  const adapter = await navigator.gpu.requestAdapter();
  // the composite needs the G-buffer's `lit` target: 36 bytes/sample
  const maxBytes = Math.min(adapter?.limits.maxColorAttachmentBytesPerSample ?? 32, 64);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: { maxColorAttachmentBytesPerSample: maxBytes } } as N);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  const ssr = new ScreenSpaceReflectionsPass(renderer, {
    gbufferOptions: { width: W, height: H }, missList: true, timestamps: q.has('timing'),
    subgroups: q.get('variant') !== 'workgroup',
  });
  const device = ssr.device;
  // hybrid resolve + denoise seam (phase 5)
  const denoiser = denoiserAvailable ? createReflectionDenoiser(device, 0.447, q.has('timing')) : null;
  const hybrid = new HybridReflections(ssr, { denoiser });
  hybrid.denoise = wantDenoise && !!denoiser;
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('[webgpu uncapturederror]', m); });
  // With the loop stopped, three renders each shadow map once per camera per frame: advance it ourselves.
  const nextNodeFrame = () => (renderer as N)._nodes.nodeFrame.update();

  // ---- coverage mask -----------------------------------------------------------------------------
  const maskTex = new THREE.StorageTexture(W, H);
  maskTex.type = THREE.UnsignedByteType;
  maskTex.minFilter = maskTex.magFilter = THREE.NearestFilter;
  maskTex.generateMipmaps = false;
  const maskModule = device.createShaderModule({ label: 'ssr example mask', code: MASK_WGSL });
  const maskLayout = device.createBindGroupLayout({
    label: 'ssr example mask',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } })),
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
    ],
  });
  const maskPipes = ['clear', 'markLists', 'resolve'].map((entryPoint) => device.createComputePipeline({
    label: `ssr example ${entryPoint}`, layout: device.createPipelineLayout({ bindGroupLayouts: [maskLayout] }), compute: { module: maskModule, entryPoint },
  }));
  const maskU = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(maskU, 0, new Uint32Array([W, H, 0, 0]));
  const maskBits = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.STORAGE });
  let maskGroup: GPUBindGroup | null = null, maskFor: unknown = null;
  function updateMask() {
    const core = ssr.tracer!;
    if (maskFor !== core) {
      renderer.initTexture(maskTex);
      const o = core.outputs;
      maskGroup = device.createBindGroup({
        layout: maskLayout,
        entries: [
          { binding: 0, resource: { buffer: maskU } }, { binding: 1, resource: { buffer: o.rayList } }, { binding: 2, resource: { buffer: o.rayCounter } },
          { binding: 3, resource: { buffer: o.missList! } }, { binding: 4, resource: { buffer: o.missCounter! } }, { binding: 5, resource: { buffer: maskBits } },
          { binding: 6, resource: getGPUTexture(renderer, maskTex).createView({ mipLevelCount: 1 }) },
        ],
      });
      maskFor = core;
    }
    const enc = device.createCommandEncoder({ label: 'ssr example mask' });
    for (const pipe of maskPipes) {
      const p = enc.beginComputePass();
      p.setPipeline(pipe); p.setBindGroup(0, maskGroup!); p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
    }
    device.queue.submit([enc.finish()]);
  }

  // ---- display ------------------------------------------------------------------------------------
  const uView = uniform(0);
  const uGrid = uniform(0);
  const tone = (c: N) => (renderOutput(c, THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace) as N).rgb;
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  let composite: ReturnType<HybridReflections['composite']> | null = null;
  // last frame's composite (linear HDR) for hitColor 'final'
  const historyRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
  historyRT.texture.name = 'ssr example final history';
  const historyMaterial = new THREE.MeshBasicNodeMaterial();
  historyMaterial.toneMapped = false;
  const historyQuad = new THREE.QuadMesh(historyMaterial);
  let hitMode: HitColorMode = (q.get('hit') as HitColorMode) ?? 'current';
  function setHitColor(m: HitColorMode) {
    if (!HIT_MODES.includes(m)) throw new Error(`hit colour ${m}?`);
    hitMode = m;
    ssr.settings.hitColor = m === 'current' ? 'current' : 'history';
    ssr.historySource = m === 'final' ? historyRT.texture : null;
    ssr.resetHistory();
  }
  setHitColor(hitMode);
  function buildDisplay() {
    // one composite, sampled at the full-screen uv or at a grid cell's local uv
    const gridUV = uv().mul(3);
    const cell = gridUV.floor();
    const at = uGrid.equal(1).select(gridUV.fract(), uv());
    Object.assign(hybrid.options, { probes: useProbes ? probes : null, environment: kit!.scene.environment, environmentIntensity: kit!.scene.environmentIntensity });
    hybrid.rebuild();
    const c = composite = hybrid.composite({ uv: at });
    // the raw (undenoised) composite from the same terms, for 'raw' and 'split'
    const rawFinal = c.geometry.select(c.lit.add(c.weight.mul(c.signal.sub(c.probeSpecular)).mul(c.amount)).max(0), c.lit);
    const mask = texture(maskTex, at);
    const dim = tone(c.lit).mul(0.35);
    const viewColor = (v: View): N => {
      switch (v) {
        case 'final': return tone(c.final.rgb);
        case 'raw': return tone(rawFinal);
        // left raw, right denoised (the final composite), a thin line between
        case 'split': return at.x.sub(0.5).abs().lessThan(0.001).select(vec3(1), at.x.lessThan(0.5).select(tone(rawFinal), tone(c.final.rgb)));
        case 'signal': return tone(c.signal);
        case 'noSSR': return tone(c.lit);
        case 'ssr': return tone(c.ssr);
        case 'specular': return tone(c.specular);
        case 'probeSpecular': return tone(c.probeSpecular);
        case 'confidence': return c.geometry.select(vec3(c.confidence), vec3(0.02, 0.03, 0.08));
        case 'hitDistance': { const d = c.hitDistance; return d.greaterThan(0).select((vec3(1, 0.8, 0.5) as N).mul(d.div(d.add(2))), vec3(0)); }
        // traced = green, quad copy = yellow-green, neither = dimmed lit image
        case 'rays': return mask.r.greaterThan(0.5).select(vec3(0.1, 0.9, 0.2), mask.g.greaterThan(0.5).select(vec3(0.6, 0.8, 0.1), dim));
        case 'misses': return mask.b.greaterThan(0.5).select(vec3(1, 0.15, 0.1), mask.r.greaterThan(0.5).select(vec3(0.1, 0.35, 0.15), dim));
        // hybrid source per pixel: SSR green, traced blue, probe orange, environment magenta, rough (probe/env, untraced) grey
        case 'source': return HybridReflections.sourceColor(c, hybrid.roughnessThreshold);
        // RT pass codes: SSR hit / traced hit / traced hit from the screen / traced miss / capped / probe
        case 'rtSource': {
          const src = c.source.add(0.5).floor();
          const probe = c.geometry.select(vec3(0.22).add(dim.mul(0.4)), vec3(0));
          const ssrHit = c.confidence.greaterThanEqual(0.9).select(vec3(0.15, 0.85, 0.25), probe);
          return src.equal(1).select(vec3(0.2, 0.4, 1), src.equal(4).select(vec3(0.2, 0.9, 0.95),
            src.equal(2).select(vec3(0.95, 0.2, 0.85), src.equal(3).select(vec3(1, 0.55, 0.1), ssrHit))));
        }
        default: return vec3(0);
      }
    };
    let full: N = vec3(0);
    VIEWS.forEach((v, i) => { if (v !== 'grid') full = uView.equal(i).select(viewColor(v), full); });
    const idx = cell.y.mul(3).add(cell.x); // row-major from the top left
    let grid: N = vec3(0.06);
    GRID.forEach((v, i) => { grid = idx.equal(i).select(viewColor(v), grid); });
    const local = gridUV.fract();
    grid = local.x.lessThan(0.004).or(local.y.lessThan(0.006)).select(vec3(0.15), grid);
    pipeline.outputNode = vec4(uGrid.equal(1).select(grid, full) as N, 1);
    historyMaterial.colorNode = hybrid.composite().final;
    historyMaterial.needsUpdate = true;
    pipeline.needsUpdate = true;
  }

  // ---- scene state --------------------------------------------------------------------------------
  const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas);
  let kit: KitScene | null = null;
  let probes: ReflectionProbes | null = null;
  let provider: MeshBVHTraceProvider | null = null;
  let bvhInfo: { meshes: number; triangles: number; buildMs: number } | null = null;
  let time = 0, paused = false;

  async function load(id: string) {
    const factory = SCENES[id];
    if (!factory) throw new Error(`unknown scene ${id}`);
    kit?.dispose?.();
    probes?.dispose?.();
    probes = null;
    status.textContent = `loading ${id}...`;
    kit = await factory({ aspect: W / H });
    controls.object = kit.camera;
    controls.target.copy(kit.target);
    controls.update();
    time = 0; kit.update?.(0);
    if (useProbes && kit.probes.length) {
      probes = new ReflectionProbes();
      for (const v of kit.probes) {
        const p = new ReflectionProbe(...v.influenceSize);
        p.position.set(...v.position);
        if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
        if (v.originOffset) p.originOffset.set(...v.originOffset);
        if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
        probes.add(p);
      }
      kit.scene.add(probes);
      probes.bake(renderer, kit.scene, { resolution: 128, near: 0.05, far: 60 });
      nextNodeFrame();
      kit.scene.environmentNode = reflectionProbes(probes) as N;
    }
    if (useRT) {
      // every visible mesh except helpers; one BVH per scene (BVHComputeData packs TLAS + BLAS)
      const meshes: THREE.Mesh[] = [];
      kit.scene.updateMatrixWorld(true);
      kit.scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !(o as N).isHelper && !o.userData.noTrace) meshes.push(o as THREE.Mesh); });
      const t0 = performance.now();
      (ssr.traced?.provider as MeshBVHTraceProvider | undefined)?.destroy();
      provider = await MeshBVHTraceProvider.fromObjects(device, meshes);
      bvhInfo = { meshes: meshes.length, triangles: provider.triangles, buildMs: performance.now() - t0 };
      ssr.setTraceProvider(provider);
    }
    ssr.gbuffer.resetHistory();
    ssr.resetHistory();
    buildDisplay();
    hybrid.resetHistory();
    refreshUI();
    return { id: kit.id, views: Object.keys(kit.views), probes: probes?.bakedProbes.length ?? 0, animated: !!kit.update };
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
    if (manual || !looping) nextNodeFrame();
    kit.camera.aspect = W / H; kit.camera.updateProjectionMatrix(); kit.camera.updateMatrixWorld();
    if (provider && kit.update) { kit.scene.updateMatrixWorld(); provider.refit(); }
    ssr.render(kit.scene, kit.camera);
    hybrid.update();
    updateMask();
    pipeline.render();
    if (hitMode === 'final') {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(historyRT);
      historyQuad.render(renderer);
      renderer.setRenderTarget(prev);
    }
  }

  let looping = false;
  const timer = new THREE.Timer();
  function animate() {
    timer.update();
    if (kit?.update && !paused) { time += Math.min(timer.getDelta(), 0.1); kit.update(time); }
    frame();
  }
  const startLoop = () => { looping = true; renderer.setAnimationLoop(animate); };
  const stopLoop = () => { looping = false; renderer.setAnimationLoop(null); };

  // ---- UI ----------------------------------------------------------------------------------------
  const panel = document.querySelector<HTMLElement>('#controls')!;
  const row = (label: string, el: HTMLElement) => { const l = document.createElement('label'); l.textContent = `${label} `; l.append(el); panel.append(l); return el; };
  const sceneSel = document.createElement('select');
  const viewSel = document.createElement('select');
  const poseSel = document.createElement('select');
  for (const id of Object.keys(SCENES)) sceneSel.append(new Option(id, id));
  for (const v of VIEWS) viewSel.append(new Option(v, v));
  sceneSel.onchange = () => { const u = new URL(location.href); u.searchParams.set('scene', sceneSel.value); u.searchParams.delete('pose'); history.replaceState(null, '', u); load(sceneSel.value).then(() => !looping && frame()); };
  viewSel.onchange = () => { setView(viewSel.value as View); if (!looping) frame(); };
  poseSel.onchange = () => { setPose(poseSel.value); if (!looping) frame(); };
  row('Scene', sceneSel); row('Show', viewSel); row('Camera', poseSel);
  const thr = document.createElement('input'); thr.type = 'range'; thr.min = '0'; thr.max = '1'; thr.step = '0.01'; thr.value = '0.447';
  thr.oninput = () => { ssr.settings.roughnessThreshold = Number(thr.value); refreshUI(); if (!looping) frame(); };
  row('Roughness threshold (perceptual)', thr);
  const ssrBox = document.createElement('input'); ssrBox.type = 'checkbox'; ssrBox.checked = true;
  ssrBox.onchange = () => { composite!.amount.value = ssrBox.checked ? 1 : 0; if (!looping) frame(); };
  row('SSR', ssrBox);
  const hitSel = document.createElement('select');
  for (const m of HIT_MODES) hitSel.append(new Option(m, m));
  hitSel.value = hitMode;
  hitSel.onchange = () => { setHitColor(hitSel.value as HitColorMode); refreshUI(); if (!looping) frame(); };
  row('Hit colour', hitSel);
  if (useRT) {
    const rtBox = document.createElement('input'); rtBox.type = 'checkbox'; rtBox.checked = true;
    rtBox.onchange = () => { ssr.rayTracing = rtBox.checked; refreshUI(); if (!looping) frame(); };
    row('Ray-traced misses', rtBox);
  }
  const denoiseBox = document.createElement('input'); denoiseBox.type = 'checkbox'; denoiseBox.checked = hybrid.denoise; denoiseBox.disabled = !denoiser;
  denoiseBox.onchange = () => { hybrid.denoise = denoiseBox.checked; refreshUI(); if (!looping) frame(); };
  row(denoiser ? 'Denoise (FFX)' : 'Denoise (no denoiser found)', denoiseBox);
  const pauseBox = document.createElement('input'); pauseBox.type = 'checkbox'; pauseBox.onchange = () => { paused = pauseBox.checked; };
  row('Pause', pauseBox);
  function refreshUI() {
    sceneSel.value = kit!.id;
    const pose = poseSel.value;
    poseSel.replaceChildren(...Object.keys(kit!.views).map((v) => new Option(v, v)));
    if (kit!.views[pose]) poseSel.value = pose;
    status.textContent = [
      `three r${THREE.REVISION} | ${kit!.title} | ${W}x${H}${manual ? ' | manual (loop stopped)' : ''}`,
      `variant ${ssr.variant ?? '(first frame pending)'} | hit colour ${hitMode} | roughnessThreshold ${ssr.settings.roughnessThreshold ?? 0.447} perceptual | lit target ${ssr.gbuffer.lit ? 'on' : 'OFF (composite unavailable)'}`,
      `specular IBL term: ${probes ? `${probes.bakedProbes.length} probe(s) by coverage, then scene.environment` : 'scene.environment'}`,
      `denoise: ${denoiser ? `${hybrid.denoise ? 'on' : 'off'} (${denoiser.name}, from ${denoiserSource})` : 'unavailable (no sibling Denoiser repo; raw signal)'}`,
      useRT ? `ray-traced misses: ${ssr.rayTracing ? 'on' : 'off'} (three-mesh-bvh${bvhInfo ? `, ${bvhInfo.meshes} meshes, ${bvhInfo.triangles} triangles, built in ${bvhInfo.buildMs.toFixed(0)} ms` : ''})` : 'ray-traced misses: off (?rt=1)',
    ].join('\n');
  }
  function setView(v: View) {
    uGrid.value = v === 'grid' ? 1 : 0;
    uView.value = VIEWS.indexOf(v);
    viewSel.value = v;
  }

  await load(q.get('scene') ?? 'mirrorWall');
  if (q.get('pose')) setPose(q.get('pose')!);
  setView((q.get('view') as View) ?? 'final');
  if (manual) frame(); else startLoop();
  refreshUI();

  // ---- headless hooks ----------------------------------------------------------------------------
  const idle = () => device.queue.onSubmittedWorkDone();
  Object.assign(window, {
    __p: {
      THREE, renderer, ssr, controls, get kit() { return kit; }, gpuErrors, get variant() { return ssr.variant; },
      scenes: () => Object.keys(SCENES),
      load: (id: string) => load(id),
      setPose, setView: (v: View) => setView(v),
      setSSR(on: boolean) { composite!.amount.value = on ? 1 : 0; },
      setSettings(s: N) { Object.assign(ssr.settings, s); },
      setHitColor: (m: HitColorMode) => setHitColor(m),
      setRT(on: boolean) { ssr.rayTracing = on; },
      hybrid, get denoiserName() { return denoiser?.name ?? null; },
      setDenoise(on: boolean) { hybrid.denoise = on && !!denoiser; denoiseBox.checked = hybrid.denoise; },
      setTraceSettings(s: N) { ssr.traceSettings = { ...s }; },
      traceStats: () => ssr.readTraceStats(),
      get bvh() { return bvhInfo; },
      tileCapCheck: () => tileCapCheck(),
      rtOracle: (n?: number) => rtOracle(n),
      hitShadingError: () => hitShadingError(),
      stop: stopLoop, start: startLoop,
      async step(n = 1) { for (let i = 0; i < n; i++) frame(); await idle(); },
      async shot() { frame(); const url = canvas.toDataURL('image/png'); await idle(); return url; },
      /** Median GPU ms per core pass over `n` frames, one frame per submit (loop stopped). */
      async time(n = 30) {
        stopLoop();
        const per: Record<string, number[]> = {};
        for (let i = 0; i < n + 3; i++) {
          frame();
          await idle();
          const t = await ssr.readTimings();
          if (i >= 3) for (const [k, v] of t) (per[k] ??= []).push(v);
        }
        const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
        return { size: [W, H], variant: ssr.variant, frames: n, ms: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Number(med(v).toFixed(4))])) };
      },
      stats: () => stats(),
    },
  });

  /**
   * Readback stats for the check: confidence / ray / miss counts, and two scene checks.
   * mirrorWall: for every mirror-floor pixel whose planar reflection lands on the wall (z = -3,
   * |x| < 5, 0 < y < 4) at a point the camera sees, the expected colour is the scene colour where
   * that wall point projects; SSR's hit colour (radiance / confidence) is compared with it by
   * luminance correlation, and its hit distance with the analytic distance.
   * Any scene: mean confidence over the mirror panels facing the camera (normal toward +z), the
   * offscreen scene's behind-the-camera case.
   */
  async function stats() {
    await idle();
    const core = ssr.tracer!;
    const t = ssr.gbuffer.gpuTextures();
    const [depth, nr, am, sc, rad, conf, hit] = await Promise.all([
      readTexture(device, t.depth), readTexture(device, t.normal), readTexture(device, t.albedo), readTexture(device, t.sceneColor),
      readTexture(device, core.outputs.radiance), readTexture(device, core.outputs.confidence), readTexture(device, core.outputs.hitDistance),
    ]);
    const counter = await readU32(device, core.outputs.rayCounter);
    const missCounter = await readU32(device, core.outputs.missCounter!);
    const cam = ssr.gbuffer.frame!.camera;
    const VP = new THREE.Matrix4().fromArray(cam.projection as N).multiply(new THREE.Matrix4().fromArray(cam.view as N));
    const invVP = VP.clone().invert();
    const eye = new THREE.Vector3(...(cam.position as [number, number, number]));
    const inverted = ssr.gbuffer.conventions.depthInverted;
    const isFar = (d: number) => (inverted ? d <= 0 : d >= 1);
    let geo = 0, confSum = 0, nonFinite = 0;
    let panel = 0, panelConf = 0, floorPx = 0, floorConf = 0;
    let panelLum = 0, panelBright = 0, panelAnalytic = 0;
    let panelErr: number[] = [];
    const pairs: [number, number][] = [];
    let wallPx = 0, wallConfident = 0, hitErr: number[] = [], behindPx = 0, behindConfident = 0;
    const P = new THREE.Vector3(), Q = new THREE.Vector3(), d = new THREE.Vector3(), s = new THREE.Vector3();
    // everything but the floor and the wall can sit between a floor point and its wall reflection
    const blockers: THREE.Object3D[] = [];
    kit!.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.type !== 'PlaneGeometry') blockers.push(o); });
    const occluder = new THREE.Raycaster();
    occluder.near = 1e-3;
    const lum = (a: Float32Array, i: number) => (a[i * 4] + a[i * 4 + 1] + a[i * 4 + 2]) / 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!Number.isFinite(rad[i * 4]) || !Number.isFinite(conf[i])) nonFinite++;
      if (isFar(depth[i])) continue;
      geo++; confSum += conf[i];
      const mirrorPx = am[i * 4 + 3] > 0.99 && nr[i * 4 + 3] < 0.03;
      if (!mirrorPx) continue;
      if (nr[i * 4 + 2] > 0.99) {
        panel++; panelConf += conf[i];
        const L = lum(rad, i);
        panelLum += L;
        if (L > 1) panelBright++;
        if (kit!.id === 'offscreen') {
          // the wall mirror (z = -3.95, facing +z) reflects the blue wall behind the camera (z = 8)
          P.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, depth[i]).applyMatrix4(invVP);
          d.copy(P).sub(eye).normalize(); d.z = -d.z;
          if (d.z > 1e-4) {
            const tb = (8 - P.z) / d.z;
            Q.copy(P).addScaledVector(d, tb);
            if (Math.abs(Q.x) < 6.9 && Q.y > 0.05 && Q.y < 4.95) {
              panelAnalytic++;
              if (hit[i] > 0) panelErr.push(Math.abs(hit[i] - tb) / tb);
            }
          }
        }
      }
      if (nr[i * 4 + 1] < 0.99) continue;
      floorPx++; floorConf += conf[i];
      if (kit!.id !== 'mirrorWall') continue;
      P.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, depth[i]).applyMatrix4(invVP);
      d.copy(P).sub(eye).normalize(); d.y = -d.y; // planar mirror at y = 0
      if (d.z >= -1e-4) continue;
      const tw = (-3 - P.z) / d.z;
      Q.copy(P).addScaledVector(d, tw);
      if (Math.abs(Q.x) > 4.9 || Q.y < 0.05 || Q.y > 3.95) continue;
      s.copy(Q).applyMatrix4(VP);
      const sx = Math.floor((s.x * 0.5 + 0.5) * W), sy = Math.floor((0.5 - s.y * 0.5) * H);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const j = sy * W + sx;
      occluder.set(P, d);
      occluder.far = tw - 1e-3;
      if (occluder.intersectObjects(blockers, false).length) continue; // the reflected ray meets an object before the wall
      if (Math.abs(depth[j] - s.z) > 2e-4) {
        // The wall point is hidden from the camera (posts, objects) and the ray passes behind them:
        // screen space can't know the answer. A confident hit here is a streak (thickness too large).
        behindPx++;
        if (conf[i] >= 0.5) behindConfident++;
        continue;
      }
      wallPx++;
      if (conf[i] < 0.9) continue;
      wallConfident++;
      pairs.push([lum(rad, i) / conf[i], lum(sc, j)]);
      hitErr.push(Math.abs(hit[i] - tw) / tw);
    }
    let corr = NaN, meanAbs = NaN;
    if (pairs.length > 10) {
      const n = pairs.length;
      const ma = pairs.reduce((a, p) => a + p[0], 0) / n, mb = pairs.reduce((a, p) => a + p[1], 0) / n;
      let sab = 0, saa = 0, sbb = 0, ad = 0;
      for (const [a, b] of pairs) { sab += (a - ma) * (b - mb); saa += (a - ma) ** 2; sbb += (b - mb) ** 2; ad += Math.abs(a - b); }
      corr = sab / Math.sqrt(saa * sbb);
      meanAbs = ad / n / Math.max(mb, 1e-6);
    }
    hitErr = hitErr.sort((a, b) => a - b);
    const objects = kit!.id === 'mirrorWall' ? stripeStats(depth, nr, am, sc, rad, conf, invVP, eye) : null;
    const facing = kit!.id === 'facingMirrors' ? mirrorInMirror(depth, nr, am, rad, conf, invVP, eye) : null;
    panelErr = panelErr.sort((a, b) => a - b);
    const rt = await ssr.readTraceStats();
    return {
      rt: rt && ssr.rayTracing ? rt : null,
      panel: {
        meanLuminance: panel ? panelLum / panel : 0, brightFraction: panel ? panelBright / panel : 0, analyticPixels: panelAnalytic,
        withHitDistance: panelErr.length, hitDistanceMedianRelErr: panelErr.length ? panelErr[panelErr.length >> 1] : NaN,
        within2pc: panelErr.length ? panelErr.filter((e) => e < 0.02).length / panelAnalytic : 0,
      },
      scene: kit!.id, variant: ssr.variant, rays: counter[1], tiles: counter[3], misses: missCounter[1],
      geometry: geo / (W * H), meanConfidence: geo ? confSum / geo : 0, nonFinite,
      mirrorFloorPixels: floorPx, mirrorFloorConfidence: floorPx ? floorConf / floorPx : 0,
      facingPanelPixels: panel, facingPanelConfidence: panel ? panelConf / panel : 0,
      wall: kit!.id === 'mirrorWall' ? {
        pixels: wallPx, confidentFraction: wallPx ? wallConfident / wallPx : 0, lumCorrelation: corr, meanAbsRelative: meanAbs,
        hitDistanceMedianRelErr: hitErr.length ? hitErr[hitErr.length >> 1] : NaN,
        behindPixels: behindPx, streakFraction: behindPx ? behindConfident / behindPx : NaN,
      } : null,
      objects,
      facing,
    };
  }

  /**
   * facingMirrors: pixels of the left mirror (normal +x) whose exact reflection ray reaches the
   * right mirror (plane x = 1.79, its 7.5 x 2.4 rectangle) with no object in between (raycast). The
   * hit colour there (radiance / confidence, confident px only) is a mirror's own colour: black with
   * this frame's specular-free scene colour, the right mirror's reflection with last frame's colour.
   * `black` = fraction of confident px with hit luminance < 0.02; `meanLum` over confident px.
   */
  function mirrorInMirror(depth: Float32Array, nr: Float32Array, am: Float32Array, rad: Float32Array, conf: Float32Array,
    invVP: THREE.Matrix4, eye: THREE.Vector3) {
    const blockers: THREE.Object3D[] = [];
    kit!.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.type !== 'PlaneGeometry') blockers.push(o); });
    const ray = new THREE.Raycaster();
    ray.near = 1e-3;
    const P = new THREE.Vector3(), d = new THREE.Vector3();
    let px = 0, confident = 0, black = 0, lumSum = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (depth[i] >= 1 || depth[i] <= 0) continue;
      if (!(am[i * 4 + 3] > 0.99 && nr[i * 4 + 3] < 0.03 && nr[i * 4] > 0.99)) continue;
      P.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, depth[i]).applyMatrix4(invVP);
      d.copy(P).sub(eye).normalize(); d.x = -d.x;
      if (d.x <= 1e-4) continue;
      const t = (1.79 - P.x) / d.x;
      const hy = P.y + d.y * t, hz = P.z + d.z * t;
      if (Math.abs(hy - 1.45) > 1.15 || Math.abs(hz + 0.25) > 3.7) continue;
      ray.set(P, d); ray.far = t - 1e-2;
      if (ray.intersectObjects(blockers, false).length) continue;
      px++;
      if (conf[i] < 0.5) continue;
      confident++;
      const l = (rad[i * 4] + rad[i * 4 + 1] + rad[i * 4 + 2]) / 3 / conf[i];
      lumSum += l;
      if (l < 0.02) black++;
    }
    return { pixels: px, confident: px ? confident / px : NaN, black: confident ? black / confident : NaN, meanLum: confident ? lumSum / confident : NaN };
  }

  /**
   * Striping in reflected objects (mirrorWall's sphere and cube). For each object:
   * - reflected mask: mirror-floor pixels whose exact planar reflection ray (three's raycaster
   *   against the object meshes) hits the object;
   * - direct mask: non-mirror pixels whose depth-reconstructed position lies on the object (local bbox);
   * - `hf`: mean of |L - mean(left, right)| + |L - mean(up, down)| over mask-interior pixels, divided
   *   by the mean L, with L = SSR radiance luminance (confidence x hit colour) in the reflection and
   *   scene-colour luminance where the object is seen directly. Striping (rows or columns of
   *   rejected hits) shows as reflected hf far above the direct one; `stripeRatio` = reflected / direct.
   * - `confident`: fraction of the reflected mask with confidence >= 0.9.
   */
  function stripeStats(depth: Float32Array, nr: Float32Array, am: Float32Array, sc: Float32Array, rad: Float32Array, conf: Float32Array,
    invVP: THREE.Matrix4, eye: THREE.Vector3) {
    const meshes: THREE.Mesh[] = [];
    kit!.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry as N;
      if (g.type === 'SphereGeometry' || (g.type === 'BoxGeometry' && g.parameters.width === g.parameters.height)) meshes.push(m);
    });
    const ray = new THREE.Raycaster();
    const P = new THREE.Vector3(), d = new THREE.Vector3(), L = new THREE.Vector3();
    const reflected = meshes.map(() => new Uint8Array(W * H)), direct = meshes.map(() => new Uint8Array(W * H));
    const boxes = meshes.map((m) => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox!.clone().expandByScalar(2e-3); });
    const inv = meshes.map((m) => m.matrixWorld.clone().invert());
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (depth[i] >= 1 || depth[i] <= 0) continue;
      P.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, depth[i]).applyMatrix4(invVP);
      const mirrorPx = am[i * 4 + 3] > 0.99 && nr[i * 4 + 3] < 0.03;
      if (mirrorPx && nr[i * 4 + 1] > 0.99) {
        d.copy(P).sub(eye).normalize(); d.y = -d.y;
        ray.set(P, d);
        const hit = ray.intersectObjects(meshes, false)[0];
        if (hit) reflected[meshes.indexOf(hit.object as THREE.Mesh)][i] = 1;
      } else if (!mirrorPx) {
        meshes.forEach((_, k) => { if (boxes[k].containsPoint(L.copy(P).applyMatrix4(inv[k]))) direct[k][i] = 1; });
      }
    }
    const lum = (a: Float32Array, i: number) => (a[i * 4] + a[i * 4 + 1] + a[i * 4 + 2]) / 3;
    const hf = (mask: Uint8Array, img: Float32Array) => {
      let s = 0, m = 0, n = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!(mask[i] && mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W])) continue;
        const v = lum(img, i);
        s += Math.abs(v - 0.5 * (lum(img, i - 1) + lum(img, i + 1))) + Math.abs(v - 0.5 * (lum(img, i - W) + lum(img, i + W)));
        m += v; n++;
      }
      return { hf: n ? s / Math.max(m, 1e-9) : NaN, pixels: n };
    };
    return Object.fromEntries(meshes.map((m, k) => {
      const r = hf(reflected[k], rad), dd = hf(direct[k], sc);
      let n = 0, c = 0;
      for (let i = 0; i < W * H; i++) if (reflected[k][i]) { n++; if (conf[i] >= 0.9) c++; }
      const name = (m.geometry as N).type === 'SphereGeometry' ? 'sphere' : 'cube';
      return [name, { reflectedPixels: r.pixels, directPixels: dd.pixels, hfReflected: r.hf, hfDirect: dd.hf, stripeRatio: r.hf / dd.hf, confident: n ? c / n : NaN }];
    }));
  }

  /**
   * Per-tile cap: every miss-list entry's source (traced or capped) from the RT source target,
   * counted per 8x8 tile. Traced entries per tile must stay <= the frame's tile cap, and traced
   * entries in all <= maxTracedRaysPerFrame.
   */
  async function tileCapCheck() {
    await idle();
    const core = ssr.tracer!, rt = ssr.traced!;
    const stats = await rt.readStats();
    const n = stats.misses;
    const list = n ? await readU32(device, core.outputs.missList!, n * 8) : [];
    const src = await readTexture(device, rt.source);
    const perTile = new Map<number, number>();
    let traced = 0, capped = 0, other = 0;
    for (let k = 0; k < n; k++) {
      const p = list[2 * k];
      const x = p & 32767, y = (p >>> 15) & 16383;
      const code = Math.round(src[y * W + x]);
      if (code === 1 || code === 2 || code === 4) {
        traced++;
        const t = (y >> 3) * rt.tilesX + (x >> 3);
        perTile.set(t, (perTile.get(t) ?? 0) + 1);
      } else if (code === 3) capped++; else other++;
    }
    const maxPerTile = Math.max(0, ...perTile.values());
    return { entries: n, traced, capped, other, tilesTraced: perTile.size, maxPerTile, stats };
  }

  /**
   * Hit-shading error (D55): traced hits the camera also sees are shaded twice, once from the
   * screen (scene colour, the reference) and once by the hit shading (reuse off); compare.
   */
  async function hitShadingError() {
    const rt = ssr.traced!, core = ssr.tracer!;
    const keep = ssr.traceSettings;
    frame(); await idle();
    const [srcA, radA] = await Promise.all([readTexture(device, rt.source), readTexture(device, core.outputs.radiance)]);
    ssr.traceSettings = { ...keep, reuseOnScreenHits: false };
    frame(); await idle();
    const radB = await readTexture(device, core.outputs.radiance);
    ssr.traceSettings = keep;
    let n = 0, sa = 0, sb = 0, sabs = 0;
    for (let i = 0; i < W * H; i++) {
      if (Math.round(srcA[i]) !== 4) continue;
      const a = (radA[i * 4] + radA[i * 4 + 1] + radA[i * 4 + 2]) / 3, b = (radB[i * 4] + radB[i * 4 + 1] + radB[i * 4 + 2]) / 3;
      n++; sa += a; sb += b; sabs += Math.abs(a - b);
    }
    return { pixels: n, meanScreen: n ? sa / n : 0, meanShaded: n ? sb / n : 0, ratio: sa ? sb / sa : NaN, meanAbsRel: sa ? sabs / sa : NaN };
  }

  /**
   * The provider against three's CPU raycaster on the same rays: n rays from the camera through a
   * jittered pixel grid, first-hit distance on the GPU (traceFirstHit in a one-off kernel) vs
   * THREE.Raycaster over the same meshes, double-sided like the BVH walk.
   */
  async function rtOracle(n = 4096) {
    if (!provider) throw new Error('rtOracle needs ?rt=1');
    const cam = kit!.camera;
    cam.updateMatrixWorld();
    const origins = new Float32Array(n * 4), dirs = new Float32Array(n * 4);
    const o = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld), v = new THREE.Vector3();
    const side = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const sx = ((i % side) + 0.37) / side, sy = (Math.floor(i / side) + 0.61) / side;
      v.set(sx * 2 - 1, 1 - sy * 2, 0.5).unproject(cam).sub(o).normalize();
      origins.set([o.x, o.y, o.z, 0], i * 4); dirs.set([v.x, v.y, v.z, 0], i * 4);
    }
    const code = `${HIT_WGSL}
@group(0) @binding(0) var<storage, read> rayO: array<vec4f>;
@group(0) @binding(1) var<storage, read> rayD: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outT: array<vec4f>;
${provider.code({ group: 1, firstBinding: 0 })}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rayO)) { return; }
  let h = traceFirstHit(rayO[id.x].xyz, rayD[id.x].xyz, 1000.0);
  outT[id.x] = vec4f(h.t, f32(h.material), select(0.0, 1.0, h.frontFace), 0.0);
}`;
    const mk = (a: Float32Array<ArrayBuffer>, usage: number) => { const b = device.createBuffer({ size: a.byteLength, usage }); device.queue.writeBuffer(b, 0, a); return b; };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const bo = mk(origins, S), bd = mk(dirs, S);
    const bt = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bl0 = device.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 2 ? 'storage' as const : 'read-only-storage' as const } })) });
    const bl1 = device.createBindGroupLayout({ entries: provider.entries.map((e, binding) => ({ ...e, binding } as GPUBindGroupLayoutEntry)) });
    const pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bl0, bl1] }), compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: bl0, entries: [bo, bd, bt].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    pass.setBindGroup(1, device.createBindGroup({ layout: bl1, entries: provider.resources().map((resource, binding) => ({ binding, resource })) }));
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    const rb = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(bt, 0, rb, 0, n * 16);
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const gpuWallMs = performance.now() - t0;
    const gpu = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); [bo, bd, bt, rb].forEach((b) => b.destroy());
    // CPU: three's raycaster, double-sided (the BVH walk has no face culling)
    const meshes: THREE.Mesh[] = [];
    kit!.scene.traverseVisible((m) => { if ((m as THREE.Mesh).isMesh && !(m as N).isHelper && !m.userData.noTrace) meshes.push(m as THREE.Mesh); });
    const sides = new Map<THREE.Material, THREE.Side>();
    for (const m of meshes) for (const mat of ([] as THREE.Material[]).concat(m.material)) { sides.set(mat, mat.side); mat.side = THREE.DoubleSide; }
    const rc = new THREE.Raycaster();
    rc.far = 1000;
    let agree = 0, bothMiss = 0, gpuOnly = 0, cpuOnly = 0, maxRel = 0;
    const errs: number[] = [];
    for (let i = 0; i < n; i++) {
      rc.set(new THREE.Vector3(origins[i * 4], origins[i * 4 + 1], origins[i * 4 + 2]), new THREE.Vector3(dirs[i * 4], dirs[i * 4 + 1], dirs[i * 4 + 2]));
      const hit = rc.intersectObjects(meshes, false)[0];
      const tg = gpu[i * 4];
      if (!hit && tg < 0) { bothMiss++; agree++; continue; }
      if (!hit) { gpuOnly++; continue; }
      if (tg < 0) { cpuOnly++; continue; }
      const rel = Math.abs(tg - hit.distance) / hit.distance;
      errs.push(rel);
      maxRel = Math.max(maxRel, rel);
      if (rel < 1e-3) agree++;
    }
    for (const [mat, sd] of sides) mat.side = sd;
    errs.sort((a, b) => a - b);
    return { rays: n, agree, bothMiss, gpuOnly, cpuOnly, maxRel, p99Rel: errs.length ? errs[Math.floor(errs.length * 0.99)] : 0, gpuWallMs };
  }
}

main().catch((e) => {
  console.error(e);
  document.querySelector<HTMLElement>('#status')!.textContent = String(e?.stack ?? e);
});
