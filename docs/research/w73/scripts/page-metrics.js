// W73 phase 2: X0's page metrics (examples/shared/metrics, W70) per scene x config on examples/ssr (page defaults:
// upscaler AA, FFX denoiser; add ?aa=off etc. in the URL). Prelude: SCENES, CONFIGS = [[name, ssrSettings]], OPTS (all() options).
const scenes = typeof SCENES !== 'undefined' ? SCENES : ['mirrorWall', 'contact', 'facingMirrors', 'offscreen', 'rooms'];
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['copy@1', {}], ['ratio@1', { rayReuse: 'ratio' }], ['copy@4', { samplesPerQuad: 4 }]];
const opts = typeof OPTS !== 'undefined' ? OPTS : { edgePan: false };
const out = [];
for (const scene of scenes) {
  await P.load(scene);
  for (const [name, set] of configs) {
    P.setSettings(set);
    const t0 = performance.now();
    const m = await P.metrics.all(opts);
    for (const k of Object.keys(set)) delete P.ssr.settings[k];
    const r = (x) => x?.regions?.reflection;
    const row = {
      scene, name, s: Math.round((performance.now() - t0) / 1000),
      drift: r(m.restDrift) && [r(m.restDrift).mean, r(m.restDrift).pctOver], rest: m.restDrift?.rest?.reflection?.mean,
      orbit: r(m.orbitFlicker) && [r(m.orbitFlicker).std, r(m.orbitFlicker).d2],
      quad: [m.quadEnergy?.display?.reflection?.ratio, m.quadEnergy?.signal?.reflection?.ratio],
      speckle: r(m.speckle)?.pct,
      energy: r(m.energy) && [r(m.energy).raw, r(m.energy).denoised, r(m.energy).loss],
    };
    log(row); out.push({ ...row, full: m });
  }
}
return out.map(({ full, ...x }) => x);
