// W58: pass timings (ours-rt, bench manual mode = loop stopped) for s.quadCopy always vs sameSurface.
// bench.html?manual&scene=carConcept&pose=w50&size=1920x1080&left=ours-rt&right=ours-rt. Median over ROUNDS reads of the
// method's own timestamp averages after 40 frames each; settings alternate to cancel drift.
const ROUNDS = typeof R !== 'undefined' ? R : 5;
P.setPose('w50');
const res = { always: [], sameSurface: [] };
for (let k = 0; k < ROUNDS; k++) {
  for (const v of ['always', 'sameSurface']) {
    P.setSetting('s.quadCopy', v);
    P.reset();
    await P.step(40);
    res[v].push(P.timings()['ours-rt']);
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = {};
for (const [v, rows] of Object.entries(res)) out[v] = Object.fromEntries(Object.keys(rows[0] ?? {}).map((key) => [key, +med(rows.map((r) => r[key])).toFixed(3)]));
log(out);
return { errors: P.gpuErrors().slice(0, 3) };
