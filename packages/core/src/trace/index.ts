// The trace seam and the ray-traced reflection pass (docs/SPEC.md "Trace seam", section 4).
export {
  HIT_WGSL, DEFAULT_HIT_MATERIAL_WGSL, fallbackHitShading,
  type BindingSlot, type ModuleBindingEntry, type TraceProvider, type TraceProviderCapabilities, type HitShading,
} from './provider';
export { environmentHitShading, HIT_MAX_DIRECTIONAL, HIT_MAX_HEMISPHERE, type EnvironmentHitShading, type EnvironmentMapping, type HitLights } from './hitShading';
export {
  createTracedReflections,
  type TracedReflections, type TracedReflectionsOptions, type TracedReflectionsSettings, type TracedReflectionsDispatch, type TracedReflectionsStats,
} from './pass';
export { RT_SOURCE, RT_STATE, RT_STATE_HEADER } from './shaders';
