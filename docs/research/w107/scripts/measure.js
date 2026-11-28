// W107 (copy of W56 / W55): the bench's Measure (K-frame mean vs the path tracer, 8-bit display, MAD over RGB and luma) at
// a pose, one row per configuration, over the named regions at this aspect and the whole frame.
// bench.html?manual&scene=carConcept&pose=w50&size=1280x1280 (W54's 1:1 regions) or size=960x540 (W50's).
// prelude (optional): CONFIGS = [[name, {key: value}, [methods]], ...], WANT = [regions], POSE = 'w50', SPP = 16
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['off', {}, ['ours-rt']],
  ['lobe 4', { 't.hitLobeOcclusionRays': 4 }, ['ours-rt']],
];
const want = typeof WANT !== 'undefined' ? WANT : null;
const pose = typeof POSE !== 'undefined' ? POSE : 'w50';
const spp = typeof SPP !== 'undefined' ? SPP : 16;
const out = [];
P.setPose(pose);
for (const [name, set, methods] of configs) {
  for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  P.setPose(pose);
  const m = await P.measure({ samples: spp, warmup: 48, frames: 8, methods });
  const rows = Object.fromEntries(m.rows.filter((r) => !want || want.includes(r.region)).map((r) => [r.region, { px: r.px, pt: +r.refLuma.toFixed(1), ...Object.fromEntries(Object.entries(r.methods).map(([id, v]) => [id, [+v.luma.toFixed(1), +v.mad.toFixed(1)]])) }]));
  out.push({ name, spp: m.referenceSamples, rows });
  log({ name, rows });
  for (const k of Object.keys(set)) P.setSetting(k, null);
  if (P.pending().methods.length) await P.rebuild();
}
return { out, errors: P.gpuErrors().slice(0, 3) };
