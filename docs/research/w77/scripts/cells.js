// W77 matrix cells (bench keys). 'default' / 'performance' are the presets (core REFLECTION_PRESETS); hitSource null = the preset's.
// Two reference cells split the preset's two parts at ratio 1.
const CELLS = [
  ['full x1', { upscale: 'native', preset: 'default', hitSource: null }],
  ['half+hits x1', { upscale: 'native', preset: 'performance', hitSource: null }],
  ['full x1.5', { upscale: 'quality', preset: 'default', hitSource: null }],
  ['half+hits x1.5', { upscale: 'quality', preset: 'performance', hitSource: null }],
  ['full x2', { upscale: 'performance', preset: 'default', hitSource: null }],
  ['half+hits x2', { upscale: 'performance', preset: 'performance', hitSource: null }],
  ['ref: half (no hits) x1', { upscale: 'native', preset: 'performance', hitSource: '0' }],
  ['ref: full+hits x1', { upscale: 'native', preset: 'default', hitSource: 'hits' }],
];
const WARM = { upscale: 'balanced', preset: 'default', hitSource: null };
