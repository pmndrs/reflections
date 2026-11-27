// W101: markdown table from image.sh's output.  node image-summary.mjs <image-rest.jsonl>
import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const j = (a, k) => a.map((x) => x[k]).join(' / ');
const d = (a) => a.map((x) => `${x.mean} / ${x.max} / ${x.over8pct}`).join('; ');
console.log('| scene | rest mean /255 occ4 | rest mean occ0 | % px > 1 occ4 | % px > 1 occ0 | rest max occ4 | rest max occ0 | image 4 vs 0: mean / max / % px > 8 | noise floor 4 vs 4 | noise floor 0 vs 0 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.tag} | ${j(r.rest.occ4, 'mean')} | ${j(r.rest.occ0, 'mean')} | ${j(r.rest.occ4, 'over1pct')} | ${j(r.rest.occ0, 'over1pct')} | ${j(r.rest.occ4, 'max')} | ${j(r.rest.occ0, 'max')} | ${d(r.cross)} | ${d(r.floor4)} | ${d(r.floor0)} |`);
}
