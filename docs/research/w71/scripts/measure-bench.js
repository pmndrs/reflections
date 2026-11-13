// W71: the bench's Measure vs the path tracer for a list of setting configs, one pose.
// Page: /showcase/bench.html?manual&scene=<s>&left=ours-denoised&right=pathtraced&aa=off[&pose=...]
// prelude: TAG, POSE (or null), CONFIGS = [{ name, set: { <bench key>: value | null } }], METHODS, SPP, WARMUP, FRAMES
if (POSE) P.setPose(POSE);
await P.step(2);
const out = [];
let prev = {};
for (const c of CONFIGS) {
  for (const k of Object.keys(prev)) if (!(k in c.set)) P.setSetting(k, null);
  for (const [k, v] of Object.entries(c.set)) P.setSetting(k, v);
  prev = c.set;
  await P.step(2);
  const m = await P.measure({ samples: SPP, warmup: WARMUP, frames: FRAMES, methods: METHODS });
  const rows = Object.fromEntries(m.rows.map((r) => [r.region, { px: r.px, pt: +r.refLuma.toFixed(2), ...Object.fromEntries(Object.entries(r.methods).map(([id, v]) => [id, { mad: +v.mad.toFixed(2), luma: +v.luma.toFixed(2), frameMad: +v.frameMad.toFixed(2) }])) }]));
  log({ tag: TAG, config: c.name, spp: m.referenceSamples, rows });
  out.push({ config: c.name, set: c.set, spp: m.referenceSamples, rows });
}
for (const k of Object.keys(prev)) P.setSetting(k, null);
return { tag: TAG, n: out.length, errors: P.gpuErrors().slice(0, 3) };
