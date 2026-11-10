// PixiJS v8 WebGPURenderer adapter (experimental), for pixi-3d (`@pixi/3d`, closed beta) scenes:
// pixi's device and textures, the frame contract from a View3D's outputs, core's screen-space tracer
// and probe set on pixi's device, the composite as a pixi Filter. The adapter never imports
// @pixi/3d: it takes pixi Textures and structural shapes (./pixi3d.ts), so it builds and type-checks
// without the beta. examples/pixi3d/shared has the one pixi-3d class the beta lacks (the G-buffer pass).

// pixi's device and textures.
export { asWebGPURenderer, createPixiTarget, getDevice, getGPUTexture, requestReflectionsDevice } from './internal/pixiWebGPU';

// What the adapter needs from pixi-3d, as plain data and structural types.
export {
  REFLECTIONS_GBUFFER_FORMAT, REFLECTIONS_GBUFFER_PASS, REFLECTIONS_GBUFFER_SHADER, REFLECTIONS_SCENE_COLOR_BIT,
  type Matrix4Like, type Pixi3DCameraLike, type Pixi3DShaderBitLike, type Pixi3DShaderTemplateLike,
} from './pixi3d';

// The frame contract from a pixi-3d View3D.
export {
  Pixi3DFrame, Pixi3DFrameTargets, PIXI3D_FRAME_CONVENTIONS, cameraFromPixi3D, eyeFromView, mat4Invert, projectionToZeroOne,
  type Pixi3DFrameSources,
} from './frame';

// Probes: core ProbeSet, captured from pixi-3d renders (faces) and the view's Hemisphere (environment slot).
export { PixiProbeSet, type HemisphereColors, type PixiProbe, type PixiProbeSetOptions } from './probes';

// Screen-space reflections, the composite Filter, and the all-in-one Sprite.
export { ScreenSpaceReflections, type ScreenSpaceReflectionsOptions } from './ScreenSpaceReflections';
export { ReflectionsFilter, REFLECTION_VIEWS, type ReflectionsFilterOptions, type ReflectionsFilterSources, type ReflectionViewName } from './ReflectionsFilter';
export { ReflectionsView, type ReflectionsViewOptions } from './ReflectionsView';
