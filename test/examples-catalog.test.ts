// W92 (E1): examples/catalog.ts is the one list of examples (docs/EXAMPLES.md). Every built entry has its page, slugs and paths
// are unique, and every brief answers the three questions; a feature, quality or performance page names its baseline.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, EXAMPLES, builtExamples, htmlPath, inputName } from '../examples/catalog';

const EXAMPLES_DIR = resolve(process.cwd(), 'examples'); // vitest runs from the repo root

describe('examples catalog', () => {
  it('slugs, paths and Vite input names are unique', () => {
    expect(new Set(EXAMPLES.map((e) => e.slug)).size).toBe(EXAMPLES.length);
    expect(new Set(EXAMPLES.map((e) => e.path)).size).toBe(EXAMPLES.length);
    expect(new Set(EXAMPLES.map(inputName)).size).toBe(EXAMPLES.length);
  });

  it('every category is known and used', () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    for (const e of EXAMPLES) expect(ids.has(e.category), `${e.slug}: ${e.category}`).toBe(true);
    for (const c of CATEGORIES) expect(EXAMPLES.some((e) => e.category === c.id), c.id).toBe(true);
  });

  it('a planned page follows the path convention: <category>/<slug without its category prefix>/', () => {
    for (const e of EXAMPLES.filter((x) => x.planned)) expect(e.path).toBe(`${e.category}/${e.slug.replace(new RegExp(`^${e.category}/`), '')}/`);
  });

  for (const e of EXAMPLES) {
    it(`${e.slug}: path, brief, source`, () => {
      expect(e.path, 'a folder with a trailing slash or an html file, no leading slash').toMatch(/^[a-z0-9][a-z0-9/._-]*(\/|\.html)$/);
      expect(e.summary.length).toBeGreaterThan(20);
      expect(e.brief.shows.length).toBeGreaterThan(20);
      expect(e.brief.tryThis.length).toBeGreaterThanOrEqual(1);
      expect(e.brief.tryThis.length).toBeLessThanOrEqual(3);
      if (['feature', 'quality', 'performance'].includes(e.brief.kind)) expect(e.brief.compare, `${e.slug}: a ${e.brief.kind} page needs a baseline`).toBeTruthy();
      if (e.planned) return;
      expect(existsSync(resolve(EXAMPLES_DIR, htmlPath(e))), `${htmlPath(e)} exists`).toBe(true);
      expect(existsSync(resolve(EXAMPLES_DIR, '..', e.source)), `${e.source} exists`).toBe(true);
    });
  }

  // engines/babylon gets the shell when it is rebuilt (E4); the lab and the pixi beta page keep their own UI
  it('built pages outside the lab mount the shell with their own slug', () => {
    const shelled = builtExamples().filter((e) => e.category !== 'lab' && !e.devOnly && e.slug !== 'engines/babylon');
    for (const e of shelled) {
      const src = resolve(EXAMPLES_DIR, '..', e.source);
      const files = src.endsWith('.ts') || src.endsWith('.tsx') ? [src] : [resolve(src, 'main.tsx'), resolve(src, 'main.ts')].filter(existsSync);
      const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
      expect(text, `${e.slug} calls mountShell('${e.slug}')`).toContain(`mountShell('${e.slug}'`);
    }
  });
});
