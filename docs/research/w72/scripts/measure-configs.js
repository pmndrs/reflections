// W72 prelude for measure.js (the bench's Measure vs PT): carConcept at W50's pose, 960x540.
const M3 = ['ours-raw', 'ours-denoised', 'ours-rt'];
const CONFIGS = [
  ['default', {}, M3],
  ['cone', { 's.hitColorFilter': 'cone' }, M3],
  ['cone x2', { 's.hitColorFilter': 'cone', 's.hitColorConeScale': 2 }, M3],
  ['comp 0.5', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.5, 's.mirrorBiasCompensate': true }, M3],
  ['comp 0.7', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.7, 's.mirrorBiasCompensate': true }, M3],
];
