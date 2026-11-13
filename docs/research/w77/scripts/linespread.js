// W77 (from W75's): X0's line spread (the double-blur gate) per matrix cell, r 0.05 / 0.15, on the bench.
// bench.html?manual&s.hitColorFilter=cone&s.mirrorBiasCompensate=1&s.mirrorBias=0.5 (W76's future defaults pinned)
// prelude: cells.js (CELLS, WARM), optional ROUGH, METHODS
const B = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.metrics && window.__p.metrics.lineSpread); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
const rough = typeof ROUGH !== 'undefined' ? ROUGH : [0.05, 0.15];
const methods = typeof METHODS !== 'undefined' ? METHODS : ['ours-denoised', 'ours-rt'];
const cells = [['warm-up (discarded)', WARM, true], ...CELLS.filter(([n]) => !n.startsWith('ref:'))];
for (const [name, settings, discard] of cells) {
  const r = await B.metrics.lineSpread({ roughness: rough, methods, settings });
  const rows = r.rows.map((x) => ({ r: x.roughness, pt: x.pt && +x.pt.toFixed(2), ...Object.fromEntries(Object.entries(x.methods).map(([id, m]) => [id, { width: m.width === null ? null : +m.width.toFixed(2), ratio: m.ratio == null ? null : +m.ratio.toFixed(3), peak: m.peakRatio == null ? null : +m.peakRatio.toFixed(3), lost: !!m.lost, pass: !!m.pass }])) }));
  log({ cell: name, discard: !!discard, rows });
}
return { errors: B.gpuErrors().slice(0, 3) };
