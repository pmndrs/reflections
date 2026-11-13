// W74 review fix 6: on a still frame (frameIndex fixed, no occupancy exit) the half-rate radiance differs from full rate only
// on the filled px; by how much, as means (bias, 8x8 blocks, confidence). ssr/?manual&rt=1&denoise=0&aa=off.
// The same body is the ssr-rt check's (scripts/run-headless.mjs, halfRateChecks).
await P.load(typeof SCENE !== 'undefined' ? SCENE : 'contact');
P.setSettings({ frameIndex: 5, minTraversalOccupancy: 0 });
const dev = P.ssr.device, tex = P.renderer.backend.get(P.ssr.radiance).texture;
const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15); };
async function conf() {
  const t = P.renderer.backend.get(P.ssr.confidence).texture, w = t.width, h = t.height, bpr = Math.ceil(w * 4 / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: t }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(w * h), raw = buf.getMappedRange();
  for (let y = 0; y < h; y++) out.set(new Float32Array(raw, y * bpr, w), y * w);
  buf.unmap(); buf.destroy();
  return out;
}
async function lum() {
  const w = tex.width, h = tex.height, bpr = Math.ceil(w * 8 / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(w * h), raw = buf.getMappedRange();
  for (let y = 0; y < h; y++) { const u = new Uint16Array(raw, y * bpr, w * 4); for (let x = 0; x < w; x++) out[y * w + x] = 0.2126 * h2f(u[4 * x]) + 0.7152 * h2f(u[4 * x + 1]) + 0.0722 * h2f(u[4 * x + 2]); }
  buf.unmap(); buf.destroy();
  return out;
}
P.setTraceSettings({ tracedMissRate: 'full' }); await P.step(3);
const full = await lum(), fullConf = await conf();
P.setTraceSettings({ tracedMissRate: 'half' }); await P.ssr.traced.prepareHalfRate(); await P.step(3);
const half = await lum(), halfConf = await conf();
const st = await P.traceStats();
P.setTraceSettings({}); P.setSettings({ frameIndex: undefined, minTraversalOccupancy: undefined });
// One full-rate ray per glossy quad is a noisy sample, so a filled px vs that px's own sample measures
// the noise, not the fill (per px the error is ~1x the mean). Compare means instead: the signed bias
// over the changed px, and 8x8 blocks holding >= 8 changed px (block mean, half vs full, relative).
const W = tex.width, H = tex.height;
let n = 0, dsum = 0, rsum = 0, cHalf = 0, cFull = 0;
const B = 8, bw = Math.ceil(W / B), bh = Math.ceil(H / B);
const bf = new Float64Array(bw * bh), bhv = new Float64Array(bw * bh), bc = new Uint32Array(bw * bh);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x, b = ((y / B) | 0) * bw + ((x / B) | 0);
  if (!Number.isFinite(full[i]) || !Number.isFinite(half[i])) continue;
  bf[b] += full[i]; bhv[b] += half[i];
  if (full[i] !== half[i]) { n++; dsum += half[i] - full[i]; rsum += full[i]; bc[b]++; cHalf += halfConf[i]; cFull += fullConf[i]; }
}
let be = 0, br = 0, blocks = 0;
for (let b = 0; b < bf.length; b++) if (bc[b] >= 8) { be += Math.abs(bhv[b] - bf[b]); br += bf[b]; blocks++; }
return { changed: n, filled: st.filled, fallbacks: st.fillFallbacks, bias: rsum > 0 ? dsum / rsum : 0, confHalf: n ? cHalf / n : 0, confFull: n ? cFull / n : 0, blockErr: br > 0 ? be / br : 0, blocks };
