// W54: bench.html?manual&scene=carConcept&pose=w50&size=1280x1280&left=ours-rt&right=pathtraced
// Full-frame shots of each configuration (A alone, split 1) and of the path tracer (split 0).
// prelude (optional): CONFIGS = [[name, method, {key: value}], ...], STEPS, PT_EACH
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['ours-rt', 'ours-rt', {}],
  ['ours-rt-specOcc', 'ours-rt', { specOcc: true }],
  ['ours-rt-noProbes', 'ours-rt', { probes: false }],
  ['ours-denoised', 'ours-denoised', {}],
  ['probes-only', 'probes', {}],
  ['env-only', 'probes', { probes: false }],
  ['three-raw', 'three-raw', {}],
];
const steps = typeof STEPS !== 'undefined' ? STEPS : 48;
P.setMode('split');
P.setPose('w50');
await P.step(steps);
for (const [name, method, set] of configs) {
  for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  await P.setSides(method, 'pathtraced');
  P.setPose('w50');
  P.reset();
  await P.step(steps);
  P.setSplit(1);
  save(`${name}.png`, await P.shot());
  // PT_EACH: the path tracer under this config too (settings that apply to it, e.g. glass)
  if (typeof PT_EACH !== 'undefined' && PT_EACH) { P.setSplit(0); save(`${name}-pt.png`, await P.shot()); }
  log({ name, info: P.info().info[method], errors: P.gpuErrors().slice(0, 2) });
  for (const k of Object.keys(set)) P.setSetting(k, null);
  if (P.pending().methods.length) await P.rebuild();
}
P.setSplit(0);
await P.step(steps);
save('pathtraced.png', await P.shot());
return { errors: P.gpuErrors().slice(0, 3) };
