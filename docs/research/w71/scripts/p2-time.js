// W71: relative GPU ms per config on examples/ssr (?manual, loop stopped), ROUNDS rounds interleaved, median per pass of
// the rounds' medians (each round: __p.time(N)). prelude: TAG, CONFIGS = [{ name, set }], ROUNDS, N
const KEYS = ['quadBaseRotation', 'thicknessDepthFactor', 'thicknessDepthMode', 'hitLobeFilterGrazing', 'historyEdgeConfidence'];
const acc = {};
for (let r = 0; r < ROUNDS; r++) {
  for (const c of CONFIGS) {
    for (const k of KEYS) delete P.ssr.settings[k];
    P.setSettings(c.set);
    await P.step(4);
    const t = await P.time(N);
    for (const [k, v] of Object.entries(t.ms)) ((acc[c.name] ??= {})[k] ??= []).push(v);
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = Object.fromEntries(Object.entries(acc).map(([c, p]) => [c, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +med(v).toFixed(4)]))]));
log({ tag: TAG, rounds: ROUNDS, n: N, ms: out });
for (const k of KEYS) delete P.ssr.settings[k];
return { errors: (P.gpuErrors ?? []).slice(0, 3) };
