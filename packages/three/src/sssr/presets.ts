// W77: apply a named preset (core `REFLECTION_PRESETS`) to a running pass and hybrid resolve.
import {
  isReflectionsPresetName, REFLECTION_PRESET_KEYS, REFLECTION_PRESET_NAMES, reflectionsPreset,
  type ReflectionsPreset, type ReflectionsPresetDenoiser, type ReflectionsPresetName, type ReflectionsPresetTracer,
} from '@pmndrs/reflections-core';
import type { HybridReflections } from './HybridReflections';
import type { ScreenSpaceReflectionsPass } from './ScreenSpaceReflectionsPass';

let warnedResolution = false;
const warnedNames = new Set<string>();

/**
 * Apply preset `name` at runtime. Layers, lowest first: the app's own construction settings
 * (`ssr.presetBase`; the denoiser's hit source as the app built it), the package defaults where the app
 * set nothing, the preset, then `overrides`. Every key any preset names (core `REFLECTION_PRESET_KEYS`)
 * is rebuilt from those layers, so 'performance' -> 'default' returns to where the app started; other
 * keys keep their current values. Drops history. When `resolutionChanged` is true the app must rebuild
 * its own composites (`hybrid.composite()`), as after any `reflectionResolution` change (warned once);
 * the hybrid rebuilds its own passes on the next `update()`. A target with a `rebuild()` (a `Reflections`:
 * `applyReflectionsPreset(reflections, name)`) is rebuilt here instead, with no warning. At construction, pass `preset` to
 * `ScreenSpaceReflectionsPass` and `HybridReflections` instead (there the app's `settings` win over the
 * preset). An unknown name warns once and changes nothing.
 */
export function applyReflectionsPreset(
  target: { ssr: ScreenSpaceReflectionsPass; hybrid?: HybridReflections | null; rebuild?(): void },
  name: ReflectionsPresetName,
  overrides: { tracer?: ReflectionsPresetTracer; denoiser?: ReflectionsPresetDenoiser } = {},
): ReflectionsPreset & { resolutionChanged: boolean } {
  const { ssr, hybrid } = target;
  if (!isReflectionsPresetName(name)) {
    if (!warnedNames.has(String(name))) { warnedNames.add(String(name)); console.warn(`applyReflectionsPreset: unknown preset '${String(name)}' (${REFLECTION_PRESET_NAMES.join(', ')}); nothing changed`); }
    return { tracer: {}, denoiser: {}, resolutionChanged: false };
  }
  const p = reflectionsPreset(name, overrides);
  const before = ssr.settings.reflectionResolution ?? 'full';
  // every key any preset names back to the app's own value, else unset (= the package default)
  const settings = ssr.settings as Record<string, unknown>, base = ssr.presetBase as Record<string, unknown>;
  for (const k of REFLECTION_PRESET_KEYS.tracer) { if (base[k] !== undefined) settings[k] = base[k]; else delete settings[k]; }
  Object.assign(ssr.settings, p.tracer);
  const resolutionChanged = (ssr.settings.reflectionResolution ?? 'full') !== before;
  if (resolutionChanged && !target.rebuild && !warnedResolution) {
    warnedResolution = true;
    console.warn(`applyReflectionsPreset('${name}'): reflectionResolution is now ${ssr.settings.reflectionResolution ?? 'full'}; rebuild your composites (hybrid.composite()) or reflections are wrong`);
  }
  if (hybrid) {
    if (p.denoiser.hitSource !== undefined) hybrid.setDenoiserHitSource(p.denoiser.hitSource);
    else hybrid.restoreDenoiserHitSource();
    hybrid.resetHistory();
  }
  ssr.resetHistory();
  if (resolutionChanged) target.rebuild?.(); // a Reflections: its composite for the new resolution
  return { ...p, resolutionChanged };
}
