// W56 (copy of W55): the bench's Measure (K-frame mean vs the path tracer, 8-bit display, MAD over RGB and luma) at W50's
// pose, one row per configuration, over the named regions at this aspect and the whole frame.
// bench.html?manual&scene=carConcept&pose=w50&size=1280x1280 (W54's 1:1 regions) or size=960x540 (W50's).
// prelude (optional): CONFIGS = [[name, {key: value}, [methods]], ...], WANT = [regions]
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [
  ['off', {}, ['ours-rt', 'probes']],
  ['wheels 128', { carProbes: 'wheels' }, ['ours-rt']],
  ['cabin 128', { carProbes: 'cabin' }, ['ours-rt']],
  ['both 128', { carProbes: 'both' }, ['ours-rt', 'probes']],
  ['both 64', { carProbes: 'both', carProbeRes: '64' }, ['ours-rt']],
  ['both 256', { carProbes: 'both', carProbeRes: '256' }, ['ours-rt']],
  ['off t.hitSpecular=0', { 't.hitSpecular': false }, ['ours-rt']],
  ['both t.hitSpecular=0', { carProbes: 'both', 't.hitSpecular': false }, ['ours-rt']],
  ['off glass=black', { glass: 'black' }, ['ours-rt']],
  ['both glass=black', { carProbes: 'both', glass: 'black' }, ['ours-rt']],
  ['off glass=hidden', { glass: 'hidden' }, ['ours-rt']],
  ['both glass=hidden', { carProbes: 'both', glass: 'hidden' }, ['ours-rt']],
];
const want = typeof WANT !== 'undefined' ? WANT : ['frame', 'glossy', 'hub', 'wheelFace', 'cabin', 'floorWheel', 'lip', 'band', 'wheel', 'door', 'car'];
const out = [];
P.setPose('w50');
for (const [name, set, methods] of configs) {
  for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  P.setPose('w50');
  const m = await P.measure({ samples: 16, warmup: 48, frames: 8, methods });
  const rows = Object.fromEntries(m.rows.filter((r) => want.includes(r.region)).map((r) => [r.region, { px: r.px, pt: +r.refLuma.toFixed(1), ...Object.fromEntries(Object.entries(r.methods).map(([id, v]) => [id, [+v.luma.toFixed(1), +v.mad.toFixed(1)]])) }]));
  out.push({ name, spp: m.referenceSamples, rows });
  log({ name, rows });
  for (const k of Object.keys(set)) P.setSetting(k, null);
  if (P.pending().methods.length) await P.rebuild();
}
return { out, errors: P.gpuErrors().slice(0, 3) };
