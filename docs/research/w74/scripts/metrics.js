// W74 phase 2: X0's page metrics (examples/shared/metrics) on the bench's ours-rt per configuration, denoiser on and off.
// bench.html?manual&scene=<id>&pose=<pose>&size=960x540&left=ours-rt&right=pathtraced
// prelude: CONFIGS = [[name, {benchKey: value}], ...], optional POSE, METRICS (names), OPTS ({ metric: options }), MEASURE_FIRST (fills lip/band masks)
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p.metrics && window.__p.setSetting); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
const pose = typeof POSE !== 'undefined' ? POSE : 'w50';
const metrics = typeof METRICS !== 'undefined' ? METRICS : ['quadEnergy', 'orbitFlicker'];
const opts = typeof OPTS !== 'undefined' ? OPTS : {};
S.setPose(pose);
if (typeof MEASURE_FIRST !== 'undefined') await S.measure({ samples: 16, warmup: 8, frames: 2, methods: ['ours-rt'] });
const pick = (r) => {
  // keep the per-region numbers only
  const o = {};
  for (const [k, v] of Object.entries(r)) if (v && typeof v === 'object') o[k] = v.regions ?? v;
  return o;
};
const out = [];
for (const [name, set] of CONFIGS) {
  for (const dn of [true, false]) {
    for (const [k, v] of Object.entries({ ...set, denoise: dn ? null : false })) S.setSetting(k, v);
    if (S.pending().methods.length) await S.rebuild();
    S.setPose(pose);
    await S.step(2); await new Promise((r) => setTimeout(r, 1500)); // W74 review fix 4: let the fill compile (async)
    const row = { name, denoise: dn };
    for (const m of metrics) {
      const r = await S.metrics[m]({ method: 'ours-rt', ...(opts[m] ?? {}) });
      row[m] = m === 'quadEnergy' ? { display: r.display, signal: r.signal } : r.regions;
    }
    out.push(row);
    log(row);
  }
  for (const k of [...Object.keys(set), 'denoise']) S.setSetting(k, null);
  if (S.pending().methods.length) await S.rebuild();
}
return { errors: S.gpuErrors().slice(0, 3) };
