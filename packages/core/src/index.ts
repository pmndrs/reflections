// Engine-agnostic public surface: everything here runs on a bare GPUDevice.
export { ProbePrefilter, LOD_MIN, maxLodFor, lodToRoughness } from './probes/prefilter';
export { createBC6HEncoder, type BC6HEncodeOptions, type BC6HEncoder, type BC6HEncoderOptions } from './encode/bc6h';
// Probe layouts (phase 1 bench, docs/research/probe-layouts.md): parameterizations, the
// layout-generic prefilter, storage formats, and the brute-force GGX reference.
export { createProbeLayout, probeLayoutsWgsl, dedupeChunks, dedupeWgslChunks, markedChunkWgsl, probeBytes, bytesPerTexel, octaGutter, type ProbeLayout, type ProbeLayoutId, type ProbeLayoutOptions, type ProbeWgslChunk } from './probes/layouts';
export { LayoutPrefilter } from './probes/layouts/prefilter';
export { ProbeFormatWriter, type ProbeFormat, type BC6HEncoderLike } from './probes/layouts/formats';
export { GGXReference, lobeTexels, referenceModeFor, type ReferenceMode } from './probes/reference';
// Probe core (phase 2): the atlas + volume table + WGSL lookup, the radiance-fallback seam, re-fit irradiance.
export { ProbeSet, type ProbeSetOptions, type ProbeSetFormat } from './probes/set';
export {
  probeLookupWgsl, probeLookupIncludesWgsl, probeLookupIncludeChunks, probeLookupFunctionWgsl, probeProxyShareFunctionWgsl, lodWgsl, DEFAULT_PROBE_LOD_MAPPING, PROBE_UNROLL_MAX_VOLUMES,
  type ProbeLookupOptions, type ProbeLookupModuleOptions, type ProbeLodMapping,
} from './probes/lookup';
export {
  packProbeTable, sortProbeVolumes, probeTableRows, probeIrradianceRow, planProbeAtlases, PROBE_HEADER_ROWS, PROBE_ROWS_PER_VOLUME, PROBE_IRRADIANCE_ROWS, PROBE_MAX_ATLASES,
  probeGridRow, probeGridRows, PROBE_GRID_MAX_CELLS, PROBE_GRID_MIN_VOLUMES, PROBE_GRID_LANE_BITS,
  PROBE_FLAG_BOX_PROJECTION, PROBE_FLAG_ORIENTED, probeVolumeRotation, probeVolumeLocal, probeVolumeWorldHalfSize, rotateByQuat,
  type ProbeVolume, type ProbeTableHeader, type ProbeTableAtlas, type ProbeAtlasPlan, type ProbeQuaternion,
} from './probes/table';
export { ProbeIrradiance, type ProbeIrradianceOptions } from './probes/irradiance';
export {
  CAPTURE_MIRROR_X, CAPTURE_MIRROR_Y, CAPTURE_BABYLON_FACES, CAPTURE_CAMERA_FACES, ProbeCaptureRemap, resolveCaptureTransform, captureAxesWgsl,
  type ProbeCaptureTransform, type ProbeCaptureFace, type ProbeAxis, type ProbeCaptureTransformOptions,
} from './probes/capture';
export { probeRadianceFallback, PROBE_FALLBACK_WGSL, type ProbeRadianceFallback } from './probes/fallback';
export { PROBE_LOOKUP_NUDGE_SCALE, PROBE_LOOKUP_NUDGE_BIAS, probeLookupNudge, PROBE_LOOKUP_ORIGIN_WGSL } from './probes/lookupOrigin';
export * from './sssr';
// Mip chains and Hi-Z via `downsampler`: the device limits that let it run six levels per dispatch.
export { reflectionsRequiredLimits, REFLECTIONS_COLOR_BYTES_PER_SAMPLE, REFLECTIONS_SAMPLED_TEXTURES_PER_STAGE } from './downsample';
export { checkStageLimits, countStageBindings, type StageBindingCounts } from './limits';

// Frame contract: the inputs every screen-space and hybrid pass reads (SPEC "Frame contract").
export {
  FrameCameraHistory, mat4Multiply,
  type Mat4, type TextureChannel, type FrameTextures, type FrameConventions, type FrameCamera, type FrameInputs,
} from './frame/contract';

// Trace seam + ray-traced reflections over the SSSR miss list (SPEC "Trace seam", section 4).
export * from './trace';
// Joint bilateral gather of a sparse reflection signal (W74: the RT layer's half-rate fill; X5's upsample).
export * from './bilateral';
// Half-resolution reflections (W75, X5): the point-sampled half frame and the joint bilateral upsample.
export * from './halfres';
// Named settings bundles (W77): 'default' and 'performance' (half-res + the denoiser's hit source), applied by adapters.
export {
  REFLECTION_PRESETS, REFLECTION_PRESET_NAMES, REFLECTION_PRESET_KEYS, isReflectionsPresetName, reflectionsPreset, denoiserHitSourceOptions, denoiserHitSourceModeOf,
  type ReflectionsPreset, type ReflectionsPresetName, type ReflectionsPresetTracer, type ReflectionsPresetDenoiser, type ReflectionResolution, type DenoiserHitSourceMode,
} from './presets';

// Denoise seam (SPEC "Denoise seam"): any denoiser-core-shaped TemporalDenoiser<SpecularInputs>, fed from the frame contract.
export {
  createReflectionDenoiseSeam,
  type ReflectionDenoiseSeam, type ReflectionDenoiseSeamOptions, type TemporalDenoiser, type SpecularInputs, type DenoiseGuides, type DenoiseCamera,
  HIT_SOURCE, type DenoiseHitSources,
} from './denoise/seam';

// Split-sum environment BRDF (DFG) for adapters without an engine BRDF table (D2004).
export {
  SPLIT_SUM_DFG_WGSL, SPLIT_SUM_DFG_TABLES, SPLIT_SUM_DFG_SIZE, splitSumDFGWgsl, integrateSplitSumDFG, type SplitSumVisibility,
} from './brdf/splitSum';
