// Babylon.js WebGPUEngine adapter (experimental): the frame contract from a Babylon geometry render,
// the core screen-space tracer and probe set on Babylon's device, a frame-graph composite.

// Babylon conventions onto the frame contract (handedness, Y-flipped targets, velocity, gloss, F0).
export {
  BABYLON_MOTION_SCALE, babylonFrameCamera, babylonFrameConventions, tracerProjection, tracerView,
} from './conventions';
export { asWebGPUEngine, getDevice, getGPUTexture, wrapGPUTexture } from './internal/babylonWebGPU';
export { BabylonFrame, type BabylonFrameOptions, type BabylonGBuffer } from './frame';

// Scene colour without specular IBL (sceneColorSpecular 'direct').
export { StripSpecularIBLPlugin, stripSpecularIBL } from './material';

// Probes: core ProbeSet, captured by Babylon cube renders.
export { BabylonCubeCapture, BabylonProbeSet, type BabylonProbe, type BabylonProbeSetOptions } from './probes';

// Screen-space reflections + the composite, standalone or as frame-graph tasks.
export { ScreenSpaceReflections, type ScreenSpaceReflectionsOptions } from './ScreenSpaceReflections';
export { FrameGraphReflectionsTask } from './FrameGraphReflectionsTask';
export { FrameGraphReflectionsCompositeTask, COMPOSITE_VIEWS, type CompositeView } from './composite';
