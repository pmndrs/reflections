// W73: where does ratio's mean shift on carConcept's door come from (SSR only)? 32-frame means over a box of the tracer's
// confidence and radiance (= confidence x hit, the adapter's black fallback), and of the hybrid's raw signal, copy vs
// ratio vs ratio with radius 1. examples/showcase/?manual&scene=carConcept&pose=hero&w=1280&h=720. Prelude: BOX (optional).
const dev = P.ssr.device;
const box = typeof BOX !== 'undefined' ? BOX : [560, 345, 721, 389];
const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, s = (h & 0x8000) ? -1 : 1; return e === 0 ? s * m * 2 ** -24 : e === 31 ? 0 : s * (1 + m / 1024) * 2 ** (e - 15); };
const gpu = (t) => P.renderer.backend.get(t).texture;
async function mean(tex) {
  const f32 = tex.format === 'r32float', bpp = f32 ? 4 : 8;
  const bpr = Math.ceil((tex.width * bpp) / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const v = new DataView(buf.getMappedRange());
  let s = 0, n = 0, mx = 0;
  const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = y * bpr + x * bpp;
    const l = f32 ? v.getFloat32(o, true) : 0.2126 * half(v.getUint16(o, true)) + 0.7152 * half(v.getUint16(o + 2, true)) + 0.0722 * half(v.getUint16(o + 4, true));
    s += l; n++; mx = Math.max(mx, l);
  }
  buf.unmap(); buf.destroy();
  return [s / n, mx];
}
const keep = { ...P.ssr.settings };
const res = [];
for (const [name, set] of typeof CONFIGS !== 'undefined' ? CONFIGS : [['copy', {}], ['ratio', { rayReuse: 'ratio' }], ['ratio r1', { rayReuse: 'ratio', rayReuseRadius: 1 }], ['ratio r0', { rayReuse: 'ratio', rayReuseRadius: 0 }]]) {
  P.ssr.settings = { ...keep, ...set };
  P.ssr.resetHistory(); P.hybrid.resetHistory();
  await P.step(8);
  const acc = { conf: 0, rad: 0, sig: 0, radMax: 0 };
  const F = 32;
  for (let f = 0; f < F; f++) {
    await P.step(1);
    const c = await mean(gpu(P.ssr.confidence)), r = await mean(gpu(P.ssr.radiance)), s = await mean(gpu(P.hybrid.signalTarget.texture));
    acc.conf += c[0] / F; acc.rad += r[0] / F; acc.sig += s[0] / F; acc.radMax = Math.max(acc.radMax, r[1]);
  }
  const row = { name, ...Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +v.toFixed(4)])) };
  log(row); res.push(row);
}
P.ssr.settings = keep;
return res;
