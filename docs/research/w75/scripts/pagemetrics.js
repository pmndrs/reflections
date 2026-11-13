// W75 phase 2: X0's page metrics (examples/shared/metrics) per reflection resolution, in one page (deterministic after a
// reset, W70), configs switched with __p.setResolution (rebuilds the composites).
// examples/ssr/?scene=<id>[&upscale=..][&aa=off][&rt=1] (no ?manual: today's defaults, upscaler AA + denoiser).
// prelude: SCENES, CONFIGS = [[name, mode, minRoughness?], ...], optional OPTS (metrics.all options), TAG
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.metrics); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
S.stop?.();
const opts = typeof OPTS !== 'undefined' ? OPTS : { speckle: false, energy: false };
const pick = (m) => {
  const r = (o, k) => o?.regions?.[k];
  return {
    drift: r(m.restDrift, 'reflection')?.mean, driftOver: r(m.restDrift, 'reflection')?.pctOver, restFlicker: m.restDrift?.rest?.reflection?.mean,
    orbitStd: r(m.orbitFlicker, 'reflection')?.std, orbitD2: r(m.orbitFlicker, 'reflection')?.d2,
    quad: m.quadEnergy?.display?.reflection?.ratio, quadSignal: m.quadEnergy?.signal?.reflection?.ratio,
    panD2Border: m.edgePan?.regions?.borderReflection?.d2, panD2Centre: m.edgePan?.regions?.centreReflection?.d2,
    speckle: r(m.speckle, 'reflection')?.pct, energyLoss: r(m.energy, 'reflection')?.loss,
  };
};
const out = [];
for (const id of SCENES) {
  await S.load(id);
  S.stop?.();
  for (const [name, mode, minR] of CONFIGS) {
    await S.setResolution(mode, minR ?? 0.01);
    const m = await S.metrics.all(opts);
    const row = { tag: typeof TAG !== 'undefined' ? TAG : '', scene: id, config: name, ...pick(m) };
    for (const k of Object.keys(row)) if (typeof row[k] === 'number') row[k] = +row[k].toFixed(4);
    log(row);
    out.push(row);
  }
}
await S.setResolution('full');
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors ?? []).slice(0, 3) };
