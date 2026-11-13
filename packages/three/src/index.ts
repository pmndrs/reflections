// three.js WebGPURenderer adapter.

// Reflection probes: the API of three.js #35046 (Ben Houston) on r187, plus extensions
// (sampleReflectionProbes, originOffset, bake({ environment, probes }), seamFix).
// reflectionProbesLocal / sampleReflectionProbesLocal: #35046 head's vec4 (radiance, coverage) form.
export {
  ReflectionProbe, ReflectionProbes, probeOrigin, probeWorldScale, type BakeOptions, type SeamFix,
} from './probes/ReflectionProbes';
export {
  ReflectionProbesNode, reflectionProbes, reflectionProbesLocal, sampleReflectionProbes, sampleReflectionProbesLocal,
  ReflectionProbesProxyNode, sampleReflectionProbesProxyShare, parallaxCorrect, cubeFaceUV, reflectionProbeVolumes, packReflectionProbesTable,
  type ProbeLookupInputs, type ProbeLookupOptions, type PackReflectionProbesTableOptions,
} from './probes/ReflectionProbesNode';
export { ReflectionProbesHelper } from './probes/ReflectionProbesHelper';

// Cube arrays on stock three r187: CubeArrayTexture vendored from three.js #35053 (Ben Houston) and a
// runtime shim that ports #35053's renderer changes, self-tested at install (W20).
export { CubeArrayTexture } from './compat/CubeArrayTexture';
export {
  installCubeArraySupport, uninstallCubeArraySupport, cubeArraySupported, cubeArraySupportStatus, cubeArrayTextureClass, nativeCubeArrayTexture,
  CUBE_ARRAY_SHIM_REVISIONS, type CubeArraySupportMode, type CubeArraySupportStatus, type InstallCubeArrayOptions,
} from './compat/cubeArray';

// Shared sampling: GGX lobe sample, per-pixel seed, firefly clamp, reference accumulation.
export { AccumulateNode, clampSample, ggxLobeSample, pixelSeed } from './sampling';

// Frame contract G-buffer: one MRT render of a three scene into the core's FrameInputs.
// Device limits for six-level mip/Hi-Z dispatches: new WebGPURenderer({ requiredLimits: reflectionsRequiredLimits(adapter) }).
export { reflectionsRequiredLimits } from '@pmndrs/reflections-core';
export { FrameGBuffer, getDevice, getGPUTexture, type FrameGBufferOptions, type FrameTargetName } from './frame/FrameGBuffer';
export { sceneColorNoSpecular, gbufferRoughness, gbufferMetalness } from './frame/nodes';

// Screen-space reflections: G-buffer + core tracer on the renderer's device, outputs as three
// textures; first-cut hybrid composite (SSR -> probes by coverage -> environment) in TSL.
export { ScreenSpaceReflectionsPass, type ScreenSpaceReflectionsPassOptions, type ScreenSpaceReflectionsPassSettings } from './sssr/ScreenSpaceReflectionsPass';
export { screenSpaceComposite, type ScreenSpaceComposite, type ScreenSpaceCompositeOptions } from './sssr/composite';

// Ray-traced fallback: three-mesh-bvh behind core's trace seam (the stopgap until @pmndrs/bvh).
// three-mesh-bvh is an optional peer, imported on demand by MeshBVHTraceProvider.fromObjects.
export { MeshBVHTraceProvider, defaultHitMaterial, hitMaterialSource, textureMeanColor, type HitMaterial, type HitMaterialSource, type MeshBVHComputeDataLike, type MeshBVHTraceProviderOptions } from './trace/MeshBVHTraceProvider';
export type { ScreenSpaceTraceOptions } from './sssr/ScreenSpaceReflectionsPass';
// The core provider (@pmndrs/bvh, optional peer, imported on demand) built from a three scene.
export {
  bvhTraceSceneFromObjects, createPmndrsBvhTraceProviderFromObjects,
  type PmndrsBvhFromObjectsOptions, type ThreeBvhTraceScene, type ThreePmndrsBvhTraceProvider,
} from './trace/PmndrsBvhTraceProvider';

// Hybrid resolve (phase 5): SSR -> RT -> probes -> environment, denoised through the denoise seam
// (any denoiser-core-shaped TemporalDenoiser<SpecularInputs>, e.g. denoiser/ffx's FfxReflectionDenoiser).
export { HybridReflections, HYBRID_SOURCE, type HybridReflectionsOptions } from './sssr/HybridReflections';
