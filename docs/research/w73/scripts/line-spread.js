// W73 phase 2: X0's line-spread gate (bench `__p.metrics.lineSpread`, W70) for copy vs ratio, AA on / off, on
// lineSpread and lineSpreadThin. bench.html?manual. Prelude: RUNS = [[label, scene, settings]], METHODS, ROUGH, SAMPLES.
const runs = typeof RUNS !== 'undefined' ? RUNS : [];
const out = [];
for (const [label, scene, settings] of runs) {
  const r = await P.metrics.lineSpread({ scene, roughness: typeof ROUGH !== 'undefined' ? ROUGH : [0.05, 0.15, 0.3, 0.5],
    methods: typeof METHODS !== 'undefined' ? METHODS : ['ours-denoised', 'ours-raw'], settings, samples: typeof SAMPLES !== 'undefined' ? SAMPLES : 256 });
  const rows = r.rows.map((x) => ({ r: x.roughness, pt: x.pt, ptPeak: x.ptPeak, ...Object.fromEntries(Object.entries(x.methods).map(([id, m]) => [id, [m.width, m.ratio, m.peak]])) }));
  const row = { label, scene, settings, rows };
  log(row); out.push(row);
}
return out;
