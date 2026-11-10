// The examples' denoiser: denoiser/ffx's FfxReflectionDenoiser from the sibling Denoiser repo when
// examples/vite.config.ts found one, else null (the hybrid resolve then runs undenoised).
import { FfxReflectionDenoiser } from '@pmndrs/denoiser-ffx';
import type { SpecularInputs, TemporalDenoiser } from '@pmndrs/reflections/core';

export const denoiserAvailable = FfxReflectionDenoiser !== null;
export const denoiserSource = __DENOISER_SOURCE__;

/**
 * FFX reflection denoiser gated at the tracer's threshold: FFX compares alpha (perceptual^2), so
 * rougher pixels (probe term only, no noise) pass through untouched.
 */
export function createReflectionDenoiser(device: GPUDevice, roughnessThreshold = 0.447, timestamps = false): TemporalDenoiser<SpecularInputs> | null {
  if (!FfxReflectionDenoiser) return null;
  return new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold * roughnessThreshold, timestamps });
}
