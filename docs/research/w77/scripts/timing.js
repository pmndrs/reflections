// W77 (from W75's timing.js): GPU ms per frame, presets 'default' vs 'performance' alternating inside one page (the
// upscale ratio is per page), render loop stopped (one frame per submit, idle between), medians over every sampled frame.
// Sum = three's render passes (`?gpuTime`: G-buffer at the render size, signal, residual, composite, display) + the
// core passes (ssr.readTimings: half-res sample, pyramid, classify, intersect, cone pyramid, rt ...) + the denoiser's
// own timestamps + the upsample + the upscaler's passes (aa.timings). Untimed: the seam's guides pass, texture copies.
// showcase: index.html?manual&gpuTime&w=1920&h=1080&scene=<id>&upscale=<preset> (RT switched on here)
// ssr page: ssr/?manual&aa=upscaler&timing&gpuTime&rt=1&w=1920&h=1080&scene=<id>&upscale=<preset>
// W76's future defaults pinned: hitColorFilter 'cone', mirrorBiasCompensate, mirrorBias 0.5.
// prelude: TAG, optional R, N, SHOWCASE, POSE, CONFIGS (preset names)
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.ssr && window.__p.setPreset); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
if (typeof SHOWCASE !== 'undefined') { await S.setSources?.({ rt: true }); if (typeof POSE !== 'undefined') S.setPose(POSE); }
S.stop?.();
Object.assign(S.ssr.settings, { hitColorFilter: 'cone', mirrorBiasCompensate: true, mirrorBias: 0.5 });
const rounds = typeof R !== 'undefined' ? R : 6, frames = typeof N !== 'undefined' ? N : 20;
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : ['default', 'performance'];
const per = Object.fromEntries(configs.map((n) => [n, {}]));
const push = (name, key, v) => { if (typeof v === 'number' && Number.isFinite(v)) (per[name][key] ??= []).push(v); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cone = {};
for (let k = 0; k < rounds; k++) {
  for (const name of (k % 2 ? [...configs].reverse() : configs)) {
    S.setPreset(name);
    await S.step(8); await sleep(k === 0 ? 2500 : 200); await S.step(4); // the cone variant compiles async on its first frame
    cone[name] = !!S.ssr.tracer?.outputs?.hitColorFilterActive;
    await S.renderer.resolveTimestampsAsync('render');
    for (let i = 0; i < frames; i++) {
      await S.step(1);
      const render = await S.renderer.resolveTimestampsAsync('render');
      const core = await S.ssr.readTimings();
      const up = await S.hybrid.readTimings();
      const dn = S.hybrid.denoise ? S.hybrid.denoiser?.gpuTimings : null;
      await sleep(5);
      const aa = S.aa?.timings;
      push(name, 'three render', render);
      for (const [key, v] of core) push(name, key === 'total' ? 'core total' : key, v);
      for (const [key, v] of up) if (key !== 'total') push(name, key, v);
      if (dn) for (const [key, v] of dn) push(name, key === 'total' ? 'denoise total' : `denoise ${key}`, v);
      let aaSum = 0; if (aa) for (const [, v] of aa) aaSum += v;
      push(name, 'upscaler', aaSum);
      push(name, 'sum', (render ?? 0) + (core.get('total') ?? 0) + (up.get('upsample') ?? 0) + (dn?.get('total') ?? 0) + aaSum);
    }
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = { tag: TAG, ratio: S.aa?.ratio, cone, ms: {} };
for (const name of configs) out.ms[name] = Object.fromEntries(Object.entries(per[name]).map(([key, v]) => [key, +med(v).toFixed(3)]));
log(out);
S.setPreset('default');
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors ?? []).slice(0, 3) };
