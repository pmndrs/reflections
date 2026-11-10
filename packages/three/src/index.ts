// three.js WebGPURenderer adapter.

// Reflection probes: the API of three.js #35046 (Ben Houston) on r187, plus extensions
// (sampleReflectionProbes, originOffset, bake({ environment, probes }), seamFix).
// reflectionProbesLocal / sampleReflectionProbesLocal: #35046 head's vec4 (radiance, coverage) form.
export {
  ReflectionProbe, ReflectionProbes, probeOrigin, type BakeOptions, type SeamFix,
} from './probes/ReflectionProbes';
export {
  ReflectionProbesNode, reflectionProbes, reflectionProbesLocal, sampleReflectionProbes, sampleReflectionProbesLocal,
  parallaxCorrect, cubeFaceUV, type ProbeLookupInputs, type ProbeLookupOptions,
} from './probes/ReflectionProbesNode';
export { ReflectionProbesHelper } from './probes/ReflectionProbesHelper';

// Shared sampling: GGX lobe sample, per-pixel seed, firefly clamp, reference accumulation.
export { AccumulateNode, clampSample, ggxLobeSample, pixelSeed } from './sampling';

// Frame contract G-buffer: one MRT render of a three scene into the core's FrameInputs.
export { FrameGBuffer, getDevice, getGPUTexture, type FrameGBufferOptions, type FrameTargetName } from './frame/FrameGBuffer';
export { sceneColorNoSpecular, gbufferRoughness, gbufferMetalness } from './frame/nodes';
