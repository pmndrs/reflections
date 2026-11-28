// W110: what the bench's ours-rt provider holds per configuration (texture count and bytes, alpha runs / flagged triangles)
const configs = typeof CONFIGS !== 'undefined' ? CONFIGS : [['W97 (base colour)', { rtAlpha: false, rtRoughMetal: false }], ['defaults', {}], ['+ emissive', { rtEmissiveMap: true }]];
const out = [];
for (const [name, set] of configs) {
  for (const [k, v] of Object.entries(set)) P.setSetting(k, v);
  if (P.pending().methods.length) await P.rebuild();
  await P.step(2);
  out.push({ name, provider: P.info().info['ours-rt']?.provider });
  for (const k of Object.keys(set)) P.setSetting(k, null);
  if (P.pending().methods.length) await P.rebuild();
}
return out;
