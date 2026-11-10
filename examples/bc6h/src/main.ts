// examples/bc6h: the GPU BC6H encoder on a procedural HDR cube, checked through the hardware decoder.
//
// Builds an rgba16float 2D-array texture (6 layers per cube, full mip chain) whose content stresses
// BC6H: smooth sky gradients, a sun disk at ~1000 with a glow, a near-black checker floor (0.001
// against 0.25, hard edges) and saturated colour bars on the horizon. Encodes it with
// createBC6HEncoder, then reads source and result back with textureLoad (so the hardware decoder
// is the ground truth for the bitstream) and reports the error, plus GPU encode times.
// `window.__p` drives the page headlessly: `await __p.runAll()` returns every number on the page.

import { createBC6HEncoder, type BC6HEncodeOptions } from '@pmndrs/reflections/core';

type Quality = NonNullable<BC6HEncodeOptions['quality']>;
const status = document.querySelector<HTMLElement>('#status')!;
const tables = document.querySelector<HTMLElement>('#tables')!;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const ctx2d = canvas.getContext('2d')!;
const log = (s: string) => { status.textContent = s; };
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const SOURCE_WGSL = /* wgsl */ `
@group(0) @binding(0) var dst: texture_storage_2d_array<rgba16float, write>;
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
fn radiance(d: vec3f, probe: u32) -> vec3f {
  let sun = normalize(vec3f(0.35 + 0.1 * f32(probe % 4u), 0.55, 0.75));
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
  for (var s = 0u; s < 4u; s++) {   // 2x2 supersampling, so small mips look like a box-filtered chain
    let uv = (vec2f(id.xy) + vec2f(f32(s & 1u), f32(s >> 1u)) * 0.5 + 0.25) / f32(size) * 2.0 - 1.0;
    col += radiance(normalize(faceDirUV(id.z % 6u, uv.x, uv.y)), id.z / 6u);
  }
  textureStore(dst, id.xy, id.z, vec4f(col * 0.25, 1.0));
}`;

// Copies source and decoded texels of one mip to a buffer: (src.rgb, dec.rgb) per texel.
const READ_WGSL = /* wgsl */ `
@group(0) @binding(0) var a: texture_2d_array<f32>;
@group(0) @binding(1) var b: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dim = textureDimensions(a);
  if (id.x >= dim.x || id.y >= dim.y) { return; }
  let s = textureLoad(a, id.xy, id.z, 0).rgb;
  let d = textureLoad(b, id.xy, id.z, 0).rgb;
  let i = ((id.z * dim.y + id.y) * dim.x + id.x) * 6u;
  out[i] = s.x; out[i + 1u] = s.y; out[i + 2u] = s.z;
  out[i + 3u] = d.x; out[i + 4u] = d.y; out[i + 5u] = d.z;
}`;

// Side-by-side view: source | BC6H | |log2 error| heat, each panel nearest-upsampled from one mip.
const VIEW_WGSL = /* wgsl */ `
struct V { layer: u32, panel: u32, height: u32, exposure: f32, gain: f32 }
@group(0) @binding(0) var a: texture_2d_array<f32>;
@group(0) @binding(1) var b: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> v: V;
fn tm(x: vec3f) -> vec3f { let y = x * v.exposure; return pow(y / (1.0 + y), vec3f(1.0 / 2.2)); }
fn heat(t: f32) -> vec3f { return saturate(vec3f(t * 3.0, t * 3.0 - 1.0, t * 3.0 - 2.0)); }
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = v.panel * 3u;
  if (id.x >= W || id.y >= v.height) { return; }
  let p = id.x / v.panel;
  let dim = textureDimensions(a);
  let t = min(vec2u(vec2f(f32(id.x % v.panel), f32(id.y)) / f32(v.panel) * vec2f(dim)), dim - 1u);
  let s = textureLoad(a, t, v.layer, 0).rgb;
  let d = textureLoad(b, t, v.layer, 0).rgb;
  var c = tm(s);
  if (p == 1u) { c = tm(d); }
  if (p == 2u) {
    let F = exp2(-12.0);
    let e = abs(log2(max(d, vec3f(F))) - log2(max(s, vec3f(F))));
    c = heat((e.x + e.y + e.z) / 3.0 * v.gain);
  }
  out[id.y * W + id.x] = pack4x8unorm(vec4f(c, 1.0));
}`;

const NOOP_WGSL = /* wgsl */ `@compute @workgroup_size(1) fn main() {}`;
// Reads the encoded texture, so the closing timestamp waits for the encode and its copies. Without
// a dependency, Metal runs the bracketing passes alongside the encode and the bracket measures ~0.
const TOUCH_WGSL = /* wgsl */ `
@group(0) @binding(0) var t: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> o: vec4f;
@compute @workgroup_size(1) fn main() { o = textureLoad(t, vec2u(0u), 0u, 0) + textureLoad(t, vec2u(0u), 0u, textureNumLevels(t) - 1u); }`;

interface Metrics {
  texels: number; log2Rmse: number; log2Max: number; rmsle: number; psnr: number;
  meanAbs: number[]; maxAbs: number[]; perMipLog2Rmse: number[];
}

async function main() {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const hasBC = adapter.features.has('texture-compression-bc');
  const hasTS = adapter.features.has('timestamp-query');
  if (!hasBC) {
    log("this adapter has no 'texture-compression-bc'; BC6H can't be used here");
    (window as unknown as { __p: unknown }).__p = { supported: false, runAll: async () => ({ supported: false }) };
    return;
  }
  const device = await adapter.requestDevice({
    requiredFeatures: ['texture-compression-bc', ...(hasTS ? ['timestamp-query' as GPUFeatureName] : [])],
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
  });
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; errors.push(m); console.error('WebGPU:', m); });

  const encoder = createBC6HEncoder(device);
  const pipe = (code: string, label: string) => device.createComputePipeline({ label, layout: 'auto', compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' } });
  const sourcePipe = pipe(SOURCE_WGSL, 'bc6h source');
  const readPipe = pipe(READ_WGSL, 'bc6h readback');
  const viewPipe = pipe(VIEW_WGSL, 'bc6h view');
  const noopPipe = pipe(NOOP_WGSL, 'noop');
  const touchPipe = pipe(TOUCH_WGSL, 'touch');
  const mipView = (t: GPUTexture, mip: number) => t.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 });

  function makeSource(size: number, probes: number): GPUTexture {
    const mips = Math.log2(size) + 1;
    const layers = 6 * probes;
    const tex = device.createTexture({
      label: `hdr cube ${size} x${probes}`, size: [size, size, layers], mipLevelCount: mips, format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const cmd = device.createCommandEncoder();
    const pass = cmd.beginComputePass();
    pass.setPipeline(sourcePipe);
    for (let m = 0; m < mips; m++) {
      const s = Math.max(1, size >> m);
      pass.setBindGroup(0, device.createBindGroup({ layout: sourcePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: mipView(tex, m) }] }));
      pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), layers);
    }
    pass.end();
    device.queue.submit([cmd.finish()]);
    return tex;
  }

  async function readMip(src: GPUTexture, dec: GPUTexture, mip: number): Promise<Float32Array> {
    const s = Math.max(1, src.width >> mip), layers = src.depthOrArrayLayers;
    const bytes = s * s * layers * 6 * 4;
    const buf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rb = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const cmd = device.createCommandEncoder();
    const pass = cmd.beginComputePass();
    pass.setPipeline(readPipe);
    pass.setBindGroup(0, device.createBindGroup({
      layout: readPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: mipView(src, mip) }, { binding: 1, resource: mipView(dec, mip) }, { binding: 2, resource: { buffer: buf } }],
    }));
    pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), layers);
    pass.end();
    cmd.copyBufferToBuffer(buf, 0, rb, 0, bytes);
    device.queue.submit([cmd.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.destroy(); buf.destroy();
    return out;
  }

  /** Error of `dec` against `src` over every mip and layer. log2 errors floor values at 2^-12. */
  async function measure(src: GPUTexture, dec: GPUTexture): Promise<Metrics> {
    const F = 2 ** -12;
    const tm = (x: number) => Math.pow(x / (1 + x), 1 / 2.2);
    let n = 0, e2 = 0, eMax = 0, l2 = 0, t2 = 0;
    const sumAbs = [0, 0, 0], maxAbs = [0, 0, 0], perMip: number[] = [];
    for (let m = 0; m < src.mipLevelCount; m++) {
      const d = await readMip(src, dec, m);
      let me2 = 0, mn = 0;
      for (let i = 0; i < d.length; i += 6) {
        for (let c = 0; c < 3; c++) {
          const s = d[i + c], x = d[i + 3 + c];
          const e = Math.log2(Math.max(x, F)) - Math.log2(Math.max(s, F));
          me2 += e * e; eMax = Math.max(eMax, Math.abs(e));
          const l = Math.log2(x + 1) - Math.log2(s + 1); l2 += l * l;
          const t = tm(x) - tm(s); t2 += t * t;
          const a = Math.abs(x - s); sumAbs[c] += a; if (a > maxAbs[c]) maxAbs[c] = a;
        }
        mn++;
      }
      e2 += me2; n += mn;
      perMip.push(Math.sqrt(me2 / (mn * 3)));
    }
    return {
      texels: n, log2Rmse: Math.sqrt(e2 / (n * 3)), log2Max: eMax, rmsle: Math.sqrt(l2 / (n * 3)),
      psnr: 10 * Math.log10(1 / (t2 / (n * 3))), meanAbs: sumAbs.map((s) => s / n), maxAbs, perMipLog2Rmse: perMip,
    };
  }

  const newDst = (src: GPUTexture) => device.createTexture({
    size: [src.width, src.height, src.depthOrArrayLayers], mipLevelCount: src.mipLevelCount, format: 'bc6h-rgb-ufloat',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  /** GPU time of `reps` encodes recorded back to back, bracketed by timestamped no-op passes. Median of `runs`. */
  async function timeEncode(src: GPUTexture, quality: Quality, reps: number, runs = 5) {
    const dst = newDst(src);
    const qs = hasTS ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
    const resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const rb = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const gpu: number[] = [], wall: number[] = [];
    const touchOut = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
    const touchBG = device.createBindGroup({
      layout: touchPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: dst.createView({ dimension: '2d-array' }) }, { binding: 1, resource: { buffer: touchOut } }],
    });
    for (let r = -1; r < runs; r++) { // r = -1 warms up (pipeline compile, first-use allocations)
      const cmd = device.createCommandEncoder();
      const bracket = (index: 0 | 1) => {
        const p = cmd.beginComputePass(qs ? { timestampWrites: index === 0 ? { querySet: qs, beginningOfPassWriteIndex: 0 } : { querySet: qs, endOfPassWriteIndex: 1 } } : {});
        if (index === 0) p.setPipeline(noopPipe); else { p.setPipeline(touchPipe); p.setBindGroup(0, touchBG); }
        p.dispatchWorkgroups(1); p.end();
      };
      bracket(0);
      for (let i = 0; i < reps; i++) encoder.encodeInto(cmd, src, dst, { quality });
      bracket(1);
      if (qs) { cmd.resolveQuerySet(qs, 0, 2, resolve, 0); cmd.copyBufferToBuffer(resolve, 0, rb, 0, 16); }
      const t0 = performance.now();
      device.queue.submit([cmd.finish()]);
      await device.queue.onSubmittedWorkDone();
      const t1 = performance.now();
      if (r < 0) continue;
      wall.push((t1 - t0) / reps);
      if (qs) {
        await rb.mapAsync(GPUMapMode.READ);
        const t = new BigUint64Array(rb.getMappedRange().slice(0));
        rb.unmap();
        gpu.push(Number(t[1] - t[0]) / 1e6 / reps);
      }
    }
    dst.destroy(); qs?.destroy(); resolve.destroy(); rb.destroy(); touchOut.destroy();
    return { gpuMs: gpu.length ? median(gpu) : null, wallMs: median(wall), reps, runs };
  }

  // ---- view -------------------------------------------------------------------------------------
  const view = { size: 128, quality: 'fast' as Quality, layer: 0, mip: 0, exposure: 1, gain: 4 };
  const PANEL = canvas.width / 3, VH = canvas.height;
  const viewOut = device.createBuffer({ size: canvas.width * VH * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const viewRb = device.createBuffer({ size: canvas.width * VH * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const viewU = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let cur: { src: GPUTexture; dec: GPUTexture; metrics: Metrics } | null = null;

  async function setConfig(size: number, quality: Quality) {
    cur?.src.destroy(); cur?.dec.destroy();
    const src = makeSource(size, 1);
    const dec = encoder.encode(src, { quality });
    cur = { src, dec, metrics: await measure(src, dec) };
    view.size = size; view.quality = quality; view.mip = Math.min(view.mip, src.mipLevelCount - 1);
    return cur.metrics;
  }

  async function render() {
    if (!cur) return;
    const u = new ArrayBuffer(32), dv = new DataView(u);
    dv.setUint32(0, view.layer, true); dv.setUint32(4, PANEL, true); dv.setUint32(8, VH, true);
    dv.setFloat32(12, view.exposure, true); dv.setFloat32(16, view.gain, true);
    device.queue.writeBuffer(viewU, 0, u);
    const cmd = device.createCommandEncoder();
    const pass = cmd.beginComputePass();
    pass.setPipeline(viewPipe);
    pass.setBindGroup(0, device.createBindGroup({
      layout: viewPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: mipView(cur.src, view.mip) }, { binding: 1, resource: mipView(cur.dec, view.mip) },
        { binding: 2, resource: { buffer: viewOut } }, { binding: 3, resource: { buffer: viewU } },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(canvas.width / 8), Math.ceil(VH / 8));
    pass.end();
    cmd.copyBufferToBuffer(viewOut, 0, viewRb, 0, viewRb.size);
    device.queue.submit([cmd.finish()]);
    await viewRb.mapAsync(GPUMapMode.READ);
    const px = new Uint8ClampedArray(viewRb.getMappedRange().slice(0));
    viewRb.unmap();
    ctx2d.putImageData(new ImageData(px, canvas.width, VH), 0, 0);
  }

  // ---- report -----------------------------------------------------------------------------------
  const f = (x: number | null, d = 4) => (x === null ? 'n/a' : x.toFixed(d));
  const results: { errors: Record<string, Metrics>; timings: Record<string, unknown>; device: Record<string, unknown> } = {
    errors: {}, timings: {}, device: { timestampQuery: hasTS, adapter: (adapter as unknown as { info?: GPUAdapterInfo }).info?.description ?? '' },
  };
  function renderTables() {
    const er = Object.entries(results.errors).map(([k, m]) =>
      `<tr><td>${k}</td><td>${f(m.log2Rmse)}</td><td>${f(m.log2Max, 3)}</td><td>${f(m.rmsle)}</td><td>${f(m.psnr, 2)}</td>`
      + `<td>${m.meanAbs.map((x) => f(x)).join(' / ')}</td><td>${m.maxAbs.map((x) => f(x, 2)).join(' / ')}</td>`
      + `<td>${m.perMipLog2Rmse.map((x) => f(x, 3)).join(' ')}</td></tr>`).join('');
    const tr = Object.entries(results.timings).map(([k, t]) => {
      const v = t as { gpuMs: number | null; wallMs: number; reps: number };
      return `<tr><td>${k}</td><td>${f(v.gpuMs, 3)}</td><td>${f(v.wallMs, 3)}</td><td>${v.reps}</td></tr>`;
    }).join('');
    tables.innerHTML = `
      <table><tr><th>config</th><th>log2 RMSE</th><th>log2 max</th><th>RMSLE log2(x+1)</th><th>PSNR tonemapped (dB)</th><th>mean |Δ| r/g/b</th><th>max |Δ| r/g/b</th><th>log2 RMSE per mip</th></tr>${er}</table>
      <table><tr><th>encode</th><th>GPU ms (median of 5)</th><th>wall ms</th><th>reps per run</th></tr>${tr}</table>`;
  }

  async function runErrors() {
    for (const size of [128, 256]) for (const q of ['fast', 'normal'] as Quality[]) {
      results.errors[`${size}px cube, ${q}`] = await setConfig(size, q);
      renderTables();
    }
  }
  async function runTimings() {
    for (const [size, probes] of [[128, 1], [256, 1], [128, 16], [256, 16]]) {
      const src = makeSource(size, probes);
      for (const q of ['fast', 'normal'] as Quality[]) {
        log(`timing ${probes} x ${size}px (${q})...`);
        results.timings[`${probes} x ${size}px cube, ${q}`] = await timeEncode(src, q, probes === 1 ? 20 : 2);
        renderTables();
      }
      src.destroy();
    }
  }

  // ---- controls ---------------------------------------------------------------------------------
  const controls = document.querySelector<HTMLElement>('#controls')!;
  const addSelect = (label: string, options: string[], value: string, on: (v: string) => void) => {
    const l = document.createElement('label'); l.textContent = label;
    const s = document.createElement('select');
    for (const o of options) s.add(new Option(o, o, false, o === value));
    s.onchange = () => on(s.value);
    l.append(s); controls.append(l); return s;
  };
  const addRange = (label: string, min: number, max: number, step: number, value: number, on: (v: number) => void) => {
    const l = document.createElement('label'); l.textContent = label;
    const r = Object.assign(document.createElement('input'), { type: 'range', min, max, step, value });
    r.oninput = () => on(Number(r.value));
    l.append(r); controls.append(l);
  };
  const reconfig = async () => { await setConfig(view.size, view.quality); mipSel.replaceChildren(...Array.from({ length: cur!.src.mipLevelCount }, (_, i) => new Option(`${i}`, `${i}`, false, i === view.mip))); await render(); };
  addSelect('size', ['128', '256'], '128', (v) => { view.size = Number(v); void reconfig(); });
  addSelect('quality', ['fast', 'normal'], 'fast', (v) => { view.quality = v as Quality; void reconfig(); });
  addSelect('face', ['0', '1', '2', '3', '4', '5'], '0', (v) => { view.layer = Number(v); void render(); });
  const mipSel = addSelect('mip', ['0'], '0', (v) => { view.mip = Number(v); void render(); });
  addRange('exposure (log2)', -10, 4, 0.5, 0, (v) => { view.exposure = 2 ** v; void render(); });
  addRange('error gain', 1, 32, 1, 4, (v) => { view.gain = v; void render(); });
  const timeBtn = Object.assign(document.createElement('button'), { textContent: 'measure encode time' });
  timeBtn.onclick = async () => { timeBtn.disabled = true; await runTimings(); log('done'); timeBtn.disabled = false; };
  controls.append(timeBtn);

  log('encoding...');
  await runErrors();
  view.size = 128; view.quality = 'fast';
  await reconfig();
  log(`done. timestamp-query: ${hasTS}. Press "measure encode time" for timings.`);

  (window as unknown as { __p: unknown }).__p = {
    supported: true, results, errors, view,
    stop() { /* no render loop: frames are drawn on demand */ },
    async runAll() { await runErrors(); await runTimings(); await reconfig(); log('done'); return results; },
    async set(o: Partial<typeof view>) { const re = (o.size && o.size !== view.size) || (o.quality && o.quality !== view.quality); Object.assign(view, o); if (re) await reconfig(); else await render(); return true; },
    async shot() { await render(); return canvas.toDataURL('image/png'); },
  };
}

main().catch((e) => { console.error(e); log(String(e?.stack ?? e)); });
