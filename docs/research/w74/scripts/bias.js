// W74: the still-frame bias of 'half' vs 'full', split by fill outcome, at three stages: the tracer's radiance, the
// hybrid signal (radiance + the composite's probe term: what raw output shows) and the denoised output.
// ssr/?manual&rt=1&aa=off (denoiser on). Fill px = those a run with fillMinWeightSum 1e9 marks 'capped' (every fill
// falls back); of them, 'fallback' = capped in the real 'half' run, 'filled' = the rest.
await P.load(typeof SCENE !== 'undefined' ? SCENE : 'contact');
P.setSettings({ frameIndex: 5, minTraversalOccupancy: 0 });
const dev = P.ssr.device, gpu = (t) => P.renderer.backend.get(t).texture;
const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15); };
async function read(tex, mode) { // mode 'lum' (rgba16/32 float) or 'r' (r32float)
  const f16 = tex.format === 'rgba16float', bpp = mode === 'r' ? 4 : f16 ? 8 : 16, w = tex.width, h = tex.height, bpr = Math.ceil(w * bpp / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = buf.getMappedRange(), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    if (mode === 'r') { out.set(new Float32Array(raw, y * bpr, w), y * w); continue; }
    const a = f16 ? new Uint16Array(raw, y * bpr, w * 4) : new Float32Array(raw, y * bpr, w * 4), g = f16 ? h2f : (x) => x;
    for (let x = 0; x < w; x++) out[y * w + x] = 0.2126 * g(a[4 * x]) + 0.7152 * g(a[4 * x + 1]) + 0.0722 * g(a[4 * x + 2]);
  }
  buf.unmap(); buf.destroy();
  return out;
}
async function run(set) {
  P.setTraceSettings(set);
  if (set.tracedMissRate === 'half') await P.ssr.traced.prepareHalfRate();
  P.ssr.resetHistory(); P.hybrid.resetHistory();
  await P.step(16);
  return {
    rad: await read(gpu(P.ssr.radiance), 'lum'), sig: await read(gpu(P.hybrid.signalTarget.texture), 'lum'),
    dn: await read(gpu(P.hybrid.denoised), 'lum'), src: await read(gpu(P.ssr.source), 'r'), conf: await read(gpu(P.ssr.confidence), 'r'),
  };
}
const full = await run({ tracedMissRate: 'full' });
const half = await run({ tracedMissRate: 'half', ...(typeof FILL !== 'undefined' ? FILL : {}) });
const none = await run({ tracedMissRate: 'half', ...(typeof FILL !== 'undefined' ? FILL : {}), fillMinWeightSum: 1e9 });
P.setTraceSettings({}); P.setSettings({ frameIndex: undefined, minTraversalOccupancy: undefined });
const sets = { filled: [], fallback: [] };
for (let i = 0; i < full.rad.length; i++) {
  if (Math.round(none.src[i]) !== 3) continue;
  (Math.round(half.src[i]) === 3 ? sets.fallback : sets.filled).push(i);
}
const out = {};
for (const [name, idx] of Object.entries(sets)) {
  const r = { px: idx.length };
  for (const k of ['rad', 'sig', 'dn']) {
    let d = 0, s = 0;
    for (const i of idx) { if (Number.isFinite(full[k][i]) && Number.isFinite(half[k][i])) { d += half[k][i] - full[k][i]; s += full[k][i]; } }
    r[k] = s > 0 ? +(d / s).toFixed(4) : null;
  }
  let ch = 0, cf = 0; for (const i of idx) { ch += half.conf[i]; cf += full.conf[i]; }
  r.conf = [+(ch / idx.length).toFixed(3), +(cf / idx.length).toFixed(3)];
  // mean signal by the px's own class (hit: confidence >= 0.5), half and full: where a remaining signal bias sits
  const cls = (run) => { const a = { hit: [0, 0], miss: [0, 0] }; for (const i of idx) { const c = run.conf[i] >= 0.5 ? a.hit : a.miss; c[0] += run.sig[i]; c[1]++; } return { hit: [+(a.hit[0] / a.hit[1]).toFixed(4), a.hit[1]], miss: [+(a.miss[0] / a.miss[1]).toFixed(4), a.miss[1]] }; };
  r.sigByClass = { half: cls(half), full: cls(full) };
  out[name] = r;
}
// the whole reflection, for scale
return { ...out, errors: P.gpuErrors.slice(0, 2) };
