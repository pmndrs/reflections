// W58: the candidates, each raw (denoiser off) and denoised. Prelude for measure.js (pass this file's text as the 4th arg).
const BASE = typeof ONLY !== 'undefined' ? ONLY : [
  ['default', {}], ['quadCopy sameSurface', { 's.quadCopy': 'sameSurface' }], ['spq 2', { spq: '2' }], ['spq 4', { spq: '4' }],
  ['geometryRoughness off', { geometryRoughness: 'off' }], ['sameSurface + geo off', { 's.quadCopy': 'sameSurface', geometryRoughness: 'off' }],
  ['missConf 0.5', { 's.missConfidenceThreshold': 0.5 }], ['missConf 1', { 's.missConfidenceThreshold': 1 }], ['depthAware 0', { 'h.depthAware': 0 }],
  ['reshade off', { reshade: 'off' }], ['lobeFilter 0', { lobeFilter: 0 }], ['reuseOnScreen off', { 't.reuseOnScreenHits': false }],
];
const CONFIGS = [];
for (const [n, s] of BASE) { CONFIGS.push([n + ' | raw', { ...s, denoise: false }, ['ours-rt']]); CONFIGS.push([n + ' | denoised', s, ['ours-rt']]); }
