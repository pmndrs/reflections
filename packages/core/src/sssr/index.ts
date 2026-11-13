// Screen-space reflections (a WGSL port of the FidelityFX SDK's stochastic screen-space reflection
// tracer; attribution in NOTICE and shaders.ts). Public names carry no product marks.
export {
  createScreenSpaceReflections, screenSpaceInputsFromFrame, screenSpaceHitShadingWgsl, mirrorBiasSplit, HIT_COLOR_PYRAMID_LEVELS, DEFAULT_ROUGHNESS_THRESHOLD, DEFAULT_TRACED_HALF_RATE_MIN_ROUGHNESS, THICKNESS_HYBRID, THICKNESS_CONSTANT, constantRadianceFallback, environmentRadianceFallback,
  type ScreenSpaceReflections, type ScreenSpaceReflectionsOptions, type ScreenSpaceReflectionsSettings,
  type ScreenSpaceReflectionsInputs, type ScreenSpaceReflectionsOutputs, type ScreenSpaceCamera,
  type ScreenSpaceVariant, type RadianceFallback, type ScreenSpaceHitShading,
} from './sssr';
export {
  createDepthPyramidBuilder, createDepthPyramidTexture, depthPyramidMipCount,
  type DepthPyramidBuilder, type DepthPyramidOptions,
} from './depthPyramid';
// Per-pass GPU timestamps (W75: the half-res passes in the adapters time themselves with it).
export { PassTimer } from './timer';
