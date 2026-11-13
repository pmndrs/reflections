// W58: is the thin bright line in view=off three's clear coat layer (never subtracted, composite.ts header / D3512)?
// Main page index.html?manual&scene=carConcept&w=1280&h=1280&aa=off&rt=1&denoise=0, bench w50 camera.
// Shots of view off / ibl / final with the authored clear coat, then with every clear coat at 0.
P.stop();
await P.setSources({ rt: true, denoise: false });
const cam = P.kit.camera; cam.fov = 40; cam.updateProjectionMatrix();
P.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
const views = typeof VIEWS !== 'undefined' ? VIEWS : ['off', 'ibl', 'final'];
async function shots(tag) {
  for (const v of views) { P.setView(v); P.hybrid.resetHistory(); P.ssr.resetHistory(); await P.step(24); save(`${tag}-${v}.png`, await P.shot()); }
}
await shots('coat');
let n = 0;
P.kit.scene.traverse((o) => {
  for (const m of [].concat(o.material ?? [])) if (m.clearcoat > 0) { m.clearcoat = 0; m.needsUpdate = true; n++; }
});
await shots('nocoat');
return { coated: n, errors: P.gpuErrors.slice(0, 3) };
