// W58: per-pixel readback of the raw reflection inputs on the main page
// (index.html?manual&scene=carConcept&w=960&h=540&aa=off&rt=1&denoise=0), at the bench's w50 pose.
// prelude: TAG, CROP = [x0, y0, x1, y1], optional SET = { settings: {...}, trace: {...}, depthAware }, FRAMES (default 1 dumped frame after 60)
P.stop();
await P.setSources({ rt: true, denoise: false });
const cam = P.kit.camera; cam.fov = 40; cam.updateProjectionMatrix();
P.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
if (typeof SET !== 'undefined') {
  if (SET.settings) Object.assign(P.ssr.settings, SET.settings);
  if (SET.trace) Object.assign(P.ssr.traceSettings, SET.trace);
  if (SET.depthAware !== undefined) P.hybrid.depthAware.value = SET.depthAware;
}
P.hybrid.resetHistory(); P.ssr.resetHistory();
await P.step(60);
const r = P.renderer, dev = P.ssr.device;
const gpu = (t) => r.backend.get(t).texture;
const [x0, y0, x1, y1] = CROP, cw = x1 - x0, ch = y1 - y0;
const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
async function read(tex, kind) {
  if (!tex) return new Float32Array(cw * ch * (kind === 'rgba16' ? 4 : 1)).fill(NaN);
  const bpp = kind === 'rgba16' ? 8 : 4, bpr = Math.ceil(cw * bpp / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * ch, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, origin: [x0, y0] }, { buffer: buf, bytesPerRow: bpr }, [cw, ch]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = buf.getMappedRange();
  const C = kind === 'rgba16' ? 4 : 1;
  const out = new Float32Array(cw * ch * C);
  for (let y = 0; y < ch; y++) {
    if (kind === 'rgba16') { const u = new Uint16Array(raw, y * bpr, cw * 4); for (let i = 0; i < cw * 4; i++) out[y * cw * 4 + i] = h2f(u[i]); }
    else out.set(new Float32Array(raw, y * bpr, cw), y * cw);
  }
  buf.unmap(); buf.destroy();
  return out;
}
const N = typeof FRAMES !== 'undefined' ? FRAMES : 1;
const dump = (name, a) => {
  const u8 = new Uint8Array(a.buffer), step = 3 * 131072;
  for (let o = 0; o < u8.length; o += step) {
    let s = ''; const e = Math.min(u8.length, o + step);
    for (let i = o; i < e; i += 8192) s += String.fromCharCode(...u8.subarray(i, Math.min(e, i + 8192)));
    console.log('__append ' + name + ' ' + btoa(s));
  }
};
const g = P.ssr.gbuffer.textures;
for (let k = 0; k < N; k++) {
  await P.step(1);
  const parts = [
    ['src', await read(gpu(P.ssr.source), 'r32')],
    ['conf', await read(gpu(P.ssr.confidence), 'r32')],
    ['hd', await read(gpu(P.ssr.hitDistance), 'r32')],
    ['rad', await read(gpu(P.ssr.radiance), 'rgba16')],
    ['sig', await read(gpu(P.hybrid.signalTarget.texture), 'rgba16')],
    ['nr', await read(gpu(g.normalRoughness), 'rgba16')],
  ];
  for (const [n, a] of parts) dump(`${TAG}-${k}-${n}.f32`, a);
  if (k === 0) save(`${TAG}-final.png`, await P.shot());
}
return { cw, ch, N, errors: P.gpuErrors.slice(0, 3) };
