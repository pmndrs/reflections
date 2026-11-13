// W76: rest drift and orbit flicker (X0, examples/ssr page defaults: upscaler, denoiser) with the page's URL settings,
// twice each (same page: the floor of this page), reflection region. Prelude: TAG.
P.stop();
// the cone builds asynchronously: let the tracer run what it was given before measuring
for (let i = 0; i < 60 && (P.ssr.settings.hitColorFilter ?? 'cone') === 'cone' && !P.ssr.tracer?.outputs.hitColorFilterActive; i++) { await P.step(1); await new Promise((r) => setTimeout(r, 100)); }
const R = (o) => o?.regions?.reflection;
const d1 = await P.metrics.restDrift(), o1 = await P.metrics.orbitFlicker();
const d2 = await P.metrics.restDrift(), o2 = await P.metrics.orbitFlicker();
const q = await P.metrics.quadEnergy();
log({ tag: TAG, scene: P.kit.id, effective: (({ hitColorFilter, mirrorBias, thicknessDepthMode, thicknessDepthFactor }) => ({ hitColorFilter, mirrorBias, thicknessDepthMode, thicknessDepthFactor }))(P.ssr.tracer?.outputs.settings ?? {}),
  drift: [R(d1)?.mean, R(d2)?.mean], pctOver: R(d1)?.pctOver, rest: d1.rest?.reflection?.mean,
  orbitStd: [R(o1)?.std, R(o2)?.std], orbitD2: R(o1)?.d2, quad: q.display?.reflection?.ratio, quadRaw: q.signal?.reflection?.ratio });
