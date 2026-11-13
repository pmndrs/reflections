// W72 smoke: each SETS entry on a scene; saves the final image and counts px that changed vs the default.
// node drive.mjs 'http://127.0.0.1:5444/ssr/?manual&rt=1&denoise=0&aa=off&hit=current' <out> cone-smoke.js ['const SCENE = "roughnessRamp";']
const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
const scene = typeof SCENE === 'undefined' ? 'mirrorWall' : SCENE;
const SETS = typeof VARIANTS === 'undefined' ? [
  ['default', {}],
  ['cone', { hitColorFilter: 'cone' }],
  ['cone-off-shading', { hitColorFilter: 'cone', hitShading: 'off' }],
  ['comp05', { hitColorFilter: 'cone', mirrorBias: 0.5, mirrorBiasCompensate: true }],
  ['default-again', {}],
] : VARIANTS;
await P.load(scene);
const lum = (a, k) => 0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2];
const res = {};
let ref = null;
for (const [name, s] of SETS) {
  for (const k of ['hitColorFilter', 'mirrorBias', 'mirrorBiasCompensate', 'hitShading', 'hitColorConeScale']) delete P.ssr.settings[k];
  P.setSettings({ frameIndex: 7, minTraversalOccupancy: 0, ...s });
  await P.step(6);
  const url = await P.shot();
  save(`${scene}-${name}.png`, url);
  const img = await px(url);
  if (!ref) ref = img;
  let changed = 0; for (let k = 0; k < img.length; k += 4) if (Math.abs(lum(img, k) - lum(ref, k)) > 2) changed++;
  res[name] = { changed: changed / (img.length / 4), errors: P.gpuErrors.length };
}
log(res);
