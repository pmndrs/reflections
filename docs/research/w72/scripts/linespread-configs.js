// W72 phase 2 prelude for linespread.js: every combination, AA on (the bench default, upscaler) and off. The first
// config is a throwaway (the page's first Measure on the lineSpread scene has no PT at r 0.05).
const COMBOS = [
  ['default', {}],
  ['cone', { 's.hitColorFilter': 'cone' }],
  ['cone x2', { 's.hitColorFilter': 'cone', 's.hitColorConeScale': 2 }],
  ['comp 0', { 's.hitColorFilter': 'cone', 's.mirrorBiasCompensate': 1 }],
  ['comp 0.3', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.3, 's.mirrorBiasCompensate': 1 }],
  ['comp 0.5', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.5, 's.mirrorBiasCompensate': 1 }],
  ['comp 0.7', { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.7, 's.mirrorBiasCompensate': 1 }],
  ['trunc 0.5', { 's.mirrorBias': 0.5 }],
];
const CONFIGS = [['warm', {}], ...COMBOS, ...COMBOS.map(([n, s]) => [`${n} | aa off`, { ...s, aa: 'off' }])];
