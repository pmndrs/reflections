// W72 default-identical (examples/ssr): per scene, the tracer's radiance hash at frameIndex 7 and an
// FNV hash of the final image after 6 frames. Run on main and on the branch, compare the JSON.
// node drive.mjs 'http://127.0.0.1:5444/ssr/?manual&rt=1&denoise=0&aa=off' <out> parity.js ['const EXTRA = {...};']
const hashU8 = (b) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
const extra = typeof EXTRA === 'undefined' ? {} : EXTRA;
const out = {};
for (const id of P.scenes()) {
  await P.load(id);
  P.setSettings({ frameIndex: 7, minTraversalOccupancy: 0, ...extra }); // occupancy 0: the march's subgroup exit depends on ray-list order (atomics), so frames differ in ~0.15 % px otherwise
  await P.step(6);
  const img = await px(await P.shot());
  out[id] = { radiance: await P.radianceHash(7), shot: hashU8(img) };
}
log(out);
