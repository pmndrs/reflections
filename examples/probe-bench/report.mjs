#!/usr/bin/env node
// Markdown tables from the full probe bench's JSON (pnpm check -- --probe-bench writes
// out/probe-bench.json):   node examples/probe-bench/report.mjs [out/probe-bench.json]
import fs from 'node:fs';

const file = process.argv[2] ?? 'out/probe-bench.json';
const R = JSON.parse(fs.readFileSync(file, 'utf8'));
const f2 = (x) => (x === undefined || Number.isNaN(x) ? '–' : x.toFixed(2));
const f1 = (x) => (x === undefined || Number.isNaN(x) ? '–' : x.toFixed(1));
const kib = (b) => `${Math.round(b / 1024)}`;
const FMT = { rgba16float: 'rgba16f', rg11b10ufloat: 'rg11b10', rgb9e5ufloat: 'rgb9e5', 'bc6h-rgb-ufloat': 'bc6h', 'bc6h-fast': 'bc6h fast' };
const out = [];
const table = (head, rows) => {
  out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
};

out.push(`Device: ${JSON.stringify(R.device)}`, `Directions: ${R.nDirs}. Run time ${R.seconds?.toFixed(0)} s.`, '');
out.push('Parity (LayoutPrefilter vs ProbePrefilter, half values differing):', '');
table(['capture', 'layout', 'differing / total'], R.parity.map((p) => [p.source, p.layout, `${p.differing} / ${p.values}`]));
if (R.refCheck.length) {
  out.push('Reference self-check (the other estimator on the same lobe; /255 after tone map):', '');
  table(['capture', 'lod', 'r', 'used', 'vs', 'mean', 'p99', 'max'], R.refCheck.map((c) => [c.source, c.lod, c.roughness.toFixed(3), c.used, c.against, f2(c.mean), f2(c.p99), f1(c.max)]));
}

for (const source of [...new Set(R.error.map((e) => e.source))]) {
  const rows = R.error.filter((e) => e.source === source);
  const mips = rows.filter((e) => !e.between);
  const levels = [...new Set(mips.map((e) => e.lod))].sort((a, b) => a - b);
  const rough = Object.fromEntries(mips.map((e) => [e.lod, e.roughness]));
  const cfgs = [...new Set(rows.map((e) => `${e.layout}@${e.size}`))];
  out.push(`### Capture ${source} px: error per roughness mip, rgba16float`, '');
  out.push('Each cell: mean / p99 over all directions, then p99 on seam directions (cube face edge, or octa fold, within one texel of that mip). /255 after the fixed tone map.', '');
  table(['layout', 'KiB / probe', ...levels.map((l) => `lod ${l} r ${rough[l].toFixed(2)}`)], cfgs.map((c) => {
    const rs = mips.filter((e) => `${e.layout}@${e.size}` === c && e.format === 'rgba16float');
    if (!rs.length) return [c, '–', ...levels.map(() => '–')];
    return [c, kib(rs[0].bytes), ...levels.map((l) => { const e = rs.find((x) => x.lod === l); return `${f2(e.all.mean)} / ${f1(e.all.p99)} · seam ${f1(e.seam.p99)}`; })];
  }));
  out.push(`### Capture ${source} px: interior vs seam p99, rgba16float`, '');
  table(['layout', ...levels.map((l) => `lod ${l} interior / seam`)], cfgs.map((c) => {
    const rs = mips.filter((e) => `${e.layout}@${e.size}` === c && e.format === 'rgba16float');
    return [c, ...levels.map((l) => { const e = rs.find((x) => x.lod === l); return e ? `${f1(e.interior.p99)} / ${f1(e.seam.p99)} (n ${e.seam.n})` : '–'; })];
  }));
  const betw = rows.filter((e) => e.between || e.roughness < 0.2);
  if (betw.length) {
    const rs = [...new Set(betw.map((e) => e.roughness))].sort((a, b) => a - b);
    out.push(`### Capture ${source} px: r < 0.2 (lookups between mips 0 and 1 except at the mips), rgba16float`, '');
    table(['layout', ...rs.map((r) => `r ${r.toFixed(3)}`)], cfgs.map((c) => [c, ...rs.map((r) => {
      const e = betw.find((x) => `${x.layout}@${x.size}` === c && x.format === 'rgba16float' && x.roughness === r);
      return e ? `${f2(e.all.mean)} / ${f1(e.all.p99)}` : '–';
    })]));
  }
  out.push(`### Capture ${source} px: formats (mean / p99 per mip; bright = reference luminance > 2, p99)`, '');
  const fmtRows = [];
  for (const c of cfgs) {
    for (const fmt of Object.keys(FMT)) {
      const rs = mips.filter((e) => `${e.layout}@${e.size}` === c && e.format === fmt);
      if (!rs.length) continue;
      fmtRows.push([c, FMT[fmt], kib(rs[0].bytes), ...levels.map((l) => { const e = rs.find((x) => x.lod === l); return `${f2(e.all.mean)} / ${f1(e.all.p99)}${e.bright.n ? ` · br ${f1(e.bright.p99)}` : ''}`; })]);
    }
  }
  table(['layout', 'format', 'KiB', ...levels.map((l) => `lod ${l}`)], fmtRows);
}

out.push('### Bake (GPU ms per probe, min of 9 spans of 8 back-to-back bakes): prefilter pass; prefilter + format conversion', '');
const bakes = R.bake;
const bcfg = [...new Set(bakes.map((b) => `${b.source}|${b.layout}@${b.size}`))];
table(['capture', 'layout', 'prefilter', ...Object.values(FMT).map((f) => `+ ${f}`)], bcfg.map((k) => {
  const [source, c] = k.split('|');
  const rs = bakes.filter((b) => `${b.source}|${b.layout}@${b.size}` === k);
  return [source, c, f2(rs[0].prefilterMs) === '–' ? '–' : rs[0].prefilterMs.toFixed(3), ...Object.keys(FMT).map((f) => { const b = rs.find((x) => x.format === f); return b ? b.bakeMs.toFixed(3) : '–'; })];
}));

out.push('### Lookup (ms per 1920×1080 pass: wall clock over bursts of 32 passes, 4 for scattered, min of 9; in brackets the median ratio to cube-hw rgba16float over 9 back-to-back burst pairs)', '');
const L = R.lookup;
const lcfg = [...new Set(L.map((l) => `${l.source}|${l.layout}@${l.size}|${l.format}`))];
const cell = (l) => (l ? `${l.ms.toFixed(3)} (${l.ratio.toFixed(2)})` : '–');
table(['capture', 'layout', 'format', '1 probe', '3 probes', '16 probes', '16, scattered', '3, 8 lookups/px'], lcfg.map((k) => {
  const [source, c, fmt] = k.split('|');
  const rs = L.filter((l) => `${l.source}|${l.layout}@${l.size}|${l.format}` === k);
  return [source, c, FMT[fmt], ...[1, 3, 16].map((p) => cell(rs.find((x) => x.probes === p && (x.pattern ?? 'coherent') === 'coherent'))), cell(rs.find((x) => x.pattern === 'scattered')), cell(rs.find((x) => x.pattern === 'x8'))];
}));

console.log(out.join('\n'));
