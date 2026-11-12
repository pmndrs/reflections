// The trace seam and the ray-traced reflection pass (docs/SPEC.md "Trace seam", section 4).
export {
  HIT_WGSL, DEFAULT_HIT_LOBE_FILTER, DEFAULT_HIT_MATERIAL_WGSL, DEFAULT_HIT_SPECULAR_WGSL, DEFAULT_TRACE_ANY_WGSL, DEFAULT_SHADING_NORMAL_WGSL, fallbackHitShading,
  type BindingSlot, type ModuleBindingEntry, type TraceProvider, type TraceProviderCapabilities, type HitShading,
} from './provider';
export {
  environmentHitShading, probeHitShading, HIT_MAX_DIRECTIONAL, HIT_MAX_HEMISPHERE, FALLBACK_SHADE_LOBE_WGSL, shadeLobeWgslFor,
  type EnvironmentHitShading, type EnvironmentMapping, type HitLights, type ProbeHitShading, type ProbeHitShadingSource, type ProbeHitShadingResources,
} from './hitShading';
export {
  createTracedReflections,
  type TracedReflections, type TracedReflectionsOptions, type TracedReflectionsSettings, type TracedReflectionsDispatch, type TracedReflectionsStats,
} from './pass';
export { RT_SOURCE, RT_STATE, RT_STATE_HEADER } from './shaders';
// The core provider: @pmndrs/bvh (optional peer, imported on demand) over engine-free geometry.
export {
  createPmndrsBvhTraceProvider, loadPmndrsBvh, PmndrsBvhTraceProvider, PMNDRS_BVH_LAYOUT_VERSION, PMNDRS_BVH_MAX_MATERIAL,
  type BvhMeshGeometry, type BvhTraceInstance, type BvhTraceMaterial, type BvhTraceScene, type BvhBuilderPreference,
  type PmndrsBvhTraceProviderOptions, type PmndrsBvhBuildInfo,
} from './pmndrsBvh';
