// W101: markdown tables from timing.sh's output (one JSON line per page).  node summarise.mjs <timing-1080p.jsonl>
import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const f = (v) => (v === undefined ? '-' : v.toFixed(3));
const rng = (a) => `${Math.min(...a).toFixed(2)}-${Math.max(...a).toFixed(2)}`;
console.log('| scene | rt | preset | intersect occ4 | intersect occ0 | (round medians 4 / 0) | core total 4 / 0 | rt trace 4 / 0 | denoise 4 / 0 | sum 4 / 0 | intersect delta | sum delta |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const a = r.ms.occ4, b = r.ms.occ0;
  const di = b.intersect - a.intersect, ds = b.sum - a.sum;
  console.log(`| ${r.tag} | ${r.rt ? 1 : 0} | ${r.preset}${r.res === 'half' ? ' (half)' : ''} | ${f(a.intersect)} | ${f(b.intersect)} | ${rng(r.rounds.occ4.intersect)} / ${rng(r.rounds.occ0.intersect)} | ${f(a['core total'])} / ${f(b['core total'])} | ${f(a['rt trace'])} / ${f(b['rt trace'])} | ${f(a['denoise total'])} / ${f(b['denoise total'])} | ${f(a.sum)} / ${f(b.sum)} | ${di >= 0 ? '+' : ''}${di.toFixed(3)} (${(100 * di / a.intersect).toFixed(1)} %) | ${ds >= 0 ? '+' : ''}${ds.toFixed(2)} |`);
}
