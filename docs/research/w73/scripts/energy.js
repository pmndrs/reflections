// W73: W45's energy metric (D3550): 64-frame linear means of the raw signal the denoiser takes
// (HybridReflections.signalTarget) and of its output (hybrid.denoised), luminance, over W45's carConcept boxes at
// 1280x720, pose hero: door rows 345-388, skirt rows 396-438, x 560-720. Per config: raw, denoised, denoised / raw.
// Also the per-pixel temporal std of each (linear luminance, mean over the box).
// examples/showcase/?manual&scene=carConcept&pose=hero&w=1280&h=720[&rt=1]. Prelude: CONFIGS = [[name, ssrSettings]], FRAMES, WARM.
const dev = P.ssr.device;
const frames = typeof FRAMES !== 'undefined' ? FRAMES : 64, warm = typeof WARM !== 'undefined' ? WARM : 32;
const boxes = typeof BOXES !== 'undefined' ? BOXES : { door: [560, 345, 721, 389], skirt: [560, 396, 721, 439] };
const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, s = (h & 0x8000) ? -1 : 1; return e === 0 ? s * m * 2 ** -24 : e === 31 ? 0 : s * (1 + m / 1024) * 2 ** (e - 15); };
const gpu = (t) => P.renderer.backend.get(t).texture;
async function readLuma(tex) {
  const bpr = Math.ceil((tex.width * 8) / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const v = new DataView(buf.getMappedRange());
  const out = {};
  for (const [k, [x0, y0, x1, y1]] of Object.entries(boxes)) {
    const a = new Float32Array((x1 - x0) * (y1 - y0)); let i = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = y * bpr + x * 8; a[i++] = 0.2126 * half(v.getUint16(o, true)) + 0.7152 * half(v.getUint16(o + 2, true)) + 0.0722 * half(v.getUint16(o + 4, true)); }
    out[k] = a;
  }
  buf.unmap(); buf.destroy();
  return out;
}
const keep = { ...P.ssr.settings };
const res = [];
for (const [name, set] of CONFIGS) {
  P.ssr.settings = { ...keep, ...set };
  P.ssr.resetHistory(); P.hybrid.resetHistory();
  await P.step(warm);
  const acc = {};
  for (let f = 0; f < frames; f++) {
    await P.step(1);
    for (const [src, tex] of [['raw', gpu(P.hybrid.signalTarget.texture)], ['den', gpu(P.hybrid.denoised)]]) {
      const l = await readLuma(tex);
      for (const [k, a] of Object.entries(l)) {
        const s = (acc[src + ' ' + k] ??= { sum: new Float64Array(a.length), sq: new Float64Array(a.length) });
        for (let i = 0; i < a.length; i++) { s.sum[i] += a[i]; s.sq[i] += a[i] * a[i]; }
      }
    }
  }
  const row = { name };
  for (const [key, s] of Object.entries(acc)) {
    let m = 0, sd = 0; const n = s.sum.length;
    for (let i = 0; i < n; i++) { const mu = s.sum[i] / frames; m += mu; sd += Math.sqrt(Math.max(0, s.sq[i] / frames - mu * mu)); }
    row[key] = [+(m / n).toFixed(4), +(sd / n).toFixed(4)];
  }
  for (const k of Object.keys(boxes)) row[k + ' den/raw'] = +(row['den ' + k][0] / row['raw ' + k][0]).toFixed(3);
  log(row); res.push(row);
}
P.ssr.settings = keep;
return { res, errors: P.gpuErrors.slice(0, 3) };
