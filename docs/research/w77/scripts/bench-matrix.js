// W77: the reflections x upscale matrix on the bench, one scene per page: per cell, bench Measure (mean of K frames vs
// the path tracer, MAD per region, + X0's std) and X0's rest drift / orbit flicker on ours-rt (named regions after the
// Measure). The first configuration on a page reads wrong (X0's note): WARM runs once first and is thrown away.
// bench.html?manual&scene=<id>&pose=<pose>&size=960x540&left=ours-rt&right=pathtraced
//   &s.hitColorFilter=cone&s.mirrorBiasCompensate=1&s.mirrorBias=0.5   (W76's future defaults, pinned)
// prelude: CELLS = [[name, { upscale, preset, ... }], ...], optional POSE, METHODS, SPP, WARM, TAG
const B = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.metrics && window.__p.metrics.of); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
const pose = typeof POSE !== 'undefined' ? POSE : 'hero';
const methods = typeof METHODS !== 'undefined' ? METHODS : ['ours-denoised', 'ours-rt'];
const flickerMethod = 'ours-rt';
const r2 = (x, n = 2) => (typeof x === 'number' ? +x.toFixed(n) : x);
const apply = async (set) => {
  for (const [k, v] of Object.entries(set)) B.setSetting(k, v);
  if (B.pending().methods.length) await B.rebuild();
  B.setPose(pose);
  // the cone filter's intersect variant (and W74's fill) compile async on their first frame: let them land
  await B.step(4); await new Promise((r) => setTimeout(r, 2500)); await B.step(2);
};
const cells = [...(typeof WARM !== 'undefined' ? [['warm-up (discarded)', WARM, true]] : []), ...CELLS];
for (const [name, set, discard] of cells) {
  await apply(set);
  const t0 = performance.now();
  const m = await B.measure({ samples: typeof SPP !== 'undefined' ? SPP : 16, warmup: 48, frames: 8, methods });
  const rows = Object.fromEntries(m.rows.map((r) => [r.region, { px: r.px, pt: r2(r.refLuma, 1), ...Object.fromEntries(Object.entries(r.methods).map(([id, v]) => [id, { mad: r2(v.mad), luma: r2(v.luma, 1), std: r2(+v.std, 3) }])) }]));
  const fm = B.metrics.of(flickerMethod);
  const drift = await fm.restDrift({});
  const orbit = await fm.orbitFlicker({});
  const flicker = {};
  for (const [reg, v] of Object.entries(orbit.regions ?? {})) flicker[reg] = { orbitStd: r2(v.std, 3), orbitD2: r2(v.d2, 3), drift: r2(drift.regions?.[reg]?.mean, 3), driftOver: r2(drift.regions?.[reg]?.pctOver, 2) };
  const row = { tag: typeof TAG !== 'undefined' ? TAG : '', scene: B.getSetting?.('scene') ?? null, pose, cell: name, discard: !!discard, spp: m.referenceSamples, measure: rows, flicker, restFlicker: r2(drift.rest?.reflection?.mean, 3), ms: Math.round(performance.now() - t0) };
  log(row);
}
return { errors: B.gpuErrors().slice(0, 3) };
