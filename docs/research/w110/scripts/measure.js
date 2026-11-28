// W110 (after W107's measure.js): the bench's Measure (8-frame mean vs the path tracer, 8-bit display) per configuration and
// pose; saves the PT reference and each configuration's mean as PNGs (for masks / crops offline: changed-mad.py, crops.py).
// Prelude: CONFIGS = [[name, {key: value}]], POSES = [pose | [name, [pos, target]]], SPP = 16, FRAMES = 8
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['off', { rtAlpha: false }], ['on', {}]];
const poses = typeof POSES !== 'undefined' ? POSES : ['low'];
const spp = typeof SPP !== 'undefined' ? SPP : 16;
const frames = typeof FRAMES !== 'undefined' ? FRAMES : 8;
const toPng = (rgb, w, h, ch) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { for (let k = 0; k < 3; k++) img.data[i * 4 + k] = rgb[i * ch + k]; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0); return c.toDataURL('image/png');
};
const out = [];
for (const entry of poses) {
  const pose = Array.isArray(entry) ? entry[0] : entry;
  let savedRef = false;
  for (const [name, set] of configs) {
    for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
    if (P.pending().methods.length) await P.rebuild();
    if (Array.isArray(entry)) { P.setPose('low'); P.setView(entry[1][0], entry[1][1]); } else P.setPose(pose);
    const m = await P.measure({ samples: spp, warmup: 48, frames, methods: ['ours-rt'] });
    const [w, h] = m.size;
    const imgs = P.metrics.lastImages;
    if (!savedRef) { save(`${pose}-pt.png`, toPng(imgs.ref, w, h, 4)); savedRef = true; }
    save(`${pose}-${name}.png`, toPng(imgs.means.get('ours-rt'), w, h, 3));
    const rows = Object.fromEntries(m.rows.map((r) => [r.region, [+r.refLuma.toFixed(1), +r.methods['ours-rt'].luma.toFixed(1), +r.methods['ours-rt'].mad.toFixed(2)]]));
    out.push({ pose, name, rows });
    log({ pose, name, rows });
    for (const k of Object.keys(set)) P.setSetting(k, null);
    if (P.pending().methods.length) await P.rebuild();
  }
}
return { errors: P.gpuErrors?.().slice(0, 3) };
