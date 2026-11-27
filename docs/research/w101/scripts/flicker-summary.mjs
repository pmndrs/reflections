// W101: occ 4 vs occ 0 from flicker-ab.sh's JSON files (flicker-occ<v>-<run>.json), reflection region per scene:
// each metric's values over the runs (run order 4 0 0 4 4 0).  node flicker-summary.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^flicker-occ\d+-\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/-(\d+)\.json/)[1]) - Number(b.match(/-(\d+)\.json/)[1]));
const by = {}; // scene -> occ -> metric -> values
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const r of j.results) {
    const R = r.regions?.reflection ?? r.regions?.glossy; if (!R) continue;
    const o = ((by[r.scene] ??= {})[r.config] ??= {});
    for (const k of ['drift', 'rest', 'orbitStd', 'd2', 'quad', 'speckle']) (o[k] ??= []).push(R[k]);
  }
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const show = (a) => `${a.map((v) => v.toFixed(4)).join(' / ')} (${mean(a).toFixed(4)})`;
for (const k of ['drift', 'rest', 'orbitStd', 'd2', 'speckle']) {
  console.log(`\n### ${k} (reflection region; runs, mean)\n\n| scene | occ4 | occ0 | change |\n|---|---|---|---|`);
  for (const [s, o] of Object.entries(by)) {
    if (!o.occ4 || !o.occ0) continue;
    const a = mean(o.occ4[k]), b = mean(o.occ0[k]);
    console.log(`| ${s} | ${show(o.occ4[k])} | ${show(o.occ0[k])} | ${a ? ((100 * (b - a)) / a).toFixed(1) + ' %' : '-'} |`);
  }
}
