// W78 run 6: prelude for bench-metrics.js: the near-mirror gate (brdfMin, perceptual; FFX brdfMinAlpha = its square).
const OFF = { brdf: null, keepBlack: null, brdfMin: null, 's.hitColorFilter': null, 's.mirrorBias': null, 's.mirrorBiasCompensate': null };
const CONFIGS = [
  ['off', { ...OFF }],
  ['replace + keepBlack', { ...OFF, brdf: 'replace', keepBlack: '1' }],
  ['replace + keepBlack, min 0.1', { ...OFF, brdf: 'replace', keepBlack: '1', brdfMin: 0.1 }],
  ['combine + keepBlack, min 0.1', { ...OFF, brdf: 'combine', keepBlack: '1', brdfMin: 0.1 }],
];
const METHODS = ['ours-denoised', 'ours-rt'];
const OPTS = { restDrift: false, edgePan: false, speckle: false };
