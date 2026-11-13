// W80: examples/ssr thinPost, 960x540, denoiser off: final and misses views at maxCandidates 1 and 8.
P.stop && P.stop();
P.setPose('default');
for (const v of [1, 8]) {
  P.setSettings({ maxCandidates: v, frameIndex: 7 });
  for (const view of ['final', 'misses']) {
    P.setView(view);
    await P.step(6);
    save(`thinPost-${view}-mc${v}.png`, await P.shot());
  }
}
return {};
