// W51: docs/SETTINGS.md is generated from the tuning bench's schema (examples/showcase/src/bench/schema.ts).
// This fails when they drift apart; `pnpm settings:doc` (UPDATE_SETTINGS_DOC=1) rewrites the doc.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSettingsMarkdown } from '../examples/showcase/src/bench/settingsDoc';
import { GROUPS, SETTINGS } from '../examples/showcase/src/bench/schema';

const DOC = resolve(process.cwd(), 'docs/SETTINGS.md'); // vitest runs from the repo root

describe('settings guide', () => {
  it('docs/SETTINGS.md matches the bench schema', () => {
    const md = renderSettingsMarkdown();
    if (process.env.UPDATE_SETTINGS_DOC === '1') writeFileSync(DOC, md);
    expect(readFileSync(DOC, 'utf8')).toBe(md);
  });

  it('every schema entry is well formed (one per key, a known group, a default or a note, a range or choices)', () => {
    const ids = new Set<string>();
    const groups = new Set(GROUPS.map((g) => g.id));
    for (const s of SETTINGS) {
      expect(ids.has(s.id), `duplicate key ${s.id}`).toBe(false);
      ids.add(s.id);
      expect(groups.has(s.group), `${s.id}: group ${s.group}`).toBe(true);
      expect(s.tradeoff.length, `${s.id}: trade-off`).toBeGreaterThan(10);
      expect(s.default !== null || s.pageDefault !== undefined || !!s.defaultNote, `${s.id}: no default`).toBe(true);
      if (s.type === 'number') expect(s.min! < s.max! && s.step! > 0, `${s.id}: range`).toBe(true);
      if (s.type === 'select') expect((s.choices ?? []).length, `${s.id}: choices`).toBeGreaterThan(1);
    }
  });
});
