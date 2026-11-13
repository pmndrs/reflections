// Writes docs/DECISIONS.md from an export of the Reflections Decisions page's db
// (https://claude.ai/artifact/E8qHQUAKxkGbW6wQ2F2sCX): node scripts/decisions-doc.mjs <exportDir>
// where <exportDir>/decisions/*.json are the page's `decisions` documents.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/decisions-doc.mjs <exportDir>'); process.exit(1); }
const read = (sub) => fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.json'))
  .map((f) => { const j = JSON.parse(fs.readFileSync(path.join(dir, sub, f), 'utf8')); return { id: j.id ?? path.basename(f, '.json'), ...(j.data ?? j) }; });
const ds = read('decisions').sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
const one = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const label = (d, id) => d.options?.find((o) => o.id === id)?.label ?? id;
const out = [
  '# Decisions',
  '',
  'Every call the maintainer made on the Reflections Decisions page (https://claude.ai/artifact/E8qHQUAKxkGbW6wQ2F2sCX), newest first. The page is where open questions go; this file is its record in the repo. Regenerate it from an export of the page\'s db with `node scripts/decisions-doc.mjs <exportDir>`. The ranked to-do list that follows from these calls is [TRIAGE.md](TRIAGE.md).',
  '',
  '| # | Decision | Status | Answer | Source |',
  '|---|---|---|---|---|',
  ...ds.map((d) => `| ${d.order ?? ''} | [${one(d.title).replace(/\|/g, '\\|')}](#${d.id}) | ${d.status} | ${d.answer ? label(d, d.answer).replace(/\|/g, '\\|') : '-'} | ${one(d.source).replace(/\|/g, '\\|')} |`),
  '',
];
for (const d of ds) {
  out.push(`## ${one(d.title)}`, '', `<a id="${d.id}"></a>`, `**Status:** ${d.status}${d.answeredAt ? ` (answered ${String(d.answeredAt).slice(0, 10)})` : ''} · **Source:** ${one(d.source) || '-'} · **Recommended:** ${d.recommended ? label(d, d.recommended) : '-'} · **Answer:** ${d.answer ? label(d, d.answer) : '-'}`, '');
  if (d.context) out.push(one(d.context), '');
  if (d.options?.length) { out.push('Options:'); for (const o of d.options) out.push(`- **${one(o.label)}**${o.id === d.answer ? ' (chosen)' : ''}: ${one(o.detail)}`); out.push(''); }
  if (d.note) out.push(`Maintainer's note: ${one(d.note)}`, '');
  if (d.outcome) out.push(`Outcome: ${one(d.outcome)}`, '');
}
fs.writeFileSync('docs/DECISIONS.md', out.join('\n'));
console.log(`docs/DECISIONS.md: ${ds.length} decisions`);
