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
// `&bvh=pmndrs` uses core's @pmndrs/bvh provider instead (createPmndrsBvhTraceProviderFromObjects;
// `&bvhBuilder=tinybvh|gpu-hploc|gpu-lbvh`, default auto = H-PLOC with subgroups, tinybvh without).
// `window.__p.rtCompare(n)` traces the same rays through both providers (SPEC phase 4 gate).
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
  HybridReflections, MeshBVHTraceProvider, ReflectionProbe, ReflectionProbes, ScreenSpaceReflectionsPass, getGPUTexture, installCubeArraySupport, reflectionProbes, reflectionsRequiredLimits,
  createPmndrsBvhTraceProviderFromObjects, type ThreePmndrsBvhTraceProvider,
} from '@pmndrs/reflections/three';
import { HIT_WGSL, type TraceProvider, type BvhBuilderPreference } from '@pmndrs/reflections/core';
import { ASSET_SCENES, SCENES, type KitScene } from '../../shared';
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
/** Ray sets for the oracles: from the camera, or spread through the scene (incoherent). */
type RayKind = 'camera' | 'scene';
const HIT_MODES: HitColorMode[] = ['current', 'lit', 'final'];
const useRT = q.get('rt') === '1';
/** Which BVH the ray-traced fallback uses: three-mesh-bvh (default, the stopgap) or core's @pmndrs/bvh. */
type BvhKind = 'three-mesh-bvh' | 'pmndrs';
const bvhKind: BvhKind = q.get('bvh') === 'pmndrs' ? 'pmndrs' : 'three-mesh-bvh';
const bvhBuilder = (q.get('bvhBuilder') ?? 'auto') as BvhBuilderPreference;
const wantDenoise = q.has('denoise') ? q.get('denoise') !== '0' : true;

const VIEWS = ['final', 'raw', 'split', 'noSSR', 'ssr', 'confidence', 'ssrWeight', 'hitFade', 'probeConsistency', 'hitDistance', 'rays', 'misses', 'specular', 'signal', 'probeSpecular', 'coverage', 'source', 'rtSource', 'grid'] as const;
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
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: { ...(adapter ? reflectionsRequiredLimits(adapter) : {}), maxColorAttachmentBytesPerSample: maxBytes } } as N);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  // cube arrays on stock r187 (W20 shim, self-tested; patches nothing and probes keep the 2D array if it fails). ?shim=0 opts out.
  if (q.get('shim') !== '0') await installCubeArraySupport(renderer);
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
        // local probe coverage (0 = environment only), on geometry
        case 'coverage': return c.geometry.select(vec3(c.coverage), vec3(0.02, 0.03, 0.08));
        case 'confidence': return c.geometry.select(vec3(c.confidence), vec3(0.02, 0.03, 0.08));
        // the weight the composite gives the hit against the probe / environment term (W22)
        case 'ssrWeight': return c.geometry.select(vec3(c.ssrWeight), vec3(0.02, 0.03, 0.08));
        // its two inputs: the screen-edge fade at the hit, and the share of the probe term whose surface is not behind the hit
        case 'hitFade': return c.geometry.select(vec3(c.hitFade), vec3(0.02, 0.03, 0.08));
        case 'probeConsistency': return c.geometry.select(vec3(c.probeConsistency), vec3(0.02, 0.03, 0.08));
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
  type ExampleProvider = TraceProvider & { destroy(): void };
  let provider: ExampleProvider | null = null;
  let refitProvider: () => void = () => {};
  /** The @pmndrs/bvh build (instance -> three object), when `bvh=pmndrs`. */
  let pmndrsBuild: ThreePmndrsBvhTraceProvider | null = null;
  let bvhInfo: { kind: BvhKind; meshes: number; triangles: number; buildMs: number; builder?: string; fallbackReason?: string | null } | null = null;
  const traceMeshes = (root: THREE.Object3D) => {
    const meshes: THREE.Mesh[] = [];
    root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !(o as N).isHelper && !o.userData.noTrace) meshes.push(o as THREE.Mesh); });
    return meshes;
  };
  async function buildProvider(kind: BvhKind, meshes: THREE.Mesh[]) {
    const t0 = performance.now();
    if (kind === 'pmndrs') {
      const built = await createPmndrsBvhTraceProviderFromObjects(device, meshes, { builder: bvhBuilder });
      const i = built.provider.info;
      return { provider: built.provider as ExampleProvider, pmndrs: built, refit: built.refit, info: { kind, meshes: meshes.length, triangles: i.triangles, buildMs: performance.now() - t0, builder: i.builder, fallbackReason: i.fallbackReason } };
    }
    const p = await MeshBVHTraceProvider.fromObjects(device, meshes);
    return { provider: p as ExampleProvider, pmndrs: null, refit: () => p.refit(), info: { kind, meshes: meshes.length, triangles: p.triangles, buildMs: performance.now() - t0 } };
  }
  let time = 0, paused = false;

  async function load(id: string) {
    const factory = SCENES[id] ?? Object.values(ASSET_SCENES).find((a) => a.id === id)?.factory;
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
        if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
        if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
        probes.add(p);
      }
      kit.scene.add(probes);
      probes.bake(renderer, kit.scene, { resolution: 128, near: 0.05, far: 60 });
      nextNodeFrame();
      kit.scene.environmentNode = reflectionProbes(probes) as N;
    }
    if (useRT) {
      // every visible mesh except helpers; one BVH per scene (two-level: instances over mesh trees)
      kit.scene.updateMatrixWorld(true);
      const meshes = traceMeshes(kit.scene);
      provider?.destroy();
      const built = await buildProvider(bvhKind, meshes);
      provider = built.provider; pmndrsBuild = built.pmndrs; refitProvider = built.refit; bvhInfo = built.info;
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
    if (provider && kit.update) { kit.scene.updateMatrixWorld(); refitProvider(); }
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
  const depthBox = document.createElement('input'); depthBox.type = 'checkbox'; depthBox.checked = q.get('depthAware') !== '0';
  hybrid.depthAware.value = depthBox.checked ? 1 : 0;
  depthBox.onchange = () => { hybrid.depthAware.value = depthBox.checked ? 1 : 0; if (!looping) frame(); };
  row('Depth-aware blend', depthBox);
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
      useRT ? `ray-traced misses: ${ssr.rayTracing ? 'on' : 'off'} (${bvhKind === 'pmndrs' ? '@pmndrs/bvh' : 'three-mesh-bvh'}${bvhInfo ? `, ${bvhInfo.meshes} meshes, ${bvhInfo.triangles} triangles, built in ${bvhInfo.buildMs.toFixed(0)} ms${bvhInfo.builder ? ` by ${bvhInfo.builder}${bvhInfo.fallbackReason ? ` (${bvhInfo.fallbackReason})` : ''}` : ''}` : ''}; &bvh=pmndrs|three-mesh-bvh)` : 'ray-traced misses: off (?rt=1)',
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
      /** W22: the composite's depth-aware blend (D2400) on / off (FFX's confidence blend). */
      setDepthAware(on: boolean) { hybrid.depthAware.value = on ? 1 : 0; depthBox.checked = on; },
      setSettings(s: N) { Object.assign(ssr.settings, s); },
      setHitColor: (m: HitColorMode) => setHitColor(m),
      setRT(on: boolean) { ssr.rayTracing = on; },
      hybrid, get denoiserName() { return denoiser?.name ?? null; },
      setDenoise(on: boolean) { hybrid.denoise = on && !!denoiser; denoiseBox.checked = hybrid.denoise; },
      setTraceSettings(s: N) { ssr.traceSettings = { ...s }; },
      traceStats: () => ssr.readTraceStats(),
      get bvh() { return bvhInfo; },
      tileCapCheck: () => tileCapCheck(),
      rtOracle: (n?: number, rays?: RayKind, which?: BvhKind) => rtOracle(n, rays, which),
      rtCompare: (n?: number, rays?: RayKind) => rtCompare(n, rays),
      hitShadingError: (extra?: N, variants?: N[]) => hitShadingError(extra, variants),
      rtAnyHitOracle: (n?: number, rays?: RayKind) => rtAnyHitOracle(n, rays),
      rtShadowEffect: () => rtShadowEffect(),
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
      blendStats: () => blendStats(),
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
  /**
   * W22: where the composite's blend puts the probe on a reflected object. mirrorWall's mirror-floor
   * pixels, classified by their exact planar reflection ray (three's raycaster, every mesh but the
   * floor): `sphere` / `object` = the ray's first hit is the sphere / another object (cube, posts),
   * so the probe (the wall, box-projected) is wrong there; `behind` = the first hit is the wall at a point the camera
   * can't see (an object covers it), so screen space can't know and the probe is the right answer;
   * `wall` = a visible wall point. Per class: pixel count, the tracer's confidence (0, partial
   * (0, 0.9) and the tiny part of it (0, 1e-3), >= 0.9, mean) and the composite's SSR weight (`ssrWeight`, read from the view, the
   * weight the hit gets against the probe/environment term). `sphereProbe` / `objectProbe` = mean
   * probe weight (1 - ssrWeight) over those px: the wall showing through the reflected objects
   * (part of it is the screen-edge fade, e.g. the posts at the frame's sides); `behindSSR` = mean
   * SSR weight over `behind` px (a streak where the probe was right).
   */
  async function blendStats() {
    await idle();
    const keepView = viewSel.value as View;
    setView('ssrWeight');
    const url = await (async () => { frame(); const u = canvas.toDataURL('image/png'); await idle(); return u; })();
    setView(keepView);
    const img = new Image(); img.src = url; await img.decode();
    const c2 = new OffscreenCanvas(W, H); const g2 = c2.getContext('2d')!; g2.drawImage(img, 0, 0);
    const shown = g2.getImageData(0, 0, W, H).data;
    const core = ssr.tracer!;
    const t = ssr.gbuffer.gpuTextures();
    const [depth, nr, am, conf] = await Promise.all([
      readTexture(device, t.depth), readTexture(device, t.normal), readTexture(device, t.albedo), readTexture(device, core.outputs.confidence),
    ]);
    const cam = ssr.gbuffer.frame!.camera;
    const VP = new THREE.Matrix4().fromArray(cam.projection as N).multiply(new THREE.Matrix4().fromArray(cam.view as N));
    const invVP = VP.clone().invert();
    const eye = new THREE.Vector3(...(cam.position as [number, number, number]));
    const inverted = ssr.gbuffer.conventions.depthInverted;
    // every mesh but the floor (a plane facing up)
    const meshes: THREE.Object3D[] = [];
    kit!.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as N).isHelper) return;
      if (m.geometry.type === 'PlaneGeometry' && m.getWorldDirection(new THREE.Vector3()).y > 0.99) return;
      meshes.push(m);
    });
    const ray = new THREE.Raycaster();
    ray.near = 1e-3;
    const P = new THREE.Vector3(), d = new THREE.Vector3(), s = new THREE.Vector3();
    type Acc = { px: number; zero: number; tiny: number; partial: number; confident: number; conf: number; weight: number };
    const acc = (): Acc => ({ px: 0, zero: 0, tiny: 0, partial: 0, confident: 0, conf: 0, weight: 0 });
    const cls: Record<string, Acc> = { sphere: acc(), object: acc(), behind: acc(), wall: acc() };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (inverted ? depth[i] <= 0 : depth[i] >= 1) continue;
      if (!(am[i * 4 + 3] > 0.99 && nr[i * 4 + 3] < 0.03 && nr[i * 4 + 1] > 0.99)) continue;
      P.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, depth[i]).applyMatrix4(invVP);
      d.copy(P).sub(eye).normalize(); d.y = -d.y;
      ray.set(P, d);
      const first = ray.intersectObjects(meshes, false)[0];
      if (!first) continue;
      let k: string;
      if ((first.object as THREE.Mesh).geometry.type === 'PlaneGeometry') {
        s.copy(first.point).applyMatrix4(VP);
        const sx = Math.floor((s.x * 0.5 + 0.5) * W), sy = Math.floor((0.5 - s.y * 0.5) * H);
        const seen = sx >= 0 && sy >= 0 && sx < W && sy < H && Math.abs(depth[sy * W + sx] - s.z) < 2e-4;
        k = seen ? 'wall' : 'behind';
      } else k = (first.object as THREE.Mesh).geometry.type === 'SphereGeometry' ? 'sphere' : 'object';
      const a = cls[k];
      a.px++; a.conf += conf[i];
      if (conf[i] <= 0) a.zero++; else if (conf[i] < 0.9) a.partial++; else a.confident++;
      if (conf[i] > 0 && conf[i] < 1e-3) a.tiny++;
      a.weight += shown[i * 4] / 255;
    }
    const out = Object.fromEntries(Object.entries(cls).map(([k, a]) => [k, {
      px: a.px, zero: a.px ? a.zero / a.px : 0, tiny: a.px ? a.tiny / a.px : 0, partial: a.px ? a.partial / a.px : 0, confident: a.px ? a.confident / a.px : 0,
      meanConfidence: a.px ? a.conf / a.px : 0, meanWeight: a.px ? a.weight / a.px : 0,
    }]));
    const probeShare = (a: Acc) => (a.px ? 1 - a.weight / a.px : 0);
    return { ...out, sphereProbe: probeShare(cls.sphere), objectProbe: probeShare(cls.object), behindSSR: cls.behind.px ? cls.behind.weight / cls.behind.px : 0 };
  }

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
   * `extra`: trace settings for both frames (e.g. `{ hitShadows: false }`, D903). With `variants`,
   * one reference frame and one shaded frame per variant (settings on top of `extra`), all on the
   * same rays: the SSSR frame index is pinned, so the variants compare the same pixels.
   * Returns the first variant's numbers, plus `variants` (each with `darker`: the fraction of
   * pixels more than 1% darker than the first variant, and `brighter` likewise).
   */
  async function hitShadingError(extra: N = {}, variants: N[] = [{}]) {
    const rt = ssr.traced!, core = ssr.tracer!;
    const keep = ssr.traceSettings;
    const keepFrame = (ssr.settings as N).frameIndex;
    (ssr.settings as N).frameIndex = 7;
    ssr.traceSettings = { ...keep, ...extra };
    frame(); await idle();
    const [srcA, radA] = await Promise.all([readTexture(device, rt.source), readTexture(device, core.outputs.radiance)]);
    const shaded: Float32Array[] = [];
    for (const v of variants) {
      ssr.traceSettings = { ...keep, ...extra, ...v, reuseOnScreenHits: false };
      frame(); await idle();
      shaded.push(await readTexture(device, core.outputs.radiance));
    }
    ssr.traceSettings = keep;
    if (keepFrame === undefined) delete (ssr.settings as N).frameIndex; else (ssr.settings as N).frameIndex = keepFrame;
    const lum = (r: Float32Array, i: number) => (r[i * 4] + r[i * 4 + 1] + r[i * 4 + 2]) / 3;
    const out = shaded.map((radB) => {
      let n = 0, sa = 0, sb = 0, sabs = 0, darker = 0, brighter = 0;
      for (let i = 0; i < W * H; i++) {
        if (Math.round(srcA[i]) !== 4) continue;
        const a = lum(radA, i), b = lum(radB, i), b0 = lum(shaded[0], i);
        n++; sa += a; sb += b; sabs += Math.abs(a - b);
        if (b < b0 * 0.99 - 1e-6) darker++;
        if (b > b0 * 1.01 + 1e-6) brighter++;
      }
      return { pixels: n, meanScreen: n ? sa / n : 0, meanShaded: n ? sb / n : 0, ratio: sa ? sb / sa : NaN, meanAbsRel: sa ? sabs / sa : NaN, darker: n ? darker / n : 0, brighter: n ? brighter / n : 0 };
    });
    return { ...out[0], variants: out };
  }

  /**
   * D903: what the shadow rays change on the hits the hit shading shades (source 1, with on-screen
   * reuse as configured): the same rays (pinned frame index) with `hitShadows` off, on, off again
   * (noise floor). Fractions of those pixels > 1% darker / brighter, and mean luminance off -> on.
   */
  async function rtShadowEffect() {
    const rt = ssr.traced!, core = ssr.tracer!;
    const keep = ssr.traceSettings;
    const keepFrame = (ssr.settings as N).frameIndex;
    (ssr.settings as N).frameIndex = 7;
    const runs: { src: Float32Array; rad: Float32Array }[] = [];
    for (const hitShadows of [false, true, false]) {
      ssr.traceSettings = { ...keep, hitShadows };
      frame(); await idle();
      const [src, rad] = await Promise.all([readTexture(device, rt.source), readTexture(device, core.outputs.radiance)]);
      runs.push({ src, rad });
    }
    ssr.traceSettings = keep;
    if (keepFrame === undefined) delete (ssr.settings as N).frameIndex; else (ssr.settings as N).frameIndex = keepFrame;
    const lum = (r: Float32Array, i: number) => (r[i * 4] + r[i * 4 + 1] + r[i * 4 + 2]) / 3;
    const cmp = (x: number) => {
      let n = 0, darker = 0, brighter = 0, s0 = 0, s1 = 0;
      for (let i = 0; i < W * H; i++) {
        if (Math.round(runs[0].src[i]) !== 1 || Math.round(runs[x].src[i]) !== 1) continue;
        const a = lum(runs[0].rad, i), b = lum(runs[x].rad, i);
        n++; s0 += a; s1 += b;
        if (b < a * 0.99 - 1e-6) darker++;
        if (b > a * 1.01 + 1e-6) brighter++;
      }
      return { pixels: n, darker: n ? darker / n : 0, brighter: n ? brighter / n : 0, meanOff: n ? s0 / n : 0, mean: n ? s1 / n : 0 };
    };
    return { on: cmp(1), noise: cmp(2) };
  }

  // ---- ray oracle --------------------------------------------------------------------------------
  /**
   * Rays for the oracles: 'camera' = n rays from the camera through a jittered pixel grid; 'scene'
   * = n rays from points spread through the traced meshes' bounding box in directions spread over
   * the sphere (incoherent, like reflection rays). Deterministic.
   */
  function makeRays(n: number, kind: RayKind) {
    const origins = new Float32Array(n * 4), dirs = new Float32Array(n * 4);
    if (kind === 'camera') {
      const cam = kit!.camera;
      cam.updateMatrixWorld();
      const o = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld), v = new THREE.Vector3();
      const side = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i++) {
        const sx = ((i % side) + 0.37) / side, sy = (Math.floor(i / side) + 0.61) / side;
        v.set(sx * 2 - 1, 1 - sy * 2, 0.5).unproject(cam).sub(o).normalize();
        origins.set([o.x, o.y, o.z, 0], i * 4); dirs.set([v.x, v.y, v.z, 0], i * 4);
      }
      return { origins, dirs };
    }
    const box = new THREE.Box3();
    for (const m of traceMeshes(kit!.scene)) box.expandByObject(m);
    const size = box.getSize(new THREE.Vector3());
    // Halton (2, 3, 5) points in the box, Fibonacci-sphere directions shuffled by a fixed stride
    const halton = (i: number, b: number) => { let f = 1, r = 0; for (let k = i + 1; k > 0; k = Math.floor(k / b)) { f /= b; r += f * (k % b); } return r; };
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      origins.set([box.min.x + size.x * halton(i, 2), box.min.y + size.y * halton(i, 3), box.min.z + size.z * halton(i, 5), 0], i * 4);
      const j = (i * 7919) % n, y = 1 - (2 * (j + 0.5)) / n, r = Math.sqrt(1 - y * y), phi = j * golden;
      dirs.set([Math.cos(phi) * r, y, Math.sin(phi) * r, 0], i * 4);
    }
    return { origins, dirs };
  }

  /**
   * traceFirstHit of `p` in a one-off kernel. Per ray 8 words: t, material (u32), frontFace (0/1),
   * instance (u32), normal xyz, triangle (u32).
   */
  async function traceRays(p: TraceProvider, origins: Float32Array<ArrayBuffer>, dirs: Float32Array<ArrayBuffer>) {
    const n = origins.length / 4;
    const code = `${HIT_WGSL}
@group(0) @binding(0) var<storage, read> rayO: array<vec4f>;
@group(0) @binding(1) var<storage, read> rayD: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outT: array<vec4f>;
${p.code({ group: 1, firstBinding: 0 })}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rayO)) { return; }
  let h = traceFirstHit(rayO[id.x].xyz, rayD[id.x].xyz, 1000.0);
  outT[id.x * 2u] = vec4f(h.t, bitcast<f32>(h.material), select(0.0, 1.0, h.frontFace), bitcast<f32>(h.instance));
  outT[id.x * 2u + 1u] = vec4f(h.normal, bitcast<f32>(h.triangle));
}`;
    const mk = (a: Float32Array<ArrayBuffer>, usage: number) => { const b = device.createBuffer({ size: a.byteLength, usage }); device.queue.writeBuffer(b, 0, a); return b; };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const bo = mk(origins, S), bd = mk(dirs, S);
    const bytes = n * 32;
    const bt = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bl0 = device.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 2 ? 'storage' as const : 'read-only-storage' as const } })) });
    const bl1 = device.createBindGroupLayout({ entries: p.entries.map((e, binding) => ({ ...e, binding } as GPUBindGroupLayoutEntry)) });
    const pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bl0, bl1] }), compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: bl0, entries: [bo, bd, bt].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    pass.setBindGroup(1, device.createBindGroup({ layout: bl1, entries: p.resources().map((resource, binding) => ({ binding, resource })) }));
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    const rb = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(bt, 0, rb, 0, bytes);
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const gpuWallMs = performance.now() - t0;
    const data = rb.getMappedRange().slice(0);
    rb.unmap(); [bo, bd, bt, rb].forEach((b) => b.destroy());
    return { f: new Float32Array(data), u: new Uint32Array(data), gpuWallMs };
  }

  /**
   * D903: the provider's `traceAny` against its own `traceFirstHit` on the same rays. Per ray, with
   * t = first-hit distance: traceAny(tMax 1000) must equal (t >= 0); where t > 0, traceAny(0.5 t)
   * must be false (nothing nearer) and traceAny(1.5 t) true. Also the GPU ms of both walks over
   * the rays (one-off kernels, timestamp queries if available, else wall time to readback).
   */
  async function rtAnyHitOracle(n = 4096, kind: RayKind = 'camera') {
    if (!provider) throw new Error('rtAnyHitOracle needs ?rt=1');
    const p = provider;
    const { origins, dirs } = makeRays(n, kind);
    const code = `${HIT_WGSL}
@group(0) @binding(0) var<storage, read> rayO: array<vec4f>;
@group(0) @binding(1) var<storage, read> rayD: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outR: array<vec4u>;
${p.code({ group: 1, firstBinding: 0 })}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rayO)) { return; }
  let o = rayO[id.x].xyz;
  let d = rayD[id.x].xyz;
  let h = traceFirstHit(o, d, 1000.0);
  var near = 0u; var far = 1u;
  if (h.t > 0.0) { near = select(0u, 1u, traceAny(o, d, 0.5 * h.t)); far = select(0u, 1u, traceAny(o, d, 1.5 * h.t)); }
  outR[id.x] = vec4u(bitcast<u32>(h.t), select(0u, 1u, traceAny(o, d, 1000.0)), near, far);
}`;
    const mk = (a: Float32Array<ArrayBuffer>) => { const b = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, a); return b; };
    const bo = mk(origins), bd = mk(dirs), bytes = n * 16;
    const br = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bl0 = device.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 2 ? 'storage' as const : 'read-only-storage' as const } })) });
    const bl1 = device.createBindGroupLayout({ entries: p.entries.map((e, binding) => ({ ...e, binding } as GPUBindGroupLayoutEntry)) });
    const pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bl0, bl1] }), compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: bl0, entries: [bo, bd, br].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    pass.setBindGroup(1, device.createBindGroup({ layout: bl1, entries: p.resources().map((resource, binding) => ({ binding, resource })) }));
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    const rb = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(br, 0, rb, 0, bytes);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(rb.getMappedRange().slice(0)), f = new Float32Array(u.buffer);
    rb.unmap(); [bo, bd, br, rb].forEach((b) => b.destroy());
    let hits = 0, agree = 0, nearOk = 0, farOk = 0, positive = 0;
    for (let i = 0; i < n; i++) {
      const t = f[i * 4], hit = t >= 0;
      if (hit) hits++;
      if ((u[i * 4 + 1] === 1) === hit) agree++;
      if (t > 0) { positive++; if (u[i * 4 + 2] === 0) nearOk++; if (u[i * 4 + 3] === 1) farOk++; }
    }
    return { provider: bvhInfo?.kind ?? null, rays: n, kind, hits, agree, positive, nearOk, farOk };
  }

  const relErr = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1e-2);
  const pct = (errs: number[], q: number) => (errs.length ? errs.sort((a, b) => a - b)[Math.min(errs.length - 1, Math.floor(errs.length * q))] : 0);

  /**
   * The current provider against three's CPU raycaster on the same rays (first-hit distance,
   * double-sided like the BVH walks). Also, where both hit within 1e-3: the triangle (faceIndex),
   * the world geometric normal (three's face normal through the normal matrix; `normalSigned` =
   * same side, `normalAbs` = same line, cos >= 0.999), frontFace = (dot(normal, dir) < 0), and for
   * @pmndrs/bvh the instance (object + instanceId) and the material id the walk reports.
   */
  async function rtOracle(n = 4096, kind: RayKind = 'camera', which?: BvhKind) {
    if (!provider || !bvhInfo) throw new Error('rtOracle needs ?rt=1');
    const meshes = traceMeshes(kit!.scene);
    // `which` other than the page's provider: build that one for this call only
    const temp = which && which !== bvhInfo.kind ? await buildProvider(which, meshes) : null;
    const tested = temp?.provider ?? provider, pmndrs = temp ? temp.pmndrs : pmndrsBuild;
    const { origins, dirs } = makeRays(n, kind);
    const { f, u, gpuWallMs } = await traceRays(tested, origins, dirs);
    temp?.provider.destroy();
    const sides = new Map<THREE.Material, THREE.Side>();
    for (const m of meshes) for (const mat of ([] as THREE.Material[]).concat(m.material)) { sides.set(mat, mat.side); mat.side = THREE.DoubleSide; }
    // @pmndrs/bvh: instance index -> the object it came from, and the material id it was given
    const instanceOf = new Map<THREE.Object3D, Map<number, number>>();
    pmndrs?.sources.forEach((s, i) => { if (!instanceOf.has(s.mesh)) instanceOf.set(s.mesh, new Map()); instanceOf.get(s.mesh)!.set(s.instanceId, i); });
    const rc = new THREE.Raycaster();
    rc.far = 1000;
    let agree = 0, bothMiss = 0, gpuOnly = 0, cpuOnly = 0, maxRel = 0, compared = 0;
    let triangle = 0, normalSigned = 0, normalAbs = 0, frontFace = 0, instance = 0, material = 0;
    const examples: string[] = [];
    const errs: number[] = [];
    const nm = new THREE.Matrix3(), wm = new THREE.Matrix4(), im = new THREE.Matrix4(), wn = new THREE.Vector3(), d = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      d.set(dirs[i * 4], dirs[i * 4 + 1], dirs[i * 4 + 2]);
      rc.set(new THREE.Vector3(origins[i * 4], origins[i * 4 + 1], origins[i * 4 + 2]), d);
      const hit = rc.intersectObjects(meshes, false)[0];
      const tg = f[i * 8];
      if (!hit && tg < 0) { bothMiss++; agree++; continue; }
      if (!hit) { gpuOnly++; continue; }
      if (tg < 0) { cpuOnly++; continue; }
      const rel = relErr(tg, hit.distance);
      errs.push(rel);
      maxRel = Math.max(maxRel, rel);
      if (rel >= 1e-3) continue;
      agree++; compared++;
      if (u[i * 8 + 7] === hit.faceIndex) triangle++;
      else if (examples.length < 4) {
        const g = (hit.object as THREE.Mesh).geometry;
        examples.push(`triangle ${u[i * 8 + 7]} vs faceIndex ${hit.faceIndex} on '${hit.object.name}' (${g.index ? g.index.count / 3 : g.getAttribute('position').count / 3} tris, ${g.groups.length} groups, drawRange ${g.drawRange.start}+${g.drawRange.count})`);
      }
      wm.copy(hit.object.matrixWorld);
      if (hit.instanceId !== undefined) { (hit.object as THREE.InstancedMesh).getMatrixAt(hit.instanceId, im); wm.multiply(im); }
      wn.copy(hit.face!.normal).applyMatrix3(nm.getNormalMatrix(wm)).normalize();
      const cos = wn.x * f[i * 8 + 4] + wn.y * f[i * 8 + 5] + wn.z * f[i * 8 + 6];
      if (cos >= 0.999) normalSigned++;
      if (Math.abs(cos) >= 0.999) normalAbs++;
      if ((f[i * 8 + 2] > 0.5) === (wn.dot(d) < 0)) frontFace++;
      if (pmndrs) {
        const want = instanceOf.get(hit.object)?.get(hit.instanceId ?? -1);
        if (want !== undefined && u[i * 8 + 3] === want) instance++;
        if (want !== undefined && u[i * 8 + 1] === (pmndrs.scene.instances[want].material ?? 0xffffffff)) material++;
      }
    }
    for (const [mat, sd] of sides) mat.side = sd;
    return {
      provider: which ?? bvhInfo.kind, rays: n, kind, agree, bothMiss, gpuOnly, cpuOnly, maxRel, p99Rel: pct(errs, 0.99), gpuWallMs,
      compared, triangle, normalSigned, normalAbs, frontFace, instance: pmndrs ? instance : null, material: pmndrs ? material : null, examples,
    };
  }

  /**
   * SPEC phase 4 gate: the @pmndrs/bvh walk vs three-mesh-bvh's on the same rays (both built fresh
   * over the scene's traced meshes). Agreement = both miss, or both hit within 1e-3 relative t;
   * where both hit: normals on the same line (three-mesh-bvh's faces the ray, ours is the authored
   * side) and the same frontFace. Triangle ids are not compared: three-mesh-bvh's are positions in
   * its reordered index buffer (rtOracle checks ours against three's faceIndex).
   */
  async function rtCompare(n = 65536, kind: RayKind = 'camera') {
    const meshes = traceMeshes(kit!.scene);
    const a = await buildProvider('pmndrs', meshes);
    const b = await buildProvider('three-mesh-bvh', meshes);
    try {
      const { origins, dirs } = makeRays(n, kind);
      const ra = await traceRays(a.provider, origins, dirs);
      const rb = await traceRays(b.provider, origins, dirs);
      let agree = 0, bothMiss = 0, pmndrsOnly = 0, tmbOnly = 0, compared = 0, normal = 0, frontFace = 0, maxRel = 0;
      const errs: number[] = [];
      for (let i = 0; i < n; i++) {
        const ta = ra.f[i * 8], tb = rb.f[i * 8];
        if (ta < 0 && tb < 0) { bothMiss++; agree++; continue; }
        if (tb < 0) { pmndrsOnly++; continue; }
        if (ta < 0) { tmbOnly++; continue; }
        const rel = relErr(ta, tb);
        errs.push(rel); maxRel = Math.max(maxRel, rel);
        if (rel >= 1e-3) continue;
        agree++; compared++;
        const cos = ra.f[i * 8 + 4] * rb.f[i * 8 + 4] + ra.f[i * 8 + 5] * rb.f[i * 8 + 5] + ra.f[i * 8 + 6] * rb.f[i * 8 + 6];
        if (Math.abs(cos) >= 0.999) normal++;
        if ((ra.f[i * 8 + 2] > 0.5) === (rb.f[i * 8 + 2] > 0.5)) frontFace++;
      }
      return {
        rays: n, kind, scene: kit!.id, triangles: a.info.triangles, builder: a.info.builder, fallbackReason: a.info.fallbackReason,
        buildMs: { pmndrs: a.info.buildMs, threeMeshBvh: b.info.buildMs },
        agree, bothMiss, pmndrsOnly, tmbOnly, maxRel, p99Rel: pct(errs, 0.99), compared, normal, frontFace,
      };
    } finally {
      a.provider.destroy(); b.provider.destroy();
    }
  }
}

main().catch((e) => {
  console.error(e);
  document.querySelector<HTMLElement>('#status')!.textContent = String(e?.stack ?? e);
});
