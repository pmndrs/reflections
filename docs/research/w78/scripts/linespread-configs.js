// W78: line-spread configs (prelude for linespread.js): BRDF prefilter off / replace / combine, at today's defaults and
// with W76's proposed defaults pinned (cone + mirrorBiasCompensate at mirrorBias 0.5), AA on and off. A throwaway first
// config (the PT reads peak 0 right after a scene load).
const COMP = { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.5, 's.mirrorBiasCompensate': 1 };
const BASES = [['default', {}], ['comp 0.5', COMP]];
const MODES = [['off', {}], ['replace', { brdf: 'replace' }], ['combine', { brdf: 'combine' }]];
const CONFIGS = [['warm', {}]];
for (const aa of [null, 'off']) for (const [b, bs] of BASES) for (const [m, ms] of MODES) {
  CONFIGS.push([`${b} | ${m}${aa ? ' | aa off' : ''}`, { ...bs, ...ms, ...(aa ? { aa } : {}) }]);
}
const METHODS = ['ours-denoised'];
const ROUGH = [0.05, 0.15, 0.3];
const SAMPLES = 256;
