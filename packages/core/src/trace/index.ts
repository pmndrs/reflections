// The trace seam and the ray-traced reflection pass (docs/SPEC.md "Trace seam", section 4).
export {
  HIT_WGSL, DEFAULT_HIT_LOBE_FILTER, DEFAULT_HIT_MATERIAL_WGSL, DEFAULT_HIT_SPECULAR_WGSL, DEFAULT_TRACE_ANY_WGSL, DEFAULT_SHADING_NORMAL_WGSL, fallbackHitShading,
  type BindingSlot, type ModuleBindingEntry, type TraceProvider, type TraceProviderCapabilities, type HitShading,
} from './provider';
export {
  environmentHitShading, probeHitShading, raytracerHitShading, HIT_MAX_DIRECTIONAL, HIT_MAX_HEMISPHERE, FALLBACK_SHADE_LOBE_WGSL, SCREEN_VISIBILITY_WGSL, shadeLobeWgslFor,
  type EnvironmentHitShading, type EnvironmentMapping, type HitLights, type ProbeHitShading, type ProbeHitShadingSource, type ProbeHitShadingResources, type RaytracerHitShading,
} from './hitShading';
export {
  createTracedReflections,
  type TracedReflections, type TracedReflectionsOptions, type TracedReflectionsSettings, type TracedReflectionsDispatch, type TracedReflectionsStats,
} from './pass';
export { RT_SOURCE, RT_STATE, RT_STATE_HEADER } from './shaders';
// The core provider (P1.5; the only one since W89): @pmndrs/raytracer's trace core over @pmndrs/bvh trees (optional peers,
// imported on demand) over engine-free geometry.
export {
  createRaytracerTraceProvider, loadRaytracer, raytracerMaterialOf, RaytracerTraceProvider, RAYTRACER_BVH_LAYOUT_VERSION, BVH_MAX_MATERIAL, BVH_TRIANGLE_MATERIAL_NONE,
  type BvhMeshGeometry, type BvhTraceInstance, type BvhTraceMaterial, type BvhTraceTexture, type BvhTraceScene, type BvhTraceScene as RaytracerTraceScene, type BvhBuilderPreference,
  type RaytracerTraceProviderOptions, type RaytracerBuildInfo, type RaytracerSun, type RaytracerEnvironment,
} from './raytracer';
