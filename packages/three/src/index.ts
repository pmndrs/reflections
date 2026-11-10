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

// Screen-space reflections: G-buffer + core tracer on the renderer's device, outputs as three
// textures; first-cut hybrid composite (SSR -> probes by coverage -> environment) in TSL.
export { ScreenSpaceReflectionsPass, type ScreenSpaceReflectionsPassOptions } from './sssr/ScreenSpaceReflectionsPass';
export { screenSpaceComposite, type ScreenSpaceComposite, type ScreenSpaceCompositeOptions } from './sssr/composite';

// Ray-traced fallback: three-mesh-bvh behind core's trace seam (the stopgap until @pmndrs/bvh).
// three-mesh-bvh is an optional peer, imported on demand by MeshBVHTraceProvider.fromObjects.
export { MeshBVHTraceProvider, defaultHitMaterial, type HitMaterial, type MeshBVHComputeDataLike, type MeshBVHTraceProviderOptions } from './trace/MeshBVHTraceProvider';
export type { ScreenSpaceTraceOptions } from './sssr/ScreenSpaceReflectionsPass';
