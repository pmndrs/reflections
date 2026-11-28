// W110: Sponza poses, ours-rt with a texture option off then on vs the path tracer; saves the PT reference, both 8-frame means
// and |on - off| x 8, so the regions the option changes can be found. Run with drive.mjs on
// bench.html?manual&scene=sponza&size=960x540. Prelude (optional): POSES = [...], KEY = 'rtAlpha', SPP = 16, TAG = 'alpha';
// a pose is a preset name or [name, [pos, target]] (an explicit view: P.setView after setPose).
const poses = typeof POSES !== 'undefined' ? POSES : ['courtyard', 'low'];
const key = typeof KEY !== 'undefined' ? KEY : 'rtAlpha';
const spp = typeof SPP !== 'undefined' ? SPP : 16;
const tag = typeof TAG !== 'undefined' ? TAG : 'alpha';

const toPng = (rgb, w, h, ch) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { for (let k = 0; k < 3; k++) img.data[i * 4 + k] = rgb[i * ch + k]; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0); return c.toDataURL('image/png');
};
const out = [];
for (const entry of poses) {
  const pose = Array.isArray(entry) ? entry[0] : entry;
  const means = {};
  let ref = null, w = 0, h = 0;
  for (const v of [false, null]) {
    P.setSetting(key, v);
    if (P.pending().methods.length) await P.rebuild();
    if (Array.isArray(entry)) { P.setPose('low'); P.setView(entry[1][0], entry[1][1]); } else P.setPose(pose);
    const m = await P.measure({ samples: spp, warmup: 48, frames: 8, methods: ['ours-rt'] });
    w = m.size[0]; h = m.size[1];
    const imgs = P.metrics.lastImages;
    ref = imgs.ref; means[v === false ? 'off' : 'on'] = imgs.means.get('ours-rt');
    const rows = Object.fromEntries(m.rows.map((r) => [r.region, [+r.refLuma.toFixed(1), +r.methods['ours-rt'].luma.toFixed(1), +r.methods['ours-rt'].mad.toFixed(2)]]));
    out.push({ pose, [key]: v === false ? 'off' : 'default', rows });
    log({ pose, [key]: v === false ? 'off' : 'default', rows });
  }
  save(`${tag}-${pose}-pt.png`, toPng(ref, w, h, 4));
  save(`${tag}-${pose}-off.png`, toPng(means.off, w, h, 3));
  save(`${tag}-${pose}-on.png`, toPng(means.on, w, h, 3));
  const d = new Float32Array(w * h * 3);
  let changed = 0;
  for (let i = 0; i < w * h; i++) {
    let m = 0;
    for (let k = 0; k < 3; k++) { const x = Math.abs(means.on[i * 3 + k] - means.off[i * 3 + k]); d[i * 3 + k] = Math.min(255, x * 8); m = Math.max(m, x); }
    if (m > 2) changed++;
  }
  save(`${tag}-${pose}-diff.png`, toPng(d, w, h, 3));
  log({ pose, changedPx: changed });
}
P.setSetting(key, null);
return { out, errors: P.gpuErrors?.().slice(0, 3) };
