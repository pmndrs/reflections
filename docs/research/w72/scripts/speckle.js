// W72 raw speckle on the tracer's radiance (before denoise / composite), per configuration.
// Prelude: PAGE = 'ssr' | 'arcade' | 'showcase'; ALPHA = [lo, hi] (extracted alpha range = the mask); optional SCENE (ssr),
// CONFIGS = [[name, settings], ...], N (frames, default 32).
// Per mask px over N frames (frame index advancing): temporal mean m_p and std s_p of luminance. Reported:
//   mean   = mean of m_p (energy; the cone should keep it),
//   relStd = mean(s_p) / mean(m_p) (noise),
//   speckle = share of samples with L > m_p + 3 sigma, sigma = the median s_p over the mask (bright outliers: heavy tails),
//   p999   = the 99.9th percentile of (L - m_p) / mean(m_p) (how bright the worst outliers are).
const dev = PAGE === 'arcade' ? P.view.ssr.core.device : P.ssr.device;
const tracer = () => (PAGE === 'arcade' ? P.view.ssr.core : P.ssr.tracer);
const settings = () => (PAGE === 'arcade' ? P.view.ssr.settings : P.ssr.settings);
const N = typeof FRAMES !== 'undefined' ? FRAMES : 32;
const h2f = (h) => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * f * 5.960464477539063e-8 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); };
async function read(tex, bpp) {
  const bpr = Math.ceil(tex.width * bpp / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder(); enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]); dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange()); const out = new Uint8Array(tex.width * tex.height * bpp);
  for (let y = 0; y < tex.height; y++) out.set(src.subarray(y * bpr, y * bpr + tex.width * bpp), y * tex.width * bpp);
  buf.unmap(); buf.destroy(); return out;
}
if (PAGE === 'ssr') await P.load(typeof SCENE === 'undefined' ? 'mirrorWall' : SCENE);
if (PAGE === 'showcase' && typeof POSE !== 'undefined') P.setCamera(...POSE);
const KEYS = ['hitColorFilter', 'hitColorConeScale', 'mirrorBias', 'mirrorBiasCompensate', 'hitLobeFilter', 'frameIndex'];
const res = {};
for (const [name, s] of CONFIGS) {
  for (const k of KEYS) delete settings()[k];
  Object.assign(settings(), s);
  await P.step(1); await P.step(6);
  const t = tracer();
  const rough = new Float32Array((await read(t.outputs.extractedRoughness, 4)).buffer);
  const mask = []; for (let i = 0; i < rough.length; i++) if (rough[i] >= ALPHA[0] && rough[i] <= ALPHA[1]) mask.push(i);
  const M = mask.length, L = new Float32Array(M * N);
  for (let f = 0; f < N; f++) {
    await P.step(1);
    const r = new Uint16Array((await read(tracer().outputs.radiance, 8)).buffer);
    for (let j = 0; j < M; j++) { const i = mask[j] * 4; L[f * M + j] = 0.2126 * h2f(r[i]) + 0.7152 * h2f(r[i + 1]) + 0.0722 * h2f(r[i + 2]); }
  }
  const m = new Float32Array(M), sd = new Float32Array(M);
  for (let j = 0; j < M; j++) { let a = 0, b = 0; for (let f = 0; f < N; f++) { const v = L[f * M + j]; a += v; b += v * v; } m[j] = a / N; sd[j] = Math.sqrt(Math.max(0, b / N - m[j] * m[j])); }
  const mean = m.reduce((a, b) => a + b, 0) / M, msd = sd.reduce((a, b) => a + b, 0) / M;
  const sigma = [...sd].sort((a, b) => a - b)[M >> 1];
  let spk = 0; const dev2 = new Float32Array(M * N);
  for (let f = 0; f < N; f++) for (let j = 0; j < M; j++) { const d = L[f * M + j] - m[j]; dev2[f * M + j] = d; if (d > 3 * sigma) spk++; }
  dev2.sort();
  res[name] = { px: M, mean: +mean.toFixed(4), relStd: +(msd / mean).toFixed(3), speckle: +(spk / (M * N)).toFixed(4), p999: +(dev2[Math.floor(dev2.length * 0.999)] / mean).toFixed(2), sigma: +sigma.toFixed(4) };
  log({ name, ...res[name] });
}
for (const k of KEYS) delete settings()[k];
return { res, errors: (typeof P.gpuErrors === 'function' ? P.gpuErrors() : P.gpuErrors)?.length ?? null };
