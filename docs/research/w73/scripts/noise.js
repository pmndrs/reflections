// W73: noise on glossy floors (examples/ssr `configStats`: 8-bit luma of the final image, static camera, loop
// stopped; per roughness bin: temporal std, flicker, bias vs one shared reference = the mean of REF_FRAMES raw
// frames at spq 4 copy). examples/ssr/?manual&denoise=1. Prelude: CASES, CONFIGS (optional), FRAMES, REF_FRAMES.
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['copy@1', { rayReuse: 'copy', samplesPerQuad: 1 }],
  ['copy@4', { rayReuse: 'copy', samplesPerQuad: 4 }],
  ['ratio@1', { rayReuse: 'ratio', samplesPerQuad: 1 }],
  ['ratio@1 taps4', { rayReuse: 'ratio', samplesPerQuad: 1, rayReuseTaps: 4 }],
  ['sameSurface@1', { rayReuse: 'copy', samplesPerQuad: 1, quadCopy: 'sameSurface' }],
  ['ratio@1 + sameSurface', { rayReuse: 'ratio', samplesPerQuad: 1, quadCopy: 'sameSurface' }],
];
const cases = typeof CASES !== 'undefined' ? CASES : [
  { scene: 'roughnessRamp', pose: 'strips', bins: [0.1, 0.2, 0.3, 0.4] },
  ...[0.2, 0.3, 0.4].map((r) => ({ scene: 'mirrorWall', pose: 'default', floor: r, bins: [r] })),
];
const all = [];
for (const c of cases) {
  await P.load(c.scene);
  P.setPose(c.pose);
  if (c.floor !== undefined) P.setFloorRoughness(c.floor);
  const r = await P.configStats({ configs: configs.map(([name, settings]) => ({ name, settings })), bins: c.bins,
    frames: typeof FRAMES !== 'undefined' ? FRAMES : 64, refFrames: typeof REF_FRAMES !== 'undefined' ? REF_FRAMES : 256 });
  const row = { ...c, seconds: Math.round(r.seconds), binPx: r.binPx, results: r.results.map((x) => ({ name: x.name, denoise: x.denoise, bins: x.bins.map((b) => ({ r: b.roughness, std: +b.std.toFixed(2), flicker: +b.flicker.toFixed(2), bias: +b.bias.toFixed(2), signed: +b.signed.toFixed(2), rmse: +b.rmse.toFixed(2), mean: +b.mean.toFixed(1) })) })) };
  log(row); all.push(row);
}
return all;
