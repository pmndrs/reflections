// W78 (W72's linespread.js, + the brdf key): X0's line-spread gate per configuration (bench.html?manual). Prelude: CONFIGS = [[name, {benchKey: value}], ...],
// optional METHODS, ROUGH, SAMPLES, SCENE. Each config starts from W72's keys and aa reset to their defaults.
const methods = typeof METHODS !== 'undefined' ? METHODS : ['ours-raw', 'ours-denoised', 'ours-rt'];
const rough = typeof ROUGH !== 'undefined' ? ROUGH : [0.05, 0.15, 0.3, 0.5];
const BASE = { aa: null, 's.hitColorFilter': null, 's.hitColorConeScale': null, 's.mirrorBias': null, 's.mirrorBiasCompensate': null, lobeFilter: null, brdf: null, keepBlack: null, brdfMin: null };
const out = [];
for (const [name, s] of CONFIGS) {
  const t0 = performance.now();
  const r = await P.metrics.lineSpread({ roughness: rough, methods, settings: { ...BASE, ...s }, samples: typeof SAMPLES !== 'undefined' ? SAMPLES : 512, scene: typeof SCENE !== 'undefined' ? SCENE : 'lineSpread' });
  const rows = r.rows.map((row) => ({ r: row.roughness, pt: row.pt, ptPeak: row.ptPeak, m: Object.fromEntries(Object.entries(row.methods).map(([id, v]) => [id, { w: v.width, ratio: v.ratio, pass: v.pass, lost: v.lost, peak: v.peakRatio }])) }));
  out.push({ name, settings: s, rows, s: Math.round((performance.now() - t0) / 1000) });
  log(out[out.length - 1]);
}
return { out, errors: P.gpuErrors().slice(0, 3) };
