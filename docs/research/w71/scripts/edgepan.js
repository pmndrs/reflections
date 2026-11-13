// W71 (X1 #4): a scripted yaw pan on examples/ssr with historyEdgeConfidence off / on: traced-ray
// counts per frame (RT on) and a stand-in for X0's edge-pan metric: mean |frame k - frame k-1| (8-bit
// RGB) in the outer 10 % of the screen vs the inner part. Page:
// /ssr/?manual&scene=<s>&rt=1&denoise=1&aa=off&hit=final&reshade=off
// prelude: TAG, RATE (rad / frame), FRAMES, DIR (+1 / -1)
P.stop();
const THREE = P.THREE, cam = P.kit.camera, c = P.controls;
const pose = { pos: cam.position.clone(), target: c.target.clone() };
const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
const px = async (u) => { const i = await load(u); const cv = new OffscreenCanvas(i.width, i.height); const g = cv.getContext('2d'); g.drawImage(i, 0, 0); return { d: g.getImageData(0, 0, i.width, i.height).data, w: i.width, h: i.height }; };
const res = {};
for (const on of [false, true]) {
  P.setSettings({ historyEdgeConfidence: on });
  cam.position.copy(pose.pos); c.target.copy(pose.target); c.update();
  P.ssr.resetHistory(); P.hybrid.resetHistory(); P.aa?.reset?.();
  await P.step(16);
  let prev = null; const edge = [], inner = [], misses = [], traced = [];
  for (let k = 0; k < FRAMES; k++) {
    const d = pose.target.clone().sub(pose.pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), DIR * RATE * (k + 1));
    c.target.copy(pose.pos).add(d); c.update();
    const img = await px(await P.shot());
    const st = await P.traceStats();
    if (st) { misses.push(st.misses); traced.push(st.traced); }
    if (prev) {
      let se = 0, ne = 0, si = 0, ni = 0; const bx = Math.round(img.w * 0.1), by = Math.round(img.h * 0.1);
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        const i = (y * img.w + x) * 4, v = (Math.abs(img.d[i] - prev[i]) + Math.abs(img.d[i + 1] - prev[i + 1]) + Math.abs(img.d[i + 2] - prev[i + 2])) / 3;
        if (x < bx || x >= img.w - bx || y < by || y >= img.h - by) { se += v; ne++; } else { si += v; ni++; }
      }
      edge.push(se / ne); inner.push(si / ni);
    }
    prev = img.d;
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  res[on ? 'on' : 'off'] = { edge: +mean(edge).toFixed(3), inner: +mean(inner).toFixed(3), misses: Math.round(mean(misses)), traced: Math.round(mean(traced)) };
  if (on) save(`${TAG}-on-last.png`, await P.shot()); else save(`${TAG}-off-last.png`, await P.shot());
}
P.setSettings({ historyEdgeConfidence: false });
log({ tag: TAG, rate: RATE, frames: FRAMES, ...res });
return { errors: P.gpuErrors?.slice?.(0, 3) ?? [] };
