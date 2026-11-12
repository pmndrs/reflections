// prelude: TAG, POS, TGT
P.stop();
await P.setSources({ rt: true });
P.setCamera(POS, TGT);
await P.step(120);
save(TAG + '.png', await P.shot());
return { cam: P.camera(), errors: P.gpuErrors.slice(0, 3) };
