// W72 phase 2: X0's page metrics (energy, speckle on the signal) per configuration on the bench (bench.html?manual&scene=...&pose=...).
// Prelude: CONFIGS (bench keys), optional EXTRA (bench keys for every config, e.g. { floorRoughness: 0.3 }), METHOD.
const method = typeof METHOD !== 'undefined' ? METHOD : 'ours-denoised';
const BASE = { 's.hitColorFilter': null, 's.hitColorConeScale': null, 's.mirrorBias': null, 's.mirrorBiasCompensate': null };
const extra = typeof EXTRA !== 'undefined' ? EXTRA : {};
const pick = (o, f) => Object.fromEntries(Object.entries(o.regions).map(([k, v]) => [k, f(v)]));
const out = [];
for (const [name, s] of CONFIGS) {
  for (const [k, v] of Object.entries({ ...BASE, ...extra, ...s })) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  const m = P.metrics.of(method);
  const e = await m.energy({});
  const sp = await m.speckle({ source: 'signal' });
  const row = { name, energy: e ? pick(e, (v) => [v.raw, v.denoised, v.loss]) : null, speckle: pick(sp, (v) => v.pct) };
  out.push(row); log(row);
}
return { out, errors: P.gpuErrors().slice(0, 3) };
