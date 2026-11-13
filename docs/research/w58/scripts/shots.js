// W58 (from W56's shots.js): bench.html?manual&scene=carConcept&pose=w50&size=960x540&aa=off&left=ours-rt&right=pathtraced
// Full-frame shots of ours-rt per configuration (each config may set `view`), and the path tracer.
// prelude: CONFIGS = [[name, method, {key: value}], ...], STEPS, PT_STEPS, NO_PT, POSE
const steps = typeof STEPS !== 'undefined' ? STEPS : 48;
const pose = typeof POSE !== 'undefined' ? POSE : 'w50';
P.setMode('split');
P.setPose(pose);
for (const [name, method, set] of CONFIGS) {
  for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  await P.setSides(method, 'pathtraced');
  P.setPose(pose);
  P.reset();
  await P.step(steps);
  P.setSplit(1);
  save(`${name}.png`, await P.shot());
  log({ name, errors: P.gpuErrors().slice(0, 2) });
  for (const k of Object.keys(set)) P.setSetting(k, null);
  if (P.pending().methods.length) await P.rebuild();
}
if (typeof NO_PT === 'undefined') { P.setSplit(0); await P.step(typeof PT_STEPS !== 'undefined' ? PT_STEPS : 64); save('pathtraced.png', await P.shot()); }
return { errors: P.gpuErrors().slice(0, 3) };
