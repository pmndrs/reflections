// W77: the reflections x upscale matrix on examples/ssr (no path tracer there): per preset, X0's rest drift (with the
// settled frame b saved as a luma PNG, compared offline against full x1's) and orbit flicker on the reflection region.
// One page per upscale ratio (ssr/?scene=<id>&rt=1&upscale=<preset>: today's AA = the upscaler, FFX denoiser on).
// W76's future defaults pinned: hitColorFilter 'cone', mirrorBiasCompensate, mirrorBias 0.5.
// prelude: TAG (file prefix), CONFIGS (preset names, default ['default', 'performance'])
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.metrics && window.__p.ssr); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
S.stop?.();
S.setSettings({ hitColorFilter: 'cone', mirrorBiasCompensate: true, mirrorBias: 0.5 });
const r2 = (x, n = 3) => (typeof x === 'number' ? +x.toFixed(n) : x);
const coneReady = async () => {
  for (let i = 0; i < 40; i++) { await S.metrics.restDrift({ a: 2, b: 3, restFrames: 0, alignPhase: false }); if (S.ssr.tracer?.outputs?.hitColorFilterActive) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
};
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : ['default', 'performance'];
// throwaway first configuration (the first metric on a page reads wrong, X0)
S.setPreset('performance'); await coneReady(); await S.metrics.restDrift({}); S.setPreset('default');
for (const name of configs) {
  S.setPreset(name);
  const cone = await coneReady();
  const drift = await S.metrics.restDrift({ heat: true });
  const orbit = await S.metrics.orbitFlicker({});
  const file = `${TAG}-${name}.png`;
  save(file, drift.images[1]);
  const R = (o) => o?.regions?.reflection;
  const row = {
    tag: TAG, preset: name, cone, ratio: S.aa.ratio, tracer: [S.ssr.tracer?.width, S.ssr.tracer?.height], hitSource: S.hybrid.denoiserHitSourceMode,
    drift: r2(R(drift)?.mean), driftOver: r2(R(drift)?.pctOver, 2), restFlicker: r2(drift.rest?.reflection?.mean), restPct: r2(drift.rest?.reflection?.pctOver1, 2),
    orbitStd: r2(R(orbit)?.std), orbitD2: r2(R(orbit)?.d2), px: R(orbit)?.px, image: file,
  };
  log(row);
}
return { errors: S.gpuErrors.slice(0, 3) };
