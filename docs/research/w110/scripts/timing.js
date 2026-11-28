// W110 (copy of W107's timing.js): GPU ms of the traced pass per configuration, render loop stopped (bench.html?manual), pass timestamps
// (&timestamps=1). Per config: rebuild if needed, warm up, then N single steps reading the 'rt trace' (and every other)
// timestamp after each; median (and min: other GPU work only adds time) per round, configurations interleaved ROUNDS times.
// bench.html?manual&scene=carConcept&pose=w50&size=1920x1080&aa=off&timestamps=1&left=ours-rt&right=ours-rt
// prelude (optional): METHOD, CONFIGS = [[name, {key: value}], ...], ROUNDS, N, POSE
const method = typeof METHOD !== 'undefined' ? METHOD : 'ours-rt';
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['base', { rtAlpha: false, rtRoughMetal: false, rtEmissiveMap: false }], ['on', {}]];
const rounds = typeof ROUNDS !== 'undefined' ? ROUNDS : 3, n = typeof N !== 'undefined' ? N : 30;
const pose = typeof POSE !== 'undefined' ? POSE : 'w50';
const med = (a) => { const s = [...a].filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
await P.setSides(method, method);
const res = Object.fromEntries(configs.map(([name]) => [name, {}]));
for (let r = 0; r < rounds; r++) {
  for (const [name, set] of configs) {
    for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
    if (P.pending().methods.length) await P.rebuild();
    P.setPose(pose);
    await P.step(20);
    const per = {};
    for (let i = 0; i < n; i++) {
      await P.step(1);
      await new Promise((ok) => setTimeout(ok, 30)); // the timestamp readback resolves after the frame
      const t = P.timings()[method] ?? {};
      for (const [k, v] of Object.entries(t)) (per[k] ??= []).push(v);
    }
    for (const [k, v] of Object.entries(per)) { (res[name][k] ??= []).push(med(v)); (res[name][k + ' (min)'] ??= []).push(Math.min(...v.filter(Number.isFinite))); }
    log({ round: r, name, rt: res[name]['rt trace']?.at(-1), total: res[name]['reflections total']?.at(-1) });
    for (const k of Object.keys(set)) P.setSetting(k, null);
    if (P.pending().methods.length) await P.rebuild();
  }
}
const stats = null;
return { method, res: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, { med: +med(pv).toFixed(3), rounds: pv.map((x) => +x.toFixed(3)) }]))])), stats, errors: P.gpuErrors().slice(0, 3) };
