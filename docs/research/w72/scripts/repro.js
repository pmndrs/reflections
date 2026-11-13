// W72: is a frame reproducible within one page? Reads textures twice at a fixed frameIndex and counts differing texels.
const dev = P.ssr.device;
async function read(tex, bpp) {
  const bpr = Math.ceil(tex.width * bpp / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder(); enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]); dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange()); const out = new Uint8Array(tex.width * tex.height * bpp);
  for (let y = 0; y < tex.height; y++) out.set(src.subarray(y * bpr, y * bpr + tex.width * bpp), y * tex.width * bpp);
  buf.unmap(); buf.destroy(); return out;
}
const gpuTex = (rt) => P.renderer.backend.get(rt.texture ?? rt).texture;
const diff = (a, b, bpp) => { let n = 0, first = -1; for (let i = 0; i < a.length; i += bpp) { for (let k = 0; k < bpp; k++) if (a[i + k] !== b[i + k]) { n++; if (first < 0) first = i / bpp; break; } } return [n, first]; };
const out = {};
for (const id of ['mirrorWall']) {
  await P.load(id);
  P.setSettings({ frameIndex: 7, minTraversalOccupancy: 0 });
  await P.step(6);
  const rows = [];
  let prev = null;
  for (let k = 0; k < 3; k++) {
    await P.step(1);
    const t = P.ssr.tracer.outputs;
    const cur = { rad: await read(t.radiance, 8), conf: await read(t.confidence, 4), noise: await read(t.blueNoise, 4), rough: await read(t.extractedRoughness, 4) };
    if (prev) rows.push(Object.fromEntries(Object.keys(cur).map((k2) => [k2, diff(prev[k2], cur[k2], k2 === 'rad' ? 8 : 4)])));
    prev = cur;
  }
  out[id] = { rows, size: [P.ssr.tracer.width, P.ssr.tracer.height] };
}
log(out);
