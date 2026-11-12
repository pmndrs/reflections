// prelude: TAG, POS, TGT, CONFIGS = [[name, {lobe, denoise, reshade}], ...], VIEW
P.stop();
await P.setSources({ rt: true });
P.setCamera(POS, TGT);
P.setView(typeof VIEW === 'undefined' ? 'final' : VIEW);
for (const [name, c] of CONFIGS) {
  if (c.lobe !== undefined) P.ssr.settings.hitLobeFilter = c.lobe;
  if (c.reshade !== undefined) P.setReshade(c.reshade);
  if (c.denoise !== undefined) await P.setSources({ denoise: c.denoise });
  P.hybrid.resetHistory(); P.ssr.resetHistory();
  await P.step(60);
  save(`${TAG}-${name}.png`, await P.shot());
}
return { lobe: P.ssr.settings.hitLobeFilter, errors: P.gpuErrors.slice(0, 3) };
