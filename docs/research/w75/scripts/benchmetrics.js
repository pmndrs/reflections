// W75 phase 2: X0's page metrics on a bench method per configuration (bench.html?manual&scene=carConcept&pose=w50&size=960x540).
// A Measure first (the lip / band / door masks come from the PT image). prelude: CONFIGS = [[name, settings]], METHOD, optional OPTS
const B = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.metrics && window.__p.metrics.of); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
const method = typeof METHOD !== 'undefined' ? METHOD : 'ours-rt';
const opts = typeof OPTS !== 'undefined' ? OPTS : { speckle: false, energy: false };
const regs = ['reflection', 'glossy', 'lip', 'band', 'door', 'car'];
for (const [name, set] of CONFIGS) {
  for (const [k, v] of Object.entries(set)) B.setSetting(k, v);
  if (B.pending().methods.length) await B.rebuild();
  B.setPose('w50');
  await B.measure({ samples: 16, warmup: 24, frames: 4, methods: [method] });
  const m = await B.metrics.of(method).all(opts);
  const row = { name };
  for (const r of regs) {
    const g = (o) => o?.regions?.[r];
    if (!g(m.restDrift) && !g(m.orbitFlicker)) continue;
    row[r] = { drift: g(m.restDrift)?.mean, orbitStd: g(m.orbitFlicker)?.std, orbitD2: g(m.orbitFlicker)?.d2, quad: m.quadEnergy?.display?.[r]?.ratio, panD2: undefined };
    for (const k of Object.keys(row[r])) if (typeof row[r][k] === 'number') row[r][k] = +row[r][k].toFixed(4); else delete row[r][k];
  }
  row.panD2BorderReflection = m.edgePan?.regions?.borderReflection?.d2;
  log(row);
  for (const k of Object.keys(set)) B.setSetting(k, null);
  if (B.pending().methods.length) await B.rebuild();
}
return { errors: B.gpuErrors().slice(0, 3) };
