// W53 regressions (compare page, ?right=pathtraced so the reference stays loaded): compare's own
// Measure (glossy mask, vs PT 64 spp) for `ours-rt` per set of params, at the scene's first pose.
// prelude: SETS
const out = {};
const touched = new Set();
for (const [name, params] of SETS) {
  for (const k of touched) P.setParam(k, null);
  for (const [k, v] of Object.entries(params)) { P.setParam(k, v); touched.add(k); }
  P.drop('ours-rt');
  const m = await P.measure({ methods: ['ours-rt'], samples: 64 });
  const r = m.rows[0];
  out[name] = { mad: +r.mad.toFixed(2), psnr: +r.psnr.toFixed(2), bias: +r.bias.toFixed(2), std: +r.stdMean.toFixed(2), p99: +r.stdP99.toFixed(1), orbit: +(r.orbit ?? NaN).toFixed(2) };
  log({ [name]: out[name] });
}
out.scene = P.info().scene; out.errors = P.gpuErrors().slice(0, 3);
return out;
