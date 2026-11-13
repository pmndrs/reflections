// W73: the tracer's raw radiance (before the denoiser; rgb / (1 + rgb), gamma 2.2) and confidence as PNGs, per scene x
// config, on examples/ssr (?manual). Prelude: SHOTS = [[scene, pose|null, floorRoughness|null]], CONFIGS = [[name, settings]], CROP = [x, y, w, h] | null.
const dev = P.ssr.device;
const half = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
async function read(tex, bpp) {
  const bpr = Math.ceil((tex.width * bpp) / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const out = new Uint8Array(buf.getMappedRange()).slice();
  buf.unmap(); buf.destroy();
  return { bytes: out, bpr, w: tex.width, h: tex.height };
}
const crop = typeof CROP !== 'undefined' ? CROP : null;
function png(img, px) {
  const [x0, y0, w, h] = crop ?? [0, 0, img.w, img.h];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); const d = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const rgb = px(x + x0, y + y0); for (let k = 0; k < 3; k++) d.data[(y * w + x) * 4 + k] = rgb[k]; d.data[(y * w + x) * 4 + 3] = 255; }
  g.putImageData(d, 0, 0); return c.toDataURL('image/png');
}
const tm = (v) => Math.round(255 * Math.pow(Math.max(0, v) / (1 + Math.max(0, v)), 1 / 2.2));
for (const [scene, pose, floor] of SHOTS) {
  await P.load(scene);
  if (pose) P.setPose(pose);
  if (floor !== null && floor !== undefined) P.setFloorRoughness(floor);
  for (const [name, set] of CONFIGS) {
    P.setSettings({ minTraversalOccupancy: 0, temporalVarianceGuidedTracing: false, rayReuse: 'copy', samplesPerQuad: 1, ...set });
    await P.radianceHash(7);
    const r = await read(P.ssr.tracer.outputs.radiance, 8);
    const v = new DataView(r.bytes.buffer);
    save(`${scene}-${name}-radiance.png`, png(r, (x, y) => { const o = y * r.bpr + x * 8; return [0, 1, 2].map((k) => tm(half(v.getUint16(o + k * 2, true)))); }));
  }
}
return 'ok';
