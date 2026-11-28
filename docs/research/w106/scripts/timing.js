// W76: GPU ms of the new defaults vs the pre-W76 path, render loop stopped (one frame per submit, idle between),
// configs interleaved per round (order alternating), medians over every sampled frame. Core passes from
// ssr.readTimings ('hit colour pyramid', 'intersect', 'rt trace', ...) and three's render passes.
// ssr page: ssr/?manual&timing&rt=1&w=1920&h=1080 (SCENE); showcase: index.html?manual&rt=1&w=1920&h=1080&scene=carConcept (SHOWCASE)
// prelude: optional R (rounds), N (frames per round), SCENE, SHOWCASE, POSE, CONFIGS ([[name, settings]]).
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
if (typeof SHOWCASE !== 'undefined') { await S.setSources?.({ rt: true }); if (typeof POSE !== 'undefined') S.setPose(POSE); }
else if (typeof SCENE !== 'undefined') { await S.load(SCENE); if (typeof POSE !== 'undefined') S.setPose(POSE); }
S.stop?.();
const rounds = typeof R !== 'undefined' ? R : 8, frames = typeof N !== 'undefined' ? N : 20;
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['old', { hitColorFilter: 'off', thicknessDepthFactor: 0 }],
  ['new, add thickness', { thicknessDepthFactor: 0 }],
  ['new', {}],
];
const KEYS = ['hitColorFilter', 'mirrorBias', 'mirrorBiasCompensate', 'thicknessDepthFactor', 'thicknessDepthMode', 'hitLobeFilterGrazing'];
const per = Object.fromEntries(configs.map(([n]) => [n, {}]));
const stats = Object.fromEntries(configs.map(([n]) => [n, []]));
const push = (name, key, v) => { if (typeof v === 'number' && Number.isFinite(v)) (per[name][key] ??= []).push(v); };
const hasRender = !!S.renderer.resolveTimestampsAsync;
for (let k = 0; k < rounds; k++) {
  for (const [name, s] of (k % 2 ? [...configs].reverse() : configs)) {
    for (const key of KEYS) delete S.ssr.settings[key];
    Object.assign(S.ssr.settings, s);
    S.ssr.resetHistory(); S.hybrid.resetHistory();
    // the cone's intersect variant builds asynchronously: run until the tracer runs what was asked
    for (let i = 0; i < 100; i++) { await S.step(1); if ((s.hitColorFilter ?? 'cone') !== 'cone' || S.ssr.tracer.outputs.hitColorFilterActive) break; await new Promise((r) => setTimeout(r, 30)); }
    await S.step(6);
    if (hasRender) await S.renderer.resolveTimestampsAsync('render').catch(() => 0);
    for (let i = 0; i < frames; i++) {
      await S.step(1);
      const render = hasRender ? await S.renderer.resolveTimestampsAsync('render').catch(() => null) : null;
      const core = await S.ssr.readTimings();
      push(name, 'three render', render);
      for (const [key, v] of core) push(name, key === 'total' ? 'core total' : key, v);
    }
    stats[name].push(await S.ssr.readTraceStats());
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = {};
for (const [name] of configs) {
  const st = stats[name].filter(Boolean);
  out[name] = {
    ms: Object.fromEntries(Object.entries(per[name]).map(([key, v]) => [key, +med(v).toFixed(4)])),
    traced: st.length ? med(st.map((x) => x.traced)) : null, misses: st.length ? med(st.map((x) => x.misses)) : null,
  };
}
for (const key of KEYS) delete S.ssr.settings[key];
log({ scene: typeof SCENE !== 'undefined' ? SCENE : 'showcase', size: [S.ssr.tracer.width, S.ssr.tracer.height], out });
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors ?? []).slice(0, 3) };
