// W78: shared prelude for the page scripts (pass its text as the 4th arg of drive.mjs, before any per-run prelude).
// readTex(tex) -> Float32Array (rgba16float / rgba32float / r32float / depth32float), glossyMask() from the G-buffer.
const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, s = (h & 0x8000) ? -1 : 1; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
const FMT = { rgba16float: [8, 4], rgba32float: [16, 4], r32float: [4, 1], depth32float: [4, 1] };
async function readTex(tex) {
  const dev = P.ssr.device;
  const [bytes, ch] = FMT[tex.format];
  const bpr = Math.ceil((tex.width * bytes) / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, aspect: tex.format.startsWith('depth') ? 'depth-only' : 'all' }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const dv = new DataView(buf.getMappedRange());
  const out = new Float32Array(tex.width * tex.height * ch);
  for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) for (let c = 0; c < ch; c++) {
    const o = y * bpr + x * bytes;
    out[(y * tex.width + x) * ch + c] = bytes === 8 ? half(dv.getUint16(o + c * 2, true)) : dv.getFloat32(o + c * 4, true);
  }
  buf.unmap(); buf.destroy();
  return out;
}
const gpuTex = (t) => P.renderer.backend.get(t).texture;
async function glossyMask(threshold = 0.447) {
  const t = P.ssr.gbuffer.gpuTextures();
  const [d, nr] = await Promise.all([readTex(t.depth), readTex(t.normal)]);
  const inv = P.ssr.gbuffer.conventions.depthInverted;
  const m = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) if (!(inv ? d[i] <= 0 : d[i] >= 1) && nr[i * 4 + 3] < threshold) m[i] = 1;
  return m;
}
const lumaOf = (f, i) => 0.2126 * f[i * 4] + 0.7152 * f[i * 4 + 1] + 0.0722 * f[i * 4 + 2];
