// W78 run 6: line spread with the near-mirror gate (brdfMin 0.1 perceptual), AA on and off.
const CONFIGS = [['warm', {}]];
for (const aa of [null, 'off']) for (const m of ['replace', 'combine']) CONFIGS.push([`${m} + keepBlack, min 0.1${aa ? ' | aa off' : ''}`, { brdf: m, keepBlack: '1', brdfMin: 0.1, ...(aa ? { aa } : {}) }]);
const METHODS = ['ours-denoised'];
const ROUGH = [0.05, 0.15, 0.3];
const SAMPLES = 256;
