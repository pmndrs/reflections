// W105 (copy of W56's flicker.js): frame-to-frame flicker per config. bench.html?manual&scene=carConcept&pose=w50&size=1280x1280&left=ours-rt&right=pathtraced
// Per configuration: 48 warm-up frames, then FRAMES consecutive frames (one step each, the AA jitter moving),
// optionally orbiting the camera by ORBIT rad per frame about the target, saved as <name>-f<i>.png.
// prelude (optional): CONFIGS = [[name, method, {key: value}], ...], FRAMES, ORBIT
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['three', 'ours-rt', {}], ['off', 'ours-rt', { geometryRoughness: 'off' }]];
const frames = typeof FRAMES !== 'undefined' ? FRAMES : 8;
const orbit = typeof ORBIT !== 'undefined' ? ORBIT : 0;
P.setMode('split');
P.setPose('w50');
const [pos0, tgt] = P.view();
const at = (a) => { const dx = pos0[0] - tgt[0], dz = pos0[2] - tgt[2]; const c = Math.cos(a), s = Math.sin(a); return [tgt[0] + dx * c - dz * s, pos0[1], tgt[2] + dx * s + dz * c]; };
for (const [name, method, set] of configs) {
  for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  await P.setSides(method, 'pathtraced');
  P.setPose('w50');
  P.reset();
  if (orbit) { P.camera.position.set(...at(-orbit * 48)); P.controls.update(); }
  for (let i = -48; i < 0; i++) { if (orbit) { P.camera.position.set(...at(orbit * i)); P.controls.update(); } await P.step(1); }
  P.setSplit(1);
  for (let i = 0; i < frames; i++) {
    if (orbit) { P.camera.position.set(...at(orbit * i)); P.controls.update(); }
    await P.step(1);
    save(`${name}-f${i}.png`, await P.shot());
  }
  if (orbit) P.setView(pos0, tgt);
  for (const k of Object.keys(set)) P.setSetting(k, null);
  if (P.pending().methods.length) await P.rebuild();
}
return { errors: P.gpuErrors().slice(0, 3) };
