// W78 (maintainer: flicker first): X0's rest drift + orbit flicker on examples/ssr (page defaults: upscaler AA, FFX
// denoiser), cone + mirrorBiasCompensate 0.5 pinned, keepHistoryOnBlack and brdfWeights 'combine' (gate at FFX's
// default 0.1) on / off, reflection region. examples/ssr/?manual&keepSample=1. Prelude: optional SCENES, CONFIGS, ROUNDS.
const COMP = { hitColorFilter: 'cone', mirrorBias: 0.5, mirrorBiasCompensate: true };
const BASE = { ...COMP, denoiserBrdf: 'off', denoiserKeepBlack: false };
const scenes = typeof SCENES !== 'undefined' ? SCENES : ['mirrorWall', 'contact', 'facingMirrors'];
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['off', {}], ['keepBlack', { denoiserKeepBlack: true }], ['combine', { denoiserBrdf: 'combine' }], ['combine + keepBlack', { denoiserBrdf: 'combine', denoiserKeepBlack: true }],
];
const rounds = typeof ROUNDS !== 'undefined' ? ROUNDS : 2;
const out = [];
for (const scene of scenes) {
  await P.load(scene);
  P.setSettings({ ...BASE }); await P.step(30); // builds the cone pipelines
  for (let k = 0; k < rounds; k++) for (const [name, set] of configs) {
    P.setSettings({ ...BASE, ...set });
    const m = await P.metrics.all({ quadEnergy: false, edgePan: false, speckle: false, energy: false });
    const r = (x) => x?.regions?.reflection;
    const row = { scene, round: k, name,
      drift: r(m.restDrift) && [r(m.restDrift).mean, r(m.restDrift).pctOver, r(m.restDrift).p99], rest: m.restDrift?.rest?.reflection && [m.restDrift.rest.reflection.mean, m.restDrift.rest.reflection.pctOver1],
      orbit: r(m.orbitFlicker) && [r(m.orbitFlicker).std, r(m.orbitFlicker).d2, r(m.orbitFlicker).pctD2Over] };
    log(row); out.push(row);
  }
}
P.setSettings({ denoiserBrdf: 'off', denoiserKeepBlack: false });
return { errors: P.gpuErrors.slice(0, 3) };
