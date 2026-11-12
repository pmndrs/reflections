// W53 stability (compare page): per set of params, `ours-rt` from reset, WARM frames, then
//  - `${TAG}-${name}-std.png`: per-pixel temporal std of 8-bit luma over N still frames, x 8 in the grey value;
//  - `${TAG}-${name}-orbit.png`: compare's orbit-flicker heat map at scale 32 (flicker = (R+G+B)/765 x 32).
// prelude: TAG, POS, TGT, SETS, WARM, N (optional METHOD)
P.freeze(true);
if (POS) P.setView(POS, TGT);
const method = typeof METHOD === 'undefined' ? 'ours-rt' : METHOD;
const decode = async (u) => { const i = new Image(); await new Promise(r => { i.onload = r; i.src = u; }); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return { w: i.width, h: i.height, d: g.getImageData(0, 0, i.width, i.height).data }; };
const png = async (w, h, f) => {
  const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const v = f(i); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  const b = await c.convertToBlob({ type: 'image/png' }); const fr = new FileReader();
  return new Promise(r => { fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
};
const touched = new Set();
const info = {};
for (const [name, params] of SETS) {
  for (const k of touched) P.setParam(k, null);
  for (const [k, v] of Object.entries(params)) { P.setParam(k, v); touched.add(k); }
  P.drop(method);
  await P.shotOf(method, WARM);
  let s1 = null, s2 = null, w = 0, h = 0;
  for (let k = 0; k < N; k++) {
    const { w: W, h: H, d } = await decode(await P.shotOf(method, 1));
    w = W; h = H; if (!s1) { s1 = new Float64Array(W * H); s2 = new Float64Array(W * H); }
    for (let i = 0; i < W * H; i++) { const l = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]; s1[i] += l; s2[i] += l * l; }
  }
  let all = 0;
  save(`${TAG}-${name}-std.png`, await png(w, h, (i) => { const m = s1[i] / N; const sd = Math.sqrt(Math.max(0, s2[i] / N - m * m)); all += sd; return Math.min(255, Math.round(sd * 8)); }));
  const fm = await P.flickerMap(method, 32, 0.05, 32);
  save(`${TAG}-${name}-orbit.png`, fm.url);
  info[name] = { stdMeanFrame: +(all / (w * h)).toFixed(3), orbitMeanFrame: +fm.mean.toFixed(3) };
}
info.errors = P.gpuErrors().slice(0, 3);
return info;
