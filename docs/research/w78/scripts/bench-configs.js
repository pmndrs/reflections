// W78: prelude for bench-metrics.js (carConcept @ w50, 960x540; bench.html?manual&scene=carConcept&pose=w50&size=960x540&keepSample=1).
// Every config sets every key (bench-metrics.js keeps settings between configs).
const OFF = { brdf: null, keepBlack: null, 's.hitColorFilter': null, 's.mirrorBias': null, 's.mirrorBiasCompensate': null };
const COMP = { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.5, 's.mirrorBiasCompensate': 1 };
const CONFIGS = [
  ['off', { ...OFF }],
  ['replace', { ...OFF, brdf: 'replace' }],
  ['combine', { ...OFF, brdf: 'combine' }],
  ['replace + keepBlack', { ...OFF, brdf: 'replace', keepBlack: '1' }],
  ['keepBlack', { ...OFF, keepBlack: '1' }],
  ['comp0.5', { ...OFF, ...COMP }],
  ['comp0.5 replace', { ...OFF, ...COMP, brdf: 'replace' }],
];
const METHODS = ['ours-denoised', 'ours-rt'];
const OPTS = { restDrift: false, edgePan: false, speckle: false };
