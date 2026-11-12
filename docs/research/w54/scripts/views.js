// W54: showcase main page (index.html?manual&scene=carConcept&w=1280&h=1280), W50's camera (the bench's
// pose w50), RT on; one shot per debug view. prelude (optional): VIEWS = [...], TAG = '...', SETUP = async () => {}
P.stop();
const views = typeof VIEWS !== 'undefined' ? VIEWS : ['final', 'off', 'ibl', 'reflections', 'source', 'rtSource', 'confidence', 'hitRadiance', 'specular', 'probeSpecular', 'traced'];
const tag = typeof TAG !== 'undefined' ? TAG : 'main';
await P.setSources({ rt: true });
P.kit.camera.fov = 40; P.kit.camera.updateProjectionMatrix();
P.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
if (typeof SETUP !== 'undefined') await SETUP();
for (const v of views) { P.setView(v); await P.step(48); save(`${tag}-${v}.png`, await P.shot()); }
return { info: await P.info(), errors: P.gpuErrors.slice(0, 3) };
