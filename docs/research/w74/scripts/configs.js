// W74: tracedMissRate full (twice: the noise floor between two Measures of one setting) vs half, raw and denoised.
// Prelude for measure.js (pass this file's text, plus optional ONLY / EXTRA, as the 4th arg).
const BASE = typeof ONLY !== 'undefined' ? ONLY : [
  ['full', {}], ['full (again)', {}], ['half', { 't.tracedMissRate': 'half' }],
  ...(typeof EXTRA !== 'undefined' ? EXTRA : []),
];
const CONFIGS = [];
for (const [n, s] of BASE) { CONFIGS.push([n + ' | raw', { ...s, denoise: false }, ['ours-rt']]); CONFIGS.push([n + ' | denoised', s, ['ours-rt']]); }
