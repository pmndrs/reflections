// Named settings bundles (W77, the maintainer's decision 4 of the SSR-sources results). Plain data, no
// engine: an adapter applies a preset's tracer part to its pass settings and its denoiser part to its
// hybrid resolve, and anything the app sets explicitly wins over the preset.
//
//   const p = reflectionsPreset('performance', { tracer: { samplesPerQuad: 2 } });
//   // p.tracer: { reflectionResolution: 'half', samplesPerQuad: 2 }, p.denoiser: {}
//
// The three adapter takes `preset` in `ScreenSpaceReflectionsPass` / `HybridReflections` options and
// `applyReflectionsPreset()` at runtime. docs/SETTINGS.md ("Presets") gives each preset's cost and
// trade-offs; docs/research/w77/ has the measurements behind 'performance'.
import type { ScreenSpaceReflectionsSettings } from './sssr/sssr';

/**
 * Where the tracer, the ray-traced pass and the denoiser run (W75, X5, D5080): the G-buffer's size, or
 * half of it in each axis (a frame point-sampled at one pixel per 2x2 quad, upsampled after the denoise).
 */
export type ReflectionResolution = 'full' | 'half';

/**
 * What the hybrid hands its denoiser as a per-pixel hit source (W53, D3660), and how the denoiser
 * uses it: 'off' (none), 'hits' (screen-space and traced hits kept apart, a miss blends with either),
 * 'all' (hits and misses kept apart). FFX's options: {@link denoiserHitSourceOptions}.
 */
export type DenoiserHitSourceMode = 'off' | 'hits' | 'all';

/** The tracer part of a preset: core tracer settings plus the adapter-level resolution. */
export type ReflectionsPresetTracer = Partial<ScreenSpaceReflectionsSettings> & { reflectionResolution?: ReflectionResolution };
/** The denoiser part of a preset. */
export interface ReflectionsPresetDenoiser { hitSource?: DenoiserHitSourceMode }

export interface ReflectionsPreset {
  /** Tracer settings (an adapter's pass settings). */
  tracer: ReflectionsPresetTracer;
  /** The hybrid resolve's denoiser input. */
  denoiser: ReflectionsPresetDenoiser;
}

export type ReflectionsPresetName = 'default' | 'performance';

/**
 * The named presets. 'default' is empty: it sets nothing, so applying it leaves every key a preset names
 * to the app's own settings and then to the package defaults (`?? default` in core and the adapters,
 * the only source of truth for them). 'performance' (W77):
 * - `reflectionResolution: 'half'`: trace (SSR and RT) and denoise at half size, joint bilateral
 *   upsample. 1080p: -1.6 to -3.4 ms of the frame (W75), the most of any setting.
 * - No denoiser hit source (maintainer, 2026-11-13). `hitSource: 'hits'` brought carConcept's sill band
 *   back from 58 to 39 MAD at half res, but made the band's orbit flicker x2.5 (W77), and flicker ranks
 *   first. It stays its own switch (`HybridReflections.setDenoiserHitSource`); to put it back in the
 *   preset, add `denoiser: Object.freeze({ hitSource: 'hits' as const })` to 'performance'.
 */
export const REFLECTION_PRESETS: Readonly<Record<ReflectionsPresetName, Readonly<ReflectionsPreset>>> = Object.freeze({
  default: Object.freeze({ tracer: Object.freeze({}), denoiser: Object.freeze({}) }),
  performance: Object.freeze({
    tracer: Object.freeze({ reflectionResolution: 'half' as const }),
    denoiser: Object.freeze({}),
  }),
});

export const REFLECTION_PRESET_NAMES = Object.keys(REFLECTION_PRESETS) as ReflectionsPresetName[];

/** Whether `name` is a known preset name (adapters warn once and fall back to no preset otherwise). */
export function isReflectionsPresetName(name: unknown): name is ReflectionsPresetName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(REFLECTION_PRESETS, name);
}

/**
 * Every key any preset names, per part. Before applying a preset at runtime an adapter clears these
 * (back to the app's own values, then the package defaults), so a preset never leaves keys behind.
 */
export const REFLECTION_PRESET_KEYS: Readonly<{ tracer: readonly string[]; denoiser: readonly string[] }> = Object.freeze({
  tracer: Object.freeze([...new Set(REFLECTION_PRESET_NAMES.flatMap((n) => Object.keys(REFLECTION_PRESETS[n].tracer)))]),
  denoiser: Object.freeze([...new Set(REFLECTION_PRESET_NAMES.flatMap((n) => Object.keys(REFLECTION_PRESETS[n].denoiser)))]),
});

/** Drop the keys whose value is undefined (an explicit `undefined` does not erase a preset's value). */
const defined = <T extends object>(o: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * A preset by name with `overrides` on top (explicit settings win, key by key; `undefined` values are
 * ignored). Returns fresh objects. Throws on an unknown name.
 */
export function reflectionsPreset(name: ReflectionsPresetName, overrides: { tracer?: ReflectionsPresetTracer; denoiser?: ReflectionsPresetDenoiser } = {}): ReflectionsPreset {
  const p = REFLECTION_PRESETS[name];
  if (!p) throw new Error(`reflectionsPreset: unknown preset '${String(name)}' (${REFLECTION_PRESET_NAMES.join(', ')})`);
  return { tracer: { ...p.tracer, ...defined(overrides.tracer) }, denoiser: { ...p.denoiser, ...defined(overrides.denoiser) } };
}

/**
 * The FFX reflection denoiser's options (`FfxReflectionDenoiserOptions`, denoiser/ffx) for a hit-source
 * mode. Other denoisers name their own; the seam only hands over the per-pixel source.
 */
export function denoiserHitSourceOptions(mode: DenoiserHitSourceMode): { separateHitSources: boolean; missesMatchAnySource: boolean } {
  return { separateHitSources: mode !== 'off', missesMatchAnySource: mode === 'hits' };
}

/** The mode FFX-shaped denoiser options amount to (the inverse of {@link denoiserHitSourceOptions}). */
export function denoiserHitSourceModeOf(o: { separateHitSources?: boolean; missesMatchAnySource?: boolean } | null | undefined): DenoiserHitSourceMode {
  return !o?.separateHitSources ? 'off' : o.missesMatchAnySource ? 'hits' : 'all';
}
