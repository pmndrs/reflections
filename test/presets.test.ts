// W77: core's named presets (plain data) and the bench's mapping of them onto its URL keys.
import { describe, expect, it } from 'vitest';
import { REFLECTION_PRESETS, REFLECTION_PRESET_NAMES, denoiserHitSourceOptions, reflectionsPreset } from '../packages/core/src/presets';
import { PRESET_DOCS, SETTINGS, presetUrlKeys } from '../examples/showcase/src/bench/schema';

describe('reflection presets', () => {
  it("'performance' is half-res + the denoiser's hit source 'hits'", () => {
    expect(reflectionsPreset('performance')).toEqual({ tracer: { reflectionResolution: 'half' }, denoiser: { hitSource: 'hits' } });
  });

  it('explicit settings win key by key; undefined overrides are ignored; the frozen table is not mutated', () => {
    const p = reflectionsPreset('performance', { tracer: { reflectionResolution: 'full', samplesPerQuad: 2, mirrorBias: undefined }, denoiser: { hitSource: undefined } });
    expect(p.tracer).toEqual({ reflectionResolution: 'full', samplesPerQuad: 2 });
    expect(p.denoiser).toEqual({ hitSource: 'hits' });
    p.tracer.reflectionResolution = 'half';
    expect(REFLECTION_PRESETS.performance.tracer.reflectionResolution).toBe('half');
    expect(REFLECTION_PRESETS.default.tracer.reflectionResolution).toBe('full');
  });

  it("'default' names every key another preset sets (so applying it undoes them)", () => {
    const def = REFLECTION_PRESETS.default;
    for (const n of REFLECTION_PRESET_NAMES) {
      for (const k of Object.keys(REFLECTION_PRESETS[n].tracer)) expect(k in def.tracer, `${n}.tracer.${k}`).toBe(true);
      for (const k of Object.keys(REFLECTION_PRESETS[n].denoiser)) expect(k in def.denoiser, `${n}.denoiser.${k}`).toBe(true);
    }
  });

  it('unknown names throw', () => {
    expect(() => reflectionsPreset('fast' as never)).toThrow(/unknown preset/);
  });

  it("FFX's options per hit-source mode", () => {
    expect(denoiserHitSourceOptions('off')).toEqual({ separateHitSources: false, missesMatchAnySource: false });
    expect(denoiserHitSourceOptions('hits')).toEqual({ separateHitSources: true, missesMatchAnySource: true });
    expect(denoiserHitSourceOptions('all')).toEqual({ separateHitSources: true, missesMatchAnySource: false });
  });

  it('docs/SETTINGS.md documents every preset once', () => {
    expect(PRESET_DOCS.map((d) => d.name).sort()).toEqual([...REFLECTION_PRESET_NAMES].sort());
  });

  it('the bench maps every preset onto URL keys its schema has, with values the controls offer', () => {
    expect(presetUrlKeys('performance')).toEqual({ 's.reflectionResolution': 'half', hitSource: 'hits' });
    expect(presetUrlKeys('default')).toEqual({ 's.reflectionResolution': 'full', hitSource: '0' });
    expect(presetUrlKeys(null)).toEqual({});
    const byId = new Map(SETTINGS.map((s) => [s.id, s]));
    expect(byId.get('preset')?.choices?.map(([v]) => v)).toEqual(REFLECTION_PRESET_NAMES);
    for (const n of REFLECTION_PRESET_NAMES) {
      for (const [k, v] of Object.entries(presetUrlKeys(n))) {
        const s = byId.get(k);
        expect(s, `${n}: ${k} not in the bench schema`).toBeDefined();
        if (s!.type === 'select') expect(s!.choices!.map(([c]) => c), `${n}: ${k}=${v}`).toContain(v);
      }
    }
  });
});
