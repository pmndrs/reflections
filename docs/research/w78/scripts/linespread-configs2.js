// W78 run 2 (after merging main 22adc27): line-spread configs, BRDF prefilter off / replace / combine x keepBlack (FFX's
// black early-out in the resolve skipped) at today's defaults, and off / replace x keepBlack with W76's proposed defaults
// pinned (cone + mirrorBiasCompensate at 0.5), AA on and off. A throwaway first config.
const COMP = { 's.hitColorFilter': 'cone', 's.mirrorBias': 0.5, 's.mirrorBiasCompensate': 1 };
const RUNS = [
  ['default', {}, ['off', 'replace', 'combine']],
  ['comp 0.5', COMP, ['off', 'replace']],
];
const CONFIGS = [['warm', {}]];
for (const aa of [null, 'off']) for (const [b, bs, modes] of RUNS) for (const m of modes) for (const kb of [false, true]) {
  CONFIGS.push([`${b} | ${m}${kb ? ' + keepBlack' : ''}${aa ? ' | aa off' : ''}`, { ...bs, ...(m !== 'off' ? { brdf: m } : {}), ...(kb ? { keepBlack: '1' } : {}), ...(aa ? { aa } : {}) }]);
}
const METHODS = ['ours-denoised'];
const ROUGH = [0.05, 0.15, 0.3];
const SAMPLES = 256;
