// W78 (maintainer: flicker first): X0's rest drift + orbit flicker on the bench's ours-denoised and ours-rt, cone +
// mirrorBiasCompensate 0.5 pinned, keepHistoryOnBlack and brdfWeights 'combine' (gate at FFX's default 0.1) on / off.
// bench.html?manual&scene=<id>&pose=<pose>&size=960x540&keepSample=1. Prelude: POSE, optional CONFIGS, METHODS, ROUNDS.
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p.metrics && window.__p.setSetting); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
const COMP = { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.5, 's.mirrorBiasCompensate': 1 };
const BASE = { ...COMP, brdf: null, keepBlack: null, brdfMin: null };
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['off', {}], ['keepBlack', { keepBlack: '1' }], ['combine', { brdf: 'combine' }], ['combine + keepBlack', { brdf: 'combine', keepBlack: '1' }],
];
const methods = typeof METHODS !== 'undefined' ? METHODS : ['ours-denoised', 'ours-rt'];
const rounds = typeof ROUNDS !== 'undefined' ? ROUNDS : 2;
const pose = typeof POSE !== 'undefined' ? POSE : null;
const out = [];
for (let k = 0; k < rounds; k++) for (const [name, set] of configs) {
  for (const [key, v] of Object.entries({ ...BASE, ...set })) S.setSetting(key, v);
  if (S.pending().methods.length) await S.rebuild();
  if (pose) S.setPose(pose);
  await S.step(2); await new Promise((r) => setTimeout(r, 1500)); // the cone pipelines compile (async)
  for (const method of methods) {
    const m = await S.metrics.all({ method, quadEnergy: false, edgePan: false, speckle: false, energy: false });
    const pick = (x, f) => x && Object.fromEntries(Object.entries(x.regions ?? {}).map(([rg, v]) => [rg, f(v)]));
    const row = { round: k, name, method, drift: pick(m.restDrift, (v) => [v.mean, v.pctOver]), orbit: pick(m.orbitFlicker, (v) => [v.std, v.d2]) };
    log(row); out.push(row);
  }
}
return { errors: S.gpuErrors().slice(0, 3) };
