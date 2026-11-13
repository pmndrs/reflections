// W72 phase 2: X0's page metrics on examples/ssr (page defaults: upscaler AA, denoiser) per configuration and scene.
// Prelude: optional SCENES, CONFIGS (core settings objects).
const scenes = typeof SCENES !== 'undefined' ? SCENES : ['mirrorWall', 'contact'];
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['default', {}], ['cone', { hitColorFilter: 'cone' }],
  ['comp 0.5', { hitColorFilter: 'cone', mirrorBias: 0.5, mirrorBiasCompensate: true }],
  ['comp 0.7', { hitColorFilter: 'cone', mirrorBias: 0.7, mirrorBiasCompensate: true }],
];
const KEYS = ['hitColorFilter', 'hitColorConeScale', 'mirrorBias', 'mirrorBiasCompensate'];
const R = (o, f) => Object.fromEntries(Object.entries(o.regions).filter(([k]) => k === 'reflection').map(([k, v]) => [k, f(v)]));
const out = [];
for (const scene of scenes) {
  await P.load(scene);
  for (const [name, s] of configs) {
    for (const k of KEYS) delete P.ssr.settings[k];
    P.setSettings(s);
    await P.step(2);
    const sp = await P.metrics.speckle({ source: 'signal' });
    const en = await P.metrics.energy({});
    const rd = await P.metrics.restDrift({});
    const of = await P.metrics.orbitFlicker({});
    const row = { scene, name, speckle: R(sp, (v) => v.pct), energy: en ? R(en, (v) => [v.raw, v.denoised, v.loss]) : null,
      drift: R(rd, (v) => [v.mean, v.pctOver]), orbit: R(of, (v) => [v.std, v.d2]) };
    out.push(row); log(row);
  }
}
for (const k of KEYS) delete P.ssr.settings[k];
return { out, errors: P.gpuErrors.length };
