// examples/ssr-bench: the phase 3 gate measurement (docs/research/ssr-gate.md). Our screen-space
// reflections (ScreenSpaceReflectionsPass + screenSpaceComposite) against three r187's SSRNode,
// composited the way three's own examples do, on the same kit scene and camera.
//
// One method per page load (?method=), because three's SSR + denoise example disables the
// environment's specular term on PhysicalLightingModel's prototype, which can't be scoped to one
// render in a page:
//   ours           ScreenSpaceReflectionsPass + screenSpaceComposite, product defaults, no denoiser
//   ours-accum     ours + an exponential history of the specular term, reprojected by the G-buffer
//                  motion, reset on disocclusion. A BENCH STAND-IN for the denoise seam, not a feature.
//   three-blur     SSRNode (mirror ray + roughness blur mips) added to the lit pass, as
//                  webgpu_postprocessing_ssr.html (without its SMAA)
//   three-stoch    SSRNode stochastic, env specular off in the lighting, lit + SSR, as
//                  webgpu_postprocessing_ssr_denoise.html's "SSR (Raw)"
//   three-denoise  the same + TemporalReprojectNode + RecurrentDenoiseNode, as that example's
//                  "Combined" (without its TRAA, sharpen and grading)
//   reference      the ideal screen-space answer, by brute force: per glossy pixel, many GGX VNDF
//                  rays (own low-discrepancy sequence) through the BVH; a hit the camera sees takes
//                  three's lit colour there, anything else the probe / environment term; fed through
//                  the same screenSpaceComposite. Written to IndexedDB for the method pages.
//
// The metrics are computed on the GPU from each method's linear HDR output (finalRT): per-pixel
// tone-mapped value v = luminance(x / (1 + x)), error e = v - reference.
//
// `window.__p` drives the page headlessly (scripts/run-headless.mjs, `--ssr-bench` and section `ssr-bench`).
import * as THREE from 'three/webgpu';
import {
  diffuseColor, float, getViewPosition, materialMetalness, materialRoughness, metalness, mix, mrt, normalView, output, packNormalToRGB,
  pass, renderOutput, roughness, sample, texture, uniform, unpackRGBToNormal, uv, vec2, vec3, vec4, velocity,
} from 'three/tsl';
import { ssr as threeSSR } from 'three/addons/tsl/display/SSRNode.js';
import { temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { recurrentDenoise } from 'three/addons/tsl/display/RecurrentDenoiseNode.js';
import {
  MeshBVHTraceProvider, ReflectionProbe, ReflectionProbes, ScreenSpaceReflectionsPass, getGPUTexture, reflectionProbes, screenSpaceComposite,
} from '@pmndrs/reflections/three';
import { HIT_WGSL } from '@pmndrs/reflections/core';
import { SCENES, type KitScene } from '../../shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const METHODS = ['ours', 'ours-accum', 'three-blur', 'three-stoch', 'three-denoise', 'reference'] as const;
type Method = (typeof METHODS)[number];
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 960), H = Number(q.get('h') ?? 540);
const method = (q.get('method') ?? 'ours') as Method;
const sceneId = q.get('scene') ?? 'mirrorWall';
const poseName = q.get('pose') ?? 'default';
const base = q.get('base') === '1';
if (!METHODS.includes(method)) throw new Error(`method ${method}?`);
const isThree = method.startsWith('three');
const isOurs = !isThree;
/** Perceptual roughness below which our tracer runs (product default) and the metrics' glossy mask. */
const GLOSSY = 0.447;
/** three's SSRNode reach (view-space units). Its examples' 0.4 / 1 are for 1-4 m scenes; ours are rooms. */
const THREE_MAX_DISTANCE = 10;
const INDOOR = new Set(['rooms', 'explainer', 'boxRoom']);

// three's SSR + denoise example: "Disable env map specular (radiance and clearcoat radiance) for every
// PBR material in this scene, since SSR provides the specular reflections instead." Verbatim.
if (method === 'three-stoch' || method === 'three-denoise') {
  const PLM = (THREE as N).PhysicalLightingModel.prototype;
  const original = PLM.indirectSpecular;
  PLM.indirectSpecular = function (this: N, builder: N) {
    builder.context.radiance = vec3(0);
    if (this.clearcoatRadiance) this.clearcoatRadiance.assign(vec3(0));
    original.call(this, builder);
  };
}

// ---- small GPU helpers ---------------------------------------------------------------------------
function halfToFloat(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
const FORMATS: Record<string, { bytes: number; channels: number; read: (dv: DataView, o: number, c: number) => number }> = {
  rgba16float: { bytes: 8, channels: 4, read: (dv, o, c) => halfToFloat(dv.getUint16(o + c * 2, true)) },
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
async function readBuffer(device: GPUDevice, b: GPUBuffer, size: number) {
  const r = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(b, 0, r, 0, size);
  device.queue.submit([enc.finish()]);
  await r.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(r.getMappedRange().slice(0));
  r.unmap(); r.destroy();
  return out;
}

// ---- IndexedDB (references cross page loads in one browser profile) ------------------------------
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ssr-bench', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('refs');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(key: string, value: unknown) {
  const db = await idb();
  await new Promise<void>((res, rej) => { const t = db.transaction('refs', 'readwrite'); t.objectStore('refs').put(value, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}
async function idbGet<T>(key: string): Promise<T> {
  const db = await idb();
  const v = await new Promise<T>((res, rej) => { const r = db.transaction('refs').objectStore('refs').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  db.close();
  if (v === undefined) throw new Error(`no reference ${key}: run ?method=reference first`);
  return v;
}
const refKey = (what: string) => `${sceneId}/${poseName}/${W}x${H}/${what}`;

// ---- metric kernel: v = luminance(x/(1+x)); 'value' writes v, 'error' accumulates e, e^2, |e - e_prev| ----
const METRIC_WGSL = /* wgsl */ `
struct U { size: vec2u, mode: u32, first: u32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> refv: array<f32>;
@group(0) @binding(3) var<storage, read_write> acc: array<vec4f>;
fn tone(c: vec3f) -> f32 { let x = max(c, vec3f(0.0)); return dot(x / (vec3f(1.0) + x), vec3f(0.2126, 0.7152, 0.0722)); }
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= u.size)) { return; }
  let i = id.y * u.size.x + id.x;
  let c = textureLoad(src, id.xy, 0).rgb;
  var v = tone(c);
  let bad = !(v == v) || abs(v) > 1e30;
  if (bad) { v = 0.0; }
  if (u.mode == 0u) { acc[i] = vec4f(v, select(0.0, 1.0, bad), 0.0, 0.0); return; }
  let e = v - refv[i];
  var a = acc[i];
  if (u.first == 1u) { a = vec4f(0.0); }
  // x: sum e, y: sum e^2, z: previous e, w: sum |e - e_prev| (the denoiser scorecard's flicker)
  let d = select(abs(e - a.z), 0.0, u.first == 1u);
  acc[i] = vec4f(a.x + e, a.y + e * e, e, a.w + d);
}
`;

// ---- reference tracer: GGX VNDF rays per glossy pixel through the BVH; on-screen hits take lit ----
const REF_WGSL = (providerCode: string) => /* wgsl */ `
${HIT_WGSL}
struct RU { invViewProj: mat4x4f, viewProj: mat4x4f, camPos: vec4f, size: vec2u, spp: u32, first: u32, threshold: f32, seed: u32, pad: vec2u };
@group(0) @binding(0) var<uniform> u: RU;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var nrTex: texture_2d<f32>;
@group(0) @binding(3) var litTex: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> acc: array<vec4f>; // xyz: sum w on L, w: sum w on
@group(0) @binding(5) var<storage, read_write> accW: array<f32>;  // sum w
${providerCode}
fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn worldAt(uvc: vec2f, d: f32) -> vec3f {
  let p = u.invViewProj * vec4f(uvc.x * 2.0 - 1.0, 1.0 - uvc.y * 2.0, d, 1.0);
  return p.xyz / p.w;
}
// Heitz 2018, "Sampling the GGX Distribution of Visible Normals"; Ve in tangent space (z = N)
fn sampleVNDF(Ve: vec3f, a: f32, r: vec2f) -> vec3f {
  let Vh = normalize(vec3f(a * Ve.x, a * Ve.y, Ve.z));
  let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
  let T1 = select(vec3f(1.0, 0.0, 0.0), vec3f(-Vh.y, Vh.x, 0.0) * inverseSqrt(max(lensq, 1e-20)), lensq > 0.0);
  let T2 = cross(Vh, T1);
  let rr = sqrt(r.x);
  let phi = 6.28318530718 * r.y;
  let t1 = rr * cos(phi);
  let s = 0.5 * (1.0 + Vh.z);
  let t2 = (1.0 - s) * sqrt(max(0.0, 1.0 - t1 * t1)) + s * rr * sin(phi);
  let Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
  return normalize(vec3f(a * Nh.x, a * Nh.y, max(0.0, Nh.z)));
}
fn smithG1(NdotL: f32, a: f32) -> f32 { let a2 = a * a; return 2.0 * NdotL / (NdotL + sqrt(a2 + (1.0 - a2) * NdotL * NdotL)); }
@compute @workgroup_size(8, 8) fn trace(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= u.size)) { return; }
  let i = id.y * u.size.x + id.x;
  var sumL = vec3f(0.0); var sumOn = 0.0; var sumW = 0.0;
  let d = textureLoad(depthTex, vec2i(id.xy), 0);
  let nr = textureLoad(nrTex, vec2i(id.xy), 0);
  if (d < 1.0 && nr.w < u.threshold) {
    let size = vec2f(u.size);
    let P = worldAt((vec2f(id.xy) + 0.5) / size, d);
    let Nw = normalize(nr.xyz);
    let V = normalize(u.camPos.xyz - P);
    let a = nr.w * nr.w;
    let up = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(Nw.z) > 0.999);
    let T = normalize(cross(up, Nw));
    let B = cross(Nw, T);
    let Ve = vec3f(dot(V, T), dot(V, B), dot(V, Nw));
    let rot = vec2f(f32(pcg(i ^ u.seed)), f32(pcg(i * 3u + 7u + u.seed))) / 4294967296.0;
    let viewDist = length(u.camPos.xyz - P);
    let origin = P + Nw * 3e-3 * viewDist;
    for (var k = 0u; k < u.spp; k++) {
      let idx = f32(u.first + k);
      let r2 = fract(rot + idx * vec2f(0.7548776662, 0.5698402910)); // R2 sequence, per-pixel rotation
      var L = reflect(-V, Nw);
      if (a > 1e-6) {
        let Ht = sampleVNDF(Ve, a, r2);
        L = reflect(-V, normalize(Ht.x * T + Ht.y * B + Ht.z * Nw));
      }
      let NdotL = dot(Nw, L);
      if (NdotL <= 0.0) { continue; } // below the horizon: zero weight (self-normalised estimator)
      let w = select(1.0, smithG1(NdotL, a), a > 1e-6);
      sumW += w;
      let hit = traceFirstHit(origin, L, 100.0);
      if (hit.t <= 0.0) { continue; }
      let hp = origin + L * hit.t;
      let clip = u.viewProj * vec4f(hp, 1.0);
      if (clip.w <= 0.0) { continue; }
      let ndc = clip.xyz / clip.w;
      let huv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
      if (any(huv < vec2f(0.0)) || any(huv >= vec2f(1.0))) { continue; }
      let pix = vec2i(huv * size);
      let ds = textureLoad(depthTex, pix, 0);
      if (ds >= 1.0) { continue; }
      let seen = worldAt((vec2f(pix) + 0.5) / size, ds);
      let dh = length(hp - u.camPos.xyz);
      if (abs(dh - length(seen - u.camPos.xyz)) > 0.02 * dh) { continue; } // the hit is hidden from the camera
      sumL += w * textureLoad(litTex, pix, 0).rgb;
      sumOn += w;
    }
  }
  if (u.first == 0u) { acc[i] = vec4f(0.0); accW[i] = 0.0; }
  acc[i] += vec4f(sumL, sumOn);
  accW[i] += sumW;
}
@group(0) @binding(6) var outRad: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var outConf: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8) fn resolve(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= u.size)) { return; }
  let i = id.y * u.size.x + id.x;
  let w = accW[i];
  let a = acc[i];
  let k = select(0.0, 1.0 / w, w > 0.0);
  textureStore(outRad, id.xy, vec4f(a.xyz * k, 0.0));
  textureStore(outConf, id.xy, vec4f(a.w * k, 0.0, 0.0, 0.0));
}
`;

async function main() {
  const status = document.querySelector<HTMLElement>('#status')!;
  const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
  if (!navigator.gpu) { status.textContent = 'WebGPU is not available in this browser.'; return; }
  const adapter = await navigator.gpu.requestAdapter();
  const maxBytes = Math.min(adapter?.limits.maxColorAttachmentBytesPerSample ?? 32, 64);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: { maxColorAttachmentBytesPerSample: maxBytes } } as N);
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  const device: GPUDevice = (renderer.backend as N).device;
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('[webgpu uncapturederror]', m); });
  const nextNodeFrame = () => (renderer as N)._nodes.nodeFrame.update();
  const idle = () => device.queue.onSubmittedWorkDone();

  // ---- scene (frozen at t = 0: the metrics need a static scene) ---------------------------------
  const kit: KitScene = await SCENES[sceneId]({ aspect: W / H });
  kit.update?.(0);
  const camera = kit.camera;
  const view = kit.views[poseName];
  if (!view) throw new Error(`no view ${poseName} in ${sceneId}`);
  const target = new THREE.Vector3(...view.target);
  const pose0 = new THREE.Vector3(...view.pos);
  if (view.fov) camera.fov = view.fov;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  /** Orbit pose t: the view's camera turned by t x `deg` degrees about the vertical through its target. */
  let orbitDeg = 0.3;
  function setOrbit(t: number) {
    const off = pose0.clone().sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(t * orbitDeg));
    camera.position.copy(target).add(off);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  }
  setOrbit(0);
  let probes: ReflectionProbes | null = null;
  if (kit.probes.length) {
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
  const scene = kit.scene;

  // ---- the method's output: linear HDR into finalRT --------------------------------------------
  const finalRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
  finalRT.texture.name = 'ssr-bench final';
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  /** Render targets the `debugTarget` hook can read back. */
  const debugTargets: Record<string, THREE.Texture> = { final: finalRT.texture };
  let ssr: ScreenSpaceReflectionsPass | null = null;
  let render: () => void;
  let info: Record<string, unknown> = {};
  // reference-only state
  let refTrace: ((spp: number, first: number, seed: number) => void) | null = null;
  let refResolve: (() => void) | null = null;

  if (isOurs) {
    ssr = new ScreenSpaceReflectionsPass(renderer, { gbufferOptions: { width: W, height: H }, missList: method === 'reference' });
    const pass0 = ssr;
    const env = scene.environment, envI = scene.environmentIntensity;
    if (method === 'reference') {
      // brute-force tracer over the G-buffer; results in two storage textures shaped like the pass's
      const meshes: THREE.Mesh[] = [];
      scene.updateMatrixWorld(true);
      scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !(o as N).isHelper && !o.userData.noTrace) meshes.push(o as THREE.Mesh); });
      const provider = await MeshBVHTraceProvider.fromObjects(device, meshes);
      const mk = (name: string, type: THREE.TextureDataType, format: THREE.AnyPixelFormat) => {
        const t = new THREE.StorageTexture(W, H); t.name = name; t.type = type; t.format = format;
        t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; return t;
      };
      const refRad = mk('ref radiance', THREE.HalfFloatType, THREE.RGBAFormat);
      const refConf = mk('ref confidence', THREE.FloatType, THREE.RedFormat);
      renderer.initTexture(refRad); renderer.initTexture(refConf);
      const module = device.createShaderModule({ label: 'ssr-bench reference', code: REF_WGSL(provider.code({ group: 1, firstBinding: 0 })) });
      const tex = (binding: number, sampleType: GPUTextureSampleType) => ({ binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType } });
      const l0 = device.createBindGroupLayout({
        label: 'ssr-bench reference', entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          tex(1, 'depth'), tex(2, 'unfilterable-float'), tex(3, 'unfilterable-float'),
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
          { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        ],
      });
      const l1 = device.createBindGroupLayout({ entries: provider.entries.map((e, binding) => ({ ...e, binding } as GPUBindGroupLayoutEntry)) });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [l0, l1] });
      const tracePipe = device.createComputePipeline({ layout, compute: { module, entryPoint: 'trace' } });
      const resolvePipe = device.createComputePipeline({ layout, compute: { module, entryPoint: 'resolve' } });
      const ubuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const acc = device.createBuffer({ size: W * H * 16, usage: GPUBufferUsage.STORAGE });
      const accW = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.STORAGE });
      const g1 = device.createBindGroup({ layout: l1, entries: provider.resources().map((resource, binding) => ({ binding, resource })) });
      let g0: GPUBindGroup | null = null;
      const dispatch = (pipe: GPUComputePipeline, spp: number, first: number, seed: number) => {
        const t = pass0.gbuffer.gpuTextures();
        const lit = pass0.gbuffer.frame!.textures.lit!;
        g0 ??= device.createBindGroup({
          layout: l0, entries: [
            { binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: t.depth.createView({ aspect: 'depth-only' }) },
            { binding: 2, resource: t.normal.createView() }, { binding: 3, resource: lit.createView() },
            { binding: 4, resource: { buffer: acc } }, { binding: 5, resource: { buffer: accW } },
            { binding: 6, resource: getGPUTexture(renderer, refRad).createView({ mipLevelCount: 1 }) },
            { binding: 7, resource: getGPUTexture(renderer, refConf).createView({ mipLevelCount: 1 }) },
          ],
        });
        const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const data = new ArrayBuffer(256);
        const f = new Float32Array(data), uu = new Uint32Array(data);
        f.set(vp.clone().invert().elements, 0); f.set(vp.elements, 16);
        f.set([camera.position.x, camera.position.y, camera.position.z, 1], 32);
        uu[36] = W; uu[37] = H; uu[38] = spp; uu[39] = first; f[40] = GLOSSY; uu[41] = seed;
        device.queue.writeBuffer(ubuf, 0, data);
        const enc = device.createCommandEncoder({ label: 'ssr-bench reference' });
        const p = enc.beginComputePass();
        p.setPipeline(pipe); p.setBindGroup(0, g0); p.setBindGroup(1, g1);
        p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
        device.queue.submit([enc.finish()]);
      };
      refTrace = (spp, first, seed) => dispatch(tracePipe, spp, first, seed);
      refResolve = () => dispatch(resolvePipe, 0, 0, 0);
      // the composite over the reference's radiance and confidence (everything else from the pass)
      const proxy = Object.create(pass0, { radiance: { value: refRad }, confidence: { value: refConf } }) as ScreenSpaceReflectionsPass;
      const c = screenSpaceComposite(proxy, { probes, environment: env, environmentIntensity: envI });
      pipeline.outputNode = c.final;
      info = { provider: { meshes: meshes.length, triangles: provider.triangles } };
      render = () => { pass0.render(scene, camera); };
    } else if (base) {
      pipeline.outputNode = vec4(texture(pass0.gbuffer.textures.lit!).rgb, 1);
      render = () => { pass0.gbuffer.render(scene, camera); draw(); };
    } else if (method === 'ours') {
      pipeline.outputNode = screenSpaceComposite(pass0, { probes, environment: env, environmentIntensity: envI }).final;
      render = () => { pass0.render(scene, camera); draw(); };
    } else {
      // ours-accum: BENCH STAND-IN. history.rgb = exponential mean of the specular radiance
      // (mix(probe/env, SSR hit, confidence)), history.a = linear view depth; reprojected by the
      // G-buffer motion (surface motion, so reflections lag under camera motion), reset where the
      // reprojected uv leaves the screen or the depth differs by > 5 %.
      const c = screenSpaceComposite(pass0, { probes, environment: env, environmentIntensity: envI });
      // hist[1] = this frame (written from hist[0] = last frame, then copied over it)
      const hist = [0, 1].map(() => new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false }));
      debugTargets.hist0 = hist[0].texture; debugTargets.hist1 = hist[1].texture;
      const prevTex = texture(hist[0].texture);
      const curTex = texture(hist[1].texture);
      const valid = uniform(0);
      const g = pass0.gbuffer.textures;
      const motion = texture(g.motion!).xy;
      const prevUV = uv().sub(motion);
      const viewZ = (getViewPosition as N)(uv(), texture(g.depth).x, pass0.uniforms.projectionInverse).z.negate();
      const prev = prevTex.sample(prevUV);
      const inside = prevUV.x.greaterThanEqual(0).and(prevUV.x.lessThanEqual(1)).and(prevUV.y.greaterThanEqual(0)).and(prevUV.y.lessThanEqual(1));
      const same = prev.w.sub(viewZ).abs().lessThan(viewZ.mul(0.05));
      const keep = inside.and(same).and(valid.equal(1));
      const a = keep.select(float(0.1), float(1));
      const accMat = new THREE.NodeMaterial(); // raw fragment output: no colour management, alpha kept
      accMat.fragmentNode = vec4(mix(prev.rgb, c.specular, a), viewZ); // (TSL's x.mix(a, b) is mix(a, b, x))
      const accQuad = new THREE.QuadMesh(accMat);
      const accumulated = curTex.rgb;
      pipeline.outputNode = vec4(c.geometry.select(c.lit.add(c.weight.mul(accumulated.sub(c.probeSpecular))).max(0), c.lit), 1);
      render = () => {
        pass0.render(scene, camera);
        renderer.setRenderTarget(hist[1]); accQuad.render(renderer);
        renderer.copyTextureToTexture(hist[1].texture, hist[0].texture);
        valid.value = 1;
        draw();
      };
      info = { standIn: 'exponential history, alpha 0.1, surface-motion reprojection, 5% depth rejection' };
      (window as N).__resetAccum = () => { valid.value = 0; };
    }
  } else {
    // three's examples, on three's own MRT pass of the same scene and camera
    const scenePass: N = pass(scene, camera);
    const stochastic = method !== 'three-blur';
    let finalNode: N;
    if (!stochastic) {
      // webgpu_postprocessing_ssr.html
      scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView), metalrough: vec2(metalness, roughness) }));
      const color = scenePass.getTextureNode('output'), depth = scenePass.getTextureNode('depth');
      const nrm = scenePass.getTextureNode('normal'), mr = scenePass.getTextureNode('metalrough');
      scenePass.getTexture('normal').type = THREE.UnsignedByteType;
      scenePass.getTexture('metalrough').type = THREE.UnsignedByteType;
      const sceneNormal = (sample as N)((u: N) => unpackRGBToNormal(nrm.sample(u)));
      const node: N = threeSSR(color, depth, sceneNormal, { metalnessNode: mr.r, roughnessNode: mr.g, camera } as N);
      // the example's params (quality 0.5, blurQuality 1, intensity 1, thickness 0.03); maxDistance for our scale
      node.quality.value = 0.5; node.blurQuality = 1; node.maxDistance.value = THREE_MAX_DISTANCE; node.intensity.value = 1; node.thickness.value = 0.03;
      finalNode = base ? vec4(color.rgb, 1) : vec4(color.rgb.add(node.rgb), 1);
      info = { example: 'webgpu_postprocessing_ssr', quality: 0.5, blurQuality: 1, maxDistance: THREE_MAX_DISTANCE, thickness: 0.03, smaa: 'omitted' };
    } else {
      // webgpu_postprocessing_ssr_denoise.html
      scenePass.setMRT(mrt({
        output, diffuseColor: vec4(diffuseColor.rgb, materialMetalness),
        normal: vec4(packNormalToRGB(normalView).rgb, materialRoughness), velocity,
      }));
      const color = scenePass.getTextureNode('output'), depth = scenePass.getTextureNode('depth');
      const nrm = scenePass.getTextureNode('normal'), vel = scenePass.getTextureNode('velocity');
      const diffuse = scenePass.getTextureNode('diffuseColor');
      scenePass.getTexture('normal').type = THREE.UnsignedByteType;
      scenePass.getTexture('diffuseColor').type = THREE.UnsignedByteType;
      const sceneNormal = (sample as N)((u: N) => unpackRGBToNormal(nrm.sample(u).rgb));
      const metalRough = (sample as N)((u: N) => vec2(diffuse.sample(u).a, nrm.sample(u).a));
      const env = (scene.environment as N)?.image?.data ? scene.environment : null;
      const node: N = threeSSR(color, depth, sceneNormal, {
        stochastic: true, diffuseNode: diffuse, metalnessNode: diffuse.a, roughnessNode: nrm.a,
        environmentNode: env, envImportanceSampling: false, binaryRefine: false, camera,
      } as N);
      // the example's params; maxDistance for our scale; env intensity = the scene's (the example's 3.14 is tuned to its HDR)
      node.resolutionScale = 1; node.quality.value = 0.25; node.mirrorBias.value = 0; node.stepExponent = 3; node.binaryRefine = false;
      node.maxDistance.value = THREE_MAX_DISTANCE; node.intensity.value = 1; node.thickness.value = 0.1; node.maxLuminance.value = 35;
      node.screenEdgeFade.value = 0.2; node.screenEdgeFadeBlack = INDOOR.has(sceneId); node.environmentIntensity.value = scene.environmentIntensity ?? 1;
      info = {
        example: 'webgpu_postprocessing_ssr_denoise', quality: 0.25, stepExponent: 3, maxDistance: THREE_MAX_DISTANCE, thickness: 0.1,
        maxLuminance: 35, screenEdgeFadeBlack: INDOOR.has(sceneId), environmentIntensity: scene.environmentIntensity ?? 1, envMisses: !!env,
        envSpecularInLighting: 'off (example patch)', traa: 'omitted', grading: 'omitted',
      };
      if (method === 'three-denoise') {
        const tr: N = temporalReproject(node, depth, nrm, vel, camera, { mode: 'specular', accumulate: false } as N);
        const dn: N = recurrentDenoise(tr, camera, { depth, normal: nrm, raw: node, metalRoughness: metalRough, mode: 'specular', accumulate: true } as N);
        dn.alphaSource = 'raylength';
        node.setHistory(dn, vel);
        tr.setHistoryTexture(dn);
        tr.maxFrames.value = 16; tr.clampIntensity.value = 0.25; tr.flickerSuppression.value = 1; tr.hitPointReprojection.value = true;
        const d = { lumaPhi: 0.75, depthPhi: 20, normalPhi: 0.3, roughnessPhi: 100, radius: 1.5, alphaPhi: 5, strength: 0.725, adapt: 0.5, smoothDisocclusions: true, flickerSuppression: 1, adaptiveTrust: 1 };
        for (const [k, v] of Object.entries(d)) dn[k].value = v;
        finalNode = base ? vec4(color.rgb, 1) : vec4(color.rgb.add(dn.rgb), 1);
        info.denoise = { temporalReproject: { maxFrames: 16, clampIntensity: 0.25, flickerSuppression: 1, hitPointReprojection: true }, recurrentDenoise: d };
      } else {
        finalNode = base ? vec4(color.rgb, 1) : vec4(color.rgb.add(node.rgb), 1);
      }
    }
    pipeline.outputNode = finalNode;
    render = () => draw();
  }
  function draw() {
    renderer.setRenderTarget(finalRT);
    pipeline.render();
    renderer.setRenderTarget(null);
  }

  /** One frame of the method (loop stopped: we advance three's node frame ourselves). */
  function frame() {
    nextNodeFrame();
    camera.updateMatrixWorld();
    render();
  }

  // ---- display (screenshots only; never part of a timed frame) ----------------------------------
  const display = new THREE.RenderPipeline(renderer);
  display.outputColorTransform = false;
  display.outputNode = vec4((renderOutput(vec4(texture(finalRT.texture).rgb, 1), THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace) as N).rgb, 1);
  const show = () => { renderer.setRenderTarget(null); display.render(); };

  // ---- metric kernel -----------------------------------------------------------------------------
  const metricModule = device.createShaderModule({ label: 'ssr-bench metric', code: METRIC_WGSL });
  const metricPipe = device.createComputePipeline({ layout: 'auto', compute: { module: metricModule, entryPoint: 'main' } });
  const mu = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const refBuf = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const accBuf = device.createBuffer({ size: W * H * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  let metricGroup: GPUBindGroup | null = null;
  function metric(mode: 0 | 1, first: boolean) {
    metricGroup ??= device.createBindGroup({
      layout: metricPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: mu } }, { binding: 1, resource: getGPUTexture(renderer, finalRT.texture).createView() },
        { binding: 2, resource: { buffer: refBuf } }, { binding: 3, resource: { buffer: accBuf } },
      ],
    });
    device.queue.writeBuffer(mu, 0, new Uint32Array([W, H, mode, first ? 1 : 0]));
    const enc = device.createCommandEncoder({ label: 'ssr-bench metric' });
    const p = enc.beginComputePass();
    p.setPipeline(metricPipe); p.setBindGroup(0, metricGroup); p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
    device.queue.submit([enc.finish()]);
  }
  const readAcc = () => readBuffer(device, accBuf, W * H * 16);

  /** Glossy mask of this pose from our G-buffer: geometry and perceptual roughness < GLOSSY. */
  async function glossyMask() {
    const t = ssr!.gbuffer.gpuTextures();
    const [depth, nr] = await Promise.all([readTexture(device, t.depth), readTexture(device, t.normal)]);
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) m[i] = depth[i] < 1 && nr[i * 4 + 3] < GLOSSY ? 1 : 0;
    return m;
  }

  /** Reference for the current pose: `spp` samples per glossy pixel in batches of 16. Returns tone-mapped v per px. */
  async function referencePose(spp: number, seed: number) {
    frame(); frame(); // G-buffer, pass uniforms
    for (let first = 0; first < spp; first += 16) { refTrace!(Math.min(16, spp - first), first, seed); if ((first / 16) % 8 === 7) await idle(); }
    refResolve!();
    draw();
    metric(0, true);
    const a = await readAcc();
    const v = new Float32Array(W * H);
    let bad = 0;
    for (let i = 0; i < W * H; i++) { v[i] = a[i * 4]; bad += a[i * 4 + 1]; }
    return { v, bad };
  }

  function stats(acc: Float32Array, mask: Uint8Array, n: number) {
    let px = 0, bias = 0, mse = 0, dflick = 0;
    const std: number[] = [];
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) continue;
      const m1 = acc[i * 4] / n, m2 = acc[i * 4 + 1] / n;
      px++; bias += m1; mse += m2; dflick += acc[i * 4 + 3] / Math.max(1, n - 1);
      std.push(Math.sqrt(Math.max(0, m2 - m1 * m1)));
    }
    std.sort((x, y) => x - y);
    const mean = std.reduce((s, x) => s + x, 0) / Math.max(1, std.length);
    return {
      pixels: px, frames: n, bias: bias / px, rmse: Math.sqrt(mse / px), stdMean: mean,
      stdP99: std.length ? std[Math.min(std.length - 1, Math.floor(std.length * 0.99))] : NaN, meanAbsDelta: dflick / px,
    };
  }

  status.textContent = [
    `three r${THREE.REVISION} | ${kit.title} | ${W}x${H} | method ${method}${base ? ' (base: G-buffer + lit only)' : ''} | loop stopped`,
    JSON.stringify(info),
  ].join('\n');
  frame(); show();
  await idle();

  // ---- timing: GPU span of one frame, from timestamps --------------------------------------------
  // A one-texel compute pass writes a timestamp right before the frame is submitted (the GPU is
  // idle: one frame in flight, loop stopped); another, which reads a texel of finalRT and so waits
  // for the whole frame, writes the end. The span is the frame's GPU wall time, plus any gap where
  // the GPU waited for the CPU's next submit (bounded by `cpuMs`, the frame's JS time). Per-pass
  // timestamps aren't used: on Dawn/Metal consecutive render passes overlap (D104).
  // `spin` (default 0) first runs a long single-thread pass to hide the CPU gaps; it doesn't work on
  // Metal: the frame's passes overlap the spin and finish before the begin bracket (span ~0.007 ms).
  const hasTimestamps = device.features.has('timestamp-query');
  const spinModule = device.createShaderModule({
    label: 'ssr-bench brackets', code: /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<uniform> n: vec4u;
@compute @workgroup_size(1) fn spin() { var x = b[0]; for (var i = 0u; i < n.x; i++) { x = x * 1664525u + 1013904223u; } b[1] = x; }
@compute @workgroup_size(1) fn begin() { b[2] = b[1] + 1u; }
@group(0) @binding(2) var t: texture_2d<f32>;
@compute @workgroup_size(1) fn end() { b[3] = u32(textureLoad(t, vec2u(0u), 0).r * 1000.0) + b[2]; }`,
  });
  const scratch = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
  const spinU = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
    ],
  });
  const bracketPipes = Object.fromEntries(['spin', 'begin', 'end'].map((e) => [e, device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bl] }), compute: { module: spinModule, entryPoint: e },
  })]));
  const querySet = hasTimestamps ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
  const qResolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  let bracketGroup: GPUBindGroup | null = null;
  async function timeFrame(spinIters: number) {
    bracketGroup ??= device.createBindGroup({
      layout: bl, entries: [
        { binding: 0, resource: { buffer: scratch } }, { binding: 1, resource: { buffer: spinU } },
        { binding: 2, resource: getGPUTexture(renderer, finalRT.texture).createView() },
      ],
    });
    device.queue.writeBuffer(spinU, 0, new Uint32Array([spinIters, 0, 0, 0]));
    const one = (enc: GPUCommandEncoder, name: string, tw?: GPUComputePassTimestampWrites) => {
      const p = enc.beginComputePass(tw ? { timestampWrites: tw } : {});
      p.setPipeline(bracketPipes[name]); p.setBindGroup(0, bracketGroup); p.dispatchWorkgroups(1); p.end();
    };
    const a = device.createCommandEncoder();
    if (spinIters) one(a, 'spin');
    one(a, 'begin', { querySet: querySet!, beginningOfPassWriteIndex: 0 });
    device.queue.submit([a.finish()]);
    const t0 = performance.now();
    frame();
    const cpuMs = performance.now() - t0;
    const b = device.createCommandEncoder();
    one(b, 'end', { querySet: querySet!, endOfPassWriteIndex: 1 });
    b.resolveQuerySet(querySet!, 0, 2, qResolve, 0);
    const rb = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    b.copyBufferToBuffer(qResolve, 0, rb, 0, 16);
    device.queue.submit([b.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const ts = new BigUint64Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    return { gpuMs: Number(ts[1] - ts[0]) / 1e6, cpuMs };
  }

  // ---- headless hooks ----------------------------------------------------------------------------
  Object.assign(window, {
    __p: {
      THREE, renderer, gpuErrors, method, scene: sceneId, info, size: [W, H],
      step: async (n = 1) => { for (let i = 0; i < n; i++) frame(); await idle(); },
      shot: async () => {
        if (method === 'reference') await referencePose(64, 1); else frame();
        show(); await idle(); return canvas.toDataURL('image/png');
      },
      setOrbitStep: (deg: number) => { orbitDeg = deg; },
      /** Mean rgba of a render target, and the texel at (x, y). */
      async debugTarget(name: string, x = W >> 1, y = H >> 1) {
        const a = await readTexture(device, getGPUTexture(renderer, debugTargets[name]));
        const m = [0, 0, 0, 0];
        for (let i = 0; i < W * H; i++) for (let c = 0; c < 4; c++) m[c] += a[i * 4 + c] / (W * H);
        return { mean: m, at: Array.from(a.slice((y * W + x) * 4, (y * W + x) * 4 + 4)) };
      },
      /** Smoke: frames render, outputs are finite. */
      async smoke(frames = 3) {
        for (let i = 0; i < frames; i++) frame();
        if (method === 'reference') await referencePose(16, 1); // draws through the reference composite
        metric(0, true);
        const a = await readAcc();
        let bad = 0, sum = 0;
        for (let i = 0; i < W * H; i++) { bad += a[i * 4 + 1]; sum += a[i * 4]; }
        show(); await idle();
        return { method, scene: sceneId, nonFinite: bad, meanTone: sum / (W * H), gpuErrors: gpuErrors.length };
      },
      /**
       * method=reference: the still pose (twice, independent sequences, for the noise floor) and the
       * orbit poses 1..orbitFrames, into IndexedDB with each pose's glossy mask.
       */
      async reference(o: { stillSpp?: number; orbitSpp?: number; orbitFrames?: number; orbitDeg?: number } = {}) {
        if (method !== 'reference') throw new Error('reference() needs ?method=reference');
        const stillSpp = o.stillSpp ?? 1024, orbitSpp = o.orbitSpp ?? 256, frames = o.orbitFrames ?? 32;
        orbitDeg = o.orbitDeg ?? orbitDeg;
        const t0 = performance.now();
        setOrbit(0);
        const a = await referencePose(stillSpp, 0x9e3779b9);
        const mask0 = await glossyMask();
        const b = await referencePose(stillSpp, 0x85ebca6b);
        let px = 0, d2 = 0, bad = a.bad;
        for (let i = 0; i < W * H; i++) if (mask0[i]) { px++; d2 += (a.v[i] - b.v[i]) ** 2; }
        await idbPut(refKey('still'), a.v);
        await idbPut(refKey('mask/0'), mask0);
        const tStill = performance.now() - t0;
        for (let t = 1; t <= frames; t++) {
          setOrbit(t);
          const r = await referencePose(orbitSpp, 0x9e3779b9 + t);
          bad += r.bad;
          await idbPut(refKey(`orbit/${t}`), r.v);
          await idbPut(refKey(`mask/${t}`), await glossyMask());
        }
        await idbPut(refKey('meta'), { stillSpp, orbitSpp, frames, orbitDeg });
        setOrbit(0); frame(); show(); await idle();
        // noise of a stillSpp reference: RMS(a - b) / sqrt 2; an orbitSpp one scales by sqrt(stillSpp / orbitSpp)
        const noiseStill = Math.sqrt(d2 / px / 2);
        return {
          glossyPixels: px, nonFinite: bad, stillSpp, orbitSpp, orbitFrames: frames, orbitDeg,
          noiseStill, noiseOrbit: noiseStill * Math.sqrt(stillSpp / orbitSpp), seconds: { still: tStill / 1e3, total: (performance.now() - t0) / 1e3 }, info,
        };
      },
      /** Bias / RMSE / still flicker (fixed camera) and orbit flicker (vs the per-pose reference). */
      async measure(o: { warm?: number; still?: number } = {}) {
        const warm = o.warm ?? 64, stillN = o.still ?? 32;
        const meta = await idbGet<{ frames: number; orbitDeg: number }>(refKey('meta'));
        orbitDeg = meta.orbitDeg;
        const mask0 = await idbGet<Uint8Array>(refKey('mask/0'));
        setOrbit(0);
        (window as N).__resetAccum?.();
        for (let i = 0; i < warm; i++) { frame(); if (i % 8 === 7) await idle(); }
        device.queue.writeBuffer(refBuf, 0, await idbGet<Float32Array<ArrayBuffer>>(refKey('still')));
        for (let i = 0; i < stillN; i++) { frame(); metric(1, i === 0); if (i % 8 === 7) await idle(); }
        const still = stats(await readAcc(), mask0, stillN);
        // orbit: continues from the converged still pose; the mask is every pose's glossy px
        const mask = mask0.slice();
        for (let t = 1; t <= meta.frames; t++) {
          setOrbit(t);
          const [ref, m] = await Promise.all([idbGet<Float32Array<ArrayBuffer>>(refKey(`orbit/${t}`)), idbGet<Uint8Array>(refKey(`mask/${t}`))]);
          for (let i = 0; i < W * H; i++) mask[i] &= m[i];
          device.queue.writeBuffer(refBuf, 0, ref);
          frame(); metric(1, t === 1);
          await idle();
        }
        const orbit = stats(await readAcc(), mask, meta.frames);
        setOrbit(0); frame(); show(); await idle();
        return { method, scene: sceneId, still, orbit, orbitDeg: meta.orbitDeg, info, gpuErrors: gpuErrors.length };
      },
      /** Median GPU ms of one frame over n frames (after `warm`), loop stopped. */
      async time(n = 30, o: { warm?: number; spin?: number } = {}) {
        if (!hasTimestamps) return { error: 'no timestamp-query' };
        const warm = o.warm ?? 10, spin = o.spin ?? 0;
        for (let i = 0; i < warm; i++) await timeFrame(spin);
        const gpu: number[] = [], cpu: number[] = [];
        for (let i = 0; i < n; i++) { const r = await timeFrame(spin); gpu.push(r.gpuMs); cpu.push(r.cpuMs); }
        const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
        const s = [...gpu].sort((x, y) => x - y);
        return { method, base, scene: sceneId, size: [W, H], frames: n, spin, gpuMs: med(gpu), gpuMin: s[0], gpuP90: s[Math.floor(n * 0.9)], cpuMs: med(cpu) };
      },
    },
  });
}

main().catch((e) => {
  console.error(e);
  document.querySelector<HTMLElement>('#status')!.textContent = String(e?.stack ?? e);
});
