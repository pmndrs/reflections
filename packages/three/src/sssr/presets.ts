// W77: apply a named preset (core `REFLECTION_PRESETS`) to a running pass and hybrid resolve.
import { REFLECTION_PRESET_KEYS, reflectionsPreset, type ReflectionsPreset, type ReflectionsPresetDenoiser, type ReflectionsPresetName, type ReflectionsPresetTracer } from '@pmndrs/reflections-core';
import type { HybridReflections } from './HybridReflections';
import type { ScreenSpaceReflectionsPass } from './ScreenSpaceReflectionsPass';

/**
 * Apply preset `name` at runtime: its tracer part (with `overrides.tracer` on top) to `ssr.settings`,
 * its denoiser part (with `overrides.denoiser`) to `hybrid.setDenoiserHitSource`. Keys the preset
 * doesn't name keep their values; every key any preset names (core `REFLECTION_PRESET_KEYS`) is
 * cleared first, so `'default'` (empty) returns them to the package defaults. Drops history
 * and rebuilds the hybrid's signal pass. When `resolutionChanged` is true the app must rebuild its own
 * composites (`hybrid.composite()`), as after any `reflectionResolution` change. At construction, pass
 * `preset` to `ScreenSpaceReflectionsPass` and `HybridReflections` instead.
 */
export function applyReflectionsPreset(
  target: { ssr: ScreenSpaceReflectionsPass; hybrid?: HybridReflections | null },
  name: ReflectionsPresetName,
  overrides: { tracer?: ReflectionsPresetTracer; denoiser?: ReflectionsPresetDenoiser } = {},
): ReflectionsPreset & { resolutionChanged: boolean } {
  const { ssr, hybrid } = target;
  const p = reflectionsPreset(name, overrides);
  const before = ssr.settings.reflectionResolution ?? 'full';
  // clear every key any preset names, so a preset never leaves one behind ('default' = the package defaults)
  const settings = ssr.settings as Record<string, unknown>;
  for (const k of REFLECTION_PRESET_KEYS.tracer) delete settings[k];
  Object.assign(ssr.settings, p.tracer);
  const resolutionChanged = (ssr.settings.reflectionResolution ?? 'full') !== before;
  if (hybrid && p.denoiser.hitSource !== undefined) hybrid.setDenoiserHitSource(p.denoiser.hitSource);
  if (hybrid) { hybrid.rebuild(); hybrid.resetHistory(); }
  ssr.resetHistory();
  return { ...p, resolutionChanged };
}
