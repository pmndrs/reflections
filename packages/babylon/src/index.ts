// Babylon.js WebGPUEngine adapter (experimental): the frame contract from a Babylon geometry render,
// the core screen-space tracer and probe set on Babylon's device, a frame-graph composite.

// Babylon conventions onto the frame contract (handedness, Y-flipped targets, velocity, gloss, F0).
export {
  BABYLON_MOTION_SCALE, BABYLON_ROUGHNESS_UNPACK, babylonFrameCamera, babylonFrameConventions, tracerProjection, tracerView,
} from './conventions';
export { asWebGPUEngine, getDevice, getGPUTexture, wrapGPUBuffer, wrapGPUTexture, wrapGPUTextureView, type WrappedStorageBuffer } from './internal/babylonWebGPU';
export { BabylonFrame, type BabylonFrameOptions, type BabylonGBuffer } from './frame';

// Scene colour without specular IBL (sceneColorSpecular 'direct'), its extra factors in velocity.z.
export { DECODE_SPECULAR_FACTORS_WGSL, StripSpecularIBLPlugin, stripSpecularIBL } from './material';

// Probes: core ProbeSet, captured by Babylon cube renders.
export { BabylonCubeCapture, BabylonProbeSet, type BabylonProbe, type BabylonProbeSetOptions } from './probes';
// Probe bounce light: PBR's diffuse IBL from the probe set, per pixel (three: scene.environmentNode).
export { ProbeIrradiancePlugin, probeIrradiance } from './irradiance';

// Screen-space reflections + the composite, standalone or as frame-graph tasks.
export { ScreenSpaceReflections, type ScreenSpaceReflectionsOptions } from './ScreenSpaceReflections';
export { FrameGraphReflectionsTask } from './FrameGraphReflectionsTask';
export { FrameGraphReflectionsCompositeTask, COMPOSITE_VIEWS, type CompositeView } from './composite';
