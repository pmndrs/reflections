// W73: is ratio's mean shift the estimator or the composite? mirrorWall floor r 0.3, raw (examples/ssr ?manual&denoise=0),
// configStats vs spq 4 copy, with the composite's depth-aware blend (D2400, nonlinear in confidence) on and off, and the
// resolve's radius 4 / 1 / 0 (0 = the own quad only: the copy, resolved).
const out = [];
for (const da of [true, false]) {
  await P.load('mirrorWall'); P.setPose('default'); P.setFloorRoughness(0.3); P.setDepthAware(da);
  const r = await P.configStats({ configs: [['copy@1', { rayReuse: 'copy' }], ['ratio@1', { rayReuse: 'ratio' }], ['ratio r1', { rayReuse: 'ratio', rayReuseRadius: 1 }], ['ratio r0', { rayReuse: 'ratio', rayReuseRadius: 0 }]].map(([name, settings]) => ({ name, settings })), bins: [0.3], frames: 32, refFrames: 128, denoise: [false] });
  out.push({ depthAware: da, rows: r.results.map((x) => [x.name, +x.bins[0].std.toFixed(2), +x.bins[0].signed.toFixed(2), +x.bins[0].bias.toFixed(2)]) });
  log(out[out.length - 1]);
}
return out;
