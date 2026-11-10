// Types for `@pmndrs/denoiser-ffx` as the examples use it. The examples resolve it from the sibling
// Denoiser repo's source (examples/vite.config.ts), or to ./denoiser-missing.ts (null) without one.
declare module '@pmndrs/denoiser-ffx' {
  import type { SpecularInputs, TemporalDenoiser } from '@pmndrs/reflections/core';
  export interface FfxReflectionDenoiserOptions {
    temporalStabilityFactor?: number;
    roughnessThreshold?: number;
    roughnessIsPerceptual?: boolean;
    missDistance?: number;
    currentFrameStatistics?: boolean;
    timestamps?: boolean;
  }
  export const FfxReflectionDenoiser:
    | (new (device: GPUDevice, options?: FfxReflectionDenoiserOptions) => TemporalDenoiser<SpecularInputs>)
    | null;
}

/** examples/vite.config.ts: the Denoiser repo the alias points at ('' when none was found). */
declare const __DENOISER_SOURCE__: string;
