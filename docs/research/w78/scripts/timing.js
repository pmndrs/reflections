// W78: GPU ms per tracer pass and per denoiser pass, BRDF prefilter off / replace / combine, interleaved A/B rounds in
// one page (loop stopped; median of N frames per pass per round, then the median over rounds). The tracer's passes from
// ssr.readTimings(), the denoiser's from FfxReflectionDenoiser.gpuTimings (its own timestamps, ?timing).
// examples/ssr/?manual&timing&w=1920&h=1080. Prelude: SCENES (with optional floor), CONFIGS, ROUNDS, N. Relative only.
const scenes = typeof SCENES !== 'undefined' ? SCENES : [['rooms'], ['mirrorWall', 0.3]];
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['off', { denoiserBrdf: 'off' }], ['replace', { denoiserBrdf: 'replace' }], ['combine', { denoiserBrdf: 'combine' }]];
const rounds = typeof ROUNDS !== 'undefined' ? ROUNDS : 3, n = typeof N !== 'undefined' ? N : 30;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const idle = () => new Promise((r) => setTimeout(r, 0));
const out = {};
for (const [scene, floor] of scenes) {
  await P.load(scene);
  if (floor !== undefined) P.setFloorRoughness(floor);
  const keep = { ...P.ssr.settings };
  const per = {};
  for (let k = 0; k < rounds; k++) for (const [name, set] of configs) {
    P.ssr.settings = { ...keep, ...set };
    await P.step(6); // the tracer rebuild on a flip, the denoiser's first timings
    const acc = {};
    for (let i = 0; i < n; i++) {
      await P.step(1);
      await idle();
      const t = await P.ssr.readTimings();
      for (const [p, v] of t) (acc['ssr ' + p] ??= []).push(v);
      const d = P.hybrid.denoiser?.gpuTimings;
      if (d) for (const [p, v] of d) (acc['dn ' + p] ??= []).push(v);
    }
    for (const [p, v] of Object.entries(acc)) ((per[name] ??= {})[p] ??= []).push(med(v));
  }
  P.ssr.settings = keep;
  out[scene] = Object.fromEntries(Object.entries(per).map(([name, p]) => [name, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +med(v).toFixed(4)]))]));
  log({ scene, ...out[scene] });
}
return { out, errors: P.gpuErrors.slice(0, 3) };
