// The examples' denoiser: denoiser/ffx's FfxReflectionDenoiser from the sibling Denoiser repo when
// examples/vite.config.ts found one, else null (the hybrid resolve then runs undenoised).
import { FfxReflectionDenoiser, type FfxReflectionDenoiserOptions } from '@pmndrs/denoiser-ffx';
import type { SpecularInputs, TemporalDenoiser } from '@pmndrs/reflections/core';

export const denoiserAvailable = FfxReflectionDenoiser !== null;
export const denoiserSource = __DENOISER_SOURCE__;

/**
 * FFX reflection denoiser gated at the tracer's threshold: FFX compares alpha (perceptual^2), so
 * rougher pixels (probe term only, no noise) pass through untouched.
 */
export function createReflectionDenoiser(device: GPUDevice, roughnessThreshold = 0.447, timestamps = false, extra: FfxReflectionDenoiserOptions = {}): TemporalDenoiser<SpecularInputs> | null {
  if (!FfxReflectionDenoiser) return null;
  return new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold * roughnessThreshold, timestamps, ...extra });
}

/**
 * W53 (D3660), all off by default:
 * - `?hitSource=1` (or `all`): the hybrid hands the denoiser a per-pixel hit source and FFX keeps
 *   screen-space hits, traced hits and misses apart (`separateHitSources`);
 * - `?hitSource=hits` (= `?hitSource=1&hitMissAny=1`): only screen-space vs traced hits; a miss blends
 *   with either (`missesMatchAnySource`). Steadier: no boiling where rays flip between hit and miss;
 * - `?hitDistW=<k>`: FFX weights neighbours by relative hit distance (`hitDistanceWeight`), no extra input.
 */
export interface DenoiserHitSourceSettings { hitSource: boolean; missesMatchAnySource: boolean; hitDistanceWeight: number }
export function hitSourceFromQuery(q: URLSearchParams): DenoiserHitSourceSettings {
  // ?hitSource=hits is ?hitSource=1&hitMissAny=1 (only screen-space vs traced hits kept apart)
  const v = q.get('hitSource');
  return { hitSource: v === '1' || v === 'all' || v === 'hits', missesMatchAnySource: v === 'hits' || q.get('hitMissAny') === '1', hitDistanceWeight: Number(q.get('hitDistW') ?? 0) || 0 };
}
/** The FFX options for `s`. */
export function hitSourceDenoiserOptions(s: DenoiserHitSourceSettings): FfxReflectionDenoiserOptions {
  return { separateHitSources: s.hitSource, missesMatchAnySource: s.missesMatchAnySource, hitDistanceWeight: s.hitDistanceWeight };
}

/** Change the W53 settings on a hybrid and its FFX denoiser between frames (drops the denoiser's history). */
export function setDenoiserHitSource(hybrid: { denoiserHitSource: boolean; denoiser: unknown; resetHistory(): void }, s: Partial<DenoiserHitSourceSettings>) {
  if (s.hitSource !== undefined) hybrid.denoiserHitSource = s.hitSource;
  const d = hybrid.denoiser as { setOptions?: (o: FfxReflectionDenoiserOptions) => void } | null;
  d?.setOptions?.({
    ...(s.hitSource !== undefined ? { separateHitSources: s.hitSource } : {}),
    ...(s.missesMatchAnySource !== undefined ? { missesMatchAnySource: s.missesMatchAnySource } : {}),
    ...(s.hitDistanceWeight !== undefined ? { hitDistanceWeight: s.hitDistanceWeight } : {}),
  });
  hybrid.resetHistory();
}
