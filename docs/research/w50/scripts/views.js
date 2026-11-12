// prelude: TAG, POS, TGT, VIEWS, RESHADE list
P.stop();
await P.setSources({ rt: true });
P.setCamera(POS, TGT);
for (const r of RESHADE) {
  P.setReshade(r);
  for (const v of VIEWS) { P.setView(v); await P.step(60); save(`${TAG}-${r}-${v}.png`, await P.shot()); }
}
return { errors: P.gpuErrors.slice(0, 3) };
