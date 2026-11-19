// W76: X0 rest drift (and its per-frame rest flicker) twice on the page as loaded (URL settings), reflection region. Prelude: TAG.
P.stop();
for (let i = 0; i < 60 && (P.ssr.settings.hitColorFilter ?? 'cone') === 'cone' && !P.ssr.tracer?.outputs.hitColorFilterActive; i++) { await P.step(1); await new Promise((r) => setTimeout(r, 100)); }
const R = (o) => o?.regions?.reflection;
const a = await P.metrics.restDrift(typeof OPTS !== 'undefined' ? OPTS : {}), b = await P.metrics.restDrift(typeof OPTS !== 'undefined' ? OPTS : {});
log({ tag: TAG, scene: P.kit.id, drift: [R(a)?.mean, R(b)?.mean], pctOver: [R(a)?.pctOver, R(b)?.pctOver], p99: R(a)?.p99, rest: [a.rest?.reflection?.mean, b.rest?.reflection?.mean], frames: a.frames });
