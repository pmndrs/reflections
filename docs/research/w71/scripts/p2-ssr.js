// W71 phase 2 on examples/ssr: X0's page metrics per settings config, one page (deterministic after a reset).
// prelude: TAG, CONFIGS = [{ name, set }], WHICH = ['restDrift', 'orbitFlicker', 'quadEnergy', 'edgePan', ...], OPTS = { <metric>: {...} }, STATS (bool: __p.stats() too)
const KEYS = ['quadBaseRotation', 'thicknessDepthFactor', 'thicknessDepthMode', 'hitLobeFilterGrazing', 'historyEdgeConfidence'];
const pick = (r) => {
  const o = {};
  for (const [k, v] of Object.entries(r ?? {})) if (k !== 'heat' && k !== 'images') o[k] = v;
  return o;
};
for (const c of CONFIGS) {
  for (const k of KEYS) delete P.ssr.settings[k];
  P.setSettings(c.set);
  const out = { tag: TAG, config: c.name };
  for (const m of WHICH) out[m] = pick(await P.metrics[m](OPTS?.[m] ?? {}));
  if (typeof STATS !== 'undefined' && STATS) {
    P.ssr.resetHistory(); P.hybrid.resetHistory(); await P.step(8);
    const s = await P.stats();
    out.stats = { rays: s.rays, misses: s.misses, wall: s.wall, objects: s.objects };
    const t = await P.traceStats?.();
    if (t) out.trace = t;
  }
  log(out);
}
for (const k of KEYS) delete P.ssr.settings[k];
return { errors: (P.gpuErrors ?? []).slice(0, 3) };
