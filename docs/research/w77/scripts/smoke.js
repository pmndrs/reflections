// W77 smoke: the preset reached the pass, the hybrid and the denoiser (ssr page), and switches at runtime.
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.ssr); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
S.stop?.();
const d = () => ({ res: S.ssr.settings.reflectionResolution, mode: S.hybrid.denoiserHitSourceMode, hs: S.hybrid.denoiserHitSource, dn: S.hybrid.denoiser?.opts ? { sep: S.hybrid.denoiser.opts.separateHitSources, any: S.hybrid.denoiser.opts.missesMatchAnySource } : null, tracer: [S.ssr.tracer?.width, S.ssr.tracer?.height] });
await S.metrics.restDrift({ a: 8, b: 16 });
const a = d();
const r = S.setPreset('default');
await S.metrics.restDrift({ a: 8, b: 16 });
const b = { ...d(), changed: r.resolutionChanged };
S.setPreset('performance', { denoiser: { hitSource: 'off' } });
await S.metrics.restDrift({ a: 8, b: 16 });
const c = d();
return { a, b, c, errors: S.gpuErrors.slice(0, 3) };
