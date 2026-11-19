// W78 smoke: examples/ssr/?manual&denoise=1. Per BRDF mode (settings.denoiserBrdf): the sample texture's coverage
// (px with pdf > 0 / glossy px), the denoised mean over the glossy px, and the max |denoised - off| per mode.
// Prelude: lib.js, then optional SCENE, FLOOR, EXTRA (ssr settings), FRAMES.
const scene = typeof SCENE !== 'undefined' ? SCENE : 'mirrorWall';
await P.load(scene);
if (typeof FLOOR !== 'undefined') P.setFloorRoughness(FLOOR);
const extra = typeof EXTRA !== 'undefined' ? EXTRA : {};
const frames = typeof FRAMES !== 'undefined' ? FRAMES : 40;
const keep = { ...P.ssr.settings };
const out = {};
let ref = null;
for (const mode of ['off', 'replace', 'combine']) {
  P.ssr.settings = { ...keep, ...extra, denoiserBrdf: mode };
  P.ssr.resetHistory(); P.hybrid.resetHistory();
  await P.step(frames);
  const d = await readTex(gpuTex(P.hybrid.denoised));
  const mask = await glossyMask();
  let sum = 0, n = 0, maxDiff = 0, nan = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const l = lumaOf(d, i);
    if (!Number.isFinite(l)) { nan++; continue; }
    sum += l; n++;
    if (ref) maxDiff = Math.max(maxDiff, Math.abs(l - ref[i]));
  }
  if (!ref) { ref = new Float32Array(mask.length); for (let i = 0; i < ref.length; i++) ref[i] = lumaOf(d, i); }
  const s = P.ssr.tracer.outputs.sampleDirection;
  let cov = null;
  if (s) {
    const f = await readTex(s);
    let has = 0, g = 0, unit = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) g++;
      if (f[i * 4 + 3] > 0) { has++; if (Math.abs(Math.hypot(f[i * 4], f[i * 4 + 1], f[i * 4 + 2]) - 1) < 1e-3) unit++; }
    }
    cov = { withPdf: has, glossy: g, unitDirs: unit };
  }
  out[mode] = { nonFinite: nan };
  Object.assign(out[mode], { mean: +(sum / n).toFixed(5), maxDiffVsOff: +maxDiff.toFixed(5), sample: cov });
  log({ scene, mode, ...out[mode] });
}
P.ssr.settings = keep;
return { out, errors: P.gpuErrors.slice(0, 5) };
