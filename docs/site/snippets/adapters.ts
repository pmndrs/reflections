// Code samples for the Babylon, pixi and denoiser pages. See three.ts for how these are checked.
import { HybridReflections, type ScreenSpaceReflectionsPass } from '@pmndrs/reflections';
import type { SpecularInputs, TemporalDenoiser } from '@pmndrs/reflections/core';

// #region babylon-imports
import { FrameGraphReflectionsCompositeTask, FrameGraphReflectionsTask, BabylonProbeSet, ScreenSpaceReflections, stripSpecularIBL } from '@pmndrs/reflections/babylon';
// #endregion

// #region pixi-imports
import { PixiProbeSet, ReflectionsView, ScreenSpaceReflections as PixiScreenSpaceReflections, requestReflectionsDevice } from '@pmndrs/reflections/pixi';
// #endregion

export function denoiseSeam(ssr: ScreenSpaceReflectionsPass, denoiser: TemporalDenoiser<SpecularInputs>) {
  // #region denoise-seam
  const hybrid = new HybridReflections(ssr, { denoiser });
  hybrid.denoise = true; // toggle at any time
  // #endregion
  return hybrid;
}

export const used = [FrameGraphReflectionsCompositeTask, FrameGraphReflectionsTask, BabylonProbeSet, ScreenSpaceReflections, stripSpecularIBL, PixiProbeSet, ReflectionsView, PixiScreenSpaceReflections, requestReflectionsDevice];
