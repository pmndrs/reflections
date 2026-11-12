// W52: the halo options on the other showcase scenes, compare page Measure (ours-rt vs the path
// tracer over the glossy mask). Run with docs/research/w50/scripts/drive.mjs on compare.html?manual.
// prelude: SCENES = [id, ...], SETS = [[name, {param: value}], ...], SAMPLES, WARM, FRAMES
P.freeze(true);
const out = {};
for (const scene of SCENES) {
  await P.load(scene);
  const pose = P.poses()[0];
  const rows = {};
  const touched = new Set();
  for (const [name, params] of SETS) {
    for (const k of touched) P.setParam(k, null);
    for (const [k, v] of Object.entries(params)) { P.setParam(k, v); touched.add(k); }
    P.drop('ours-rt');
    const m = await P.measure({ samples: SAMPLES, warmup: WARM, frames: FRAMES, methods: ['ours-rt'], orbitFrames: 0 });
    const r = m.rows[0];
    rows[name] = { mad: +r.mad.toFixed(3), psnr: +r.psnr.toFixed(2), bias: +r.bias.toFixed(3), std: +r.stdMean.toFixed(3) };
    log({ scene, pose, name, ...rows[name] });
  }
  for (const k of touched) P.setParam(k, null);
  out[scene] = { pose, rows };
}
out.errors = P.gpuErrors().slice(0, 3);
return out;
