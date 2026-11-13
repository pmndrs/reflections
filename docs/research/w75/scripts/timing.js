// W75: reflectionResolution full vs half, GPU ms per frame with the render loop stopped (one frame per submit, idle
// between), configs alternating order per round inside one page (`__p.setResolution` rebuilds the composites), medians
// over every sampled frame. Sums: three's render passes (`?gpuTime`: G-buffer, signal, residual, composite, display),
// the core passes (ssr.readTimings: half-res sample, depth pyramid, classify, intersect, rt ...), the denoiser's own
// timestamps and the upsample. Untimed: the seam's guides pass and the texture copies.
// ssr page: ssr/?manual&timing&gpuTime&rt=1&w=1920&h=1080; showcase: index.html?manual&gpuTime&rt=1&w=1920&h=1080&scene=carConcept
// prelude: optional R, N, SCENE (ssr page), SHOWCASE, POSE, CONFIGS (default ['full', 'half'])
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
if (typeof SHOWCASE !== 'undefined') { await S.setSources?.({ rt: true }); if (typeof POSE !== 'undefined') S.setPose(POSE); }
else if (typeof SCENE !== 'undefined') { await S.load(SCENE); if (typeof POSE !== 'undefined') S.setPose(POSE); }
S.stop?.();
const rounds = typeof R !== 'undefined' ? R : 6, frames = typeof N !== 'undefined' ? N : 20;
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : ['full', 'half'];
const per = Object.fromEntries(configs.map((n) => [n, {}]));
const stats = Object.fromEntries(configs.map((n) => [n, []]));
const push = (name, key, v) => { if (typeof v === 'number' && Number.isFinite(v)) (per[name][key] ??= []).push(v); };
for (let k = 0; k < rounds; k++) {
  for (const name of (k % 2 ? [...configs].reverse() : configs)) {
    await S.setResolution(name, typeof MINR !== 'undefined' ? MINR : 0.05);
    S.ssr.resetHistory(); S.hybrid.resetHistory();
    await S.step(8);
    await S.renderer.resolveTimestampsAsync('render');
    for (let i = 0; i < frames; i++) {
      await S.step(1);
      const render = await S.renderer.resolveTimestampsAsync('render');
      const core = await S.ssr.readTimings();
      const up = await S.hybrid.readTimings();
      const dn = S.hybrid.denoise ? S.hybrid.denoiser?.gpuTimings : null;
      push(name, 'three render', render);
      for (const [key, v] of core) push(name, key === 'total' ? 'core total' : key, v);
      for (const [key, v] of up) if (key !== 'total') push(name, key, v);
      if (dn) for (const [key, v] of dn) push(name, key === 'total' ? 'denoise total' : `denoise ${key}`, v);
      const sum = (render ?? 0) + (core.get('total') ?? 0) + (up.get('upsample') ?? 0) + (dn?.get('total') ?? 0);
      push(name, 'sum', sum);
    }
    stats[name].push(await S.ssr.readTraceStats());
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = {};
for (const name of configs) {
  const st = stats[name].filter(Boolean);
  out[name] = {
    ms: Object.fromEntries(Object.entries(per[name]).map(([key, v]) => [key, +med(v).toFixed(4)])),
    traced: st.length ? med(st.map((s) => s.traced)) : null, misses: st.length ? med(st.map((s) => s.misses)) : null,
    tracer: [S.ssr.tracer.width, S.ssr.tracer.height],
  };
}
log(out);
await S.setResolution('full');
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors ?? []).slice(0, 3) };
