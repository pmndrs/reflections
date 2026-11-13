// W72 GPU ms (examples/ssr?timing&manual&w=1920&h=1080): core passes per config, median of N frames, loop stopped,
// configs interleaved ROUNDS times (A/B inside one page; relative numbers only). Prelude: optional SCENE, N, ROUNDS.
const scene = typeof SCENE !== 'undefined' ? SCENE : 'mirrorWall';
await P.load(scene);
if (typeof FLOOR !== 'undefined') P.setFloorRoughness(FLOOR);
const KEYS = ['hitColorFilter', 'hitColorConeScale', 'mirrorBias', 'mirrorBiasCompensate'];
const CFG = [['default', {}], ['cone', { hitColorFilter: 'cone' }], ['comp 0.5', { hitColorFilter: 'cone', mirrorBias: 0.5, mirrorBiasCompensate: true }]];
const per = {};
for (let round = 0; round < (typeof ROUNDS !== 'undefined' ? ROUNDS : 5); round++) {
  for (const [name, s] of CFG) {
    for (const k of KEYS) delete P.ssr.settings[k];
    P.setSettings(s);
    await P.step(4);
    const t = await P.time(typeof N !== 'undefined' ? N : 30);
    for (const [k, v] of Object.entries(t.ms)) ((per[name] ??= {})[k] ??= []).push(v);
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const res = Object.fromEntries(Object.entries(per).map(([n, m]) => [n, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +med(v).toFixed(4)]))]));
for (const k of KEYS) delete P.ssr.settings[k];
return { scene, size: [P.ssr.tracer.width, P.ssr.tracer.height], res };
