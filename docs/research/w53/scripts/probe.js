// W53 probe (main showcase page, ?aa=off&w=960&h=540&rt=1): per-pixel readback of the denoiser's
// inputs and output over N still frames, cropped to CROP = [x0, y0, x1, y1].
// prelude: POS, TGT, N, CROP, TAG (optional HS: W53 settings)
P.stop();
await P.setSources({ rt: true });
P.setCamera(POS, TGT);
// optional HS = { hitSource, missesMatchAnySource, hitDistanceWeight }: W53's settings
if (typeof HS !== 'undefined') P.setHitSource(HS);
P.hybrid.resetHistory(); P.ssr.resetHistory();
await P.step(90);
log('warm');
const r = P.renderer, dev = P.ssr.device;
const gpu = (t) => r.backend.get(t).texture;
const [x0, y0, x1, y1] = CROP, cw = x1 - x0, ch = y1 - y0;
const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
async function read(tex, kind) {
  const bpp = kind === 'rgba16' ? 8 : 4, bpr = Math.ceil(cw * bpp / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * ch, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, origin: [x0, y0] }, { buffer: buf, bytesPerRow: bpr }, [cw, ch]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = buf.getMappedRange();
  const out = new Float32Array(cw * ch * (kind === 'rgba16' ? 3 : 1));
  for (let y = 0; y < ch; y++) {
    if (kind === 'rgba16') { const u = new Uint16Array(raw, y * bpr, cw * 4); for (let x = 0; x < cw; x++) for (let c = 0; c < 3; c++) out[(y * cw + x) * 3 + c] = h2f(u[x * 4 + c]); }
    else { const f = new Float32Array(raw, y * bpr, cw); out.set(f, y * cw); }
  }
  buf.unmap(); buf.destroy();
  return out;
}
const n = cw * ch, C = 12;
const acc = new Float32Array(n * C); // 0-2 signal, 3-5 denoised, 6 S, 7 T1, 8 T4, 9 M, 10 dS, 11 dT1, (12 dT4 -> in second array)
const acc2 = new Float32Array(n * 6); // 0 dT4, 1-3 frame0 signal, 4 frame0 class, 5 frame0 hit distance
for (let k = 0; k < N; k++) {
  await P.step(1);
  if (k % 8 === 0) log('frame ' + k);
  const sig = await read(gpu(P.hybrid.signalTarget.texture), 'rgba16');
  const den = await read(gpu(P.hybrid.denoised), 'rgba16');
  const hd = await read(gpu(P.ssr.hitDistance), 'r32');
  const src = await read(gpu(P.ssr.source), 'r32');
  const conf = await read(gpu(P.ssr.confidence), 'r32');
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { acc[i * C + c] += sig[i * 3 + c] / N; acc[i * C + 3 + c] += den[i * 3 + c] / N; }
    const s = Math.round(src[i]);
    const cls = s === 1 ? 2 : s === 4 ? 3 : s === 2 ? 0 : conf[i] > 0 ? 1 : 0; // 0 miss, 1 SS, 2 traced, 3 traced on-screen
    acc[i * C + 6 + [3, 0, 1, 2][cls]] += 1; // S at 6, T1 at 7, T4 at 8, M at 9
    if (cls === 1) acc[i * C + 10] += hd[i]; else if (cls === 2) acc[i * C + 11] += hd[i]; else if (cls === 3) acc2[i * 6] += hd[i];
    if (k === 0) { for (let c = 0; c < 3; c++) acc2[i * 6 + 1 + c] = sig[i * 3 + c]; acc2[i * 6 + 4] = cls; acc2[i * 6 + 5] = hd[i]; }
  }
}
for (let i = 0; i < n; i++) {
  acc[i * C + 10] /= Math.max(1, acc[i * C + 6]); acc[i * C + 11] /= Math.max(1, acc[i * C + 7]); acc2[i * 6] /= Math.max(1, acc[i * C + 8]);
  for (let c = 6; c < 10; c++) acc[i * C + c] /= N;
}
// binary dumps in 384 KiB chunks (one huge console message stalls CDP)
const dump = (name, a) => {
  const u8 = new Uint8Array(a.buffer), step = 3 * 131072;
  for (let o = 0; o < u8.length; o += step) {
    let s = ''; const e = Math.min(u8.length, o + step);
    for (let i = o; i < e; i += 8192) s += String.fromCharCode(...u8.subarray(i, Math.min(e, i + 8192)));
    console.log('__append ' + name + ' ' + btoa(s));
  }
};
dump(`${TAG}-a.f32`, acc);
dump(`${TAG}-b.f32`, acc2);
return { cw, ch, N, errors: P.gpuErrors.slice(0, 3) };
