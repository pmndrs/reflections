// Half-resolution reflections (W75, plan X5): the half-size frame (point-sampled, one pixel per quad)
// and the joint bilateral upsample back to full res.
export {
  createHalfResolutionFrame, halfResolutionCamera, halfResolutionClipTransform, halfResolutionSize,
  type HalfResolutionFrame, type HalfResolutionFrameOptions,
} from './frame';
export {
  createReflectionUpsample, DEFAULT_REFLECTION_UPSAMPLE_WEIGHTS,
  type ReflectionUpsample, type ReflectionUpsampleInputs, type ReflectionUpsampleOutputs, type ReflectionUpsampleSettings,
} from './upsample';
