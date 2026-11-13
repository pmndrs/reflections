// docs/SETTINGS.md, rendered from the bench's schema (W51). `pnpm settings:doc` writes it;
// test/settings-doc.test.ts fails when the checked-in file and the schema differ.
import { ALL, GROUPS, NOT_EXPOSED, OURS, OURS_DN, OURS_SSR, RASTER, RT_BEHAVIOUR, SETTINGS, THREE, type Setting, type Value } from './schema';

const SETS: [readonly string[], string][] = [[ALL, 'every method'], [RASTER, 'ours + three SSR'], [OURS, 'ours (incl. probes only)'], [OURS_SSR, 'ours'], [OURS_DN, 'ours denoised, ours + RT'], [THREE, 'three SSR']];
/** A method list in words where it is one of the schema's sets. */
export const appliesText = (a: Setting['appliesTo']) => a === 'page' ? 'page' : SETS.find(([s]) => s.length === a.length && s.every((x) => a.includes(x as never)))?.[1] ?? a.join(', ');

const fmt = (v: Value | null | undefined) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'number' ? String(+v.toFixed(4)) : `\`${v}\``);
const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function defaults(s: Setting) {
  const parts: string[] = [];
  if (s.default !== null) parts.push(fmt(s.default));
  if (s.pageDefault !== undefined && s.pageDefault !== s.default) parts.push(`examples: ${fmt(s.pageDefault)}`);
  if (s.defaultNote) parts.push(s.defaultNote);
  if (s.rtDefault !== undefined && !(s.defaultNote ?? '').includes('RT')) parts.push(`with RT: ${fmt(s.rtDefault)}`);
  return parts.join('; ') || 'none';
}
function range(s: Setting) {
  if (s.type === 'bool') return 'on / off';
  if (s.type === 'select') return (s.choices ?? []).map(([v]) => `\`${v}\``).join(', ');
  return `${s.min} .. ${s.max}`;
}

export function renderSettingsMarkdown(): string {
  const out: string[] = [];
  out.push('# Settings guide');
  out.push('');
  out.push('<!-- Generated from examples/showcase/src/bench/schema.ts by `pnpm settings:doc`; edit the schema, not this file (test/settings-doc.test.ts checks they match). -->');
  out.push('');
  out.push('Every tuning knob the package and the examples expose, with its default, what it trades and, where one was measured, its GPU cost. The same list drives the tuning bench, `examples/showcase/bench.html`: each row is a control there and a URL key (`bench.html?<key>=<value>`, booleans as 1 / 0), so a link reproduces a view.');
  out.push('');
  out.push('- **Default:** the package\'s default (what you get without passing the option). "examples:" is what the showcase and the bench use where that differs.');
  out.push('- **Apply:** *live* changes without a reload; *rebuild* is taken at construction (on the bench: the Rebuild button).');
  out.push('- **Cost:** measured GPU time with its source (docs/HANDOFF.md, docs/DIVERGES.md). Blank: not measured on its own. Small costs add up; a later "fast" preset will need them.');
  out.push('- **Applies to:** the bench\'s methods (ours raw / denoised / + RT, probes only, three SSR raw / + denoise / + FFX, path traced).');
  out.push('');
  for (const g of GROUPS) {
    const rows = SETTINGS.filter((s) => s.group === g.id);
    if (!rows.length) continue;
    out.push(`## ${g.title}`);
    out.push('');
    out.push(g.blurb);
    out.push('');
    out.push('| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    for (const s of rows) {
      const label = s.planned ? `${s.label} (**planned**)` : s.label;
      const trade = s.planned ? `${s.planned} ${s.tradeoff}` : s.tradeoff;
      const applies = appliesText(s.appliesTo);
      out.push(`| ${cell(label)} | \`${s.id}\` | ${cell(s.api ?? '')} | ${cell(defaults(s))} | ${cell(range(s))} | ${s.apply} | ${cell(trade)} | ${cell(s.cost ?? '')} | ${applies} |`);
    }
    out.push('');
  }
  // W76: every default that differs with ray tracing on, so users know RT changes settings
  out.push('## What changes when ray tracing is on');
  out.push('');
  out.push('Turning the ray-traced fallback on (`ScreenSpaceReflectionsPass({ trace })`, `setTraceProvider()`, `rayTracing`; in core, `missesTraced: true` on the tracer\'s dispatch) changes these defaults. **An explicit value always wins**: set the field to keep the RT-off value. The bench shows the effective value of an unset field.');
  out.push('');
  out.push('| Setting | URL key | Default | With RT | Why |');
  out.push('|---|---|---|---|---|');
  for (const s of SETTINGS.filter((x) => x.rtDefault !== undefined)) out.push(`| ${cell(s.label)} | \`${s.id}\` | ${fmt(s.default)} | ${fmt(s.rtDefault)} | ${cell(s.rtWhy ?? '')} |`);
  out.push('');
  out.push('Behaviour of the RT path that differs from RT off (no setting to miss, listed for completeness):');
  out.push('');
  out.push('| What | Why |');
  out.push('|---|---|');
  for (const b of RT_BEHAVIOUR) out.push(`| ${cell(b.what)} | ${cell(b.why)} |`);
  out.push('');
  out.push('## Not exposed');
  out.push('');
  out.push('| Option | Why |');
  out.push('|---|---|');
  for (const n of NOT_EXPOSED) out.push(`| \`${n.name}\` | ${cell(n.why)} |`);
  out.push('');
  return out.join('\n');
}
