// examples/probe-bench: phase 1 of docs/SPEC.md. Probe layout x storage format, against a
// brute-force GGX reference, in raw WebGPU on @pmndrs/reflections/core (no engine).
//
// Per capture size ("class": 128 and 256 px cubes of a procedural HDR sky, ./env.ts):
//   error   each layout x size x format, at every roughness mip, looked up along 65536 Fibonacci
//           directions and compared with GGXReference over the capture's mip 0. Metric: max over
//           channels of |tone(test) - tone(ref)|, tone = Reinhard per channel + sRGB, in /255.
//           Split into seam texels (within 1 texel of a cube face edge, or of an octa fold for
//           octa), interior, and bright (reference luminance > 2).
//   memory  every mip and layer of one probe.
//   bake    GPU time of the prefilter pass, and of prefilter + format conversion.
//   lookup  a 1920x1080 full-screen pass, one probe lookup per pixel (directions over the sphere,
//           roughness in bands, probe picked per screen region), 1, 3 and 16 probes.
// All GPU times are timestamp queries, loop stopped (nothing else runs), median of 5 runs.
//
// `window.__p.run({ smoke })` runs it and returns the results; `?smoke` / `?run` run on load.

import {
  GGXReference, LayoutPrefilter, ProbeFormatWriter, ProbePrefilter, createBC6HEncoder, createProbeLayout, lodToRoughness,
  maxLodFor, octaGutter, probeBytes, referenceModeFor, type ProbeFormat, type ProbeLayout, type ProbeLayoutId,
} from '@pmndrs/reflections/core';
import { ENV_CUBE_WGSL, ENV_WGSL } from './env';
import { cubeEdgeTexels, errorStats, fibonacciDirs, median, octaFoldTexels } from './stats';

const q = new URLSearchParams(location.search);
const statusEl = document.querySelector<HTMLElement>('#status')!;
const lines: string[] = [];
const log = (s: string) => { lines.push(s); statusEl.textContent = lines.join('\n'); console.log(s); };

// 'bc6h-fast' is bc6h-rgb-ufloat from the encoder's mode-11-only preset; 'bc6h-rgb-ufloat' uses 'normal'
type BenchFormat = ProbeFormat | 'bc6h-fast';
const FORMATS: BenchFormat[] = ['rgba16float', 'rg11b10ufloat', 'rgb9e5ufloat', 'bc6h-rgb-ufloat', 'bc6h-fast'];
const gpuFormat = (f: BenchFormat): ProbeFormat => (f === 'bc6h-fast' ? 'bc6h-rgb-ufloat' : f);
const writerFor = (layout: ProbeLayout, size: number, f: BenchFormat, scratch: GPUTexture) =>
  new ProbeFormatWriter(device, layout, size, gpuFormat(f), scratch, bc6h, f === 'bc6h-fast' ? 'fast' : 'normal');
const U = () => GPUBufferUsage;
const T = () => GPUTextureUsage;

interface Config { id: ProbeLayoutId; size: number }
interface Class { source: number; configs: Config[]; lookup: Config[] }

const FULL: Class[] = [
  {
    source: 128,
    // octa 320 / 640: about the memory of the 128 / 256 cube (320^2 vs 6 x 128^2 = 1.04x)
    configs: [{ id: 'cube2d-warp', size: 128 }, { id: 'cube2d-none', size: 128 }, { id: 'cube-hw', size: 128 }, { id: 'octa', size: 128 }, { id: 'octa', size: 256 }, { id: 'octa', size: 320 }, { id: 'octa', size: 512 }],
    lookup: [{ id: 'cube2d-warp', size: 128 }, { id: 'cube2d-none', size: 128 }, { id: 'cube-hw', size: 128 }, { id: 'octa', size: 256 }, { id: 'octa', size: 320 }],
  },
  {
    source: 256,
    configs: [{ id: 'cube2d-warp', size: 256 }, { id: 'cube2d-none', size: 256 }, { id: 'cube-hw', size: 256 }, { id: 'octa', size: 256 }, { id: 'octa', size: 512 }, { id: 'octa', size: 640 }, { id: 'octa', size: 1024 }],
    lookup: [{ id: 'cube2d-warp', size: 256 }, { id: 'cube2d-none', size: 256 }, { id: 'cube-hw', size: 256 }, { id: 'octa', size: 512 }],
  },
];
const SMOKE: Class[] = [{
  source: 64,
  configs: [{ id: 'cube2d-warp', size: 64 }, { id: 'cube2d-none', size: 64 }, { id: 'cube-hw', size: 64 }, { id: 'octa', size: 128 }],
  lookup: [{ id: 'cube2d-warp', size: 64 }, { id: 'cube-hw', size: 64 }, { id: 'octa', size: 128 }],
}];

let device: GPUDevice;
let hasTimestamps = false;
let bc6h: ReturnType<typeof createBC6HEncoder> | null = null;

async function init() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU unavailable');
  const want: GPUFeatureName[] = ['timestamp-query', 'texture-compression-bc'];
  const requiredFeatures = want.filter((f) => adapter.features.has(f));
  device = await adapter.requestDevice({ requiredFeatures });
  device.addEventListener('uncapturederror', (e) => console.error('uncaptured WebGPU error:', (e as GPUUncapturedErrorEvent).error.message));
  device.lost.then((i) => console.error('device lost:', i.message));
  hasTimestamps = device.features.has('timestamp-query') && !q.has('nots');
  if (device.features.has('texture-compression-bc')) bc6h = createBC6HEncoder(device);
  const info = adapter.info;
  return { vendor: info.vendor, architecture: info.architecture, description: info.description, features: requiredFeatures, userAgent: navigator.userAgent };
}

// ---- small GPU helpers --------------------------------------------------------------------------

function buffer(data: ArrayBufferView | number, usage: number) {
  const size = typeof data === 'number' ? data : data.byteLength;
  const b = device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage: usage | U().COPY_DST });
  if (typeof data !== 'number') device.queue.writeBuffer(b, 0, data as BufferSource);
  return b;
}

async function readBuffer(src: GPUBuffer, size: number): Promise<ArrayBuffer> {
  const dst = device.createBuffer({ size, usage: U().MAP_READ | U().COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, dst, 0, size);
  device.queue.submit([enc.finish()]);
  await dst.mapAsync(GPUMapMode.READ);
  const out = dst.getMappedRange().slice(0);
  dst.destroy();
  return out;
}

/** Every mip and layer of an rgba16float texture, as u16 per channel (rows unpadded). */
async function readTexture16(tex: GPUTexture, mips: number): Promise<Uint16Array[]> {
  const out: Uint16Array[] = [];
  for (let m = 0; m < mips; m++) {
    const s = Math.max(tex.width >> m, 1), L = tex.depthOrArrayLayers;
    const bpr = Math.ceil((s * 8) / 256) * 256;
    const b = device.createBuffer({ size: bpr * s * L, usage: U().COPY_DST | U().COPY_SRC });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex, mipLevel: m }, { buffer: b, bytesPerRow: bpr, rowsPerImage: s }, [s, s, L]);
    device.queue.submit([enc.finish()]);
    const raw = new Uint16Array(await readBuffer(b, bpr * s * L));
    b.destroy();
    const packed = new Uint16Array(s * s * L * 4);
    for (let row = 0; row < s * L; row++) packed.set(raw.subarray((row * bpr) / 2, (row * bpr) / 2 + s * 4), row * s * 4);
    out.push(packed);
  }
  return out;
}

/**
 * Timestamp pairs: `writes(i)` for pass i, `read()` gives each pair's ms. Pooled per size and
 * reused (`Timer.get`): creating a query set per measurement ran this Metal device out of memory
 * (kIOGPUCommandBufferCallbackErrorOutOfMemory) after a few hundred.
 */
class Timer {
  private static readonly pool = new Map<number, Timer>();
  static get(n: number) {
    let t = Timer.pool.get(n);
    if (!t) Timer.pool.set(n, (t = new Timer(n)));
    return t;
  }
  private readonly qs: GPUQuerySet;
  private readonly res: GPUBuffer;
  private constructor(private readonly n: number) {
    this.qs = device.createQuerySet({ type: 'timestamp', count: 2 * n });
    this.res = device.createBuffer({ size: 16 * n, usage: U().QUERY_RESOLVE | U().COPY_SRC });
  }
  writes(i: number, which: 'both' | 'begin' | 'end' = 'both') {
    return {
      querySet: this.qs,
      ...(which !== 'end' ? { beginningOfPassWriteIndex: 2 * i } : {}),
      ...(which !== 'begin' ? { endOfPassWriteIndex: 2 * i + 1 } : {}),
    };
  }
  resolve(enc: GPUCommandEncoder) { enc.resolveQuerySet(this.qs, 0, 2 * this.n, this.res, 0); }
  async read(): Promise<{ pairs: number[]; raw: BigInt64Array }> {
    const raw = new BigInt64Array(await readBuffer(this.res, 16 * this.n));
    const pairs: number[] = [];
    for (let i = 0; i < this.n; i++) pairs.push(Number(raw[2 * i + 1] - raw[2 * i]) / 1e6);
    return { pairs, raw };
  }
  destroy() { /* pooled */ }
}

// A one-workgroup pass that reads texel (0, 0) of a texture: closes a timed span after work that
// writes the texture, so Metal can't overlap the timestamp with that work (W2's note).
const TOUCH_WGSL = /* wgsl */ `
@group(0) @binding(0) var t: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> o: array<vec4<f32>>;
@compute @workgroup_size(1) fn main() { o[0] = textureLoad(t, vec2<i32>(0, 0), 0, 0); }`;
let touchPipe: GPUComputePipeline;
let touchBuf: GPUBuffer;
function touch(enc: GPUCommandEncoder, tex: GPUTexture, timestampWrites?: GPUComputePassTimestampWrites) {
  const pass = enc.beginComputePass({ timestampWrites });
  pass.setPipeline(touchPipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: touchPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: tex.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 }) },
    { binding: 1, resource: { buffer: touchBuf } },
  ] }));
  pass.dispatchWorkgroups(1);
  pass.end();
}

// ---- environment ----------------------------------------------------------------------------------

function envCube(size: number): GPUTexture {
  const tex = device.createTexture({ label: `env${size}`, size: [size, size, 6], format: 'rgba16float', usage: T().STORAGE_BINDING | T().TEXTURE_BINDING | T().COPY_SRC });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: ENV_CUBE_WGSL }), entryPoint: 'main' } });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: tex.createView({ dimension: '2d-array' }) },
    { binding: 1, resource: { buffer: buffer(new Uint32Array([size, 0, 0, 0]), U().UNIFORM) } },
  ] }));
  pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
  pass.end();
  device.queue.submit([enc.finish()]);
  return tex;
}

/** Equirect preview of the environment on the page's canvas. */
function preview() {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview')!;
  const ctx = canvas.getContext('webgpu');
  if (!ctx) return;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format });
  const module = device.createShaderModule({ code: `${ENV_WGSL}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)); return vec4(p * 2.0 - 1.0, 0.0, 1.0); }
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = pos.xy / vec2(512.0, 256.0);
  let az = (uv.x - 0.5) * 6.283185307; let el = (0.5 - uv.y) * 3.14159265;
  let c = envRadiance(vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az)));
  return vec4(pow(c / (1.0 + c), vec3(1.0 / 2.2)), 1.0); }` });
  const pipe = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipe);
  pass.draw(3);
  pass.end();
  device.queue.submit([enc.finish()]);
}

// ---- probes -----------------------------------------------------------------------------------

const sampler = () => device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

function makeTarget(layout: ProbeLayout, size: number, probes: number, format: ProbeFormat) {
  const d = layout.textureDescriptor(size, probes, format);
  return device.createTexture({ ...d, usage: (d.usage as number) | T().COPY_SRC | T().COPY_DST });
}

const evalPipes = new Map<string, GPUComputePipeline>();
function evalPipe(layout: ProbeLayout) {
  let p = evalPipes.get(layout.wgsl);
  if (!p) {
    const code = `${layout.wgsl}
@group(0) @binding(0) var tex: ${layout.textureType};
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<storage, read> dirs: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outRad: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> P: vec4<f32>; // x = lod, y = count
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= u32(P.y)) { return; }
  outRad[g.x] = sampleLayout(tex, samp, 0u, dirs[g.x].xyz, P.x);
}`;
    p = device.createComputePipeline({ label: `eval.${layout.id}`, layout: 'auto', compute: { module: device.createShaderModule({ code, label: `eval.${layout.id}` }), entryPoint: 'main' } });
    evalPipes.set(layout.wgsl, p);
  }
  return p;
}

/** sampleLayout of probe 0 along every direction at `lod`. */
async function lookupAll(layout: ProbeLayout, tex: GPUTexture, dirs: GPUBuffer, count: number, lod: number): Promise<Float32Array> {
  const pipe = evalPipe(layout);
  const out = device.createBuffer({ size: count * 16, usage: U().STORAGE | U().COPY_SRC });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: tex.createView({ dimension: layout.viewDimension }) },
    { binding: 1, resource: sampler() },
    { binding: 2, resource: { buffer: dirs } },
    { binding: 3, resource: { buffer: out } },
    { binding: 4, resource: { buffer: buffer(new Float32Array([lod, count, 0, 0]), U().UNIFORM) } },
  ] }));
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  const r = new Float32Array(await readBuffer(out, count * 16));
  out.destroy();
  return r;
}

function seamMask(cfg: Config, maxLod: number, lod: number, dirs: Float32Array): Uint8Array {
  const n = dirs.length / 4;
  const m = new Uint8Array(n);
  const s = Math.max(cfg.size >> lod, 1);
  const octaSpan = s * (1 - 2 * octaGutter(cfg.size, maxLod));
  for (let i = 0; i < n; i++) {
    const x = dirs[i * 4], y = dirs[i * 4 + 1], z = dirs[i * 4 + 2];
    m[i] = (cfg.id === 'octa' ? octaFoldTexels(x, y, z, octaSpan) : cubeEdgeTexels(x, y, z, s)) < 1 ? 1 : 0;
  }
  return m;
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// ---- the bench --------------------------------------------------------------------------------

async function run({ smoke = false, runs = 9 } = {}) {
  const timedRuns = runs;
  const t0 = performance.now();
  lines.length = 0;
  const classes = smoke ? SMOKE : FULL;
  const nDirs = smoke ? 4096 : 65536;
  const results: Record<string, unknown> & { error: unknown[]; bake: unknown[]; lookup: unknown[]; parity: unknown[]; refCheck: unknown[]; pending: string[] } = {
    device: deviceInfo, smoke, nDirs, error: [], bake: [], lookup: [], parity: [], refCheck: [], pending: [],
  };
  touchPipe ??= device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: TOUCH_WGSL }), entryPoint: 'main' } });
  touchBuf ??= device.createBuffer({ size: 16, usage: U().STORAGE });
  const formats = FORMATS.filter((f) => !f.startsWith('bc6h') || bc6h);
  if (!bc6h) results.pending.push('bc6h: no texture-compression-bc on this device');
  const dirsCpu = fibonacciDirs(nDirs);
  const dirs = buffer(dirsCpu, U().STORAGE);

  for (const cls of classes) {
    const N = cls.source;
    const maxLod = maxLodFor(N);
    log(`\n== capture ${N} px, maxLod ${maxLod} ==`);
    const src = envCube(N);

    // parity: the generic prefilter writes the cube2d layouts bit-identically to ProbePrefilter
    for (const warp of [true, false]) {
      const layout = createProbeLayout(warp ? 'cube2d-warp' : 'cube2d-none', { maxLod });
      const a = makeTarget(layout, N, 1, 'rgba16float'), b = makeTarget(layout, N, 1, 'rgba16float');
      const oldPf = new ProbePrefilter(device, N, warp), newPf = new LayoutPrefilter(device, layout, N, N);
      const enc = device.createCommandEncoder();
      oldPf.encode(enc, src, a, 0);
      newPf.encode(enc, src, b, 0);
      device.queue.submit([enc.finish()]);
      const [ra, rb] = [await readTexture16(a, maxLod + 1), await readTexture16(b, maxLod + 1)];
      let diff = 0, total = 0;
      for (let m = 0; m < ra.length; m++) for (let i = 0; i < ra[m].length; i++) { total++; if (ra[m][i] !== rb[m][i]) diff++; }
      results.parity.push({ source: N, layout: layout.id, values: total, differing: diff });
      log(`parity ProbePrefilter vs LayoutPrefilter(${layout.id}): ${diff} / ${total} half values differ`);
      oldPf.dispose(); newPf.dispose(); a.destroy(); b.destroy();
    }

    // reference per roughness mip, plus roughness between the first mips (r < 0.2, where the
    // roughness-to-lod mappings differ most, D64): those lookups blend two mips
    const levels: { lod: number; r: number; between: boolean }[] = [];
    for (let lod = 0; lod <= maxLod; lod++) levels.push({ lod, r: lodToRoughness(lod, maxLod), between: false });
    if (!smoke) for (const r of [0.05, 0.1, 0.15]) levels.push({ lod: maxLod * r * (2 - r), r, between: true });
    const reference = new GGXReference(device, src, N);
    const refs: Float32Array[] = [];
    const refOut = device.createBuffer({ size: nDirs * 16, usage: U().STORAGE | U().COPY_SRC });
    for (const { lod, r } of levels) {
      const tr = performance.now();
      const mode = await reference.compute(dirs, refOut, nDirs, r);
      refs.push(new Float32Array(await readBuffer(refOut, nDirs * 16)));
      log(`reference lod ${lod.toFixed(2)} r ${r.toFixed(3)} (${mode}) ${(performance.now() - tr).toFixed(0)} ms`);
      await nextFrame();
    }
    // QMC noise: the 65536-sample reference against 262144 samples, at every QMC mip
    for (let lod = 1; lod <= maxLod && !smoke; lod++) {
      const r = lodToRoughness(lod, maxLod);
      if (referenceModeFor(r, N) !== 'qmc') continue;
      await reference.compute(dirs, refOut, nDirs, r, { mode: 'qmc', samples: 262144 });
      const alt = new Float32Array(await readBuffer(refOut, nDirs * 16));
      const st = errorStats(alt, refs[lod], new Uint8Array(nDirs));
      results.refCheck.push({ source: N, lod, roughness: r, used: 'qmc', against: 'qmc 262144', ...st.all });
      log(`reference check lod ${lod}: qmc 65536 vs 262144: mean ${st.all.mean.toFixed(3)} p99 ${st.all.p99.toFixed(2)} max ${st.all.max.toFixed(1)} /255`);
    }
    // the two estimators on the same lobes, either side of the switch
    for (let lod = 1; lod <= maxLod; lod++) {
      const r = lodToRoughness(lod, maxLod);
      const mode = referenceModeFor(r, N);
      const prev = lod > 1 ? referenceModeFor(lodToRoughness(lod - 1, maxLod), N) : mode;
      const next = lod < maxLod ? referenceModeFor(lodToRoughness(lod + 1, maxLod), N) : mode;
      if (smoke || (mode === prev && mode === next)) continue;
      const other = mode === 'qmc' ? 'exhaustive' : 'qmc';
      await reference.compute(dirs, refOut, nDirs, r, { mode: other, samples: 262144 });
      const alt = new Float32Array(await readBuffer(refOut, nDirs * 16));
      const st = errorStats(alt, refs[lod], new Uint8Array(nDirs));
      results.refCheck.push({ source: N, lod, roughness: r, used: mode, against: other, ...st.all });
      log(`reference check lod ${lod}: ${mode} vs ${other}: mean ${st.all.mean.toFixed(3)} p99 ${st.all.p99.toFixed(2)} max ${st.all.max.toFixed(1)} /255`);
    }
    refOut.destroy();

    // error, memory and bake time per layout x size x format
    for (const cfg of cls.configs) {
      const layout = createProbeLayout(cfg.id, { maxLod });
      const pf = new LayoutPrefilter(device, layout, cfg.size, N);
      const masks = Array.from({ length: maxLod + 1 }, (_, lod) => seamMask(cfg, maxLod, lod, dirsCpu));
      // Bake times are spans over a block of BLOCK back-to-back bakes (begin of the first pass to
      // the end of a pass that reads the result), divided by BLOCK: single-pass timestamps on
      // Metal overlap with neighbouring passes and with clock ramps. Two untimed bakes go first.
      const BLOCK = Number(q.get('block') ?? (smoke ? 1 : 8));
      // The span opens and closes with a one-texel pass carrying both of its timestamps: with
      // begin-only / end-only timestamps on the prefilter passes themselves, more than ~4 prefilters
      // per command buffer failed on this Metal device (kIOGPUCommandBufferCallbackErrorOutOfMemory).
      const span = async (one: (enc: GPUCommandEncoder) => void, tex: GPUTexture) => {
        const timer = hasTimestamps ? Timer.get(2) : null;
        const enc = device.createCommandEncoder();
        for (let i = 0; i < 2; i++) one(enc);
        touch(enc, tex, timer?.writes(0));
        for (let i = 0; i < BLOCK; i++) one(enc);
        touch(enc, tex, timer?.writes(1));
        timer?.resolve(enc);
        device.queue.submit([enc.finish()]);
        if (!timer) { await device.queue.onSubmittedWorkDone(); return NaN; }
        const { raw } = await timer.read();
        return Number(raw[3] - raw[1]) / 1e6 / BLOCK;
      };
      const prefMs: number[] = [];
      if (hasTimestamps) {
        for (let k = 0; k < timedRuns; k++) prefMs.push(await span((enc) => pf.encodeScratch(enc, src), pf.scratch));
      }
      for (const format of formats) {
        const writer = writerFor(layout, cfg.size, format, pf.scratch);
        const target = makeTarget(layout, cfg.size, 1, gpuFormat(format));
        // bake: prefilter + conversion, closed by a pass that reads the target
        const bakeMs: number[] = [];
        for (let k = 0; k < (hasTimestamps ? timedRuns : 1); k++) {
          bakeMs.push(await span((enc) => { pf.encodeScratch(enc, src); writer.encode(enc, pf.scratch, target, 0); }, target));
        }
        const bytes = probeBytes(layout, cfg.size, gpuFormat(format));
        results.bake.push({ source: N, layout: cfg.id, size: cfg.size, format, prefilterMs: Math.min(...prefMs), bakeMs: Math.min(...bakeMs), prefilterMedianMs: median(prefMs), bakeMedianMs: median(bakeMs) });
        const row: string[] = [];
        for (let li = 0; li < levels.length; li++) {
          const { lod, r, between } = levels[li];
          const test = await lookupAll(layout, target, dirs, nDirs, lod);
          const st = errorStats(test, refs[li], masks[Math.floor(lod)]);
          results.error.push({ source: N, layout: cfg.id, size: cfg.size, format, bytes, lod, roughness: r, between, ...st });
          row.push(`${st.all.mean.toFixed(2)}/${st.all.p99.toFixed(1)}`);
        }
        log(`${cfg.id}@${cfg.size} ${format}: ${(bytes / 1024).toFixed(0)} KiB, bake ${median(bakeMs).toFixed(3)} ms (prefilter ${median(prefMs).toFixed(3)}), mean/p99 per level ${row.join('  ')}`);
        writer.dispose(); target.destroy();
        await nextFrame();
      }
      pf.dispose();
    }

    // lookup cost. Apple GPUs change clocks with load, so every timed pass of a configuration is
    // interleaved with the same pass on the baseline (cube-hw, rgba16float, same probe count) in
    // one submit, after a warm-up; the ratio is the robust number, the ms are that submit's.
    const W = smoke ? 320 : 1920, H = smoke ? 180 : 1080;
    const baseLayout = createProbeLayout('cube-hw', { maxLod });
    const basePf = new LayoutPrefilter(device, baseLayout, N, N);
    const baseWriter = new ProbeFormatWriter(device, baseLayout, N, 'rgba16float', basePf.scratch);
    { const e = device.createCommandEncoder(); basePf.encodeScratch(e, src); device.queue.submit([e.finish()]); }
    const counts = smoke ? [3] : [1, 3, 16];
    const baseTex = new Map<number, GPUTexture>();
    for (const probes of counts) {
      const t = makeTarget(baseLayout, N, probes, 'rgba16float');
      const e = device.createCommandEncoder();
      for (let k = 0; k < probes; k++) baseWriter.encode(e, basePf.scratch, t, k);
      device.queue.submit([e.finish()]);
      baseTex.set(probes, t);
    }
    const patterns = smoke ? ['coherent'] : ['coherent', 'scattered', 'x8'];
    for (const cfg of cls.lookup) {
      const layout = createProbeLayout(cfg.id, { maxLod });
      const pf = new LayoutPrefilter(device, layout, cfg.size, N);
      const enc0 = device.createCommandEncoder();
      pf.encodeScratch(enc0, src);
      device.queue.submit([enc0.finish()]);
      for (const format of smoke ? (['rgba16float', 'rgb9e5ufloat'] as ProbeFormat[]) : formats.filter((f) => f !== 'bc6h-fast')) {
        for (const probes of counts) {
          const target = makeTarget(layout, cfg.size, probes, gpuFormat(format));
          const writer = writerFor(layout, cfg.size, format, pf.scratch);
          const enc = device.createCommandEncoder();
          for (let k = 0; k < probes; k++) writer.encode(enc, pf.scratch, target, k);
          device.queue.submit([enc.finish()]);
          for (const pattern of patterns) {
            if ((pattern === 'scattered' && probes !== 16) || (pattern === 'x8' && probes !== 3)) continue;
            const m = await timeLookup(
              { layout, tex: target }, { layout: baseLayout, tex: baseTex.get(probes)! },
              probes, maxLod, W, H, smoke ? 1 : timedRuns, pattern,
            );
            results.lookup.push({ source: N, layout: cfg.id, size: cfg.size, format, probes, pattern, width: W, height: H, ...m });
            log(`lookup ${cfg.id}@${cfg.size} ${format} x${probes} ${pattern}: ${m.ms.toFixed(3)} ms, baseline ${m.baseMs.toFixed(3)} ms, ratio ${m.ratio.toFixed(3)} (timestamps ${m.timestampMs.toFixed(3)} ms)`);
          }
          writer.dispose(); target.destroy();
        }
      }
      pf.dispose();
    }
    for (const t of baseTex.values()) t.destroy();
    basePf.dispose(); baseWriter.dispose();
    src.destroy();
  }
  dirs.destroy();
  results.seconds = (performance.now() - t0) / 1000;
  log(`\ndone in ${(results.seconds as number).toFixed(1)} s`);
  (window as unknown as { __results: unknown }).__results = results;
  return results;
}

/** Lod for roughness r under a mapping (the JS twin of core's lodWgsl). */
function lodFor(mapping: 'r187' | 'alpha', r: number, maxLod: number) {
  const lod = maxLod * r * (2 - r);
  if (mapping === 'r187') return lod;
  const l = Math.min(Math.floor(lod), Math.max(maxLod - 1, 0));
  const rl = lodToRoughness(l, maxLod), rh = lodToRoughness(l + 1, maxLod);
  if (rh > 0.3) return lod;
  return l + Math.min(1, Math.max(0, (r * r - rl * rl) / Math.max(rh * rh - rl * rl, 1e-6)));
}

/**
 * D101 experiment (W7): error of lookups between the roughness mips under the r187 lod mapping and the
 * 'alpha' mapping (same mips, blend linear in r^2), cube-hw rgba16float, 128 and 256 px captures.
 */
async function lowRoughness({ nDirs = 65536 } = {}) {
  lines.length = 0;
  const rows: unknown[] = [];
  const dirsCpu = fibonacciDirs(nDirs);
  const dirs = buffer(dirsCpu, U().STORAGE);
  const rs = [0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.4, 0.7];
  for (const N of [128, 256]) {
    const maxLod = maxLodFor(N);
    const src = envCube(N);
    const layout = createProbeLayout('cube-hw', { maxLod });
    const pf = new LayoutPrefilter(device, layout, N, N);
    const target = makeTarget(layout, N, 1, 'rgba16float');
    const enc = device.createCommandEncoder(); pf.encode(enc, src, target, 0); device.queue.submit([enc.finish()]);
    const reference = new GGXReference(device, src, N);
    const refOut = device.createBuffer({ size: nDirs * 16, usage: U().STORAGE | U().COPY_SRC });
    const none = new Uint8Array(nDirs);
    for (const r of rs) {
      await reference.compute(dirs, refOut, nDirs, r);
      const ref = new Float32Array(await readBuffer(refOut, nDirs * 16));
      const cells: string[] = [];
      for (const mapping of ['r187', 'alpha'] as const) {
        const lod = lodFor(mapping, r, maxLod);
        const st = errorStats(await lookupAll(layout, target, dirs, nDirs, lod), ref, none);
        rows.push({ source: N, r, mapping, lod, ...st.all });
        cells.push(`${mapping} lod ${lod.toFixed(2)}: ${st.all.mean.toFixed(2)} / ${st.all.p99.toFixed(1)}`);
      }
      log(`${N} px r ${r.toFixed(3)}: ${cells.join('   ')}`);
      await nextFrame();
    }
    refOut.destroy(); target.destroy(); pf.dispose(); src.destroy();
  }
  dirs.destroy();
  return rows;
}

// Full-screen lookup. 'coherent': directions over the whole sphere (equirect of the screen, slightly
// jittered per pixel), roughness in diagonal bands 0 ... 1, probe chosen per screen region (1, 3
// columns, or a 4x4 grid), so neighbouring pixels read neighbouring texels, as a real frame does.
// 'scattered': random direction, roughness and probe per pixel (cache worst case). 'x8': eight
// coherent lookups per pixel.
const lookupPipes = new Map<string, GPURenderPipeline>();
function lookupPipe(layout: ProbeLayout) {
  let p = lookupPipes.get(layout.wgsl);
  if (!p) {
    const code = `${layout.wgsl}
struct LU { res: vec2<f32>, probes: u32, maxLod: f32 }
@group(0) @binding(0) var tex: ${layout.textureType};
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: LU;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)); return vec4(p * 2.0 - 1.0, 0.0, 1.0); }
fn hash2(p: vec2<u32>) -> vec2<f32> {
  var x = p.x * 1664525u + p.y * 1013904223u; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u;
  var y = x * 0x846ca68bu; y ^= y >> 16u;
  return vec2(f32(x), f32(y)) * 2.3283064365386963e-10 - 0.5;
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = pos.xy / P.res;
  let scattered = (P.probes & 0x100u) != 0u;
  let count = P.probes & 0xffu;
  let j = hash2(vec2<u32>(pos.xy));
  var az = (uv.x + j.x * 0.01) * 6.283185307; var el = (0.5 - uv.y + j.y * 0.01) * 3.14159265;
  var r = fract(uv.x * 5.0 + uv.y * 3.0);
  var probe = 0u;
  if (count == 3u) { probe = min(u32(uv.x * 3.0), 2u); }
  else if (count == 16u) { probe = min(u32(uv.x * 4.0), 3u) + 4u * min(u32(uv.y * 4.0), 3u); }
  if (scattered) {
    // worst case for the texture cache: every pixel a random direction, roughness and probe
    let k = hash2(vec2<u32>(pos.yx) + 7u);
    az = j.x * 6.283185307; el = asin(clamp(j.y * 2.0, -1.0, 1.0)); r = k.x + 0.5;
    probe = min(u32((k.y + 0.5) * f32(count)), count - 1u);
  }
  if ((P.probes & 0x200u) != 0u) {
    // 8 lookups per pixel (nearby directions, spread roughness): sampling cost without the
    // render-target write dominating
    var acc = vec4(0.0);
    for (var i = 0u; i < 8u; i++) {
      let a = az + f32(i) * 0.02;
      let ri = fract(r + f32(i) * 0.125);
      acc += sampleLayout(tex, samp, probe, vec3(cos(el) * sin(a), sin(el), cos(el) * cos(a)), P.maxLod * ri * (2.0 - ri));
    }
    return acc * 0.125;
  }
  let dir = vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az));
  return sampleLayout(tex, samp, probe, dir, P.maxLod * r * (2.0 - r));
}`;
    const module = device.createShaderModule({ code, label: `lookup.${layout.id}` });
    p = device.createRenderPipeline({ label: `lookup.${layout.id}`, layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    lookupPipes.set(layout.wgsl, p);
  }
  return p;
}

/**
 * ms of one full-screen lookup pass of `test`, and of the same pass on `base` (wall clock over
 * bursts, see below), and their ratio.
 */
async function timeLookup(test: { layout: ProbeLayout; tex: GPUTexture }, base: { layout: ProbeLayout; tex: GPUTexture }, probes: number, maxLod: number, W: number, H: number, runs: number, pattern: string) {
  const scattered = pattern === 'scattered';
  const rt = device.createTexture({ size: [W, H], format: 'rgba16float', usage: T().RENDER_ATTACHMENT | T().TEXTURE_BINDING });
  const u = new ArrayBuffer(16);
  new Float32Array(u, 0, 2).set([W, H]);
  new Uint32Array(u, 8, 1).set([probes | (scattered ? 0x100 : 0) | (pattern === 'x8' ? 0x200 : 0)]);
  new Float32Array(u, 12, 1).set([maxLod]);
  const ub = buffer(new Uint8Array(u), U().UNIFORM);
  const bind = (c: { layout: ProbeLayout; tex: GPUTexture }) => {
    const pipe = lookupPipe(c.layout);
    return { pipe, group: device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: c.tex.createView({ dimension: c.layout.viewDimension }) },
      { binding: 1, resource: sampler() },
      { binding: 2, resource: { buffer: ub } },
    ] }) };
  };
  const t = bind(test), b = bind(base);
  const burst = (c: typeof t, n: number, tw?: { timer: Timer }) => {
    const enc = device.createCommandEncoder();
    for (let k = 0; k < n; k++) {
      const writes = tw ? (k === 0 ? tw.timer.writes(0, 'begin') : k === n - 1 ? tw.timer.writes(0, 'end') : undefined) : undefined;
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: rt.createView(), loadOp: 'clear', storeOp: 'store' }], timestampWrites: writes });
      pass.setPipeline(c.pipe); pass.setBindGroup(0, c.group); pass.draw(3); pass.end();
    }
    tw?.timer.resolve(enc);
    return enc.finish();
  };
  // Wall clock over bursts of N passes (submit to onSubmittedWorkDone, / N), test and baseline
  // bursts alternating, after a warm-up burst; median over `runs` pairs. Render-pass timestamps on
  // this Metal device were not usable for this: identical passes timed ~0.8x depending on order,
  // and the spans came out at ~2x the wall clock, so they are kept only as a secondary number.
  // Scattered passes are ~10x slower: fewer of them per burst, under the GPU watchdog.
  const N = scattered ? 4 : 32;
  const wallOf = async (c: typeof t) => {
    const c0 = performance.now();
    device.queue.submit([burst(c, N)]);
    await device.queue.onSubmittedWorkDone();
    return (performance.now() - c0) / N;
  };
  device.queue.submit([burst(t, N), burst(b, N)]);
  await device.queue.onSubmittedWorkDone();
  const ms: number[] = [], baseMs: number[] = [], ts: number[] = [];
  for (let run = 0; run < runs; run++) {
    ms.push(await wallOf(t));
    baseMs.push(await wallOf(b));
  }
  if (hasTimestamps) {
    for (let run = 0; run < runs; run++) {
      const timer = Timer.get(1);
      device.queue.submit([burst(t, N, { timer })]);
      ts.push((await timer.read()).pairs[0] / N);
    }
  }
  rt.destroy(); ub.destroy();
  // min: the least contended run (other GPU work shared this machine); ratio: median of the
  // per-pair ratios of back-to-back bursts
  return { ms: Math.min(...ms), medianMs: median(ms), baseMs: Math.min(...baseMs), ratio: median(ms.map((m, i) => m / baseMs[i])), timestampMs: hasTimestamps ? median(ts) : NaN };
}

let deviceInfo: unknown = null;

async function main() {
  try {
    deviceInfo = await init();
    log(`device: ${JSON.stringify(deviceInfo)}`);
    preview();
    const api = { run, lowRoughness, get log() { return lines.join('\n'); }, get results() { return (window as unknown as { __results: unknown }).__results; }, device: deviceInfo };
    (window as unknown as { __p: typeof api }).__p = api;
    document.querySelector('#go')!.addEventListener('click', () => run());
    document.querySelector('#smoke')!.addEventListener('click', () => run({ smoke: true }));
    if (q.has('smoke')) await run({ smoke: true });
    else if (q.has('run')) await run();
  } catch (e) {
    log(`error: ${(e as Error).stack ?? e}`);
    console.error(e);
  }
}

main();
