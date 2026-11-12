// W52 (D3640): facingMirrors with hitShadeVisibility 'offscreen' (default) and 'all', on examples/ssr
// (?manual&rt=1&denoise=0&scene=facingMirrors). Run with docs/research/w50/scripts/drive.mjs.
// Per mode: the mirror seen in a mirror (stats().facing: black share and mean luminance of the left
// mirror's px that reflect the right one, final view), and D4301's miss-fill numbers (run-headless
// MISS_FILL: mean abs diff / 255 of the RT-off final vs the RT-on final over the SSR miss px, kit bake).
const p = P;
const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
const out = {};
for (const vis of ['offscreen', 'all']) {
  p.setTraceSettings({ hitShadeVisibility: vis });
  const r = { fill: {} };
  for (const pose of ['default', 'left']) {
    p.setPose(pose);
    p.setRT(false); p.setView('misses'); await p.step(3);
    const M = await px(await p.shot());
    p.setView('final'); p.setRT(true); await p.step(6);
    const Ru = await p.shot(); const R = await px(Ru);
    save(`facing-${vis}-${pose}-rt.png`, Ru);
    if (pose === 'left') r.facing = (await p.stats()).facing;
    p.setRT(false); await p.step(3);
    const F = await px(await p.shot());
    let n = 0, d = 0;
    for (let k = 0; k < M.length; k += 4) {
      if (!(M[k] > 200 && M[k + 1] < 80 && M[k + 2] < 80)) continue;
      n++; d += (Math.abs(F[k] - R[k]) + Math.abs(F[k + 1] - R[k + 1]) + Math.abs(F[k + 2] - R[k + 2])) / 3;
    }
    r.fill[pose] = { px: n, mad: +(n ? d / n : 0).toFixed(2) };
  }
  p.setPose('default'); p.setRT(true); p.setView('final'); await p.step(6);
  r.facingDefault = (await p.stats()).facing;
  out[vis] = r;
  log({ vis, ...r });
}
p.setTraceSettings({});
out.errors = p.gpuErrors?.slice?.(0, 3) ?? [];
return out;
