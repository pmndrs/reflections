// W78 (W74's, plus the denoised output): default-is-identical. On the ssr page (ssr/?manual&rt=1) or the showcase (index.html?manual&scene=carConcept&rt=1&aa=off):
// per scene, a fixed number of frames from a fresh load, then FNV-1a hashes of the raw outputs (radiance, hit distance,
// confidence, rt source) and the final image saved as PNG (diffed offline). Run on the baseline sources and on this
// branch with the default settings; equal hashes = bit for bit.
// prelude: TAG, optional SCENES, FRAMES, SET (trace settings), SHOWCASE (true on index.html)
// the showcase sets a stub __p first: wait for the real one
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
const scenes = typeof SCENES !== 'undefined' ? SCENES : ['offscreen', 'contact', 'mirrorWall', 'facingMirrors'];
const frames = typeof FRAMES !== 'undefined' ? FRAMES : 12;
const r = S.renderer, dev = S.ssr.device;
const gpu = (t) => r.backend.get(t).texture;
async function hash(t) {
  const tex = gpu(t), bpp = tex.format === 'rgba16float' ? 8 : 4, w = tex.width, h = tex.height, bpr = Math.ceil(w * bpp / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const u8 = new Uint8Array(buf.getMappedRange());
  let x = 0x811c9dc5;
  for (let y = 0; y < h; y++) for (let i = y * bpr, e = i + w * bpp; i < e; i++) { x ^= u8[i]; x = Math.imul(x, 0x01000193); }
  buf.unmap(); buf.destroy();
  return (x >>> 0).toString(16);
}
const out = [];
for (const id of scenes) {
  await S.load(id);
  if (typeof SHOWCASE !== 'undefined') { await S.setSources({ rt: true }); S.setPose(S.poses()[0]); }
  if (typeof SET !== 'undefined') Object.assign(S.ssr.traceSettings, SET);
  if (typeof FRAME_INDEX !== 'undefined') S.ssr.settings.frameIndex = FRAME_INDEX;
  if (typeof SSR !== 'undefined') Object.assign(S.ssr.settings, SSR);
  S.ssr.resetHistory(); S.hybrid.resetHistory(); S.aa?.reset?.();
  await S.step(frames);
  const row = { id, denoised: S.hybrid?.denoise ? await hash(S.hybrid.denoised) : null, radiance: await hash(S.ssr.radiance), hitDistance: await hash(S.ssr.hitDistance), confidence: await hash(S.ssr.confidence), source: await hash(S.ssr.source) };
  save(`${TAG}-${id}.png`, await S.shot());
  out.push(row);
}
log(out);
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors).slice(0, 3) };
