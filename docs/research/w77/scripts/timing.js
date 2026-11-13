// W77: pass timings + miss counts per s.maxCandidates (bench manual mode = loop stopped).
// bench.html?manual&scene=carConcept&pose=w50&size=1920x1080&left=ours-rt&right=ours-rt (prelude: R rounds, VALS)
const ROUNDS = typeof R !== 'undefined' ? R : 5;
const VALS_ = typeof VALS !== 'undefined' ? VALS : [1, 2, 4, 8];
P.setPose('w50');
const res = Object.fromEntries(VALS_.map((v) => [v, []]));
const stats = {};
for (let k = 0; k < ROUNDS; k++) {
  for (const v of VALS_) {
    P.setSetting('s.maxCandidates', v);
    P.reset();
    await P.step(40);
    res[v].push(P.timings()['ours-rt']);
    if (k === 0) { const t = await P.traceStats(); stats[v] = t['ours-rt']; }
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = {};
for (const [v, rows] of Object.entries(res)) out[v] = Object.fromEntries(Object.keys(rows[0] ?? {}).map((key) => [key, +med(rows.map((r) => r[key])).toFixed(3)]));
log({ timings: out, stats });
return { errors: P.gpuErrors().slice(0, 3) };
