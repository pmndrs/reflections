// W73: the hybrid's raw signal (what the denoiser takes), its output, the tracer's confidence, and the final canvas, per
// config, on examples/showcase (?manual). rgb / (1 + rgb), gamma 2.2. Prelude: CONFIGS = [[name, ssrSettings]], MEAN (frames
// averaged, default 1), BOXES (drawn in red on the signal image).
const dev = P.ssr.device;
const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, s = (h & 0x8000) ? -1 : 1; return e === 0 ? s * m * 2 ** -24 : e === 31 ? 0 : s * (1 + m / 1024) * 2 ** (e - 15); };
const gpu = (t) => P.renderer.backend.get(t).texture;
async function readRgb(tex) {
  const f32 = tex.format === 'r32float';
  const bpp = f32 ? 4 : 8;
  const bpr = Math.ceil((tex.width * bpp) / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const v = new DataView(buf.getMappedRange());
  const out = new Float32Array(tex.width * tex.height * 3);
  for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) {
    const o = y * bpr + x * bpp, i = (y * tex.width + x) * 3;
    if (f32) { const c = v.getFloat32(o, true); out[i] = out[i + 1] = out[i + 2] = c; } else for (let k = 0; k < 3; k++) out[i + k] = half(v.getUint16(o + k * 2, true));
  }
  buf.unmap(); buf.destroy();
  return { w: tex.width, h: tex.height, d: out };
}
const tm = (v) => Math.round(255 * Math.pow(Math.max(0, v) / (1 + Math.max(0, v)), 1 / 2.2));
function png(img, boxes, linear = false) {
  const c = document.createElement('canvas'); c.width = img.w; c.height = img.h;
  const g = c.getContext('2d'); const id = g.createImageData(img.w, img.h);
  for (let i = 0; i < img.w * img.h; i++) { for (let k = 0; k < 3; k++) id.data[i * 4 + k] = linear ? Math.round(255 * Math.min(1, img.d[i * 3 + k])) : tm(img.d[i * 3 + k]); id.data[i * 4 + 3] = 255; }
  g.putImageData(id, 0, 0);
  g.strokeStyle = '#f00';
  for (const [x0, y0, x1, y1] of boxes ?? []) g.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
  return c.toDataURL('image/png');
}
const keep = { ...P.ssr.settings };
const n = typeof MEAN !== 'undefined' ? MEAN : 1;
for (const [name, set] of CONFIGS) {
  P.ssr.settings = { ...keep, ...set };
  P.ssr.resetHistory(); P.hybrid.resetHistory();
  await P.step(24);
  let sig = null, den = null;
  for (let f = 0; f < n; f++) {
    await P.step(1);
    const a = await readRgb(gpu(P.hybrid.signalTarget.texture)), b = await readRgb(gpu(P.hybrid.denoised));
    if (!sig) { sig = a; den = b; } else for (let i = 0; i < a.d.length; i++) { sig.d[i] += a.d[i]; den.d[i] += b.d[i]; }
  }
  for (let i = 0; i < sig.d.length; i++) { sig.d[i] /= n; den.d[i] /= n; }
  save(`${name}-signal.png`, png(sig, typeof BOXES !== 'undefined' ? BOXES : []));
  save(`${name}-denoised.png`, png(den, []));
  save(`${name}-confidence.png`, png(await readRgb(gpu(P.ssr.confidence)), [], true));
  save(`${name}-final.png`, await P.shot());
}
P.ssr.settings = keep;
return 'ok';
