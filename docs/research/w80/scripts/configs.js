// W80: s.maxCandidates 1 / 2 / 4 / 8, each raw (denoiser off) and denoised. Prelude for measure.js (pass this file's text as the 4th arg).
const CONFIGS = [];
for (const v of [1, 2, 4, 8]) {
  CONFIGS.push([`mc ${v} | raw`, { 's.maxCandidates': v, denoise: false }, ['ours-rt']]);
  CONFIGS.push([`mc ${v} | denoised`, { 's.maxCandidates': v }, ['ours-rt']]);
}
