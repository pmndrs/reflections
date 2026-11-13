// W80: core pass ms (median of 30, loop stopped) per maxCandidates at 1920x1080, examples/ssr (prelude: POSE, ROUNDS).
// Values alternate each round so drift cancels; the median over rounds is reported.
P.stop && P.stop();
if (typeof POSE !== 'undefined') P.setPose(POSE);
const VALS_ = [1, 2, 4, 8], rounds = typeof ROUNDS !== 'undefined' ? ROUNDS : 5;
const acc = Object.fromEntries(VALS_.map((v) => [v, {}]));
for (let k = 0; k < rounds; k++) {
  for (const v of VALS_) {
    P.setSettings({ maxCandidates: v, frameIndex: undefined });
    const t = await P.time(30);
    for (const [key, ms] of Object.entries(t.ms)) (acc[v][key] ??= []).push(ms);
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = {};
for (const v of VALS_) {
  out[v] = Object.fromEntries(Object.entries(acc[v]).map(([k, a]) => [k, +med(a).toFixed(3)]));
  P.setSettings({ maxCandidates: v });
  await P.step(3);
  out[v].misses = (await P.stats()).misses;
}
log(out);
return { errors: P.gpuErrors.slice(0, 3) };
