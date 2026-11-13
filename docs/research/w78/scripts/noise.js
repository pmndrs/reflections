// W78 (W73's noise.js): denoised noise on glossy floors (examples/ssr `configStats`: 8-bit luma of the final image,
// static camera, loop stopped; per roughness bin: temporal std, flicker, bias vs one shared reference = the mean of
// REF_FRAMES raw frames at spq 4 copy). examples/ssr/?manual&denoise=1. `denoiserBrdf` is the page's example-only
// per-frame key (off | replace | combine). Prelude: optional CONFIGS, CASES, FRAMES, REF_FRAMES, DENOISE.
const COMP = { hitColorFilter: 'cone', mirrorBias: 0.5, mirrorBiasCompensate: true };
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['copy@1', { samplesPerQuad: 1 }],
  ['copy@1 brdf replace', { samplesPerQuad: 1, denoiserBrdf: 'replace' }],
  ['copy@1 brdf combine', { samplesPerQuad: 1, denoiserBrdf: 'combine' }],
  ['copy@4', { samplesPerQuad: 4 }],
  ['ratio@1 (W73)', { rayReuse: 'ratio', samplesPerQuad: 1 }],
  ['comp0.5 copy@1', { ...COMP }],
  ['comp0.5 brdf replace', { ...COMP, denoiserBrdf: 'replace' }],
  ['comp0.5 brdf combine', { ...COMP, denoiserBrdf: 'combine' }],
];
const cases = typeof CASES !== 'undefined' ? CASES : [0.2, 0.3, 0.4].map((r) => ({ scene: 'mirrorWall', pose: 'default', floor: r, bins: [r] }));
const all = [];
for (const c of cases) {
  await P.load(c.scene);
  P.setPose(c.pose);
  if (c.floor !== undefined) P.setFloorRoughness(c.floor);
  const r = await P.configStats({ configs: configs.map(([name, settings]) => ({ name, settings })), bins: c.bins, denoise: typeof DENOISE !== 'undefined' ? DENOISE : [true],
    frames: typeof FRAMES !== 'undefined' ? FRAMES : 48, refFrames: typeof REF_FRAMES !== 'undefined' ? REF_FRAMES : 128 });
  const row = { ...c, seconds: Math.round(r.seconds), binPx: r.binPx, results: r.results.map((x) => ({ name: x.name, denoise: x.denoise, bins: x.bins.map((b) => ({ r: b.roughness, std: +b.std.toFixed(3), flicker: +b.flicker.toFixed(3), bias: +b.bias.toFixed(3), signed: +b.signed.toFixed(3), mean: +b.mean.toFixed(2) })) })) };
  log(row); all.push(row);
}
return { all, errors: P.gpuErrors.slice(0, 3) };
