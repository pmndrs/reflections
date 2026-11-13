// W72 review re-run (after merging 8595b36 and fixes 1-3): default / cone / compensation f 0.3 and 0.5, AA on and off.
// A throwaway first config, as in linespread-configs.js.
const COMBOS = [
  ['default', {}],
  ['cone', { 's.hitColorFilter': 'cone' }],
  ['comp 0.3', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.3, 's.mirrorBiasCompensate': 1 }],
  ['comp 0.5', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.5, 's.mirrorBiasCompensate': 1 }],
];
const CONFIGS = [['warm', {}], ...COMBOS, ...COMBOS.map(([n, s]) => [`${n} | aa off`, { ...s, aa: 'off' }])];
