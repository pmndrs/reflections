// W72 phase 1 configurations (prelude for speckle.js / energy.js): the defaults, the cone at scale 1 and 2,
// D49's truncation at 0.5 for reference, and the compensated split at f 0.3 / 0.5 / 0.7.
const CONFIGS = [
  ['default', {}],
  ['cone', { hitColorFilter: 'cone' }],
  ['cone x2', { hitColorFilter: 'cone', hitColorConeScale: 2 }],
  ['bias 0.5 (trunc)', { mirrorBias: 0.5 }],
  ['comp 0.3', { hitColorFilter: 'cone', mirrorBias: 0.3, mirrorBiasCompensate: true }],
  ['comp 0.5', { hitColorFilter: 'cone', mirrorBias: 0.5, mirrorBiasCompensate: true }],
  ['comp 0.7', { hitColorFilter: 'cone', mirrorBias: 0.7, mirrorBiasCompensate: true }],
];
