// W110 debug: what the bench's ours-rt built (provider info) with a setting off and back on
const key = typeof KEY !== 'undefined' ? KEY : 'rtAlpha';
const out = [];
for (const v of [false, null]) {
  P.setSetting(key, v);
  const pend = P.pending();
  if (pend.methods.length) await P.rebuild();
  P.setPose('low');
  P.setSides?.(['ours-rt', 'ours-rt']);
  await P.step(4);
  const info = P.info().info['ours-rt'];
  out.push({ v, pend, provider: info?.provider });
}
return out;
