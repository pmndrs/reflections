// Engine-agnostic public surface: everything here runs on a bare GPUDevice.
export { ProbePrefilter, LOD_MIN, maxLodFor, lodToRoughness } from './probes/prefilter';

// Frame contract: the inputs every screen-space and hybrid pass reads (SPEC "Frame contract").
export {
  FrameCameraHistory, mat4Multiply,
  type Mat4, type TextureChannel, type FrameTextures, type FrameConventions, type FrameCamera, type FrameInputs,
} from './frame/contract';
