// W73: default-identical check. FNV-1a hashes of the tracer's radiance / hit distance / confidence (and the
// canvas) at a fixed frame index with deterministic settings (occupancy exit off, D301), on examples/ssr.
// Prelude: SCENES = [...], SETTINGS = {} (extra ssr settings, e.g. { rayReuse: 'copy' }).
const scenes = typeof SCENES !== 'undefined' ? SCENES : ['mirrorWall', 'roughnessRamp', 'rooms', 'facingMirrors', 'contact'];
const extra = typeof SETTINGS !== 'undefined' ? SETTINGS : {};
const dev = P.ssr.device;
async function hashTex(tex, bpp) {
  const bpr = Math.ceil((tex.width * bpp) / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const b = new Uint8Array(buf.getMappedRange());
  let h = 0x811c9dc5;
  for (let y = 0; y < tex.height; y++) for (let x = y * bpr, e = x + tex.width * bpp; x < e; x++) { h ^= b[x]; h = Math.imul(h, 0x01000193) >>> 0; }
  buf.unmap(); buf.destroy();
  return h.toString(16).padStart(8, '0');
}
const out = {};
for (const s of scenes) {
  await P.load(s);
  P.setSettings({ minTraversalOccupancy: 0, temporalVarianceGuidedTracing: false, ...extra });
  await P.step?.(4);
  const r = await P.radianceHash(7);
  const o = P.ssr.tracer.outputs;
  out[s] = { radiance: r, hit: await hashTex(o.hitDistance, 4), conf: await hashTex(o.confidence, 4) };
}
return out;
