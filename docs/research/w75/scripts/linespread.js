// W75 phase 2: X0's line spread (the double-blur gate) on the bench, one call per configuration.
// bench.html?manual. prelude: RUNS = [[name, { scene?, settings, roughness?, methods? }], ...]
const B = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.metrics && window.__p.metrics.lineSpread); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
for (const [name, o] of RUNS) {
  const r = await B.metrics.lineSpread({ roughness: [0.05, 0.15, 0.3], methods: ['ours-denoised', 'ours-raw', 'ours-rt'], ...o });
  const rows = r.rows.map((x) => ({ r: x.roughness, pt: x.pt && +x.pt.toFixed(2), ...Object.fromEntries(Object.entries(x.methods).map(([id, m]) => [id, `${m.lost ? 'LOST ' : ''}${m.width === null ? '-' : m.width.toFixed(2) + ' x' + m.ratio.toFixed(2)} peak x${m.peakRatio === null ? '?' : m.peakRatio.toFixed(2)}`])) }));
  log({ name, rows });
}
return { errors: B.gpuErrors().slice(0, 3) };
