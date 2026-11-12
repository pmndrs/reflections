// W55: frame and bake cost of carProbes at 1920 x 1080, render loop stopped (bench.html?manual), one method on
// both sides (rendered once per step). Frame: wall ms per GPU-synced frame (step(1) = frame + idle), median of
// N after warm-up, configurations interleaved ROUNDS times. Bake: a live floorRoughness set re-bakes the set;
// (set + step(1)) - step(1), median of 5.
// bench.html?manual&scene=carConcept&pose=w50&size=1920x1080&left=ours-rt&right=ours-rt
// prelude (optional): METHOD, CONFIGS = [[name, {key: value}], ...], ROUNDS, N
const method = typeof METHOD !== 'undefined' ? METHOD : 'ours-rt';
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['off', {}], ['wheels', { carProbes: 'wheels' }], ['cabin', { carProbes: 'cabin' }], ['both 128', { carProbes: 'both' }], ['both 64', { carProbes: 'both', carProbeRes: '64' }], ['both 256', { carProbes: 'both', carProbeRes: '256' }]];
const rounds = typeof ROUNDS !== 'undefined' ? ROUNDS : 3, n = typeof N !== 'undefined' ? N : 60;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
await P.setSides(method, method);
P.setMode('split');
const res = Object.fromEntries(configs.map(([name]) => [name, { frame: [], bake: [] }]));
for (let r = 0; r < rounds; r++) {
  for (const [name, set] of configs) {
    for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
    await P.rebuild();
    P.setPose('w50');
    await P.step(30);
    const f = [];
    for (let i = 0; i < n; i++) { const t0 = performance.now(); await P.step(1); f.push(performance.now() - t0); }
    res[name].frame.push(med(f));
    if (r === 0) {
      const b = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now(); await P.step(1); const s = performance.now() - t0;
        const t1 = performance.now(); P.setSetting('floorRoughness', 0.03); await P.step(1); b.push(performance.now() - t1 - s);
      }
      P.setSetting('floorRoughness', null); await P.step(2);
      res[name].bake.push(med(b));
      res[name].info = (({ atlases, carProbes, bakeMs }) => ({ atlases, carProbes, bakeMsCpu: bakeMs }))(P.info().info[method]);
    }
    log({ round: r, name, frame: res[name].frame.at(-1), bake: res[name].bake.at(-1) });
    for (const k of Object.keys(set)) P.setSetting(k, null);
  }
}
return { method, res: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { frameMed: +med(v.frame).toFixed(2), frames: v.frame.map((x) => +x.toFixed(2)), bake: v.bake.map((x) => +x.toFixed(1)), info: v.info }])), errors: P.gpuErrors().slice(0, 3) };
