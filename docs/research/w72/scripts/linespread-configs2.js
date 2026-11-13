// W72 phase 2, second batch (the first stalled after default / cone on a shared GPU): the f sweep and D49's truncation with AA on,
// then the main combinations with AA off. A throwaway first config, as in linespread-configs.js.
const ON = [
  ['comp 0.5', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.5, 's.mirrorBiasCompensate': 1 }],
  ['comp 0.7', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.7, 's.mirrorBiasCompensate': 1 }],
  ['trunc 0.5', { 's.mirrorBias': 0.5 }],
  ['comp 0.3', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.3, 's.mirrorBiasCompensate': 1 }],
  ['comp 0', { 's.hitColorFilter': 'cone', 's.mirrorBiasCompensate': 1 }],
  ['cone x2', { 's.hitColorFilter': 'cone', 's.hitColorConeScale': 2 }],
];
const OFF = [
  ['default', {}],
  ['cone', { 's.hitColorFilter': 'cone' }],
  ['comp 0.5', ON[0][1]],
  ['comp 0.7', ON[1][1]],
  ['trunc 0.5', ON[2][1]],
];
const CONFIGS = [['warm', {}], ...ON, ...OFF.map(([n, s]) => [`${n} | aa off`, { ...s, aa: 'off' }])];
