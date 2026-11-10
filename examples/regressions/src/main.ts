// examples/regressions: GPU repros for bugs found in review, one function per bug, all numbers
// returned from `await __p.run()` (scripts/run-headless.mjs, `--only regressions`, checks them).
//
//  gbuffer:  motion is 0 on a static scene with instanced, skinned and batched meshes; moving one
//            instance moves only it; a camera cut + resetHistory() gives 0 motion; two render()
//            calls in one animation frame give the same motion as one per frame; jittered frames
//            with the unjittered projection given give 0 motion; roughnessNode / metalnessNode
//            reach the G-buffer; MeshBasic env reflections stay out of scene colour;
//            logarithmicDepthBuffer is rejected.
//  bc6h:     no anchor index overflows its slot (a patched copy of the shipped WGSL counts them);
//            a capped scratch buffer gives the same bits; an encode whose blocks exceed the
//            default maxStorageBufferBindingSize works on a device with default limits.
import * as THREE from 'three/webgpu';
import { float } from 'three/tsl';
import { createBC6HEncoder } from '@pmndrs/reflections/core';
import { FrameGBuffer, getDevice } from '@pmndrs/reflections/three';
// @ts-ignore vite raw import
import bc6hSrc from '../../../packages/core/src/encode/bc6h.ts?raw';
import { gbufferFirstFrameChecks, rtHistoryChecks, rtStatsChecks, rtTileChecks, ssrHistoryChecks } from './ssr';
import { rtLimitChecks } from './core';

/** Stream F2's sections (SSR / RT and probe-core review), by name. */
const F2: Record<string, () => Promise<unknown>> = {
  ssrHistory: ssrHistoryChecks,
  rtTiles: rtTileChecks,
  rtLimits: rtLimitChecks,
  rtHistory: rtHistoryChecks,
  rtStats: rtStatsChecks,
  gbufferFirstFrame: gbufferFirstFrameChecks,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const status = document.querySelector<HTMLElement>('#status')!;
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const W = 320, H = 160;

function halfToFloat(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Read a 2D texture into floats (rg16float, rgba16float, rgba8unorm). */
async function readTexture(device: GPUDevice, tex: GPUTexture) {
  const info = ({ rg16float: [4, 2, 'h'], rgba16float: [8, 4, 'h'], rgba8unorm: [4, 4, 'u8'] } as const)[tex.format as 'rg16float'];
  if (!info) throw new Error(`readTexture: ${tex.format}`);
  const [bytes, ch, kind] = info;
  const bpr = Math.ceil((tex.width * bytes) / 256) * 256;
  const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const e = device.createCommandEncoder();
  e.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  device.queue.submit([e.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const dv = new DataView(buf.getMappedRange());
  const out = new Float32Array(tex.width * tex.height * ch);
  for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) for (let c = 0; c < ch; c++) {
    const o = y * bpr + x * bytes;
    out[(y * tex.width + x) * ch + c] = kind === 'h' ? halfToFloat(dv.getUint16(o + c * 2, true)) : dv.getUint8(o + c) / 255;
  }
  buf.unmap(); buf.destroy();
  return { data: out, ch, width: tex.width, height: tex.height };
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
function motionStats(m: { data: Float32Array; width: number; height: number }, rect?: Rect, eps = 1e-4) {
  let max = 0, inside = 0, outside = 0, outsideMax = 0;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    const i = (y * m.width + x) * 2;
    const v = Math.max(Math.abs(m.data[i]), Math.abs(m.data[i + 1]));
    max = Math.max(max, v);
    const isIn = rect && x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
    if (v > eps) { if (isIn) inside++; else { outside++; } }
    if (!isIn) outsideMax = Math.max(outsideMax, v);
  }
  return { max, inside, outside, outsideMax };
}
/** Max |motion| per screen quarter (columns: plain, instanced, skinned, batched). */
function perColumn(m: { data: Float32Array; width: number; height: number }) {
  const out = [0, 0, 0, 0];
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    const i = (y * m.width + x) * 2;
    const c = Math.min(3, Math.floor((x / m.width) * 4));
    out[c] = Math.max(out[c], Math.abs(m.data[i]), Math.abs(m.data[i + 1]));
  }
  return out;
}
/** Pixel rect covering an axis-aligned box `size` at `matrix`, seen by `camera`, padded. */
function screenRect(matrix: THREE.Matrix4, size: number, camera: THREE.Camera, pad = 3): Rect {
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? size / 2 : -size / 2, i & 2 ? size / 2 : -size / 2, i & 4 ? size / 2 : -size / 2).applyMatrix4(matrix).project(camera);
    const px = (v.x * 0.5 + 0.5) * W, py = (0.5 - v.y * 0.5) * H;
    r.x0 = Math.min(r.x0, px); r.x1 = Math.max(r.x1, px); r.y0 = Math.min(r.y0, py); r.y1 = Math.max(r.y1, py);
  }
  return { x0: Math.floor(r.x0) - pad, y0: Math.floor(r.y0) - pad, x1: Math.ceil(r.x1) + pad, y1: Math.ceil(r.y1) + pad };
}

// ---- G-buffer ---------------------------------------------------------------------------------
async function gbufferChecks() {
  const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  await renderer.init();
  const device = getDevice(renderer);
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('[webgpu uncapturederror]', m); });
  const gb = new FrameGBuffer(renderer, { width: W, height: H });
  const motion = async () => readTexture(device, gb.gpuTextures().motion);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(2, 3, 5); scene.add(sun);
  const cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
  cam.position.set(0, 0, 10); cam.updateMatrixWorld();
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.4 });
  const T = (x: number, y: number, z = 0) => new THREE.Matrix4().makeTranslation(x, y, z);

  const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  plain.position.set(-3.6, 0, 0); scene.add(plain);

  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat, 3);
  inst.position.set(-1.2, 0, 0);
  [1.2, 0, -1.2].forEach((y, i) => inst.setMatrixAt(i, T(0, y)));
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);

  // a two-bone skinned bar, the upper bone posed away from the bind pose
  const sgeo = new THREE.BoxGeometry(0.8, 2.4, 0.8, 1, 8, 1);
  const sp = sgeo.attributes.position;
  const si: number[] = [], sw: number[] = [];
  for (let i = 0; i < sp.count; i++) { const w = THREE.MathUtils.smoothstep(sp.getY(i), -0.6, 0.6); si.push(0, 1, 0, 0); sw.push(1 - w, w, 0, 0); }
  sgeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  sgeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const skinned = new THREE.SkinnedMesh(sgeo, mat);
  const b0 = new THREE.Bone(); b0.position.y = -1.2;
  const b1 = new THREE.Bone(); b1.position.y = 1.2; b0.add(b1);
  skinned.add(b0);
  skinned.position.set(1.2, 0, 0);
  skinned.updateMatrixWorld(true);
  skinned.bind(new THREE.Skeleton([b0, b1]));
  b1.rotation.z = 0.5;
  scene.add(skinned);

  const batched = new THREE.BatchedMesh(2, 64, 128, mat);
  const bg = batched.addGeometry(new THREE.BoxGeometry(0.6, 0.6, 0.6));
  batched.setMatrixAt(batched.addInstance(bg), T(0, 0.8));
  batched.setMatrixAt(batched.addInstance(bg), T(0, -0.8));
  batched.position.set(3.6, 0, 0);
  scene.add(batched);

  const r: Record<string, unknown> = {};
  for (let i = 0; i < 4; i++) { await raf(); gb.render(scene, cam); }
  const s0 = await motion();
  r.staticScene = { ...motionStats(s0), perColumn: perColumn(s0) };

  // move instance 0 only: motion inside its rect, none elsewhere
  inst.setMatrixAt(0, T(0.3, 1.2)); inst.instanceMatrix.needsUpdate = true;
  await raf(); gb.render(scene, cam);
  const rect = screenRect(new THREE.Matrix4().multiplyMatrices(inst.matrixWorld, T(0.3, 1.2)), 0.6, cam);
  r.movedInstance = { rect, ...motionStats(await motion(), rect) };
  await raf(); gb.render(scene, cam);
  r.afterMove = motionStats(await motion());

  // camera cut + resetHistory: no previous frame, so no motion
  await raf();
  cam.position.set(1.5, 0.3, 10); cam.updateMatrixWorld();
  gb.resetHistory();
  gb.render(scene, cam);
  r.cutReset = motionStats(await motion());
  await raf(); gb.render(scene, cam);
  r.afterCut = motionStats(await motion());

  // two render() calls in one animation frame vs one per frame: same motion, and the camera
  // struct's previous view is the one rendered just before
  const P0 = [0, 0, 10], P1 = [0.2, 0, 10], P2 = [0.4, 0.1, 10];
  const at = (p: number[]) => { cam.position.set(p[0], p[1], p[2]); cam.updateMatrixWorld(); };
  at(P0); await raf(); gb.render(scene, cam); await raf();
  at(P1); const fA1 = gb.render(scene, cam);
  const viewP1 = Array.from(fA1.camera.view as ArrayLike<number>);
  at(P2); const fA2 = gb.render(scene, cam); // same animation frame
  const mA = await motion();
  const prevIsP1 = Array.from(fA2.camera.prevView as ArrayLike<number>).every((v, i) => Math.abs(v - viewP1[i]) < 1e-6);
  at(P0); await raf(); gb.render(scene, cam); await raf();
  at(P1); gb.render(scene, cam); await raf();
  at(P2); gb.render(scene, cam);
  const mB = await motion();
  let diff = 0, nonzero = 0;
  for (let i = 0; i < mA.data.length; i++) { diff = Math.max(diff, Math.abs(mA.data[i] - mB.data[i])); if (Math.abs(mB.data[i]) > 1e-4) nonzero++; }
  r.twoRendersOneFrame = { maxDiff: diff, nonzero, cameraPrevIsLastRender: prevIsP1 };

  // jitter: the projection alternates by ±0.25 px, the unjittered one is passed: static => 0 motion
  at(P0);
  cam.clearViewOffset();
  const unjittered = cam.projectionMatrix.clone();
  let jitterMax = 0, projOk = true;
  for (let i = 0; i < 4; i++) {
    const j: [number, number] = i & 1 ? [0.25, -0.25] : [-0.25, 0.25];
    cam.setViewOffset(W, H, j[0], j[1], W, H);
    await raf();
    const f = gb.render(scene, cam, { jitter: j, projection: unjittered.elements } as N);
    if (i > 0) jitterMax = Math.max(jitterMax, motionStats(await motion()).max);
    const pj = (f.camera as N).projectionJittered as ArrayLike<number> | undefined;
    projOk &&= Array.from(f.camera.projection as ArrayLike<number>).every((v, k) => Math.abs(v - unjittered.elements[k]) < 1e-5)
      && !!pj && Array.from(pj).every((v, k) => Math.abs(v - cam.projectionMatrix.elements[k]) < 1e-5);
  }
  cam.clearViewOffset();
  r.jitter = { maxMotion: jitterMax, projectionUnjitteredAndJitteredExposed: projOk };

  // materials: roughnessNode / metalnessNode, MeshBasic + envMap kept out of scene colour
  const ms = new THREE.Scene();
  const mcam = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 10); mcam.position.z = 5; mcam.updateMatrixWorld();
  const nodeMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  nodeMat.roughnessNode = float(0.25);
  nodeMat.metalnessNode = float(0.75);
  const left = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), nodeMat); left.position.x = -1; ms.add(left);
  const env = new THREE.DataTexture(new Uint8Array(4 * 8).fill(255), 4, 2); env.mapping = THREE.EquirectangularReflectionMapping; env.needsUpdate = true;
  const basic = new THREE.MeshBasicMaterial({ color: 0x404040, envMap: env, combine: THREE.AddOperation, reflectivity: 1 });
  const right = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), basic); right.position.x = 1; ms.add(right);
  await raf(); gb.render(ms, mcam);
  const tx = gb.gpuTextures();
  const nr = await readTexture(device, tx.normal), am = await readTexture(device, tx.albedo), sc = await readTexture(device, tx.sceneColor);
  const px = (t: { data: Float32Array; ch: number; width: number }, x: number, y: number, c: number) => t.data[(y * t.width + x) * t.ch + c];
  r.materials = {
    roughnessNode: px(nr, W / 4, H / 2, 3), metalnessNode: px(am, W / 4, H / 2, 3),
    basicEnvSceneColor: [0, 1, 2].map((c) => px(sc, (3 * W) / 4, H / 2, c)), basicExpected: new THREE.Color(0x404040).r,
  };

  // logarithmic depth: rejected with a clear error
  const c2 = document.createElement('canvas'); c2.width = c2.height = 16;
  const logR = new THREE.WebGPURenderer({ canvas: c2, logarithmicDepthBuffer: true } as N);
  await logR.init();
  try { new FrameGBuffer(logR, { width: 16, height: 16 }); r.logDepth = { threw: false }; }
  catch (e) { r.logDepth = { threw: true, message: String((e as Error).message) }; }
  logR.dispose();

  r.gpuErrors = gpuErrors;
  gb.dispose();
  return r;
}

// ---- BC6H -------------------------------------------------------------------------------------
const SRC_GEN = /* wgsl */ `
@group(0) @binding(0) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(1) var<uniform> kind: vec4u;
fn hash(v: u32) -> u32 { var x = v * 747796405u + 2891336453u; x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u; return (x >> 22u) ^ x; }
fn rnd(v: u32) -> f32 { return f32(hash(v) & 0xffffffu) / 16777216.0; }
var<private> PATTERNS: array<u32, 16> = array<u32, 16>(
  2290666700u, 3972591342u, 4276930688u, 3967876808u, 4293707776u, 3892379264u, 4278255592u, 4026597360u,
  9369360u, 147747072u, 1930428556u, 2362323200u, 823134348u, 913073766u, 267393000u, 966553998u);
fn faceDirUV(face: u32, u: f32, v: f32) -> vec3f {
  switch face {
    case 0u: { return vec3( 1.0, -v, -u); }
    case 1u: { return vec3(-1.0, -v,  u); }
    case 2u: { return vec3( u,  1.0,  v); }
    case 3u: { return vec3( u, -1.0, -v); }
    case 4u: { return vec3( u, -v,  1.0); }
    default: { return vec3(-u, -v, -1.0); }
  }
}
fn radiance(d: vec3f) -> vec3f {
  let sun = normalize(vec3f(0.35, 0.55, 0.75));
  let c = dot(d, sun);
  var col = mix(vec3f(0.9, 1.0, 1.2), vec3f(0.06, 0.12, 0.4), saturate(d.y));
  col += vec3f(40.0, 30.0, 18.0) * pow(max(c, 0.0), 300.0);
  if (c > 0.999) { col = vec3f(1000.0, 920.0, 800.0); }
  if (d.y >= 0.0 && d.y < 0.12) {
    let a = atan2(d.z, d.x) * 3.0 / 3.14159265;
    let k = u32(floor(a + 3.0)) % 6u;
    var bars = array<vec3f, 6>(vec3f(6.0, 0.02, 0.02), vec3f(0.02, 3.0, 0.02), vec3f(0.02, 0.02, 8.0),
                               vec3f(0.5, 0.5, 0.0), vec3f(0.003, 0.003, 0.003), vec3f(20.0, 20.0, 20.0));
    col = bars[k];
  }
  if (d.y < 0.0) {
    let g = d.xz / max(-d.y, 0.05);
    let ch = (i32(floor(g.x * 2.0)) + i32(floor(g.y * 2.0))) & 1;
    col = select(vec3f(0.001, 0.0012, 0.0015), vec3f(0.25, 0.2, 0.15), ch == 1);
  }
  return col;
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst).x;
  if (id.x >= size || id.y >= size) { return; }
  var col = vec3f(0.0);
  if (kind.x == 0u) {
    for (var s = 0u; s < 4u; s++) {
      let uv = (vec2f(id.xy) + vec2f(f32(s & 1u), f32(s >> 1u)) * 0.5 + 0.25) / f32(size) * 2.0 - 1.0;
      col += radiance(normalize(faceDirUV(id.z % 6u, uv.x, uv.y))) * 0.25;
    }
  } else {
    // two-subset blocks: per block a random BC6H partition, two random colours, small ramps
    let b = (id.z * 4096u + id.y / 4u) * 4096u + id.x / 4u + kind.y * 7919u;
    let p = hash(b) % 32u;
    let i = (id.y % 4u) * 4u + (id.x % 4u);
    var enc = PATTERNS[p >> 1u];
    if ((p & 1u) != 0u) { enc = enc >> 16u; }
    let sub = (enc >> i) & 1u;
    let sc = exp2(rnd(b * 3u + 1u) * 8.0 - 4.0);
    let c0 = vec3f(rnd(b * 5u + 2u), rnd(b * 7u + 3u), rnd(b * 11u + 4u)) * sc;
    let c1 = vec3f(rnd(b * 13u + 5u), rnd(b * 17u + 6u), rnd(b * 19u + 7u)) * sc;
    let t = f32(i) / 15.0 * 0.3;
    col = select(c0, c1, sub == 1u) * (1.0 + t);
  }
  textureStore(dst, id.xy, id.z, vec4f(col, 1.0));
}`;

// (src.rgb, dec.rgb) per texel of one 2D-array mip; or 3 sample texels per layer (big test)
const READ = /* wgsl */ `
@group(0) @binding(0) var a: texture_2d_array<f32>;
@group(0) @binding(1) var b: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dim = textureDimensions(a);
  if (id.x >= dim.x || id.y >= dim.y) { return; }
  let s = textureLoad(a, id.xy, id.z, 0).rgb;
  let d = textureLoad(b, id.xy, id.z, 0).rgb;
  let i = ((id.z * dim.y + id.y) * dim.x + id.x) * 6u;
  o[i] = s.x; o[i + 1u] = s.y; o[i + 2u] = s.z; o[i + 3u] = d.x; o[i + 4u] = d.y; o[i + 5u] = d.z;
}`;
const SAMPLE = /* wgsl */ `
@group(0) @binding(0) var b: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> o: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let d = textureDimensions(b) - 1u;
  var pts = array<vec2u, 4>(vec2u(0u), d, vec2u(d.x / 2u, d.y / 3u), vec2u(d.x, 0u));
  for (var k = 0u; k < 4u; k++) { o[id.x * 4u + k] = textureLoad(b, pts[k], id.x, 0); }
}`;

async function bc6hChecks() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter?.features.has('texture-compression-bc')) return { supported: false };
  // default limits on purpose (maxStorageBufferBindingSize 128 MiB, maxBufferSize 256 MiB)
  const device = await adapter.requestDevice({ requiredFeatures: ['texture-compression-bc'] });
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('[webgpu uncapturederror]', m); });
  const pipe = (code: string, constants?: Record<string, number>) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main', constants } });
  const genPipe = pipe(SRC_GEN), readPipe = pipe(READ), samplePipe = pipe(SAMPLE);
  const out: Record<string, unknown> = { limits: { maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxBufferSize: device.limits.maxBufferSize } };

  // a patched copy of the shipped WGSL that counts anchor indices too big for their slot
  const start = bc6hSrc.indexOf('const WGSL = /* wgsl */ `') + 'const WGSL = /* wgsl */ `'.length;
  let wgsl: string = bc6hSrc.slice(start, bc6hSrc.indexOf('`;', start));
  for (const s of ['  blk.z |= pat << 13u;\n', '  var block = vec4u(0u);\n', '  let u0 = unquantize10(ep0);\n', 'var<private> texels']) {
    if (!wgsl.includes(s)) throw new Error('bc6h patch anchor missing: ' + JSON.stringify(s));
  }
  wgsl = wgsl.replace('var<private> texels', '@group(0) @binding(3) var<storage, read_write> dbg: array<atomic<u32>, 4>;\nvar<private> texels');
  wgsl = wgsl.replace('  blk.z |= pat << 13u;\n', '  atomicAdd(&dbg[1], 1u);\n  if (indices[0] > 3u || indices[patternFixupID(pat)] > 3u) { atomicAdd(&dbg[0], 1u); }\n  blk.z |= pat << 13u;\n');
  wgsl = wgsl.replace('  let u0 = unquantize10(ep0);\n', '  if (indices[0] > 7u) { atomicAdd(&dbg[2], 1u); }\n  let u0 = unquantize10(ep0);\n');
  const dbgPipe = pipe(wgsl, { ENCODE_P2: 1 });
  const enc = createBC6HEncoder(device);
  const cappedEnc = (createBC6HEncoder as N)(device, { maxScratchBytes: 4096 });

  const makeSrc = (kind: number, size: number, layers: number, mips = 1) => {
    const src = device.createTexture({ size: [size, size, layers], mipLevelCount: mips, format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    const ku = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ku, 0, new Uint32Array([kind, 1, 0, 0]));
    const cmd = device.createCommandEncoder();
    const pass = cmd.beginComputePass();
    pass.setPipeline(genPipe);
    for (let m = 0; m < mips; m++) {
      const s = size >> m;
      pass.setBindGroup(0, device.createBindGroup({ layout: genPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: src.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1 }) }, { binding: 1, resource: { buffer: ku } }] }));
      pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), layers);
    }
    pass.end();
    device.queue.submit([cmd.finish()]);
    return src;
  };

  async function log2Rmse(src: GPUTexture, dec: GPUTexture) {
    const s = src.width, L = src.depthOrArrayLayers, bytes = s * s * L * 24;
    const buf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rb = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const cmd = device.createCommandEncoder();
    const pass = cmd.beginComputePass();
    pass.setPipeline(readPipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: readPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: src.createView({ dimension: '2d-array', mipLevelCount: 1 }) }, { binding: 1, resource: dec.createView({ dimension: '2d-array', mipLevelCount: 1 }) }, { binding: 2, resource: { buffer: buf } }] }));
    pass.dispatchWorkgroups(s / 8, s / 8, L); pass.end();
    cmd.copyBufferToBuffer(buf, 0, rb, 0, bytes);
    device.queue.submit([cmd.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const d = new Float32Array(rb.getMappedRange());
    const F = 2 ** -12;
    let e2 = 0, bad = 0, nan = 0;
    // blocks whose worst texel is off by more than 1 stop
    const nb = (s / 4) * (s / 4) * L, worst = new Float32Array(nb);
    for (let t = 0; t < d.length / 6; t++) {
      const x = t % s, y = Math.floor(t / s) % s, z = Math.floor(t / (s * s));
      const bi = (z * (s / 4) + (y >> 2)) * (s / 4) + (x >> 2);
      for (let c = 0; c < 3; c++) {
        const e = Math.log2(Math.max(d[t * 6 + 3 + c], F)) - Math.log2(Math.max(d[t * 6 + c], F));
        if (!Number.isFinite(e)) { nan++; continue; }
        e2 += e * e; worst[bi] = Math.max(worst[bi], Math.abs(e));
      }
    }
    for (const w of worst) if (w > 1) bad++;
    const n = d.length / 2;
    rb.unmap(); rb.destroy(); buf.destroy();
    return { log2Rmse: Math.sqrt(e2 / n), blocksOverOneStop: bad, blocks: nb, nonFinite: nan };
  }

  const anchors: unknown[] = [];
  for (const [name, kind, size, layers] of [['procedural cube 256', 0, 256, 6], ['two-subset random 512', 1, 512, 4]] as const) {
    const src = makeSrc(kind, size, layers);
    const bx = size / 4, by = size / 4, rowStride = Math.ceil((bx * 16) / 256) * 16;
    const blocks = device.createBuffer({ size: rowStride * 16 * by * layers, usage: GPUBufferUsage.STORAGE });
    const P = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(P, 0, new Uint32Array([0, rowStride, bx, by, 0, 0, 0, 0]));
    const dbg = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const dbgRb = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const cmd = device.createCommandEncoder();
    const pass = cmd.beginComputePass();
    pass.setPipeline(dbgPipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: dbgPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: src.createView({ dimension: '2d-array' }) }, { binding: 1, resource: { buffer: blocks } },
      { binding: 2, resource: { buffer: P } }, { binding: 3, resource: { buffer: dbg } }] }));
    pass.dispatchWorkgroups(Math.ceil(bx / 8), Math.ceil(by / 8), layers); pass.end();
    cmd.copyBufferToBuffer(dbg, 0, dbgRb, 0, 16);
    device.queue.submit([cmd.finish()]);
    await dbgRb.mapAsync(GPUMapMode.READ);
    const d = Array.from(new Uint32Array(dbgRb.getMappedRange().slice(0)));
    dbgRb.unmap();
    const dec = enc.encode(src, { quality: 'normal' });
    anchors.push({ name, blocks: bx * by * layers, twoSubsetBlocks: d[1], twoSubsetAnchorOverflow: d[0], oneSubsetAnchorOverflow: d[2], hardware: await log2Rmse(src, dec) });
    src.destroy(); dec.destroy(); blocks.destroy(); P.destroy(); dbg.destroy(); dbgRb.destroy();
  }
  out.anchors = anchors;

  // capped scratch (forces chunking by rows and layers) gives the same bits as one big scratch
  {
    const src = makeSrc(0, 256, 6, 9);
    const a = enc.encode(src, { quality: 'normal' }), b = cappedEnc.encode(src, { quality: 'normal' });
    const read = async (t: GPUTexture) => {
      const parts: Uint8Array[] = [];
      for (let m = 0; m < t.mipLevelCount; m++) {
        const bxm = Math.max(1, Math.ceil((t.width >> m) / 4)), bpr = Math.ceil((bxm * 16) / 256) * 256;
        const buf = device.createBuffer({ size: bpr * bxm * t.depthOrArrayLayers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const c = device.createCommandEncoder();
        c.copyTextureToBuffer({ texture: t, mipLevel: m }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: bxm }, [bxm * 4, bxm * 4, t.depthOrArrayLayers]);
        device.queue.submit([c.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        parts.push(new Uint8Array(buf.getMappedRange().slice(0)));
        buf.destroy();
      }
      return parts;
    };
    const A = await read(a), B = await read(b);
    let differ = 0;
    A.forEach((p, m) => { for (let i = 0; i < p.length; i++) if (p[i] !== B[m][i]) differ++; });
    out.cappedScratch = { bytesDiffer: differ, bytes: A.reduce((s, p) => s + p.length, 0) };
    src.destroy(); a.destroy(); b.destroy();
  }

  // more block data than one default storage binding holds: 4096² × 9 layers = 151 MB of blocks
  {
    const size = 4096, layers = 9;
    const errsBefore = gpuErrors.length;
    const src = device.createTexture({ size: [size, size, layers], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    const cmd = device.createCommandEncoder();
    for (let l = 0; l < layers; l++) {
      const v = (l + 1) / 10;
      cmd.beginRenderPass({ colorAttachments: [{ view: src.createView({ dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: [v, 0, 0, 1] }] }).end();
    }
    device.queue.submit([cmd.finish()]);
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    const dec = enc.encode(src, { quality: 'fast' });
    const oom = await device.popErrorScope();
    const val = await device.popErrorScope();
    const o = device.createBuffer({ size: layers * 4 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const orb = device.createBuffer({ size: layers * 4 * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const c2 = device.createCommandEncoder();
    const pass = c2.beginComputePass();
    pass.setPipeline(samplePipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: samplePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: dec.createView({ dimension: '2d-array' }) }, { binding: 1, resource: { buffer: o } }] }));
    pass.dispatchWorkgroups(layers); pass.end();
    c2.copyBufferToBuffer(o, 0, orb, 0, orb.size);
    device.queue.submit([c2.finish()]);
    await orb.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(orb.getMappedRange().slice(0));
    let maxErr = 0;
    for (let l = 0; l < layers; l++) for (let k = 0; k < 4; k++) {
      const i = (l * 4 + k) * 4, v = Math.round(((l + 1) / 10) * 255) / 255;
      maxErr = Math.max(maxErr, Math.abs(f[i] - v) / v, Math.abs(f[i + 1]), Math.abs(f[i + 2]));
    }
    out.overBindingLimit = {
      blockBytes: (size / 4) * (size / 4) * 16 * layers, validationError: val?.message ?? null, outOfMemory: oom?.message ?? null,
      newUncapturedErrors: gpuErrors.slice(errsBefore), maxRelErr: maxErr,
    };
    src.destroy(); dec.destroy(); o.destroy(); orb.destroy();
  }
  enc.destroy(); cappedEnc.destroy();
  out.gpuErrors = gpuErrors;
  return out;
}

const results: Record<string, unknown> = {};
(window as unknown as { __p: unknown }).__p = {
  results,
  async run(which = ['gbuffer', 'bc6h', ...Object.keys(F2)]) {
    if (which.includes('gbuffer')) results.gbuffer = await gbufferChecks();
    if (which.includes('bc6h')) results.bc6h = await bc6hChecks();
    // F2 sections report a thrown error instead of failing the whole page
    for (const [name, fn] of Object.entries(F2)) {
      if (!which.includes(name)) continue;
      try { results[name] = await fn(); } catch (e) { results[name] = { error: String((e as Error)?.stack ?? e) }; }
    }
    status.textContent = JSON.stringify(results, null, 1);
    return results;
  },
};
status.textContent = 'ready: await __p.run()';
