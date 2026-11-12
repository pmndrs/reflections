// W53 cost (showcase, ?aa=off, loop stopped): FFX denoiser per-pass GPU ms (its timestamps), median
// of N frames, per W53 setting. prelude: N, SETS = [[name, settings for P.setHitSource]]
P.stop();
await P.setSources({ rt: true });
P.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
const out = {};
for (const [name, s] of SETS) {
  P.setHitSource({ hitSource: false, missesMatchAnySource: false, hitDistanceWeight: 0, ...s });
  await P.step(20);
  const per = {};
  for (let i = 0; i < N; i++) {
    await P.step(1);
    await new Promise((r) => setTimeout(r, 30)); // timestamp readback
    for (const [k, v] of P.hybrid.denoiser.gpuTimings ?? []) (per[k] ??= []).push(v);
  }
  out[name] = Object.fromEntries(Object.entries(per).map(([k, v]) => { v.sort((a, b) => a - b); return [k, +v[v.length >> 1].toFixed(3)]; }));
}
out.errors = P.gpuErrors.slice(0, 3);
return out;
