// W72 leakage at depth edges (bench.html?manual&scene=carConcept&pose=w50&floorRoughness=0.3): per config, Measure vs the PT, then
// the MAD of the method's mean over two masks inside the 'car' region (the floor reflection of the car): `edge` = the 15 % of px with the
// largest PT luma gradient (the reflected silhouettes, where a plain pyramid averages across depth), `flat` = the rest. Leakage shows as
// edge MAD rising with the cone while flat MAD doesn't. Prelude: CONFIGS (bench keys), optional METHODS.
const methods = typeof METHODS !== 'undefined' ? METHODS : ['ours-raw', 'ours-denoised'];
const BASE = { 's.hitColorFilter': null, 's.hitColorConeScale': null, 's.mirrorBias': null, 's.mirrorBiasCompensate': null };
const out = [];
for (const [name, s] of CONFIGS) {
  for (const [k, v] of Object.entries({ ...BASE, ...s })) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  P.setPose('w50');
  await P.measure({ samples: 64, warmup: 48, frames: 8, methods });
  const img = P.metrics.lastImages;
  const car = img.masks.get('car');
  const W = 960, H = 540, ref = img.ref;
  const L = (i) => 0.2126 * ref[i * 4] + 0.7152 * ref[i * 4 + 1] + 0.0722 * ref[i * 4 + 2];
  const g = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (car[i]) g.push([i, Math.hypot(L(i + 1) - L(i - 1), L(i + W) - L(i - W))]); }
  g.sort((a, b) => b[1] - a[1]);
  const cut = Math.floor(g.length * 0.15);
  const edge = new Set(g.slice(0, cut).map((v) => v[0]));
  const row = { name, px: [cut, g.length - cut], m: {} };
  for (const id of methods) {
    const m = img.means.get(id);
    let se = 0, sf = 0;
    for (const [i] of g) { const d = (Math.abs(m[i * 3] - ref[i * 4]) + Math.abs(m[i * 3 + 1] - ref[i * 4 + 1]) + Math.abs(m[i * 3 + 2] - ref[i * 4 + 2])) / 3; if (edge.has(i)) se += d; else sf += d; }
    row.m[id] = { edge: +(se / cut).toFixed(2), flat: +(sf / (g.length - cut)).toFixed(2) };
  }
  out.push(row); log(row);
}
return { out, errors: P.gpuErrors().slice(0, 3) };
