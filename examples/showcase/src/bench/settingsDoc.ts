// docs/SETTINGS.md, rendered from the bench's schema (W51). `pnpm settings:doc` writes it;
// test/settings-doc.test.ts fails when the checked-in file and the schema differ.
import { ALL, GROUPS, NOT_EXPOSED, OURS, OURS_DN, OURS_SSR, PRESET_DOCS, RASTER, SETTINGS, THREE, type Setting, type Value } from './schema';

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
  // W77: the named presets (core REFLECTION_PRESETS) before the knobs they set
  out.push('## Presets');
  out.push('');
  out.push('Named bundles of the settings below, in core (`REFLECTION_PRESETS`, `reflectionsPreset(name, overrides)`): an adapter applies the tracer part to its pass and the denoiser part to its hybrid resolve, and settings you pass explicitly win key by key. three: `new ScreenSpaceReflectionsPass(renderer, { preset, settings })` and `new HybridReflections(ssr, { preset, denoiser })` at construction, `applyReflectionsPreset({ ssr, hybrid }, name, overrides)` at runtime (rebuild your composites when it returns `resolutionChanged`). Bench: `preset` (the first control). Measurements: docs/research/w77/.');
  out.push('');
  out.push('| Preset | Sets | GPU cost | Trade-offs | Don\'t use it when | With the upscaler |');
  out.push('|---|---|---|---|---|---|');
  for (const p of PRESET_DOCS) out.push(`| \`${p.name}\` | ${cell(p.sets)} | ${cell(p.cost)} | ${cell(p.tradeoffs)} | ${cell(p.avoid)} | ${cell(p.upscaler)} |`);
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
  out.push('## Not exposed');
  out.push('');
  out.push('| Option | Why |');
  out.push('|---|---|');
  for (const n of NOT_EXPOSED) out.push(`| \`${n.name}\` | ${cell(n.why)} |`);
  out.push('');
  return out.join('\n');
}
