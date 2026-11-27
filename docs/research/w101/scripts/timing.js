// W101 (from W77's timing.js): GPU ms per frame, minTraversalOccupancy 4 (FFX's early exit, core's default before
// W101) vs 0 (every glossy ray marches to its end), alternating inside one page (ABBA per round), render loop stopped
// (one frame per submit, idle between). Per round: N frames per config; reported: the median over every sampled frame
// per config, and each round's median of the intersect pass / the sum (so the run-to-run spread shows).
// Sum = three's render passes (`?gpuTime`) + the core passes (ssr.readTimings 'total': pyramid, classify, intersect,
// rt ...) + the denoiser's own timestamps + the half-res upsample + the upscaler's passes.
// showcase: index.html?manual&gpuTime&w=1920&h=1080&scene=<id>   (RT switched on here when RT=1)
// ssr page: ssr/?manual&timing&gpuTime&w=1920&h=1080&scene=<id>[&rt=1]
// prelude: TAG, optional R (rounds), N (frames), SHOWCASE, RT, PRESET, POSE
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.ssr && window.__p.step); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
if (typeof SHOWCASE !== 'undefined') { await S.setSources?.({ rt: typeof RT !== 'undefined' && !!RT }); if (typeof POSE !== 'undefined') S.setPose(POSE); }
S.stop?.();
if (typeof PRESET !== 'undefined' && S.setPreset) S.setPreset(PRESET);
const rounds = typeof R !== 'undefined' ? R : 6, frames = typeof N !== 'undefined' ? N : 30;
const configs = [['occ4', 4], ['occ0', 0]];
const per = Object.fromEntries(configs.map(([n]) => [n, {}]));
const roundMed = Object.fromEntries(configs.map(([n]) => [n, { intersect: [], sum: [] }]));
const push = (name, key, v) => { if (typeof v === 'number' && Number.isFinite(v)) (per[name][key] ??= []).push(v); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
for (let k = 0; k < rounds; k++) {
  for (const [name, occ] of (k % 2 ? [...configs].reverse() : configs)) {
    S.ssr.settings.minTraversalOccupancy = occ;
    S.ssr.resetHistory?.(); S.hybrid?.resetHistory?.();
    await S.step(8); await sleep(k === 0 ? 2500 : 200); await S.step(4);
    await S.renderer.resolveTimestampsAsync('render');
    const ri = [], rs = [];
    for (let i = 0; i < frames; i++) {
      await S.step(1);
      const render = await S.renderer.resolveTimestampsAsync('render');
      const core = await S.ssr.readTimings();
      const up = S.hybrid?.readTimings ? await S.hybrid.readTimings() : new Map();
      const dn = S.hybrid?.denoise ? S.hybrid.denoiser?.gpuTimings : null;
      await sleep(5);
      const aa = S.aa?.timings;
      push(name, 'three render', render);
      for (const [key, v] of core) push(name, key === 'total' ? 'core total' : key, v);
      for (const [key, v] of up) if (key !== 'total') push(name, key, v);
      if (dn) for (const [key, v] of dn) push(name, key === 'total' ? 'denoise total' : `denoise ${key}`, v);
      let aaSum = 0; if (aa) for (const [, v] of aa) aaSum += v;
      push(name, 'upscaler', aaSum);
      const sum = (render ?? 0) + (core.get('total') ?? 0) + (up.get('upsample') ?? 0) + (dn?.get('total') ?? 0) + aaSum;
      push(name, 'sum', sum);
      if (typeof core.get('intersect') === 'number') ri.push(core.get('intersect'));
      rs.push(sum);
    }
    roundMed[name].intersect.push(+med(ri).toFixed(3)); roundMed[name].sum.push(+med(rs).toFixed(3));
  }
}
const out = { tag: TAG, rt: typeof RT !== 'undefined' && !!RT, preset: typeof PRESET !== 'undefined' ? PRESET : 'default', res: S.ssr.settings.reflectionResolution ?? 'full', ms: {}, rounds: roundMed };
for (const [name] of configs) out.ms[name] = Object.fromEntries(Object.entries(per[name]).map(([key, v]) => [key, +med(v).toFixed(3)]));
log(out);
delete S.ssr.settings.minTraversalOccupancy;
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors ?? []).slice(0, 3) };
