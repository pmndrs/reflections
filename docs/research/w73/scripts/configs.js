// W73: prelude for measure.js (pass this file's text as the 4th arg): each config raw (denoiser off) and denoised,
// on ours (SSR) and ours + RT, at W50's pose. bench.html?manual&scene=carConcept&pose=w50&size=960x540
const BASE = typeof ONLY !== 'undefined' ? ONLY : [
  ['copy@1', {}],
  ['ratio@1', { 's.rayReuse': 'ratio' }],
  ['copy@4', { spq: '4' }],
  ['sameSurface@1', { 's.quadCopy': 'sameSurface' }],
  ['ratio@1 + sameSurface', { 's.rayReuse': 'ratio', 's.quadCopy': 'sameSurface' }],
  ['ratio@1 taps 4', { 's.rayReuse': 'ratio', 's.rayReuseTaps': '4' }],
];
const METHODS = typeof ONLY_METHODS !== 'undefined' ? ONLY_METHODS : ['ours-denoised', 'ours-rt'];
const CONFIGS = [];
for (const [n, s] of BASE) { CONFIGS.push([n + ' | raw', { ...s, denoise: false }, METHODS]); CONFIGS.push([n + ' | denoised', s, METHODS]); }
