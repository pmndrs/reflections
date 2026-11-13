// W75: does the half-res signal pass composite each texel at its sample pixel (2x, 2y)? On the ssr page
// (?manual&denoise=1): render the frame at full res, read the full-res signal; flip to 'half', render, read the
// half-res signal; compare signal_half[x, y] with signal_full[2x, 2y] where the tracer's confidence is 0 at
// both (the probe term only: deterministic, no ray noise), and with the four other neighbours for contrast.
// Also: the half-res tracer's roughness extract vs the full-res one at (2x, 2y).
// prelude: optional SCENE
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
if (typeof SCENE !== 'undefined') await S.load(SCENE);
const r = S.renderer, dev = S.ssr.device;
const gpu = (t) => r.backend.get(t).texture;
async function read(tex) {
  const bpp = tex.format === 'rgba16float' ? 8 : 4, w = tex.width, h = tex.height, bpr = Math.ceil(w * bpp / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(buf.getMappedRange()).slice();
  buf.unmap(); buf.destroy();
  const f16 = (u) => { const s = u >> 15, e = (u >> 10) & 31, m = u & 1023; const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15); return s ? -v : v; };
  const ch = bpp === 8 ? 4 : 1, out = new Float32Array(w * h * ch);
  const dv = new DataView(bytes.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    const o = y * bpr + (x * ch + c) * (bpp / ch);
    out[(y * w + x) * ch + c] = bpp === 8 ? f16(dv.getUint16(o, true)) : dv.getFloat32(o, true);
  }
  return { w, h, ch, d: out };
}
S.ssr.settings.frameIndex = 5;
S.ssr.settings.reflectionResolution = 'full';
await S.step(3);
const full = await read(gpu(S.hybrid.signalTarget.texture));
const fullConf = await read(S.ssr.tracer.outputs.confidence);
const fullRough = await read(S.ssr.tracer.outputs.extractedRoughness);
S.ssr.settings.reflectionResolution = 'half';
await S.step(3);
const half = await read(gpu(S.hybrid.signalTarget.texture));
const halfConf = await read(S.ssr.tracer.outputs.confidence);
const halfRough = await read(S.ssr.tracer.outputs.extractedRoughness);
const stats = {};
for (const [name, dx, dy] of [['(2x,2y)', 0, 0], ['(2x+1,2y)', 1, 0], ['(2x,2y+1)', 0, 1], ['(2x+1,2y+1)', 1, 1]]) {
  let n = 0, sum = 0, exact = 0, rn = 0, rsum = 0;
  for (let y = 0; y < half.h; y++) for (let x = 0; x < half.w; x++) {
    const fx = Math.min(2 * x + dx, full.w - 1), fy = Math.min(2 * y + dy, full.h - 1);
    const hi = y * half.w + x, fi = fy * full.w + fx;
    rsum += Math.abs(halfRough.d[hi] - fullRough.d[fi]); rn++;
    if (halfConf.d[hi] !== 0 || fullConf.d[fi] !== 0) continue;
    let e = 0;
    for (let c = 0; c < 3; c++) e += Math.abs(half.d[hi * 4 + c] - full.d[fi * 4 + c]);
    sum += e; n++; if (e === 0) exact++;
  }
  stats[name] = { px: n, meanAbs: +(sum / Math.max(1, n)).toFixed(5), exactShare: +(exact / Math.max(1, n)).toFixed(4), roughnessMeanAbs: +(rsum / rn).toFixed(5) };
}
log({ full: [full.w, full.h], half: [half.w, half.h], stats });
S.ssr.settings.reflectionResolution = 'full';
await S.step(1);
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors ?? []).slice(0, 3) };
