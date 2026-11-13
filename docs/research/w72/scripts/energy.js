// W72 energy (W45's metric, D3550): the showcase's carConcept at its hero pose, 1280x720, 64-frame linear means of the
// raw signal (the denoiser's input, hybrid.signalTarget) and the denoised specular (hybrid.denoised) over W45's rows:
// x 560-720, door y 345-388, skirt y 396-438. loss = 1 - denoised / raw. Prelude: CONFIGS (configs.js), optional RT (bool).
const dev = P.ssr.device;
const gpu = (t) => P.renderer.backend.get(t).texture;
const h2f = (h) => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * f * 5.960464477539063e-8 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); };
async function readRows(tex, y0, y1, x0, x1) {
  const bpr = Math.ceil(tex.width * 8 / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder(); enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]); dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = buf.getMappedRange();
  const out = {};
  for (const [name, [a, b]] of Object.entries({ door: [345, 388], skirt: [396, 438] })) {
    let s = 0, n = 0;
    for (let y = a; y < b; y++) { const r = new Uint16Array(raw, y * bpr, tex.width * 4); for (let x = x0; x < x1; x++) { s += 0.2126 * h2f(r[x * 4]) + 0.7152 * h2f(r[x * 4 + 1]) + 0.0722 * h2f(r[x * 4 + 2]); n++; } }
    out[name] = s / n;
  }
  buf.unmap(); buf.destroy();
  return out;
}
P.stop();
if (typeof RT !== 'undefined' && RT) await P.setSources({ rt: true });
const KEYS = ['hitColorFilter', 'hitColorConeScale', 'mirrorBias', 'mirrorBiasCompensate'];
const res = {};
for (const [name, s] of CONFIGS) {
  for (const k of KEYS) delete P.ssr.settings[k];
  Object.assign(P.ssr.settings, s);
  await P.step(1);
  P.hybrid.resetHistory?.(); P.ssr.resetHistory?.();
  await P.step(32);
  const acc = { raw: { door: 0, skirt: 0 }, den: { door: 0, skirt: 0 } };
  const K = 64;
  for (let f = 0; f < K; f++) {
    await P.step(1);
    const a = await readRows(gpu(P.hybrid.signalTarget.texture), 0, 0, 560, 720);
    const b = await readRows(gpu(P.hybrid.denoised), 0, 0, 560, 720);
    for (const r of ['door', 'skirt']) { acc.raw[r] += a[r] / K; acc.den[r] += b[r] / K; }
  }
  res[name] = Object.fromEntries(['door', 'skirt'].map((r) => [r, { raw: +acc.raw[r].toFixed(4), denoised: +acc.den[r].toFixed(4), loss: +(1 - acc.den[r] / acc.raw[r]).toFixed(3) }]));
  log({ name, ...res[name] });
}
for (const k of KEYS) delete P.ssr.settings[k];
return { res, size: [P.ssr.tracer.width, P.ssr.tracer.height], errors: P.gpuErrors?.length ?? null };
