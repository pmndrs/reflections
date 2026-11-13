// W80: examples/ssr page (index.html?manual&scene=X&w=960&h=540&aa=off&denoise=0 [&rt=1]); prelude: VALS = [1,2,4,8]
// For each maxCandidates: blendStats (W22 classes) + stats (wall / hitErr / streak / facing) + miss count; loop stopped.
P.stop && P.stop();
if (typeof POSE !== 'undefined') P.setPose(POSE);
const out = [];
for (const v of VALS) {
  P.setSettings({ maxCandidates: v, frameIndex: 7 }); // fixed noise frame: counts differ only by the candidates
  P.hybrid.resetHistory && P.hybrid.resetHistory();
  await P.step(6);
  const s = await P.stats();
  const b = await P.blendStats();
  out.push({ v, stats: s, blend: b, hash: await P.radianceHash(7) });
}
log(out);
return { errors: P.gpuErrors.slice(0, 3) };
