// W52 GPU cost of the halo options on the showcase page (run with docs/research/w50/scripts/drive.mjs).
// prelude: POS, TGT, CONFIGS = [[name, {ssr: {...}, trace: {...}}], ...], N (frames per config)
// Loop stopped (CLAUDE.md rule 3), RT on; per config: settings applied, 40 frames warm-up, then the
// median over N frames of each pass's GPU ms (ssr.readTimings: 'intersect', 'rt trace', 'total').
P.stop();
await P.setSources({ rt: true });
if (POS) P.setCamera(POS, TGT);
const base = { ssr: { ...P.ssr.settings }, trace: { ...P.ssr.traceSettings } };
const out = {};
for (const [name, c] of CONFIGS) {
  P.ssr.settings = { ...base.ssr, ...(c.ssr ?? {}) };
  P.ssr.traceSettings = { ...base.trace, ...(c.trace ?? {}) };
  P.ssr.resetHistory(); P.hybrid.resetHistory();
  await P.step(40);
  const acc = {};
  for (let i = 0; i < N; i++) {
    await P.step(1);
    const t = await P.ssr.readTimings();
    for (const [k, v] of t) (acc[k] ??= []).push(v);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(4); };
  out[name] = Object.fromEntries(Object.entries(acc).filter(([k]) => ['intersect', 'rt trace', 'total'].includes(k)).map(([k, v]) => [k, med(v)]));
  log({ name, ...out[name] });
}
out.trace = await P.ssr.readTraceStats();
out.errors = P.gpuErrors.slice(0, 3);
return out;
