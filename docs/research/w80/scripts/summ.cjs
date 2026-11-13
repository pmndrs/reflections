// node summ.js <file>... : one line per maxCandidates from a drive.mjs log of ssr.js
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const t = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith('[{'));
  if (!t) { console.log(f, 'no data'); continue; }
  console.log(f);
  for (const r of JSON.parse(t)) {
    const st = r.stats, b = r.blend, w = st.wall;
    console.log(r.v, 'rays', st.rays, 'miss', st.misses, 'conf', st.meanConfidence.toFixed(4), 'floorConf', st.mirrorFloorConfidence.toFixed(4),
      w ? `| wall ${w.pixels}px conf ${w.confidentFraction.toFixed(4)} corr ${w.lumCorrelation.toFixed(4)} relErr ${w.meanAbsRelative.toFixed(4)} hitErr ${w.hitDistanceMedianRelErr.toExponential(1)} behind ${w.behindPixels} streak ${w.streakFraction.toFixed(4)}` : '',
      '| blend', ['sphere', 'object', 'behind', 'wall'].map((k) => b[k] ? `${k} ${b[k].px}px c${b[k].confident.toFixed(3)} z${b[k].zero.toFixed(3)} w${b[k].meanWeight.toFixed(3)}` : '').join(' '),
      `sphereProbe ${b.sphereProbe?.toFixed(4)} objectProbe ${b.objectProbe?.toFixed(4)} behindSSR ${b.behindSSR?.toFixed(4)}`,
      'hash', r.hash, st.facing ? '| facing ' + JSON.stringify(st.facing) : '', st.objects ? '| obj ' + ['sphere', 'cube'].map((k) => `${k} conf ${(st.objects[k].confident ?? NaN).toFixed(3)} stripe ${(st.objects[k].stripeRatio ?? NaN).toFixed(2)}`).join(' ') : '');
  }
}
