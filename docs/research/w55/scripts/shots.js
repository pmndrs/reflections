// W55: bench.html?manual&scene=carConcept&pose=w50&size=1280x1280&left=ours-rt&right=pathtraced
// Full-frame shots of ours-rt per carProbes configuration, and the path tracer.
// prelude (optional): CONFIGS = [[name, method, {key: value}], ...], STEPS, NO_PT, POSE
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['off', 'ours-rt', {}],
  ['both-128', 'ours-rt', { carProbes: 'both' }],
];
const steps = typeof STEPS !== 'undefined' ? STEPS : 48;
const pose = typeof POSE !== 'undefined' ? POSE : 'w50';
P.setMode('split');
P.setPose(pose);
for (const [name, method, set] of configs) {
  for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  await P.setSides(method, 'pathtraced');
  P.setPose(pose);
  P.reset();
  await P.step(steps);
  P.setSplit(1);
  save(`${name}.png`, await P.shot());
  const i = P.info().info[method];
  log({ name, carProbes: i.carProbes, atlases: i.atlases, bakeMs: i.bakeMs, errors: P.gpuErrors().slice(0, 2) });
  for (const k of Object.keys(set)) P.setSetting(k, null);
  if (P.pending().methods.length) await P.rebuild();
}
if (typeof NO_PT === 'undefined') { P.setSplit(0); await P.step(steps); save('pathtraced.png', await P.shot()); }
return { errors: P.gpuErrors().slice(0, 3) };
