// W54: the bench's Measure (K-frame mean vs the path tracer, 8-bit display, MAD over RGB and luma) at W50's
// pose, 1280 x 1280, over W54's regions (hub, wheelFace, cabin, floorWheel) and the whole frame, one row per
// configuration. bench.html?manual&scene=carConcept&pose=w50&size=1280x1280&left=ours-rt&right=pathtraced
const CONFIGS = [
  ['default', {}, ['ours-rt', 'ours-denoised', 'probes', 'three-raw']],
  ['probes=0 (env only)', { probes: false }, ['probes']],
  ['specOcc=1', { specOcc: true }, ['ours-rt', 'probes']],
  ['denoise=0', { denoise: false }, ['ours-rt']],
  ['denoise=0 t.hitSpecular=0', { denoise: false, 't.hitSpecular': false }, ['ours-rt']],
  ['t.hitSpecular=0', { 't.hitSpecular': false }, ['ours-rt']],
  ['lobeFilter=0', { lobeFilter: 0 }, ['ours-rt']],
  ['hitSource=all hitDistW=4', { hitSource: 'all', hitDistW: 4 }, ['ours-rt']],
  ['hitSource=all hitDistW=4 lobeFilter=0', { hitSource: 'all', hitDistW: 4, lobeFilter: 0 }, ['ours-rt']],
  ['glass=black', { glass: 'black' }, ['ours-rt']],
  ['glass=hidden', { glass: 'hidden' }, ['ours-rt', 'probes']],
  ['glass=hidden probes=0', { glass: 'hidden', probes: false }, ['probes']],
];
const want = ['frame', 'hub', 'wheelFace', 'cabin', 'floorWheel'];
const out = [];
P.setPose('w50');
for (const [name, set, methods] of CONFIGS) {
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
