// W73 phase 2: GPU ms per tracer pass, copy vs ratio, interleaved A/B in one page (render loop stopped, examples/ssr
// __p.time: median of n frames per pass). examples/ssr/?manual&timing&w=1920&h=1080. Prelude: SCENES, CONFIGS, ROUNDS, N.
const scenes = typeof SCENES !== 'undefined' ? SCENES : ['mirrorWall', 'rooms'];
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['copy@1', {}], ['ratio@1', { rayReuse: 'ratio' }], ['copy@4', { samplesPerQuad: 4 }]];
const rounds = typeof ROUNDS !== 'undefined' ? ROUNDS : 3, n = typeof N !== 'undefined' ? N : 30;
const out = {};
for (const scene of scenes) {
  await P.load(scene);
  const per = {};
  for (let k = 0; k < rounds; k++) for (const [name, set] of configs) {
    P.setSettings(set);
    const t = await P.time(n);
    for (const key of Object.keys(set)) delete P.ssr.settings[key];
    for (const [pass, ms] of Object.entries(t.ms)) ((per[name] ??= {})[pass] ??= []).push(ms);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  out[scene] = Object.fromEntries(Object.entries(per).map(([name, p]) => [name, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +med(v).toFixed(4)]))]));
  log({ scene, ...out[scene] });
}
return out;
