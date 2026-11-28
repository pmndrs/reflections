// examples/ssr: the scene kit with screen-space reflections on (ScreenSpaceReflectionsPass +
// screenSpaceComposite from @pmndrs/reflections/three).
//
// Each frame: the pass renders the frame-contract G-buffer, traces with the core SSR on three's
// device and copies radiance / hit distance / confidence into three textures; a RenderPipeline
// shows the composite or a debug view. The probes suggested by each kit scene are baked and lit
// with (`scene.environmentNode = reflectionProbes(probes)`) unless `?probes=0`; the composite then
// reads them with `sampleReflectionProbesLocal` and falls back to `scene.environment` by coverage.
//
// `?rt=1` attaches a ray-traced fallback for the misses: core's @pmndrs/raytracer provider (createRaytracerTraceProviderFromObjects;
// the only provider since W89: the earlier stopgap and the @pmndrs/bvh wrapper are gone), rebuilt per scene and refitted
// per frame for animated scenes. `&bvhBuilder=tinybvh|gpu-hploc|gpu-lbvh` (default auto = H-PLOC with subgroups, tinybvh
// without), `&bvhRayMasks=1` compiles @pmndrs/bvh's instance-mask test in, `&rtPacking=split` binds the scene copy as two
// buffers (D5450), `&rtShade=1` shades traced hits with the raytracer's rtShade.
//
// `?denoise=1|0` (default on): the hybrid resolve (HybridReflections) hands the specular signal to denoiser/ffx's
// FfxReflectionDenoiser (the `denoiser` package) through the denoise seam.
//
// `?brdf=replace|combine` (W78, X3 phase B, default off): BRDF / pdf weights in the FFX denoiser's prefilter
// (the tracer hands each pixel's sample direction and pdf through the seam). Also the example-only key
// `settings.denoiserBrdf` ('off' | 'replace' | 'combine'), read every frame, so `__p.configStats` configs can set it.
// `?keepBlack=0` (or `settings.denoiserKeepBlack: false`): FFX's own black handling; on by default (HybridReflections.denoiserKeepHistoryOnBlack, D5145).
// `?keepSample=1` keeps the tracer's sample output on in every mode (A/B runs without a tracer rebuild).
// `?mirrorBias=0..1`: the tracer's bias of glossy rays toward the mirror direction (core `settings.mirrorBias`,
// SSSR 2015 / PICA, D49); also a slider. `__p.mirrorBiasStats()` measures it. Default (W76): 0.5 with the cone
// and compensation (the bias narrows the sampled lobe and the cone puts the width back); a bias set without
// `mirrorBiasCompensate` is D49's truncation (`?s.mirrorBiasCompensate=1` keeps compensation). The slider keeps
// whatever compensation the tracer was running.
//
// `?specOcc=1` (default 0): Lagarde's specular occlusion (D66) on the probe / environment part of the
// composite, from a screen-space AO (three's GTAO on the G-buffer, ../../shared/ao.ts); also a checkbox,
// and the views `ao` (the AO input) and `specularOcclusion` (the factor applied). See D4510.
//
// `window.__p` drives the page headlessly (scripts/run-headless.mjs, section `ssr`).
import * as THREE from 'three/webgpu';
import { renderOutput, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import { PROBE_LOOKUP_EXPERIMENT } from '@pmndrs/reflections-core/probes/lookup';
import { packReflectionProbesTable, probeTableStats } from '@pmndrs/reflections-three/probes/ReflectionProbesNode';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  HybridReflections, ReflectionProbe, applyReflectionsPreset, defaultHitMaterial, type DenoiserHitSourceMode, type ReflectionsPresetName, ReflectionProbes, type BakeOptions, ScreenSpaceReflectionsPass, getGPUTexture, installCubeArraySupport, reflectionProbes, reflectionsRequiredLimits,
  type ThreeRaytracerTraceProvider, createRaytracerTraceProviderFromObjects, applySpecularAA, SPECULAR_AA_VARIANCE,
} from '@pmndrs/reflections/three';
import { DEFAULT_SHADING_NORMAL_WGSL, HIT_WGSL, type TraceProvider, type BvhBuilderPreference } from '@pmndrs/reflections/core';
import {
  ASSET_SCENES, SCENES, TEST_SCENES, PROBE_LAYOUT_BUDGET, PROBE_LAYOUT_NAMES, availableAssets, hasProbeLayouts, probeAtlasBytes, probeGrid, probeLayout, type KitScene, type ProbeLayout, type ProbeLayoutName, type ProbeVolume,
} from '../../shared';
import { HEAT_LEGEND, ProbeVolumesOverlay, gbufferWorldPosition, heatColor, probeColor, probeWeights } from '../../shared/probeDebug';
import { SHOWCASE } from '../../showcase/src/scenes';
import { brdfFromQuery, createReflectionDenoiser, denoiserAvailable, denoiserSource, hitSourceDenoiserOptions, hitSourceFromQuery, syncDenoiserBrdf, type DenoiserBrdf } from '../../shared/denoiser';
import { AA_MODES, DisplayAA, aaFromQuery, reflectionReactive, renderSize, type AAMode } from '../../shared/antialias';
import { ScreenSpaceAO } from '../../shared/ao';
import { canvasReader, createMetrics } from '../../shared/metrics/run';
import { gbufferGlossyMask, hybridReaders } from '../../shared/metrics/three';
import { ssrSettingsFromQuery } from '../../shared/ssrQuery';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const q = new URLSearchParams(location.search);
const manual = q.has('manual');
/**
 * Anti-aliasing (../../shared/antialias.ts, W36): `?aa=upscaler|taa|off`, default @pmndrs/upscaler's
 * temporal path at ratio 1 (NativeAA), off under `?manual` (the headless checks compare unjittered
 * pixels); `?taa=0|1` = off / upscaler. `?upscale=quality|balanced|performance|ultra|<ratio>`: the
 * G-buffer and reflections run at the render size, the upscaler rebuilds the display size (`?w=&h=`).
 * `?reactive=<0..1>` scales the reactive mask (the reflection's share of the pixel in motion, D4202).
 */
const aaQuery = aaFromQuery(q, manual ? 'off' : 'upscaler');
const DW = Number(q.get('w') ?? 960), DH = Number(q.get('h') ?? 540);
const reactiveScale = Number(q.get('reactive') ?? 0);
/** Render (G-buffer, tracer, denoiser) size: the display size unless upscaling. */
const { width: W, height: H } = renderSize(DW, DH, aaQuery.ratio);
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
/** W77: ?preset=performance|default (core REFLECTION_PRESETS, through the three adapter's `preset` options). */
// an unknown name is passed on: the pass and the hybrid warn once and ignore it
const presetName = (q.get('preset') as ReflectionsPresetName | null) ?? null;
const bvhBuilder = (q.get('bvhBuilder') ?? 'auto') as BvhBuilderPreference;
/** `&bvhRayMasks=1`: @pmndrs/bvh's walk with its instance-mask test compiled in (W48; default off, D3591). */
const bvhRayMasks = q.get('bvhRayMasks') === '1';
/** W82 (T70): `&rtShade=1` shades traced hits with @pmndrs/raytracer's rtShade instead of the probes. */
const rtShade = q.get('rtShade') === '1';
/** W89 (D5450): `&rtPacking=split` binds the scene copy as table + data (5 storage buffers) instead of packed (4). */
const rtPacking = q.get('rtPacking') === 'split' ? 'split' as const : 'auto' as const;
// W97: traced hits sample base colour textures. `?rtTextures=0`: the maps' averages (before W97); `?rtCone=0.05`: the LOD ray cone (default 0.012)
const rtTextures = q.get('rtTextures') === '0' ? false as const : q.get('rtCone') ? { cone: Number(q.get('rtCone')) } : undefined;
/** `&shadingNormals=0`: traced hits shaded with the flat geometric normal (D1700 A/B). */
const shadingNormals = q.get('shadingNormals') !== '0';
const wantDenoise = q.has('denoise') ? q.get('denoise') !== '0' : true;
/**
 * W61, probe layouts at an equal memory budget (../../shared/probeLayouts.ts): `?probeLayout=shipped|few|medium|many|manyCell|mixed`
 * on the scenes that have them (rooms, offscreen, showcaseSponza = the showcase's Sponza); `?probeBlend=` the grid's
 * blend distance as a share of its cell's shorter side (default 0.25); `?probeVolumes=1` draws the volumes. With a
 * layout the page tracks GPU timestamps (three's passes and the core passes) for the HUD's "Time" button.
 */
const layoutMode = q.has('probeLayout');
/**
 * W61 (D4804) / W62 (D4900): every probe size is one more atlas binding wherever the set is sampled. The library
 * asks for up to 32 sampled textures per stage (`reflectionsRequiredLimits`); `?texLimit=default` pins WebGPU's
 * default 16 (Sponza's three-size set fits since the lookups share their atlas nodes, D4900); `?texLimit=adapter`
 * asks for the adapter's own limit (up to 48).
 */
const texLimit = (adapter: GPUAdapter | null): Record<string, number> => {
  const v = q.get('texLimit');
  if (v === 'default') return { maxSampledTexturesPerShaderStage: 16 };
  return adapter && v === 'adapter' ? { maxSampledTexturesPerShaderStage: Math.min(adapter.limits.maxSampledTexturesPerShaderStage, 48) } : {};
};
const timingOn = q.has('gpuTime') || layoutMode;
/** W63 bench only: `?lookupExp=skip,loop,...` compiles a probe lookup variant (core's PROBE_LOOKUP_EXPERIMENT). */
if (q.has('lookupExp')) PROBE_LOOKUP_EXPERIMENT.mode = q.get('lookupExp')!;

const VIEWS = ['final', 'raw', 'split', 'noSSR', 'ssr', 'confidence', 'ssrWeight', 'hitFade', 'probeConsistency', 'hitDistance', 'rays', 'misses', 'specular', 'signal', 'probeSpecular', 'coverage', 'source', 'rtSource', 'grid', 'ao', 'specularOcclusion',
  // W61 probe views: the dominant probe (its palette colour over the lit image), the volumes blended per px (heat),
  // and two for the checks: raw data (r = dominant + 1, g = count, b = roughness, /255) and |weights' sum - coverage| x 50
  'probeIndex', 'probeCount', 'probeData', 'probeCheck'] as const;
type View = (typeof VIEWS)[number];
/** Views that are a tone-mapped image: fed to the upscaler linear, tone-mapped after it. */
const LINEAR_VIEWS: View[] = ['final', 'raw', 'split', 'signal', 'noSSR', 'ssr', 'specular', 'probeSpecular'];
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
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: q.get('reversedDepth') === '1', trackTimestamp: timingOn, requiredLimits: { ...(adapter ? reflectionsRequiredLimits(adapter) : {}), maxColorAttachmentBytesPerSample: maxBytes, ...texLimit(adapter) } } as N);
  renderer.setPixelRatio(1);
  renderer.setSize(DW, DH, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  // cube arrays on stock r187 (W20 shim, self-tested; patches nothing and probes keep the 2D array if it fails). ?shim=0 opts out.
  if (q.get('shim') !== '0') await installCubeArraySupport(renderer);
  const ssr = new ScreenSpaceReflectionsPass(renderer, {
    gbufferOptions: { width: W, height: H }, missList: true, timestamps: q.has('timing') || layoutMode,
    subgroups: q.get('variant') !== 'workgroup',
    // W75 (X5, D5080): ?res=half traces, denoises at half res and upsamples
    ...(q.get('res') === 'half' || q.get('res') === 'mixed' ? { settings: { reflectionResolution: 'half' as const } } : {}),
    ...(q.get('res') === 'full' ? { settings: { reflectionResolution: 'full' as const } } : {}),
    // W77: ?preset=performance|default (core REFLECTION_PRESETS); ?res= and ?hitSource= given explicitly win
    ...(presetName ? { preset: presetName } : {}),
  });
  const device = ssr.device;
  // hybrid resolve + denoise seam (phase 5)
  // W77: ?hitSource=0|hits|all|1 (W53: what the denoiser keeps apart), read as the bench and the showcase read it
  // (hitSourceFromQuery: 0 / off = off, 1 = all) and set at construction like an app would: the page's own
  // setting, which wins over ?preset= and which a preset change returns to
  const hitSourceQ = q.has('hitSource') ? hitSourceFromQuery(q) : null;
  const denoiserExtra = hitSourceQ ? hitSourceDenoiserOptions(hitSourceQ) : {};
  let denoiser = denoiserAvailable ? createReflectionDenoiser(device, 0.447, q.has('timing'), denoiserExtra) : null;
  const hybrid = new HybridReflections(ssr, { denoiser, ...(hitSourceQ ? { denoiserHitSource: hitSourceQ.hitSource } : {}), ...(presetName ? { preset: presetName } : {}) });
  // FFX's options are constructor-only, so the denoiser follows the tracer's roughness threshold by
  // being rebuilt when it changes (D1402); checked once per frame, so a slider drag rebuilds at most per frame.
  let denoiserGate = 0.447;
  const syncDenoiserGate = () => {
    const t = ssr.settings.roughnessThreshold ?? 0.447;
    if (!denoiser || t === denoiserGate) return;
    const old = denoiser;
    denoiser = createReflectionDenoiser(device, t, q.has('timing'), denoiserExtra)!;
    hybrid.setDenoiser(denoiser); // new seam: history starts over
    old.dispose();
    denoiserGate = t;
  };
  hybrid.denoise = wantDenoise && !!denoiser;
  // W78 (D5140): the page's BRDF mode; `settings.denoiserBrdf` (example-only) overrides it per frame
  const brdfMode = brdfFromQuery(q);
  let brdfApplied = 'off' + false;
  const syncBrdf = () => {
    const mode = ((ssr.settings as N).denoiserBrdf as DenoiserBrdf | undefined) ?? brdfMode;
    const keepBlack = ((ssr.settings as N).denoiserKeepBlack as boolean | undefined) ?? q.get('keepBlack') !== '0';
    const brdfMin = ((ssr.settings as N).denoiserBrdfMin as number | undefined) ?? (q.has('brdfMin') ? Number(q.get('brdfMin')) : undefined);
    syncDenoiserBrdf(ssr, hybrid, mode, keepBlack, brdfMin);
    if (q.get('keepSample') === '1') ssr.settings.sampleDirection = true; // A/B runs: no tracer rebuild between modes
    if (mode + keepBlack !== brdfApplied) { hybrid.resetHistory(); brdfApplied = mode + keepBlack; }
  };
  if (q.has('mirrorBias')) ssr.settings.mirrorBias = Number(q.get('mirrorBias'));
  Object.assign(ssr.settings, ssrSettingsFromQuery(q)); // W76: ?s.<field>=<value> from the first frame
  if (q.get('res') === 'mixed' || q.has('halfResMin')) console.warn("?res=mixed / ?halfResMin= were removed (W76, D5084: halfResMinRoughness and the full-res mirror path); running ?res=half");
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
  /**
   * W61: the probe views walk every volume per px; the display graph selects its view with `select`, which
   * evaluates every branch, so they are compiled in only while one of them is shown (else a 33-volume layout
   * paid ~10 ms at 1080p in 'final' for a view nobody looked at).
   */
  const PROBE_VIEWS: View[] = ['probeIndex', 'probeCount', 'probeData', 'probeCheck'];
  let shownView: View = 'final';
  let probeViewsBuilt = false;
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
  const aa = new DisplayAA(renderer, ssr.gbuffer, { ...aaQuery, displayWidth: DW, displayHeight: DH, tone });
  await aa.init();
  let hitMode: HitColorMode = (q.get('hit') as HitColorMode) ?? 'current';
  /** W39: Lagarde's specular occlusion from a screen-space AO (GTAO) on the composite's probe part (D66, D4510). */
  let specOcc = q.get('specOcc') === '1';
  let ssao: ScreenSpaceAO | null = null;
  function setHitColor(m: HitColorMode) {
    if (!HIT_MODES.includes(m)) throw new Error(`hit colour ${m}?`);
    hitMode = m;
    ssr.settings.hitColor = m === 'current' ? 'current' : 'history';
    ssr.historySource = m === 'final' ? historyRT.texture : null;
    ssr.resetHistory();
    aa.reset();
  }
  setHitColor(hitMode);
  // W44 (D3540): ?reshade=reshade|off, how a screen-space hit accounts for the view direction (default the package's 'reshade')
  if (q.has('reshade')) ssr.settings.hitShading = q.get('reshade') as 'reshade' | 'off';
  function buildDisplay() {
    // one composite, sampled at the full-screen uv or at a grid cell's local uv
    const gridUV = uv().mul(3);
    const cell = gridUV.floor();
    const at = uGrid.equal(1).select(gridUV.fract(), uv());
    // the AO source follows the scene's camera; only rendered while something samples it (specOcc or the ao view)
    ssao?.dispose();
    const ao = ssao = new ScreenSpaceAO(ssr.gbuffer, kit!.camera);
    Object.assign(hybrid.options, {
      probes: useProbes && probesEnabled && compositeProbes ? probes : null, environment: kit!.scene.environment, environmentIntensity: kit!.scene.environmentIntensity,
      ao: specOcc ? (u: N) => ao.sample(u) : null,
    });
    hybrid.rebuild();
    const c = composite = hybrid.composite({ uv: at });
    // the raw (undenoised) composite from the same terms, for 'raw' and 'split'
    const rawFinal = c.geometry.select(c.lit.add(c.weight.mul(c.signal.sub(c.probeSpecular)).mul(c.amount)).max(0), c.lit);
    const mask = texture(maskTex, at);
    const dim = tone(c.lit).mul(0.35);
    // W61: the baked set's volume weights at this px's world position (../../shared/probeDebug.ts)
    probeViewsBuilt = PROBE_VIEWS.includes(shownView);
    const pw = probeWeights(probeViewsBuilt && useProbes && probesEnabled ? probes : null, c.probePosition); // the composite's nudged lookup position (D5420), so the views weigh what the lookup weighed
    const litLuma: N = tone(c.lit).dot(vec3(0.2126, 0.7152, 0.0722));
    const bg = vec3(0.02, 0.03, 0.08);
    // tone-mapped views (LINEAR_VIEWS): linear while the upscaler runs, which tone-maps after it
    const T = (x: N): N => aa.linear.equal(1).select(x, tone(x));
    const viewColor = (v: View): N => {
      switch (v) {
        case 'final': return T(c.final.rgb);
        case 'raw': return T(rawFinal);
        // left raw, right denoised (the final composite), a thin line between
        case 'split': return at.x.sub(0.5).abs().lessThan(0.001).select(vec3(1), at.x.lessThan(0.5).select(T(rawFinal), T(c.final.rgb)));
        case 'signal': return T(c.signal);
        case 'noSSR': return T(c.lit);
        case 'ssr': return T(c.ssr);
        case 'specular': return T(c.specular);
        case 'probeSpecular': return T(c.probeSpecular);
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
        // W39: the AO input (GTAO on the G-buffer) and the specular occlusion factor the composite applies (1 with specOcc off)
        case 'ao': return c.geometry.select(vec3(ao.sample(at)), vec3(0.02, 0.03, 0.08));
        case 'specularOcclusion': return c.geometry.select(vec3(c.specularOcclusion), vec3(0.02, 0.03, 0.08));
        // W61: the dominant probe's colour (as the volume overlay draws it) over the lit image's luma
        case 'probeIndex': return c.geometry.select(probeColor(pw.dominant, pw.volumes).mul(litLuma.mul(0.7).add(0.3)), bg);
        // W61: how many volumes the lookup samples here (weight > 0): its cost (HEAT_LEGEND)
        case 'probeCount': return c.geometry.select(heatColor(pw.count).mul(litLuma.mul(0.5).add(0.5)), bg);
        case 'probeData': return c.geometry.select(vec3(pw.dominant.add(1).div(255), pw.count.div(255), c.roughness.mul(255).round().div(255)), vec3(0));
        case 'probeCheck': return c.geometry.select(vec3(pw.sum.sub(c.coverage).abs().mul(50).min(1), 0, 0), vec3(0));
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
    // reactive (D4202): the reflection's share of the final colour, where the pixel moves (a reflection
    // does not move with its surface, so the surface's motion reprojects it to the wrong place)
    aa.setReactive(reactiveScale > 0 ? reflectionReactive(hybrid.composite(), ssr.gbuffer.textures.motion!, reactiveScale) : null);
    historyMaterial.needsUpdate = true;
    pipeline.needsUpdate = true;
  }

  // ---- scene state --------------------------------------------------------------------------------
  const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas);
  let kit: KitScene | null = null;
  let probes: ReflectionProbes | null = null;
  /** W38: `__p.setProbesEnabled(false)` lights with `scene.environment` only (the probe-free reference). */
  let probesEnabled = true;
  /** W63: the composite's own probe lookups on / off (`__p.setProbeParts`), to split the lookup's cost. */
  let compositeProbes = true;
  type ExampleProvider = TraceProvider & { destroy(): void };
  let provider: ExampleProvider | null = null;
  let refitProvider: () => void = () => {};
  /** The provider's build (instance -> three object). */
  let pmndrsBuild: ThreeRaytracerTraceProvider | null = null;
  let bvhInfo: { kind: '@pmndrs/raytracer'; meshes: number; triangles: number; buildMs: number; builder?: string; fallbackReason?: string | null; packing: string } | null = null;
  const traceMeshes = (root: THREE.Object3D) => {
    const meshes: THREE.Mesh[] = [];
    root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !(o as N).isHelper && !o.userData.noTrace) meshes.push(o as THREE.Mesh); });
    return meshes;
  };
  async function buildProvider(meshes: THREE.Mesh[]) {
    const t0 = performance.now();
    const built = await createRaytracerTraceProviderFromObjects(device, meshes, { builder: bvhBuilder, shadingNormals, rayMasks: bvhRayMasks, packing: rtPacking, textures: rtTextures });
    const i = built.provider.info;
    return { provider: built.provider as ExampleProvider, pmndrs: built, refit: built.refit, info: { kind: '@pmndrs/raytracer' as const, meshes: meshes.length, triangles: i.triangles, buildMs: performance.now() - t0, builder: i.builder, fallbackReason: i.fallbackReason, packing: i.packing } };
  }
  let time = 0, paused = false;
  /**
   * The bake's options: `?probeRes=` (the set's default face size, 256; a kit probe's own
   * `resolution` and `?probeSizes=` override it per probe, W60), `?bounces=` (default 2, D25 / D4300; 1 halves
   * the bake where no mirror or glossy surface faces another). The kit scenes keep their free-standing
   * objects out of the captures (`userData.reflectionProbeExclude`, D4301).
   */
  /** `?probeSizes=512,,256` (W60, D4700): per-probe face sizes in kit order over the kit's own (0: the set's `?probeRes=`). */
  const probeSizes = (q.get('probeSizes') ?? '').split(',').map((x) => x.trim());
  const bakeOptions = (extra: Partial<BakeOptions> = {}): BakeOptions => ({
    ...(q.has('probeRes') ? { resolution: Number(q.get('probeRes')) } : {}),
    ...(q.has('bounces') ? { bounces: Number(q.get('bounces')) } : {}),
    near: 0.05, far: 60, ...extra,
  });

  /** W38: bytes of the probe atlases (rgba16float, 6 faces per slot incl. the environment slot, every mip; every atlas, W60). */
  const probeBytes = () => probeAtlasBytes(probes as N);
  /** A probe set from volumes (the kit's suggestion, or W38's variants via `__p.setProbeVolumes`), baked and lit with. */
  function buildProbes(volumes: ProbeVolume[], extra: Partial<BakeOptions> = {}) {
    probes = makeSet(volumes);
    kit!.scene.add(probes);
    // bake as on a fresh load: a previous set left on the scene would light the first pass's captures
    kit!.scene.environmentNode = null;
    probes.bake(renderer, kit!.scene, bakeOptions(extra));
    nextNodeFrame();
    kit!.scene.environmentNode = reflectionProbes(probes) as N;
    refreshOverlay();
  }
  function makeSet(volumes: ProbeVolume[]) {
    const probes = new ReflectionProbes();
    for (const v of volumes) {
      const p = new ReflectionProbe(...v.influenceSize);
      p.position.set(...v.position);
      if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
      if (v.originOffset) p.originOffset.set(...v.originOffset);
      if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
      if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
      if (v.resolution !== undefined) p.resolution = v.resolution;
      // `?probeSizes=` (W60): per probe in kit order, a face size, 0 for the set's, empty for the kit's
      const size = probeSizes[probes.children.length];
      if (size !== undefined && size !== '') p.resolution = Number(size) > 0 ? Number(size) : null;
      probes.add(p);
    }
    return probes;
  }
  /** W61: a fixed probe set for the traced hits' shading (`traceOptions.probes`), so a ?rt=1 reference doesn't move with the set under test. */
  let traceRef: ReflectionProbes | null = null;

  // ---- W61: probe layouts at an equal memory budget, the volume overlay, the HUD's numbers ------
  let layoutName = q.get('probeLayout') as ProbeLayoutName | null;
  let layoutBlend = Number(q.get('probeBlend') ?? 0.25);
  /** The last bake: wall clock idle to idle (ms), atlas bytes, probe count. */
  let lastBake: { ms: number; bytes: number; probes: number } | null = null;
  /** The HUD's GPU ms: three's passes (rolling median of the running loop) and the last "Time" (loop stopped). */
  const rolling: number[] = [];
  let timingBusy = false;
  let lastTiming: { renderMs: number; renderSpread: [number, number]; coreMs: number; size: [number, number] } | null = null;
  let showVolumes = q.get('probeVolumes') === '1';
  let overlay: ProbeVolumesOverlay | null = null;
  function refreshOverlay() {
    if (overlay) { overlay.removeFromParent(); overlay.dispose(); overlay = null; }
    if (showVolumes && probes && kit) { overlay = new ProbeVolumesOverlay(probes); kit.scene.add(overlay); }
  }
  /** The current layout for the loaded scene (null: no layout asked, or the scene has none). */
  function currentLayout(): ProbeLayout | null {
    if (!layoutName || !kit || !hasProbeLayouts(kit.id)) return null;
    return probeLayout(kit.id, layoutName, kit.probes, { blend: layoutBlend, shippedResolution: q.has('probeRes') ? Number(q.get('probeRes')) : 256 });
  }
  /** Bake options of a layout: its set default (the environment slot's size); 'shipped' keeps the page's. */
  const layoutExtra = (L: ProbeLayout | null): Partial<BakeOptions> => (L && L.name !== 'shipped' ? { resolution: L.resolution } : {});
  const queueIdle = () => device.queue.onSubmittedWorkDone();
  /** Bakes `volumes` as the scene's set, timed (wall clock, idle to idle). */
  async function timedBuild(volumes: ProbeVolume[], extra: Partial<BakeOptions> = {}) {
    await queueIdle();
    const t0 = performance.now();
    buildProbes(volumes, extra);
    await queueIdle();
    lastBake = { ms: performance.now() - t0, bytes: probeAtlasBytes(probes as N), probes: probes!.bakedProbes.length };
    return lastBake;
  }
  /** Replaces the scene's set with `volumes` (W38's setProbeVolumes): a clean bake, materials and display rebuilt. */
  async function swapProbes(volumes: ProbeVolume[], extra: Partial<BakeOptions> = {}) {
    const old = probes;
    if (old) kit!.scene.remove(old);
    let baked: Awaited<ReturnType<typeof timedBuild>>;
    try { baked = await timedBuild(volumes, extra); } catch (e) {
      // a set the bake refused (e.g. past maxTextureArrayLayers): put the old one back
      if (probes && probes !== old) { kit!.scene.remove(probes); probes.dispose?.(); }
      probes = old;
      if (old) { kit!.scene.add(old); kit!.scene.environmentNode = reflectionProbes(old) as N; }
      refreshOverlay();
      throw e;
    }
    // every material's environment node changed: rebuild them before the old atlas goes
    kit!.scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of ([] as THREE.Material[]).concat(m)) x.needsUpdate = true; });
    buildDisplay();
    frame(); await queueIdle();
    old?.dispose?.();
    ssr.resetHistory(); hybrid.resetHistory(); aa.reset();
    return baked;
  }
  /** W61: bake layout `name` (blend: the grid's share of its cell) for the loaded scene. */
  async function setProbeLayout(name: ProbeLayoutName, blend = layoutBlend) {
    layoutName = name; layoutBlend = blend;
    const L = currentLayout();
    if (!L) throw new Error(`no probe layout ${name} for ${kit?.id}`);
    const baked = await swapProbes(L.volumes, layoutExtra(L));
    const u = new URL(location.href); u.searchParams.set('probeLayout', name); if (L.blend !== undefined) u.searchParams.set('probeBlend', String(blend)); history.replaceState(null, '', u);
    refreshUI();
    return { layout: name, description: L.description, planned: L.bytes, spacing: L.spacing ?? null, blend: L.blend ?? null, ...baked, sizes: probes!.bakedResolutions };
  }
  /** The showcase's Sponza (polished floor, seven probes) as a kit scene. */
  async function showcaseSponza(opts: { aspect?: number } = {}): Promise<KitScene> {
    const s = await SHOWCASE.find((e) => e.id === 'sponza')!.build(opts.aspect ?? 16 / 9);
    return { id: 'showcaseSponza', title: 'Sponza (the showcase\'s: polished floor, 7 probes)', scene: s.scene, camera: s.camera, target: new THREE.Vector3(...s.views.courtyard.target), views: s.views, probes: s.probes, exposure: s.exposure } as KitScene;
  }

  async function load(id: string) {
    const factory = SCENES[id] ?? TEST_SCENES[id] ?? Object.values(ASSET_SCENES).find((a) => a.id === id)?.factory ?? (id === 'showcaseSponza' ? showcaseSponza : undefined);
    if (!factory) throw new Error(`unknown scene ${id}`);
    kit?.dispose?.();
    probes?.dispose?.();
    probes = null;
    if (overlay) { overlay.removeFromParent(); overlay.dispose(); overlay = null; }
    status.textContent = `loading ${id}...`;
    kit = await factory({ aspect: W / H });
    // W105: ?specularAA=variance (&specularAAVariance=<sigma^2>): the package's variance-form geometric specular AA
    if (q.get('specularAA') === 'variance') applySpecularAA(kit.scene, { mode: 'variance', variance: Number(q.get('specularAAVariance') ?? SPECULAR_AA_VARIANCE), traceRoughness: q.get('specularAATrace') === 'material' ? 'material' : 'filtered' });
    controls.object = kit.camera;
    controls.target.copy(kit.target);
    controls.update();
    time = 0; kit.update?.(0);
    renderer.toneMappingExposure = (kit as N).exposure ?? 1;
    lastBake = null; lastTiming = null; rolling.length = 0;
    if (useProbes && kit.probes.length) { const L = currentLayout(); await timedBuild(L ? L.volumes : kit.probes, layoutExtra(L)); }
    if (useRT) {
      // every visible mesh except helpers; one BVH per scene (two-level: instances over mesh trees)
      kit.scene.updateMatrixWorld(true);
      const meshes = traceMeshes(kit.scene);
      provider?.destroy();
      const built = await buildProvider(meshes);
      provider = built.provider; pmndrsBuild = built.pmndrs; refitProvider = built.refit; bvhInfo = built.info;
      ssr.setTraceProvider(provider);
      ssr.setRaytracerHitShading(rtShade);
    }
    ssr.gbuffer.resetHistory();
    ssr.resetHistory();
    buildDisplay();
    hybrid.resetHistory();
    aa.reset();
    refreshUI();
    return { id: kit.id, views: Object.keys(kit.views), probes: (probes as ReflectionProbes | null)?.bakedProbes.length ?? 0, animated: !!kit.update };
  }

  function setPose(name: string) {
    const v = kit!.views[name];
    if (!v) throw new Error(`no view ${name} in ${kit!.id}`);
    kit!.camera.position.set(...v.pos);
    if (v.fov) { kit!.camera.fov = v.fov; kit!.camera.updateProjectionMatrix(); }
    controls.target.set(...v.target);
    controls.update();
    aa.reset();
  }

  function frame() {
    if (!kit) return;
    if (manual || !looping) nextNodeFrame();
    kit.camera.aspect = W / H; kit.camera.updateProjectionMatrix(); kit.camera.updateMatrixWorld();
    if (provider && kit.update) { kit.scene.updateMatrixWorld(); refitProvider(); }
    syncBrdf();
    ssr.render(kit.scene, kit.camera, aa.begin(kit.camera));
    aa.end(kit.camera);
    syncDenoiserGate();
    hybrid.update();
    updateMask();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(aa.target);
    pipeline.render();
    renderer.setRenderTarget(prev);
    aa.resolve(kit.camera);
    if (timingOn && !timingBusy) {
      void renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then((ms) => {
        if (typeof ms !== 'number' || !ms) return;
        rolling.push(ms); if (rolling.length > 60) rolling.shift();
      });
    }
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
  // W61: the showcase's Sponza (seven probes, polished floor), when `pnpm assets` fetched it
  if ((await availableAssets()).some((a) => a.dir === 'Sponza')) sceneSel.append(new Option('showcaseSponza', 'showcaseSponza'));
  for (const v of VIEWS) viewSel.append(new Option(v, v));
  sceneSel.onchange = () => { const u = new URL(location.href); u.searchParams.set('scene', sceneSel.value); u.searchParams.delete('pose'); history.replaceState(null, '', u); load(sceneSel.value).then(() => !looping && frame()); };
  viewSel.onchange = () => { setView(viewSel.value as View); refreshUI(); if (!looping) frame(); };
  poseSel.onchange = () => { setPose(poseSel.value); if (!looping) frame(); };
  row('Scene', sceneSel); row('Show', viewSel); row('Camera', poseSel);
  const thr = document.createElement('input'); thr.type = 'range'; thr.min = '0'; thr.max = '1'; thr.step = '0.01'; thr.value = '0.447';
  thr.oninput = () => { ssr.settings.roughnessThreshold = Number(thr.value); refreshUI(); if (!looping) frame(); };
  row('Roughness threshold (perceptual)', thr);
  const biasIn = document.createElement('input'); biasIn.type = 'range'; biasIn.min = '0'; biasIn.max = '1'; biasIn.step = '0.05'; biasIn.value = String(ssr.settings.mirrorBias ?? 0.5); // W76: the resolved default (cone + compensation)
  biasIn.oninput = () => {
    // W76: a set mirrorBias alone means D49's truncation; keep the compensation the tracer ran (on by default)
    ssr.settings.mirrorBiasCompensate ??= ssr.tracer?.outputs.settings?.mirrorBiasCompensate ?? true;
    ssr.settings.mirrorBias = Number(biasIn.value); hybrid.resetHistory(); refreshUI(); if (!looping) frame();
  };
  row('Mirror bias (D49)', biasIn);
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
  const aaSel = document.createElement('select');
  for (const [k, v] of Object.entries(AA_MODES)) aaSel.append(new Option(v, k));
  aaSel.value = aa.mode;
  const setAA = (m: AAMode) => { aa.mode = m; aaSel.value = m; refreshUI(); };
  aaSel.onchange = () => { setAA(aaSel.value as AAMode); if (!looping) frame(); };
  row(aa.ratio > 1 ? `Anti-aliasing (upscale x${aa.ratio})` : 'Anti-aliasing', aaSel);
  const depthBox = document.createElement('input'); depthBox.type = 'checkbox'; depthBox.checked = q.get('depthAware') !== '0';
  hybrid.depthAware.value = depthBox.checked ? 1 : 0;
  depthBox.onchange = () => { hybrid.depthAware.value = depthBox.checked ? 1 : 0; if (!looping) frame(); };
  row('Depth-aware blend', depthBox);
  const soBox = document.createElement('input'); soBox.type = 'checkbox'; soBox.checked = specOcc;
  const setSpecOcc = (on: boolean) => { specOcc = on; soBox.checked = on; buildDisplay(); hybrid.resetHistory(); aa.reset(); refreshUI(); };
  soBox.onchange = () => { setSpecOcc(soBox.checked); if (!looping) frame(); };
  row('Specular occlusion (GTAO, D66)', soBox);
  const pauseBox = document.createElement('input'); pauseBox.type = 'checkbox'; pauseBox.onchange = () => { paused = pauseBox.checked; };
  row('Pause', pauseBox);
  // ---- W61: probe layouts at an equal memory budget (rooms, offscreen, showcaseSponza) ----
  const layoutSel = document.createElement('select');
  layoutSel.append(new Option('(scene default)', ''));
  for (const n of PROBE_LAYOUT_NAMES) layoutSel.append(new Option(n, n));
  layoutSel.value = layoutName ?? '';
  const relayout = () => {
    if (!layoutSel.value || !kit || !hasProbeLayouts(kit.id)) return;
    const was = looping; stopLoop();
    setProbeLayout(layoutSel.value as ProbeLayoutName, Number(blendIn.value)).then(() => { if (was) startLoop(); else frame(); }).catch((e) => { status.textContent = String(e); });
  };
  layoutSel.onchange = relayout;
  row('Probe layout', layoutSel);
  const blendIn = document.createElement('input'); blendIn.type = 'range'; blendIn.min = '0.05'; blendIn.max = '0.5'; blendIn.step = '0.05'; blendIn.value = String(layoutBlend);
  blendIn.onchange = relayout;
  row('Grid blend (x cell)', blendIn);
  const volBox = document.createElement('input'); volBox.type = 'checkbox'; volBox.checked = showVolumes;
  volBox.onchange = () => { showVolumes = volBox.checked; refreshOverlay(); if (!looping) frame(); };
  row('Probe volumes', volBox);
  const timeBtn = document.createElement('button'); timeBtn.textContent = 'Time (loop stopped)'; timeBtn.disabled = !timingOn;
  timeBtn.title = timingOn ? 'GPU ms over 30 frames with the render loop stopped' : 'needs ?gpuTime or ?probeLayout';
  timeBtn.onclick = async () => {
    const was = looping; stopLoop(); timeBtn.disabled = true;
    try {
      const P = (window as N).__p;
      const r = await P.renderTime(30), t = await P.time(30);
      lastTiming = { renderMs: r?.ms ?? NaN, renderSpread: [r?.p10 ?? NaN, r?.p90 ?? NaN], coreMs: Object.values(t.ms as Record<string, number>).reduce((a, b) => a + b, 0), size: [W, H] };
    } finally { timeBtn.disabled = false; refreshUI(); if (was) startLoop(); else frame(); }
  };
  panel.append(timeBtn);
  /** "2 x 512 + 24 x 128" for the baked set. */
  const sizeSummary = () => {
    if (!probes) return '';
    const per = new Map<number, number>();
    probes.bakedAtlases.forEach((a) => { const r = probes!.bakedResolutions[a]; per.set(r, (per.get(r) ?? 0) + 1); });
    return [...per].sort((a, b) => b[0] - a[0]).map(([r, n]) => `${n} x ${r}`).join(' + ');
  };
  const medianOf = (a: number[]) => { const x = [...a].sort((p, q) => p - q); return x[x.length >> 1]; };
  function refreshUI() {
    sceneSel.value = kit!.id;
    const pose = poseSel.value;
    poseSel.replaceChildren(...Object.keys(kit!.views).map((v) => new Option(v, v)));
    if (kit!.views[pose]) poseSel.value = pose;
    status.textContent = [
      `three r${THREE.REVISION} | ${kit!.title} | ${W}x${H}${manual ? ' | manual (loop stopped)' : ''}`,
      `variant ${ssr.variant ?? '(first frame pending)'} | hit colour ${hitMode} | roughnessThreshold ${ssr.settings.roughnessThreshold ?? 0.447} perceptual | mirrorBias ${ssr.tracer?.outputs.settings?.mirrorBias ?? ssr.settings.mirrorBias ?? 0.5}${ssr.tracer?.outputs.settings?.mirrorBiasCompensate && ssr.tracer?.outputs.settings?.hitColorFilter === 'cone' ? ' (compensated)' : ''} | lit target ${ssr.gbuffer.lit ? 'on' : 'OFF (composite unavailable)'}`,
      `specular IBL term: ${probes ? `${probes.bakedProbes.length} probe(s) by coverage, then scene.environment` : 'scene.environment'} | specular occlusion ${specOcc ? 'on (GTAO, probe part)' : 'off'} (?specOcc=1)`,
      `denoise: ${denoiser ? `${hybrid.denoise ? 'on' : 'off'} (${denoiser.name}, from ${denoiserSource})` : 'unavailable (no sibling Denoiser repo; raw signal)'}`,
      ...(probes ? [`probes: ${(() => { const L = currentLayout(); return L ? `layout '${L.name}' (${L.description}${L.blend !== undefined ? `, blend ${L.blend} x ${L.spacing!.toFixed(2)} m cell` : ''})` : (layoutName && kit && !hasProbeLayouts(kit.id) ? `(no layouts for ${kit.id}: rooms, offscreen, showcaseSponza)` : 'the scene\'s own'); })()} | ${sizeSummary()} px + environment ${probes.bakedResolutions[0]} px | atlases ${(probeAtlasBytes(probes as N) / 1e6).toFixed(1)} MB (layout budget ${(PROBE_LAYOUT_BUDGET / 1e6).toFixed(1)}) | bake ${lastBake ? lastBake.ms.toFixed(0) : '-'} ms (wall, 2 bounces unless ?bounces=)`] : []),
      ...(timingOn ? [`GPU ms: three's passes (G-buffer + probe lookups, composite, display) ${rolling.length ? medianOf(rolling).toFixed(2) : '-'} running${lastTiming ? ` | loop stopped at ${lastTiming.size.join('x')}: three's passes ${lastTiming.renderMs.toFixed(2)} (p10 ${lastTiming.renderSpread[0].toFixed(2)}, p90 ${lastTiming.renderSpread[1].toFixed(2)}), core passes (SSR${ssr.rayTracing ? ' + RT' : ''}) ${lastTiming.coreMs.toFixed(2)}` : ' | press Time for loop-stopped numbers'}`] : []),
      ...(viewSel.value === 'probeCount' ? [`probeCount: volumes blended per px (lookup samples): ${HEAT_LEGEND.map(([, l]) => l).join(' / ')} = dark blue / green / yellow / orange / red / magenta`] : []),
      ...(viewSel.value === 'probeIndex' ? ['probeIndex: the dominant probe per px, in the colour the volume overlay draws it (?probeVolumes=1)'] : []),
      useRT ? `ray-traced misses: ${ssr.rayTracing ? (ssr.traceError ? `unavailable (${ssr.traceError})` : 'on') : 'off'} (@pmndrs/raytracer${bvhInfo ? `, ${bvhInfo.meshes} meshes, ${bvhInfo.triangles} triangles, scene copy ${bvhInfo.packing}, built in ${bvhInfo.buildMs.toFixed(0)} ms${bvhInfo.builder ? ` by ${bvhInfo.builder}${bvhInfo.fallbackReason ? ` (${bvhInfo.fallbackReason})` : ''}` : ''}` : ''})` : 'ray-traced misses: off (?rt=1)',
    ].join('\n');
  }
  function setView(v: View) {
    aa.reset();
    aa.toneView = LINEAR_VIEWS.includes(v);
    uGrid.value = v === 'grid' ? 1 : 0;
    uView.value = VIEWS.indexOf(v);
    viewSel.value = v;
    shownView = v;
    if (PROBE_VIEWS.includes(v) !== probeViewsBuilt && composite) buildDisplay();
  }

  await load(q.get('scene') ?? 'mirrorWall');
  if (q.get('pose')) setPose(q.get('pose')!);
  setView((q.get('view') as View) ?? 'final');
  if (manual) frame(); else startLoop();
  refreshUI();

  // ---- headless hooks ----------------------------------------------------------------------------
  const idle = () => device.queue.onSubmittedWorkDone();
  // X0 (W70): the experiment plan's flicker / firefly metrics (../../shared/metrics/README.md), loop stopped
  const readCanvas = canvasReader(DW, DH);
  const metrics = createMetrics({
    width: DW, height: DH,
    async step(n = 1) { stopLoop(); for (let i = 0; i < n; i++) frame(); await idle(); },
    async grab() { stopLoop(); frame(); const d = readCanvas(canvas); await idle(); return d; },
    reset() { ssr.resetHistory(); hybrid.resetHistory(); ssr.gbuffer.resetHistory(); aa.reset(); },
    async reflectionMask() { stopLoop(); frame(); await idle(); return gbufferGlossyMask(ssr, DW, DH); },
    getView: () => ({ pos: kit!.camera.position.toArray() as [number, number, number], target: controls.target.toArray() as [number, number, number] }),
    setView(pos, target) { kit!.camera.position.set(...pos); controls.target.set(...target); kit!.camera.lookAt(controls.target); kit!.camera.updateMatrixWorld(); },
    ...hybridReaders(renderer, ssr, hybrid),
    setDenoise(on) { const was = hybrid.denoise; hybrid.denoise = on && !!denoiser; denoiseBox.checked = hybrid.denoise; return was; },
    jitterPhases: () => (aa.mode === 'upscaler' ? aa.upscaler.jitterPhaseCount : null),
    describe: () => ({ page: 'ssr', scene: kit?.id, aa: aa.mode, ratio: aa.ratio, render: [W, H], display: [DW, DH], denoiser: hybrid.denoise ? denoiser?.name ?? null : null, rt: ssr.rayTracing, hit: hitMode,
      // W76: the defaults the tracer resolved last frame (cone / compensation; 'relative' thickness with RT)
      effective: (({ hitColorFilter, mirrorBias, mirrorBiasCompensate, hitColorConeGrazing, thicknessDepthMode, thicknessDepthFactor }) => ({ hitColorFilter, mirrorBias, mirrorBiasCompensate, hitColorConeGrazing, thicknessDepthMode, thicknessDepthFactor }))(ssr.tracer?.outputs.settings ?? {}) }),
  });
  Object.assign(window, {
    __p: {
      metrics,
      THREE, renderer, ssr, controls, get kit() { return kit; }, gpuErrors, get variant() { return ssr.variant; },
      scenes: () => Object.keys(SCENES),
      /** Ids of the downloaded asset scenes `load()` takes (W49's material survey). */
      assets: async () => { const dirs = new Set((await availableAssets()).map((a) => a.dir)); return Object.entries(ASSET_SCENES).filter(([dir]) => dirs.has(dir)).map(([, a]) => a.id); },
      load: (id: string) => load(id),
      setPose, setView: (v: View) => setView(v),
      /** W79 (D5160): per-row traced profile of the last `rows` rows: px with confidence > 0.01, mean confidence, geometry px. */
      async bandProfile(rows = 64, frames = 4) {
        stopLoop(); for (let i = 0; i < frames; i++) { frame(); await idle(); }
        const core = ssr.tracer!, t = ssr.gbuffer.gpuTextures();
        const [depth, conf] = await Promise.all([readTexture(device, t.depth), readTexture(device, core.outputs.confidence)]);
        const inverted = ssr.gbuffer.conventions.depthInverted;
        const out: { y: number; hit: number; meanConf: number; geo: number }[] = [];
        for (let y = H - rows; y < H; y++) {
          let hit = 0, mc = 0, geo = 0;
          for (let x = 0; x < W; x++) { const i = y * W + x; if (inverted ? depth[i] > 0 : depth[i] < 1) geo++; if (conf[i] > 0.01) hit++; mc += conf[i]; }
          out.push({ y, hit, meanConf: mc / W, geo });
        }
        let mask = ''; { const u = new Uint8Array(W * H); for (let i = 0; i < u.length; i++) u[i] = conf[i] > 0.01 ? 1 : 0; for (let i = 0; i < u.length; i += 0x8000) mask += String.fromCharCode(...u.subarray(i, i + 0x8000)); }
        return { W, H, inverted, rows: out, totalHit: conf.reduce((a, c) => a + (c > 0.01 ? 1 : 0), 0), mask: btoa(mask) };
      },
      /** W79: camera pose with a roll (up = -y) so reflected rays travel down the screen; lookAt direct (no controls). */
      setFlipped(pos: [number, number, number], target: [number, number, number], flip: boolean) {
        const c = kit!.camera; c.position.set(...pos); c.up.set(0, flip ? -1 : 1, 0); c.lookAt(...target); c.updateMatrixWorld(); aa.reset();
      },
      /** W75 (X5): reflection resolution, rebuilding the composites (W76 removed step 2's 'mixed', D5084). */
      async setResolution(r: 'full' | 'half') {
        ssr.settings.reflectionResolution = r;
        hybrid.rebuild(); buildDisplay();
        ssr.resetHistory(); hybrid.resetHistory();
      },
      /**
       * W77: apply a named preset at runtime (three `applyReflectionsPreset`; `overrides` win), rebuilding
       * the composites. Returns the applied preset.
       */
      setPreset(name: ReflectionsPresetName, overrides: Parameters<typeof applyReflectionsPreset>[2] = {}) {
        const r = applyReflectionsPreset({ ssr, hybrid }, name, overrides);
        buildDisplay(); aa.reset();
        return r;
      },
      /** W77 (W53): what the denoiser keeps apart: 'off' | 'hits' | 'all'. */
      setHitSource(mode: DenoiserHitSourceMode) { hybrid.setDenoiserHitSource(mode); aa.reset(); },
      setSSR(on: boolean) { composite!.amount.value = on ? 1 : 0; },
      /** W22: the composite's depth-aware blend (D2400) on / off (FFX's confidence blend). */
      setDepthAware(on: boolean) { hybrid.depthAware.value = on ? 1 : 0; depthBox.checked = on; },
      setSettings(s: N) { Object.assign(ssr.settings, s); },
      setHitColor: (m: HitColorMode) => setHitColor(m),
      /** W39: Lagarde's specular occlusion from GTAO on the composite's probe part (D66, D4510); rebuilds the display. */
      setSpecOcc: (on: boolean) => setSpecOcc(on),
      get specOcc() { return specOcc; },
      get ssao() { return ssao; },
      setRT(on: boolean) { ssr.rayTracing = on; },
      hybrid, get denoiserName() { return denoiser?.name ?? null; },
      /** D1402: the perceptual threshold the current denoiser was built with (its alpha gate is this squared). */
      get denoiserGate() { return denoiser ? denoiserGate : null; },
      denoiserGateCheck: (threshold?: number) => denoiserGateCheck(threshold),
      get aa() { return aa; },
      /** W36: 'upscaler' (default) | 'taa' (W40's resolve) | 'off'. */
      setAA: (m: AAMode) => setAA(m),
      /** Old switch (W40): on = the default anti-aliasing (the upscaler), off = none. */
      setTAA(on: boolean) { setAA(on ? 'upscaler' : 'off'); },
      /** GPU ms of the upscaler's passes over `n` frames (median per pass, loop stopped), plus the NDC motion copy. */
      async aaTime(n = 30) {
        stopLoop();
        const per: Record<string, number[]> = {};
        for (let i = 0; i < n + 4; i++) {
          frame(); await idle(); await new Promise((r) => setTimeout(r, 30));
          if (i >= 4) { let sum = 0; for (const [k, v] of aa.timings) { (per[k] ??= []).push(v); sum += v; } (per.total ??= []).push(sum); }
        }
        const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
        return { display: [DW, DH], render: [W, H], frames: n, ms: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Number(med(v).toFixed(4))])) };
      },
      setDenoise(on: boolean) { hybrid.denoise = on && !!denoiser; denoiseBox.checked = hybrid.denoise; },
      setTraceSettings(s: N) { ssr.traceSettings = { ...s }; },
      /** D901 A/B: traced hits lit by the scene's probes (default) or always by the environment mean (`false`). */
      setHitProbes(on: boolean) { const o = (ssr as N).traceOptions; if (o) { if (on) delete o.probes; else o.probes = null; } },
      get hitShadingSource() { return ssr.hitShadingSource; },
      traceStats: () => ssr.readTraceStats(),
      get bvh() { return bvhInfo && { ...bvhInfo, provider: provider?.name }; },
      tileCapCheck: () => tileCapCheck(),
      rtOracle: (n?: number, rays?: RayKind) => rtOracle(n, rays),
      rtMaterialCheck: (n?: number, rays?: RayKind) => rtMaterialCheck(n, rays),
      hitShadingError: (extra?: N, variants?: N[]) => hitShadingError(extra, variants),
      rtAnyHitOracle: (n?: number, rays?: RayKind) => rtAnyHitOracle(n, rays),
      rtShadowEffect: () => rtShadowEffect(),
      rtHitRadiance: (extra?: N) => rtHitRadiance(extra),
      stop: stopLoop, start: startLoop,
      get probes() { return probes; },
      /** W109 (T43) bench: the probe nodes' table checks / packs / bytes uploaded (`always`: pack + upload on every check, as before T43). */
      tableStats: probeTableStats,
      /** W109 (T43) bench: CPU ms per call, median of `rounds` x `n` calls: the version check vs a pack + 64 KB upload. */
      tableCost(n = 200, rounds = 9) {
        if (!probes) return null;
        const set = probes, buf = device.createBuffer({ size: 1 << 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        let packed = new Float32Array(0) as Float32Array<ArrayBuffer>;
        const med = (f: () => void) => { const v: number[] = []; for (let r = 0; r < rounds; r++) { const t0 = performance.now(); for (let i = 0; i < n; i++) f(); v.push((performance.now() - t0) / n); } v.sort((a, b) => a - b); return v[v.length >> 1]; };
        const check = med(() => set.updateVersion());
        const pack = med(() => { packed = packReflectionProbesTable(set, packed, { atlases: 'all' }); });
        const upload = med(() => device.queue.writeBuffer(buf, 0, packed));
        buf.destroy();
        return { check, pack, upload, bytes: packed.byteLength, probes: set.bakedProbes.length };
      },
      /**
       * W37: re-bake the scene's probes with the page's options plus `extra` (`bounces`, `exclude`
       * as a predicate over meshes or a list). `include: true` first clears every
       * `userData.reflectionProbeExclude` (the kit's own exclusions), to bake with everything captured.
       * Returns the bake's ms (wall clock to the queue draining, loop stopped), median of `repeat`.
       */
      async rebake(extra: N = {}, repeat = 1) {
        if (!probes || !kit) return null;
        stopLoop();
        const { include, exclude, ...rest } = extra;
        const saved: THREE.Object3D[] = [];
        if (include) kit.scene.traverse((o) => { if (o.userData.reflectionProbeExclude) { saved.push(o); o.userData.reflectionProbeExclude = false; } });
        let list: THREE.Object3D[] | undefined;
        if (typeof exclude === 'function') { list = []; kit.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && exclude(o)) list!.push(o); }); } else list = exclude;
        const ms: number[] = [];
        try {
          for (let i = 0; i < repeat; i++) {
            await idle();
            const t0 = performance.now();
            probes.bake(renderer, kit.scene, bakeOptions({ ...rest, ...(list ? { exclude: list } : {}) }));
            await idle();
            ms.push(performance.now() - t0);
          }
        } finally { for (const o of saved) o.userData.reflectionProbeExclude = true; }
        nextNodeFrame();
        ssr.resetHistory(); hybrid.resetHistory(); aa.reset();
        ms.sort((a, b) => a - b);
        return { ms: ms[ms.length >> 1], all: ms, excluded: list?.length ?? 0 };
      },
      /**
       * W38: replace the scene's probe set with `volumes` (null: the kit's own), baked with the page's
       * options plus `extra`. Returns the probe count, the bake's wall-clock ms (idle to idle, loop
       * stopped) and the atlas's bytes (every slot incl. the environment, all mips).
       */
      async setProbeVolumes(volumes: ProbeVolume[] | null, extra: N = {}) {
        if (!kit) return null;
        stopLoop();
        const b = await swapProbes(volumes ?? kit.probes, extra);
        return { probes: b.probes, ms: b.ms, bytes: b.bytes };
      },
      /** W61: bake probe layout `name` for the loaded scene (../../shared/probeLayouts.ts); loop stopped. */
      async setProbeLayout(name: ProbeLayoutName, blend?: number) { stopLoop(); return setProbeLayout(name, blend); },
      /** W61: the layout `name` as planned for the loaded scene (volumes, planned bytes), without baking. */
      probeLayout: (name: ProbeLayoutName, blend?: number) => (kit ? probeLayout(kit.id, name, kit.probes, { blend: blend ?? layoutBlend }) : null),
      layoutNames: () => [...PROBE_LAYOUT_NAMES], layoutBudget: PROBE_LAYOUT_BUDGET,
      /** W63: an `n`-cell 128 px grid over the loaded scene's regions (null without layouts). */
      probeGrid: (n: number, opts: { resolution?: number; blend?: number } = {}) => (kit ? probeGrid(kit.id, n, opts) : null),
      get lastBake() { return lastBake; },
      /** W61: the volume overlay on / off. */
      setShowVolumes(on: boolean) { showVolumes = on; volBox.checked = on; refreshOverlay(); },
      /**
       * W61: traced hits shaded by a fixed set baked from `volumes` (one size: D4702 leaves other atlases out
       * at hits), `null` back to the scene's. Bakes with no environment node (D4402), off the scene graph after.
       */
      async setTraceProbes(volumes: ProbeVolume[] | null, extra: N = {}) {
        if (!kit) return null;
        stopLoop();
        const o = (ssr as N).traceOptions;
        traceRef?.dispose(); traceRef = null;
        if (!o) return null;
        if (!volumes) { delete o.probes; return null; }
        const keep = kit.scene.environmentNode;
        const ref = makeSet(volumes);
        kit.scene.add(ref);
        kit.scene.environmentNode = null;
        ref.bake(renderer, kit.scene, bakeOptions(extra));
        nextNodeFrame();
        await idle();
        kit.scene.remove(ref);
        kit.scene.environmentNode = keep;
        o.probes = traceRef = ref;
        ssr.resetHistory(); hybrid.resetHistory();
        return { probes: ref.bakedProbes.length, sizes: ref.bakedResolutions };
      },
      probeBytes: () => probeBytes(),
      /**
       * W38: the probe-free reference for the miss-fill metric: with `false` the lit image and the
       * composite use `scene.environment` only, and traced hits are lit by the environment, so a
       * `?rt=1` frame no longer depends on what the probes captured (D901). `true` restores the probes.
       */
      setProbesEnabled(on: boolean) {
        if (!kit) return;
        kit.scene.environmentNode = on && probes ? (reflectionProbes(probes) as N) : null;
        kit.scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of ([] as THREE.Material[]).concat(m)) x.needsUpdate = true; });
        probesEnabled = on;
        buildDisplay();
        ssr.resetHistory(); hybrid.resetHistory(); aa.reset();
      },
      /** W63 bench only: compile lookup variant `mode` (core's PROBE_LOOKUP_EXPERIMENT; '' the shipped lookup) into every lookup. */
      setLookupExp(mode: string) { PROBE_LOOKUP_EXPERIMENT.mode = mode; (this as N).setProbeParts(true, true); },
      /** W63: the probe lookups of the lit materials and of the composite on / off separately (cost split). */
      setProbeParts(material: boolean, composite: boolean) {
        if (!kit) return;
        kit.scene.environmentNode = material && probes ? (reflectionProbes(probes) as N) : null;
        kit.scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of ([] as THREE.Material[]).concat(m)) x.needsUpdate = true; });
        compositeProbes = composite;
        buildDisplay();
        ssr.resetHistory(); hybrid.resetHistory(); aa.reset();
      },
      /**
       * W38: GPU ms of three's render passes per frame (`?gpuTime`: the renderer tracks timestamps),
       * median of `n` frames, loop stopped: the G-buffer (whose lit image runs every material's probe
       * lookup), the composite (its probe lookup per pixel) and the display; the core passes are
       * `time()`. The probe lookup's cost is the difference between two probe sets on the same frame.
       */
      async renderTime(n = 30) {
        stopLoop();
        if (!(renderer as N).backend.trackTimestamp) return null;
        const v: number[] = [];
        timingBusy = true;
        try {
          await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
          for (let i = 0; i < n + 3; i++) {
            frame(); await idle();
            const ms = await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
            if (i >= 3 && typeof ms === 'number') v.push(ms);
          }
        } finally { timingBusy = false; }
        v.sort((a, b) => a - b);
        return { frames: v.length, ms: v[v.length >> 1], p10: v[Math.floor(v.length * 0.1)], p90: v[Math.floor(v.length * 0.9)] };
      },
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
      /** W26 (D53): the probe set's seam options, [distanceRoughness, roughnessLerp] (null without probes). */
      getSeamOptions() { return probes ? [probes.distanceRoughness, probes.roughnessLerp] : null; },
      /** W26 (D53): Lagarde's seam options on the probe set (lit and composite rebuilt together). */
      setSeamOptions(distanceRoughness: boolean, roughnessLerp = distanceRoughness) {
        if (!probes) return false;
        probes.distanceRoughness = distanceRoughness; probes.roughnessLerp = roughnessLerp;
        buildDisplay(); hybrid.resetHistory();
        return true;
      },
      /** W26: the roughness of the scene's floor (its largest upward plane), e.g. a glossy mirrorWall. */
      setFloorRoughness(r: number) {
        let best: THREE.Mesh | null = null, area = 0;
        kit!.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || m.geometry.type !== 'PlaneGeometry' || m.getWorldDirection(new THREE.Vector3()).y < 0.99) return;
          const g = (m.geometry as THREE.PlaneGeometry).parameters, s = m.getWorldScale(new THREE.Vector3());
          const a = g.width * g.height * s.x * s.y;
          if (a > area) { area = a; best = m; }
        });
        if (best) ((best as THREE.Mesh).material as THREE.MeshStandardMaterial).roughness = r;
        hybrid.resetHistory();
        return !!best;
      },
      seamStats: (o?: SeamOptions) => seamStats(o),
      mirrorBiasStats: (o?: BiasOptions) => mirrorBiasStats(o),
      /** W73: noise / bias of any tracer settings against one shared reference (spq 4 copy by default). */
      configStats: (o: ConfigOptions) => configStats(o),
      radianceHash: (frameIndex?: number) => radianceHash(frameIndex),
    },
  });

  /** W32: an FNV-1a hash of the tracer's radiance bytes at a fixed frame index (parity across builds). */
  async function radianceHash(frameIndex = 7) {
    const keep = (ssr.settings as N).frameIndex;
    (ssr.settings as N).frameIndex = frameIndex;
    frame(); await idle();
    if (keep === undefined) delete (ssr.settings as N).frameIndex; else (ssr.settings as N).frameIndex = keep;
    const tex = ssr.tracer!.outputs.radiance;
    const bpr = Math.ceil((tex.width * 8) / 256) * 256;
    const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const b = new Uint8Array(buf.getMappedRange());
    let h = 0x811c9dc5;
    for (let y = 0; y < tex.height; y++) for (let x = y * bpr, e = x + tex.width * 8; x < e; x++) { h ^= b[x]; h = Math.imul(h, 0x01000193) >>> 0; }
    buf.unmap(); buf.destroy();
    return h.toString(16).padStart(8, '0');
  }

  /**
   * D1402: does the denoiser's roughness gate follow the tracer's threshold? Sets the threshold,
   * renders `frames` denoised frames, then compares the denoiser's output with its input (the hybrid
   * signal) per roughness band on geometry: FFX passes pixels above its gate through unchanged, so
   * pixels between the default threshold (0.447) and the new one change only if the gate moved.
   */
  async function denoiserGateCheck(threshold = 0.8, frames = 8) {
    if (!denoiser) return null;
    const keep = ssr.settings.roughnessThreshold, keepDenoise = hybrid.denoise;
    ssr.settings.roughnessThreshold = threshold;
    hybrid.denoise = true;
    for (let i = 0; i < frames; i++) frame();
    await idle();
    const t = ssr.gbuffer.gpuTextures();
    const [depth, nr, sig, den] = await Promise.all([
      readTexture(device, t.depth), readTexture(device, t.normal),
      readTexture(device, getGPUTexture(renderer, hybrid.signalTarget.texture)), readTexture(device, getGPUTexture(renderer, hybrid.denoised)),
    ]);
    const gate = denoiserGate;
    const inverted = ssr.gbuffer.conventions.depthInverted;
    const bands = { glossy: [0.05, 0.42], between: [0.47, threshold - 0.03], above: [threshold + 0.03, 1] };
    const out: Record<string, { px: number; changed: number }> = {};
    for (const [k, [lo, hi]] of Object.entries(bands)) {
      let px = 0, changed = 0;
      for (let i = 0; i < W * H; i++) {
        if (inverted ? depth[i] <= 0 : depth[i] >= 1) continue;
        const r = nr[i * 4 + 3];
        if (r < lo || r > hi) continue;
        px++;
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(den[i * 4 + c] - sig[i * 4 + c]));
        if (d > 1e-3) changed++;
      }
      out[k] = { px, changed: px ? changed / px : 0 };
    }
    if (keep === undefined) delete ssr.settings.roughnessThreshold; else ssr.settings.roughnessThreshold = keep;
    hybrid.denoise = keepDenoise;
    frame(); await idle();
    return { threshold, gate, bands: out };
  }

  /**
   * W32 (D49): noise and bias of `settings.mirrorBias` on the final image (8-bit luma after tone
   * mapping, Rec. 709), static camera, loop stopped, per roughness bin (G-buffer perceptual
   * roughness within +-0.02 of each bin, geometry only). The reference R is the mean of `refFrames`
   * raw (denoise off) frames at bias 0 (FFX's blue noise repeats every 256 frames). Per (denoise,
   * bias): `warm` frames after a history reset, then `frames` frames, per px mean m and variance v:
   * `std` = mean temporal std, `flicker` = mean |x_t - x_t-1| (the denoiser scorecard's), `bias` =
   * RMS of (m - R) with the finite-sample noise taken out (sqrt(max(0, <(m-R)^2> - <v>/frames -
   * <vR>/refFrames))), `signed` = <m - R>, `rmse` = RMS of a single frame against R (what one frame shows),
   * `added` = the same bias estimate against this denoise mode's own bias-0 mean (the knob's share).
   */
  type BiasOptions = { biases?: number[]; bins?: number[]; frames?: number; refFrames?: number; warm?: number; denoise?: boolean[] };
  async function mirrorBiasStats(o: BiasOptions = {}) {
    const { biases = [0, 0.25, 0.5, 0.75], bins = [0.1, 0.2, 0.3, 0.4], frames = 64, refFrames = 256, warm = 32 } = o;
    const denoiseModes = (o.denoise ?? [false, true]).filter((d) => !d || !!denoiser);
    const keepBias = ssr.settings.mirrorBias, keepDenoise = hybrid.denoise, keepView = viewSel.value as View;
    setView('final');
    const c2 = new OffscreenCanvas(W, H); const g2 = c2.getContext('2d', { willReadFrequently: true })!;
    const luma = new Float32Array(W * H);
    const grab = async () => {
      frame();
      const u = canvas.toDataURL('image/png'); await idle();
      const img = new Image(); img.src = u; await img.decode();
      g2.drawImage(img, 0, 0);
      const d = g2.getImageData(0, 0, W, H).data;
      for (let i = 0; i < W * H; i++) luma[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
      return luma;
    };
    frame(); await idle();
    const t = ssr.gbuffer.gpuTextures();
    const [depth, nr] = await Promise.all([readTexture(device, t.depth), readTexture(device, t.normal)]);
    const inverted = ssr.gbuffer.conventions.depthInverted;
    const bin = new Int8Array(W * H).fill(-1);
    const binPx = bins.map(() => 0);
    for (let i = 0; i < W * H; i++) {
      if (inverted ? depth[i] <= 0 : depth[i] >= 1) continue;
      const r = nr[i * 4 + 3];
      const k = bins.findIndex((b) => Math.abs(r - b) < 0.02);
      if (k >= 0) { bin[i] = k; binPx[k]++; }
    }
    const run = async (bias: number, dn: boolean, n: number, ref: { mean: Float64Array; varr: Float64Array } | null) => {
      ssr.settings.mirrorBias = bias;
      hybrid.denoise = dn;
      ssr.resetHistory(); hybrid.resetHistory();
      for (let i = 0; i < (dn ? warm : 2); i++) frame();
      await idle();
      const sum = new Float64Array(W * H), sq = new Float64Array(W * H), prev = new Float32Array(W * H), fl = new Float64Array(W * H), se = new Float64Array(W * H);
      for (let f = 0; f < n; f++) {
        const x = await grab();
        for (let i = 0; i < W * H; i++) {
          if (bin[i] < 0) continue;
          const v = x[i];
          sum[i] += v; sq[i] += v * v;
          if (f > 0) fl[i] += Math.abs(v - prev[i]);
          prev[i] = v;
          if (ref) se[i] += (v - ref.mean[i]) ** 2;
        }
      }
      const mean = new Float64Array(W * H), varr = new Float64Array(W * H);
      for (let i = 0; i < W * H; i++) if (bin[i] >= 0) { mean[i] = sum[i] / n; varr[i] = Math.max(0, sq[i] / n - mean[i] ** 2) * n / (n - 1); }
      const per = bins.map((b, k) => {
        let px = 0, std = 0, flick = 0, d2 = 0, vv = 0, vr = 0, sgn = 0, e2 = 0;
        for (let i = 0; i < W * H; i++) {
          if (bin[i] !== k) continue;
          px++; std += Math.sqrt(varr[i]); flick += fl[i] / (n - 1); vv += varr[i];
          if (ref) { const d = mean[i] - ref.mean[i]; d2 += d * d; sgn += d; vr += ref.varr[i]; e2 += se[i] / n; }
        }
        if (!px) return { roughness: b, px: 0 };
        const out: N = { roughness: b, px, std: std / px, flicker: flick / px };
        if (ref) Object.assign(out, { bias: Math.sqrt(Math.max(0, d2 / px - vv / px / n - vr / px / refFrames)), signed: sgn / px, rmse: Math.sqrt(e2 / px) });
        return out;
      });
      return { mean, varr, per };
    };
    const t0 = performance.now();
    const ref = await run(0, false, refFrames, null);
    const results: N[] = [];
    // `added`: the same noise-corrected RMS of (m_b - m_0) against this denoise mode's own bias-0 mean,
    // i.e. what the knob adds on top of the denoiser's own (spatial) bias
    const added = (a: { mean: Float64Array; varr: Float64Array }, z: { mean: Float64Array; varr: Float64Array }, k: number) => {
      let px = 0, d2 = 0, v = 0;
      for (let i = 0; i < W * H; i++) if (bin[i] === k) { px++; d2 += (a.mean[i] - z.mean[i]) ** 2; v += a.varr[i] + z.varr[i]; }
      return px ? Math.sqrt(Math.max(0, d2 / px - v / px / frames)) : 0;
    };
    for (const dn of denoiseModes) {
      let zero: Awaited<ReturnType<typeof run>> | null = null;
      for (const b of biases) {
        const r = await run(b, dn, frames, ref);
        if (b === 0) zero = r;
        results.push({ denoise: dn, mirrorBias: b, bins: r.per.map((x: N, k) => (zero ? { ...x, added: added(r, zero, k) } : x)) });
      }
    }
    ssr.settings.mirrorBias = keepBias; if (keepBias === undefined) delete ssr.settings.mirrorBias;
    hybrid.denoise = keepDenoise; hybrid.resetHistory(); setView(keepView);
    return { scene: kit!.id, size: [W, H], frames, refFrames, warm, binPx, refStd: ref.per, results, seconds: (performance.now() - t0) / 1e3 };
  }

  /**
   * W73 (X3): `mirrorBiasStats` for any tracer settings against one shared reference. The reference R
   * is the mean of `refFrames` raw frames with `ref` settings (default spq 4, copy: the per-pixel
   * unbiased trace). Per config x denoise mode: std, flicker, bias (noise-corrected RMS of m - R),
   * signed, rmse, as mirrorBiasStats; settings are applied over the page's and removed after.
   */
  type ConfigOptions = { configs: { name: string; settings: N }[]; ref?: N; bins?: number[]; frames?: number; refFrames?: number; warm?: number; denoise?: boolean[] };
  async function configStats(o: ConfigOptions) {
    const { configs, ref: refSettings = { samplesPerQuad: 4 }, bins = [0.1, 0.2, 0.3, 0.4], frames = 64, refFrames = 256, warm = 32 } = o;
    const denoiseModes = (o.denoise ?? [false, true]).filter((d) => !d || !!denoiser);
    const keepDenoise = hybrid.denoise, keepView = viewSel.value as View;
    const keep = { ...ssr.settings };
    setView('final');
    const c2 = new OffscreenCanvas(W, H); const g2 = c2.getContext('2d', { willReadFrequently: true })!;
    const luma = new Float32Array(W * H);
    const grab = async () => {
      frame();
      const u = canvas.toDataURL('image/png'); await idle();
      const img = new Image(); img.src = u; await img.decode();
      g2.drawImage(img, 0, 0);
      const d = g2.getImageData(0, 0, W, H).data;
      for (let i = 0; i < W * H; i++) luma[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
      return luma;
    };
    frame(); await idle();
    const t = ssr.gbuffer.gpuTextures();
    const [depth, nr] = await Promise.all([readTexture(device, t.depth), readTexture(device, t.normal)]);
    const inverted = ssr.gbuffer.conventions.depthInverted;
    const bin = new Int8Array(W * H).fill(-1);
    const binPx = bins.map(() => 0);
    for (let i = 0; i < W * H; i++) {
      if (inverted ? depth[i] <= 0 : depth[i] >= 1) continue;
      const k = bins.findIndex((b) => Math.abs(nr[i * 4 + 3] - b) < 0.02);
      if (k >= 0) { bin[i] = k; binPx[k]++; }
    }
    const run = async (settings: N, dn: boolean, n: number, R: { mean: Float64Array; varr: Float64Array } | null) => {
      ssr.settings = { ...keep, ...settings };
      hybrid.denoise = dn;
      ssr.resetHistory(); hybrid.resetHistory();
      for (let i = 0; i < (dn ? warm : 2); i++) frame();
      await idle();
      const sum = new Float64Array(W * H), sq = new Float64Array(W * H), prev = new Float32Array(W * H), fl = new Float64Array(W * H), se = new Float64Array(W * H);
      for (let f = 0; f < n; f++) {
        const x = await grab();
        for (let i = 0; i < W * H; i++) {
          if (bin[i] < 0) continue;
          const v = x[i];
          sum[i] += v; sq[i] += v * v;
          if (f > 0) fl[i] += Math.abs(v - prev[i]);
          prev[i] = v;
          if (R) se[i] += (v - R.mean[i]) ** 2;
        }
      }
      const mean = new Float64Array(W * H), varr = new Float64Array(W * H);
      for (let i = 0; i < W * H; i++) if (bin[i] >= 0) { mean[i] = sum[i] / n; varr[i] = Math.max(0, sq[i] / n - mean[i] ** 2) * n / (n - 1); }
      const per = bins.map((b, k) => {
        let px = 0, std = 0, flick = 0, d2 = 0, vv = 0, vr = 0, sgn = 0, e2 = 0, m = 0;
        for (let i = 0; i < W * H; i++) {
          if (bin[i] !== k) continue;
          px++; std += Math.sqrt(varr[i]); flick += fl[i] / (n - 1); vv += varr[i]; m += mean[i];
          if (R) { const d = mean[i] - R.mean[i]; d2 += d * d; sgn += d; vr += R.varr[i]; e2 += se[i] / n; }
        }
        if (!px) return { roughness: b, px: 0 };
        const out: N = { roughness: b, px, mean: m / px, std: std / px, flicker: flick / px };
        if (R) Object.assign(out, { bias: Math.sqrt(Math.max(0, d2 / px - vv / px / n - vr / px / refFrames)), signed: sgn / px, rmse: Math.sqrt(e2 / px) });
        return out;
      });
      return { mean, varr, per };
    };
    const t0 = performance.now();
    const R = await run(refSettings, false, refFrames, null);
    const results: N[] = [];
    for (const dn of denoiseModes) for (const c of configs) results.push({ name: c.name, denoise: dn, bins: (await run(c.settings, dn, frames, R)).per });
    ssr.settings = keep;
    hybrid.denoise = keepDenoise; hybrid.resetHistory(); setView(keepView);
    return { scene: kit!.id, size: [W, H], frames, refFrames, warm, binPx, ref: refSettings, refStats: R.per, results, seconds: (performance.now() - t0) / 1e3 };
  }

  /**
   * W26 (D53): the SSR-to-probe seam, measured as the step a viewer sees where the hybrid's weight
   * falls from the hit to the probe. At a confident hit (confidence >= cmin) the final image is
   * ~ lit + w (hit - probe); with SSR off it is lit (three's own probe term), so `final - lit` there
   * is exactly the jump the image makes where the confidence fades (D41) or a ray misses. Measured
   * in display units (8-bit luma, Rec. 709, after tone mapping), on 8x8 blocks of px that are each a
   * confident hit in the roughness band [rmin, rmax) (perceptual, G-buffer), at least half of them:
   * block means first, so the SSR's noise doesn't count as seam. Returns the mean |step| and the signed mean (probe - hit).
   */
  type SeamOptions = { rmin?: number; rmax?: number; cmin?: number; frames?: number; block?: number; shots?: boolean };
  async function seamStats(o: SeamOptions = {}) {
    const { rmin = 0.1, rmax = 0.45, cmin = 0.9, frames = 16, block = 8 } = o;
    const keepView = viewSel.value as View, keepAmount = composite!.amount.value;
    setView('final');
    composite!.amount.value = 1;
    const grab = async () => {
      const u = canvas.toDataURL('image/png'); await idle();
      const img = new Image(); img.src = u; await img.decode();
      const c2 = new OffscreenCanvas(W, H); const g2 = c2.getContext('2d')!; g2.drawImage(img, 0, 0);
      return g2.getImageData(0, 0, W, H).data;
    };
    for (let i = 0; i < frames; i++) { frame(); await idle(); }
    const A = await grab();
    const core = ssr.tracer!;
    const t = ssr.gbuffer.gpuTextures();
    const [depth, nr, conf] = await Promise.all([readTexture(device, t.depth), readTexture(device, t.normal), readTexture(device, core.outputs.confidence)]);
    composite!.amount.value = 0;
    frame(); await idle();
    const B = await grab();
    composite!.amount.value = keepAmount;
    setView(keepView);
    const inverted = ssr.gbuffer.conventions.depthInverted;
    const luma = (d: Uint8ClampedArray, i: number) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    // per px the signed step lit - final over confident glossy hits; per 8x8 block (at least half its
    // px qualify) the mean of those, so the SSR's noise averages out before the absolute value
    let px = 0, pxAbs = 0, blocks = 0, abs = 0, signed = 0, hitL = 0;
    for (let by = 0; by + block <= H; by += block) for (let bx = 0; bx + block <= W; bx += block) {
      let n = 0, a = 0, b = 0;
      for (let y = by; y < by + block; y++) for (let x = bx; x < bx + block; x++) {
        const i = y * W + x;
        const geo = inverted ? depth[i] > 0 : depth[i] < 1;
        const r = nr[i * 4 + 3];
        if (!geo || r < rmin || r >= rmax || conf[i] < cmin) continue;
        const la = luma(A, i), lb = luma(B, i);
        n++; a += la; b += lb; px++; pxAbs += Math.abs(la - lb);
      }
      if (n * 2 < block * block) continue;
      blocks++; abs += Math.abs(b - a) / n; signed += (b - a) / n; hitL += a / n;
    }
    const toUrl = async (d: Uint8ClampedArray) => { const c3 = new OffscreenCanvas(W, H); c3.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d), W, H), 0, 0); const bl = await c3.convertToBlob(); return await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.readAsDataURL(bl); }); };
    const shots = o.shots ? { final: await toUrl(A), lit: await toUrl(B) } : undefined;
    return { blocks, px, step: blocks ? abs / blocks : 0, bias: blocks ? signed / blocks : 0, pxStep: px ? pxAbs / px : 0, hitLuma: blocks ? hitL / blocks : 0, shots };
  }

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
      if (kit!.id !== 'mirrorWall' && kit!.id !== 'thinPost') continue; // W80: thinPost shares the wall (z = -3) and the mirror floor
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
      wall: kit!.id === 'mirrorWall' || kit!.id === 'thinPost' ? {
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
    return { ...out[0], variants: out, source: ssr.hitShadingSource };
  }

  /**
   * D903: what the shadow rays change on the hits the hit shading shades (source 1, with on-screen
   * reuse as configured): the same rays (pinned frame index) with `hitShadows` off, on, off again
   * (noise floor). Fractions of those pixels > 1% darker / brighter, and mean luminance off -> on.
   */
  /**
   * W47 (D4702): the traced pass's output on fixed rays (SSSR frame index pinned, on-screen reuse
   * off, so every hit is shaded by the hit shading), for comparing probe sets in the page: the
   * `source` codes (core RT_SOURCE, 1 = traced hit) and the tracer's `radiance` (rgba, linear).
   */
  async function rtHitRadiance(extra: N = {}) {
    const rt = ssr.traced!, core = ssr.tracer!;
    const keep = ssr.traceSettings;
    const keepFrame = (ssr.settings as N).frameIndex;
    (ssr.settings as N).frameIndex = 7;
    ssr.traceSettings = { ...keep, ...extra, reuseOnScreenHits: false };
    frame(); await idle();
    const [source, radiance] = await Promise.all([readTexture(device, rt.source), readTexture(device, core.outputs.radiance)]);
    ssr.traceSettings = keep;
    if (keepFrame === undefined) delete (ssr.settings as N).frameIndex; else (ssr.settings as N).frameIndex = keepFrame;
    return { width: W, height: H, source, radiance, kind: ssr.hitShadingSource };
  }

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
   * instance (u32), normal xyz, triangle (u32). `s`: per ray the provider's shading normal
   * (`traceHitShadingNormal`, D1700; 0 without one), xyz + 0.
   */
  async function traceRays(p: TraceProvider, origins: Float32Array<ArrayBuffer>, dirs: Float32Array<ArrayBuffer>) {
    const n = origins.length / 4;
    const code = `${HIT_WGSL}
@group(0) @binding(0) var<storage, read> rayO: array<vec4f>;
@group(0) @binding(1) var<storage, read> rayD: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outT: array<vec4f>;
${p.code({ group: 1, firstBinding: 0 })}
${p.capabilities.shadingNormal ? '' : DEFAULT_SHADING_NORMAL_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rayO)) { return; }
  let h = traceFirstHit(rayO[id.x].xyz, rayD[id.x].xyz, 1000.0);
  outT[id.x * 3u] = vec4f(h.t, bitcast<f32>(h.material), select(0.0, 1.0, h.frontFace), bitcast<f32>(h.instance));
  outT[id.x * 3u + 1u] = vec4f(h.normal, bitcast<f32>(h.triangle));
  outT[id.x * 3u + 2u] = vec4f(select(vec3f(0.0), traceHitShadingNormal(h), h.t >= 0.0), 0.0);
}`;
    const mk = (a: Float32Array<ArrayBuffer>, usage: number) => { const b = device.createBuffer({ size: a.byteLength, usage }); device.queue.writeBuffer(b, 0, a); return b; };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const bo = mk(origins, S), bd = mk(dirs, S);
    const bytes = n * 48;
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
    const all = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); [bo, bd, bt, rb].forEach((b) => b.destroy());
    // split into the 8-word hit records and the shading normals
    const f = new Float32Array(n * 8), s = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { f.set(all.subarray(i * 12, i * 12 + 8), i * 8); s.set(all.subarray(i * 12 + 8, i * 12 + 12), i * 4); }
    return { f, u: new Uint32Array(f.buffer), s, gpuWallMs };
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

  /**
   * W49 (D1701 / D1702): the provider's hit material (`traceHitMaterial`) against the three material
   * that draws the hit triangle (three's `face.materialIndex` into the mesh's material array), on
   * the same rays as rtOracle, where three and the walk hit within 1e-3 of each other. Expected:
   * `defaultHitMaterial` of that material (the page builds both providers with the default). Per
   * three material: such hits, how many carry its albedo and emissive (within the stopgap's rgb8 /
   * rgb9e5 rounding), and how many carry the mesh's first material instead (what a provider without
   * per-triangle materials reports). Also: meshes with a material array in the scene.
   */
  async function rtMaterialCheck(n = 4096, kind: RayKind = 'camera') {
    if (!provider || !bvhInfo) throw new Error('rtMaterialCheck needs ?rt=1');
    const meshes = traceMeshes(kit!.scene);
    const { origins, dirs } = makeRays(n, kind);
    const code = `${HIT_WGSL}
@group(0) @binding(0) var<storage, read> rayO: array<vec4f>;
@group(0) @binding(1) var<storage, read> rayD: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outM: array<vec4f>;
${provider.code({ group: 1, firstBinding: 0 })}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rayO)) { return; }
  let h = traceFirstHit(rayO[id.x].xyz, rayD[id.x].xyz, 1000.0);
  var m = HitMaterial(vec3f(0.0), vec3f(0.0));
  if (h.t >= 0.0) { m = traceHitMaterial(h); }
  outM[id.x * 2u] = vec4f(h.t, m.albedo);
  outM[id.x * 2u + 1u] = vec4f(m.emissive, 0.0);
}`;
    const f = await runRayKernel(provider, code, origins, dirs, n * 32);
    const sides = new Map<THREE.Material, THREE.Side>();
    for (const m of meshes) for (const mat of ([] as THREE.Material[]).concat(m.material)) { sides.set(mat, mat.side); mat.side = THREE.DoubleSide; }
    const expected = new Map<THREE.Material, ReturnType<typeof defaultHitMaterial>>();
    const want = (mat: THREE.Material) => {
      if (!expected.has(mat)) expected.set(mat, defaultHitMaterial(new THREE.Mesh(undefined, mat)));
      return expected.get(mat)!;
    };
    const close = (got: ArrayLike<number>, e: readonly number[], tol: number) => [0, 1, 2].every((c) => Math.abs(got[c] - e[c]) <= tol + 0.01 * Math.max(...e));
    const per = new Map<THREE.Material, { material: string; multi: boolean; hits: number; own: number; first: number }>();
    const rc = new THREE.Raycaster();
    rc.far = 1000;
    let compared = 0, mismatch = 0;
    const d = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      d.set(dirs[i * 4], dirs[i * 4 + 1], dirs[i * 4 + 2]);
      rc.set(new THREE.Vector3(origins[i * 4], origins[i * 4 + 1], origins[i * 4 + 2]), d);
      const hit = rc.intersectObjects(meshes, false)[0];
      const tg = f[i * 8];
      if (!hit || tg < 0 || relErr(tg, hit.distance) >= 1e-3) { if (!!hit !== tg >= 0) mismatch++; continue; }
      compared++;
      const mesh = hit.object as THREE.Mesh;
      const list = ([] as THREE.Material[]).concat(mesh.material);
      const mat = Array.isArray(mesh.material) ? mesh.material[hit.face!.materialIndex] : mesh.material;
      if (!mat) continue;
      if (!per.has(mat)) per.set(mat, { material: mat.name || mat.type, multi: list.length > 1, hits: 0, own: 0, first: 0 });
      const row = per.get(mat)!;
      row.hits++;
      const albedo = f.subarray(i * 8 + 1, i * 8 + 4), emissive = f.subarray(i * 8 + 4, i * 8 + 7);
      const matches = (m: THREE.Material) => { const e = want(m); return close(albedo, e.albedo, 3 / 255) && close(emissive, e.emissive, 0.004); };
      if (matches(mat)) row.own++;
      if (matches(list[0])) row.first++;
    }
    for (const [mat, sd] of sides) mat.side = sd;
    let arrays = 0, groups = 0;
    for (const m of meshes) if (Array.isArray(m.material)) { arrays++; groups += m.geometry.groups.length; }
    return { provider: bvhInfo.kind, rays: n, kind, compared, mismatch, meshes: meshes.length, multiMaterialMeshes: arrays, groups, materials: [...per.values()] };
  }

  /** Run `code` (bindings: rays at group 0 slots 0-1, `bytes` of output at 2; `p` at group 1) over the rays, read the output back. */
  async function runRayKernel(p: TraceProvider, code: string, origins: Float32Array<ArrayBuffer>, dirs: Float32Array<ArrayBuffer>, bytes: number) {
    const n = origins.length / 4;
    const mk = (a: Float32Array<ArrayBuffer>) => { const b = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, a); return b; };
    const bo = mk(origins), bd = mk(dirs);
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
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); [bo, bd, bt, rb].forEach((b) => b.destroy());
    return out;
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
  async function rtOracle(n = 4096, kind: RayKind = 'camera') {
    if (!provider || !bvhInfo) throw new Error('rtOracle needs ?rt=1');
    const meshes = traceMeshes(kit!.scene);
    const tested = provider, pmndrs = pmndrsBuild;
    const { origins, dirs } = makeRays(n, kind);
    const { f, u, s, gpuWallMs } = await traceRays(tested, origins, dirs);
    const shadingNormal = !!tested.capabilities.shadingNormal;
    const sides = new Map<THREE.Material, THREE.Side>();
    for (const m of meshes) for (const mat of ([] as THREE.Material[]).concat(m.material)) { sides.set(mat, mat.side); mat.side = THREE.DoubleSide; }
    // @pmndrs/bvh: instance index -> the object it came from, and the material id it was given
    const instanceOf = new Map<THREE.Object3D, Map<number, number>>();
    pmndrs?.sources.forEach((s, i) => { if (!instanceOf.has(s.mesh)) instanceOf.set(s.mesh, new Map()); instanceOf.get(s.mesh)!.set(s.instanceId, i); });
    const rc = new THREE.Raycaster();
    rc.far = 1000;
    let agree = 0, bothMiss = 0, gpuOnly = 0, cpuOnly = 0, maxRel = 0, compared = 0;
    let triangle = 0, normalSigned = 0, normalAbs = 0, frontFace = 0, instance = 0, material = 0;
    // D1700: the shading normal vs three's interpolated intersection.normal (meshes with normals)
    let shadedCompared = 0, shadedAgree = 0, shadedAngle = 0, flatAngle = 0;
    const sn = new THREE.Vector3(), tn = new THREE.Vector3();
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
      if (hit.normal) {
        // both turned to face the ray; angles in degrees
        tn.copy(hit.normal).applyMatrix3(nm).normalize();
        if (tn.dot(d) > 0) tn.negate();
        sn.set(s[i * 4], s[i * 4 + 1], s[i * 4 + 2]);
        if (sn.lengthSq() > 0) sn.normalize(); else sn.copy(wn);
        if (sn.dot(d) > 0) sn.negate();
        const g = wn.dot(d) > 0 ? wn.clone().negate() : wn;
        const deg = (c: number) => (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
        shadedCompared++;
        if (sn.dot(tn) >= 0.999) shadedAgree++;
        shadedAngle += deg(sn.dot(tn));
        flatAngle += deg(g.dot(tn));
      }
      if (pmndrs) {
        const want = instanceOf.get(hit.object)?.get(hit.instanceId ?? -1);
        if (want !== undefined && u[i * 8 + 3] === want) instance++;
        // W49: the group's material for a multi-material mesh (three's face.materialIndex), else the instance's
        if (want !== undefined && u[i * 8 + 1] === (pmndrs.materialIdOf(hit.object as THREE.Mesh, hit.face?.materialIndex ?? 0) ?? 0xffffffff)) material++;
      }
    }
    for (const [mat, sd] of sides) mat.side = sd;
    return {
      provider: bvhInfo.kind, rays: n, kind, agree, bothMiss, gpuOnly, cpuOnly, maxRel, p99Rel: pct(errs, 0.99), gpuWallMs,
      compared, triangle, normalSigned, normalAbs, frontFace, instance: pmndrs ? instance : null, material: pmndrs ? material : null, examples,
      shading: { capability: shadingNormal, compared: shadedCompared, agree: shadedAgree, meanDeg: shadedCompared ? shadedAngle / shadedCompared : 0, flatMeanDeg: shadedCompared ? flatAngle / shadedCompared : 0 },
    };
  }
}

main().catch((e) => {
  console.error(e);
  document.querySelector<HTMLElement>('#status')!.textContent = String(e?.stack ?? e);
});
