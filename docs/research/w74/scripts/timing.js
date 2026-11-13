// W74: tracedMissRate full vs half, GPU ms per pass (render loop stopped: manual pages, one frame at a time, idle between)
// and the trace stats. ssr page: ssr/?manual&timing&rt=1&w=1920&h=1080&scene=<id>; showcase: index.html?manual&scene=carConcept&rt=1&w=1920&h=1080.
// Configs alternate per round (R rounds x N frames each) so drift cancels; medians over every sampled frame.
// prelude: optional R, N, CONFIGS = [[name, traceSettings], ...], SHOWCASE, POSE, SCENE (ssr page)
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
if (typeof SHOWCASE !== 'undefined') { await S.setSources({ rt: true }); if (typeof POSE !== 'undefined') S.setPose(POSE); }
else if (typeof SCENE !== 'undefined') { await S.load(SCENE); if (typeof POSE !== 'undefined') S.setPose(POSE); }
S.stop?.();
const rounds = typeof R !== 'undefined' ? R : 5, frames = typeof N !== 'undefined' ? N : 20;
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['full', { tracedMissRate: 'full' }], ['half', { tracedMissRate: 'half' }]];
const base = { ...S.ssr.traceSettings };
const per = Object.fromEntries(configs.map(([n]) => [n, {}]));
const stats = Object.fromEntries(configs.map(([n]) => [n, []]));
for (let k = 0; k < rounds; k++) {
  for (const [name, set] of configs) {
    S.ssr.traceSettings = { ...base, ...set };
    S.ssr.resetHistory(); S.hybrid.resetHistory();
    await S.step(6);
    for (let i = 0; i < frames; i++) {
      await S.step(1);
      const t = await S.ssr.readTimings();
      for (const [key, v] of t) (per[name][key] ??= []).push(v);
    }
    stats[name].push(await S.ssr.readTraceStats());
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = {};
for (const [name] of configs) {
  const st = stats[name];
  const m = (key) => med(st.map((s) => s[key]));
  out[name] = {
    ms: Object.fromEntries(Object.entries(per[name]).map(([key, v]) => [key, +med(v).toFixed(4)])),
    misses: m('misses'), traced: m('traced'), skipped: m('halfRateSkipped'), filled: m('filled'), fallbacks: m('fillFallbacks'), overflow: m('fillOverflow'),
  };
}
log(out);
S.ssr.traceSettings = base;
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors).slice(0, 3) };
