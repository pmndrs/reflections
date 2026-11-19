// W76: X0's grazing sweep (bench.html?manual) for the cone's grazing shrink. Prelude: CONFIGS = [[name, {benchKey: value}]],
// optional METHODS. Each config starts from the W72 / W76 keys reset to the package defaults (null = unset).
const methods = typeof METHODS !== 'undefined' ? METHODS : ['ours-raw', 'ours-denoised'];
const BASE = { aa: null, 's.hitColorFilter': null, 's.hitColorConeScale': null, 's.mirrorBias': null, 's.mirrorBiasCompensate': null, 's.hitLobeFilterGrazing': null };
const out = [];
for (const [name, s] of CONFIGS) {
  const r = await P.metrics.grazing({ methods, settings: { ...BASE, ...s } });
  const rows = r.rows.map((row) => ({ e: row.elevation, ptGrad: row.ptGradient, m: Object.fromEntries(Object.entries(row.methods).map(([id, v]) => [id, [v.mad, v.bias, v.gradientRatio]])) }));
  out.push({ name, rows });
  log({ name, rows });
}
return { out, errors: P.gpuErrors().slice(0, 3) };
