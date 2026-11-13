// W74 debug: raw source / confidence / radiance / hit distance over a crop of the showcase (W58's w50 camera, denoiser off).
// prelude: SET (traceSettings), CROP = [x0, y0, x1, y1]
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
S.stop();
await S.setSources({ rt: true, denoise: false });
const cam = S.kit.camera; cam.fov = 40; cam.updateProjectionMatrix();
S.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
Object.assign(S.ssr.traceSettings, SET);
S.hybrid.resetHistory(); S.ssr.resetHistory();
await S.step(12);
const r = S.renderer, dev = S.ssr.device, gpu = (t) => r.backend.get(t).texture;
const [x0, y0, x1, y1] = CROP, cw = x1 - x0, ch = y1 - y0;
const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15); };
async function read(tex, rgba) {
  const bpp = rgba ? 8 : 4, bpr = Math.ceil(cw * bpp / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * ch, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, origin: [x0, y0] }, { buffer: buf, bytesPerRow: bpr }, [cw, ch]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = buf.getMappedRange(), out = [];
  for (let y = 0; y < ch; y++) {
    if (rgba) { const u = new Uint16Array(raw, y * bpr, cw * 4); out.push(Array.from({ length: cw }, (_, i) => [h2f(u[4 * i]), h2f(u[4 * i + 1]), h2f(u[4 * i + 2]), h2f(u[4 * i + 3])])); }
    else out.push(Array.from(new Float32Array(raw, y * bpr, cw)));
  }
  buf.unmap(); buf.destroy();
  return out;
}
const src = await read(gpu(S.ssr.source)), conf = await read(gpu(S.ssr.confidence)), hd = await read(gpu(S.ssr.hitDistance)), rad = await read(gpu(S.ssr.radiance), true);
const rough = await read(S.ssr.tracer.outputs.extractedRoughness);
return { src: src.map((row) => row.join('')), conf: conf.map((row) => row.map((v) => v.toFixed(1)).join(' ')), hd: hd.slice(0, 4).map((row) => row.map((v) => v.toFixed(2)).join(' ')), rad: rad.slice(0, 4).map((row) => row.map((v) => v.map((x) => x.toFixed(2)).join(',')).join(' | ')), alpha: rough[0].slice(0, 8), stats: await S.ssr.readTraceStats(), spq: S.ssr.settings.samplesPerQuad };
