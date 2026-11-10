// PixiJS v8 WebGPURenderer adapter (experimental): an adapter-owned 3-D G-buffer layer (pixi has
// none), core's screen-space tracer and probe set on pixi's device, the composite as a pixi Filter.

// pixi's device and textures.
export { asWebGPURenderer, createPixiTarget, getDevice, getGPUTexture, requestReflectionsDevice } from './internal/pixiWebGPU';

// The 3-D layer: scene, camera, meshes (materials take pixi Textures, e.g. RenderTextures of pixi content).
export { ReflectionCamera, ReflectionMaterial, ReflectionMesh, ReflectionScene, type ReflectionMaterialOptions, type SkyOptions, type SunOptions } from './scene';
export { Geometry, VERTEX_STRIDE, type GeometryData } from './geometry';
export { mat4Compose, mat4Invert, mat4LookAt, mat4Mul, mat4Perspective, type Mat4, type Vec3 } from './math';

// The frame contract from the adapter's G-buffer.
export { GBufferRenderer, GBufferTargets, GBUFFER_WGSL } from './gbuffer';
export { PixiFrame, PIXI_FRAME_CONVENTIONS } from './frame';

// Probes: core ProbeSet, captured by the 3-D layer (environment slot = the sky).
export { PixiProbeSet, type PixiProbe, type PixiProbeSetOptions } from './probes';

// Screen-space reflections, the composite Filter, and the all-in-one Sprite.
export { ScreenSpaceReflections, type ScreenSpaceReflectionsOptions } from './ScreenSpaceReflections';
export { ReflectionsFilter, REFLECTION_VIEWS, type ReflectionsFilterOptions, type ReflectionsFilterSources, type ReflectionViewName } from './ReflectionsFilter';
export { ReflectionsView, type ReflectionsViewOptions } from './ReflectionsView';
