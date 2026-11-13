// W74: views per config on the showcase (index.html?manual&scene=carConcept&rt=1&aa=off&w=960&h=540&denoise=0), W58's w50 camera.
// prelude: CONFIGS = [[name, traceSettings], ...], optional VIEWS
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
S.stop();
await S.setSources({ rt: true, denoise: false });
const cam = S.kit.camera; cam.fov = 40; cam.updateProjectionMatrix();
S.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
const base = { ...S.ssr.traceSettings };
const views = typeof VIEWS !== 'undefined' ? VIEWS : ['final', 'rtSource', 'confidence'];
for (const [name, set] of CONFIGS) {
  S.ssr.traceSettings = { ...base, ...set };
  for (const v of views) { S.setView(v); S.hybrid.resetHistory(); S.ssr.resetHistory(); await S.step(12); save(`${name}-${v}.png`, await S.shot()); }
  log({ name, stats: await S.ssr.readTraceStats() });
}
return { errors: S.gpuErrors.slice(0, 3) };
