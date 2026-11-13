// W77: core's named presets (plain data) and the bench's mapping of them onto its URL keys.
import { describe, expect, it } from 'vitest';
import { REFLECTION_PRESETS, REFLECTION_PRESET_KEYS, REFLECTION_PRESET_NAMES, denoiserHitSourceModeOf, denoiserHitSourceOptions, isReflectionsPresetName, reflectionsPreset } from '../packages/core/src/presets';
import { PRESET_DOCS, SETTINGS, presetUrlKeys } from '../examples/showcase/src/bench/schema';

describe('reflection presets', () => {
  it("'performance' is half-res only (the maintainer dropped the hit source: flicker first)", () => {
    expect(reflectionsPreset('performance')).toEqual({ tracer: { reflectionResolution: 'half' }, denoiser: {} });
  });

  it('explicit settings win key by key; undefined overrides are ignored; the frozen table is not mutated', () => {
    const p = reflectionsPreset('performance', { tracer: { reflectionResolution: 'full', samplesPerQuad: 2, mirrorBias: undefined }, denoiser: { hitSource: 'all' } });
    expect(p.tracer).toEqual({ reflectionResolution: 'full', samplesPerQuad: 2 });
    expect(p.denoiser).toEqual({ hitSource: 'all' }); // an override can still add one
    p.tracer.reflectionResolution = 'half';
    expect(REFLECTION_PRESETS.performance.tracer.reflectionResolution).toBe('half');
    expect(REFLECTION_PRESETS.default).toEqual({ tracer: {}, denoiser: {} });
  });

  it("'default' is empty (the package defaults stay the only source of truth); the key list covers every preset", () => {
    expect(reflectionsPreset('default')).toEqual({ tracer: {}, denoiser: {} });
    for (const n of REFLECTION_PRESET_NAMES) {
      for (const k of Object.keys(REFLECTION_PRESETS[n].tracer)) expect(REFLECTION_PRESET_KEYS.tracer, `${n}.tracer.${k}`).toContain(k);
      for (const k of Object.keys(REFLECTION_PRESETS[n].denoiser)) expect(REFLECTION_PRESET_KEYS.denoiser, `${n}.denoiser.${k}`).toContain(k);
    }
    expect(REFLECTION_PRESET_KEYS).toEqual({ tracer: ['reflectionResolution'], denoiser: [] });
  });

  it('unknown names throw; isReflectionsPresetName guards them', () => {
    expect(() => reflectionsPreset('fast' as never)).toThrow(/unknown preset/);
    expect(isReflectionsPresetName('performance')).toBe(true);
    for (const bad of ['fast', 'toString', '', null, 3]) expect(isReflectionsPresetName(bad), String(bad)).toBe(false);
  });

  it("FFX's options per hit-source mode", () => {
    expect(denoiserHitSourceOptions('off')).toEqual({ separateHitSources: false, missesMatchAnySource: false });
    expect(denoiserHitSourceOptions('hits')).toEqual({ separateHitSources: true, missesMatchAnySource: true });
    expect(denoiserHitSourceOptions('all')).toEqual({ separateHitSources: true, missesMatchAnySource: false });
    for (const m of ['off', 'hits', 'all'] as const) expect(denoiserHitSourceModeOf(denoiserHitSourceOptions(m))).toBe(m);
    expect(denoiserHitSourceModeOf(null)).toBe('off');
  });

  it('docs/SETTINGS.md documents every preset once', () => {
    expect(PRESET_DOCS.map((d) => d.name).sort()).toEqual([...REFLECTION_PRESET_NAMES].sort());
  });

  it('the bench maps every preset onto URL keys its schema has, with values the controls offer', () => {
    expect(presetUrlKeys('performance')).toEqual({ 's.reflectionResolution': 'half' });
    expect(presetUrlKeys('default')).toEqual({});
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
