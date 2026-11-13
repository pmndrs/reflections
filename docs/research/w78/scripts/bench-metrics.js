// W78 (W73's bench-metrics.js): X0's page metrics on the bench (carConcept @ w50, W50's regions; one Measure first for the lip / band /
// door masks), copy vs ratio, per method. bench.html?manual&scene=carConcept&pose=w50&size=960x540.
// Prelude: CONFIGS = [[name, benchSettings]], METHODS, OPTS (all() options).
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['copy@1', { 's.rayReuse': null }], ['ratio@1', { 's.rayReuse': 'ratio' }]];
const methods = typeof METHODS !== 'undefined' ? METHODS : ['ours-denoised', 'ours-rt'];
const opts = typeof OPTS !== 'undefined' ? OPTS : { restDrift: false, edgePan: false };
const regs = ['glossy', 'lip', 'band', 'door', 'car', 'wheel'];
P.setPose('w50');
await P.measure({ samples: 32, warmup: 8, frames: 2, methods: ['ours-denoised'] });
const out = [];
for (const [name, set] of configs) {
  for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  P.setPose('w50');
  for (const method of methods) {
    const m = await P.metrics.all({ method, ...opts });
    const pick = (x, f) => x && Object.fromEntries(regs.filter((r) => x.regions?.[r] || x[r]).map((r) => [r, f(x.regions?.[r] ?? x[r])]));
    const row = { name, method,
      orbit: pick(m.orbitFlicker, (v) => [v.std, v.d2]),
      quad: { display: pick(m.quadEnergy?.display, (v) => v.ratio), signal: pick(m.quadEnergy?.signal, (v) => v.ratio) },
      speckle: pick(m.speckle, (v) => v.pct),
      energy: pick(m.energy, (v) => [v.raw, v.denoised, v.loss]) };
    log(row); out.push(row);
  }
}
for (const [k] of Object.entries(configs[0][1])) P.setSetting(k, null);
return out;
