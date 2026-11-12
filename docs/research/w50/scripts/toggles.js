// prelude: TAG, POS, TGT, PT (bool), SETS = [[name, {param: value|null}], ...], METHOD (default 'ours-rt'), WARM, N
P.freeze(true);
if (POS) P.setView(POS, TGT);
const method = typeof METHOD === 'undefined' ? 'ours-rt' : METHOD;
const decode = async (u) => { const i = new Image(); await new Promise(r => { i.onload = r; i.src = u; }); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return { w: i.width, h: i.height, d: g.getImageData(0, 0, i.width, i.height).data }; };
const meanShot = async (id) => {
  const first = await P.shotOf(id, WARM);
  let acc = null, w = 0, h = 0;
  for (let k = 0; k < N; k++) {
    const { w: W, h: H, d } = await decode(await P.shotOf(id, 1));
    w = W; h = H; if (!acc) acc = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) acc[i] += d[i];
  }
  const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); const img = g.createImageData(w, h);
  for (let i = 0; i < acc.length; i++) img.data[i] = Math.round(acc[i] / N);
  g.putImageData(img, 0, 0);
  const b = await c.convertToBlob({ type: 'image/png' });
  const fr = new FileReader(); const mean = await new Promise(r => { fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  return { first, mean };
};
const info = {};
if (PT) { info.pt = (await P.converge(64)).status; save(`${TAG}-pathtraced.png`, await P.shotOf('pathtraced', 1)); }
const touched = new Set();
for (const [name, params] of SETS) {
  for (const k of touched) P.setParam(k, null);
  for (const [k, v] of Object.entries(params)) { P.setParam(k, v); touched.add(k); }
  P.drop(method);
  const t0 = performance.now();
  const { first, mean } = await meanShot(method);
  save(`${TAG}-${name}.png`, first); save(`${TAG}-${name}-mean.png`, mean);
  info[name] = ((performance.now() - t0) / 1000).toFixed(1) + ' s';
}
info.errors = P.gpuErrors().slice(0, 3);
return info;
