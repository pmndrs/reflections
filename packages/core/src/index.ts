// Engine-agnostic public surface: everything here runs on a bare GPUDevice.
export { ProbePrefilter, LOD_MIN, maxLodFor, lodToRoughness } from './probes/prefilter';
export { createBC6HEncoder, type BC6HEncodeOptions, type BC6HEncoder, type BC6HEncoderOptions } from './encode/bc6h';
// Probe layouts (phase 1 bench, docs/research/probe-layouts.md): parameterizations, the
// layout-generic prefilter, storage formats, and the brute-force GGX reference.
export { createProbeLayout, probeBytes, bytesPerTexel, octaGutter, type ProbeLayout, type ProbeLayoutId, type ProbeLayoutOptions } from './probes/layouts';
export { LayoutPrefilter } from './probes/layouts/prefilter';
export { ProbeFormatWriter, type ProbeFormat, type BC6HEncoderLike } from './probes/layouts/formats';
export { GGXReference, lobeTexels, referenceModeFor, type ReferenceMode } from './probes/reference';
// Probe core (phase 2): the atlas + volume table + WGSL lookup, the radiance-fallback seam, re-fit irradiance.
export { ProbeSet, type ProbeSetOptions, type ProbeSetFormat } from './probes/set';
export {
  probeLookupWgsl, probeLookupIncludesWgsl, probeLookupFunctionWgsl, lodWgsl,
  type ProbeLookupOptions, type ProbeLookupModuleOptions, type ProbeLodMapping,
} from './probes/lookup';
export {
  packProbeTable, sortProbeVolumes, probeTableRows, probeIrradianceRow, PROBE_HEADER_ROWS, PROBE_ROWS_PER_VOLUME, PROBE_IRRADIANCE_ROWS,
  type ProbeVolume, type ProbeTableHeader,
} from './probes/table';
export { ProbeIrradiance, type ProbeIrradianceOptions } from './probes/irradiance';
export { probeRadianceFallback, PROBE_FALLBACK_WGSL, type ProbeRadianceFallback } from './probes/fallback';
export * from './sssr';

// Frame contract: the inputs every screen-space and hybrid pass reads (SPEC "Frame contract").
export {
  FrameCameraHistory, mat4Multiply,
  type Mat4, type TextureChannel, type FrameTextures, type FrameConventions, type FrameCamera, type FrameInputs,
} from './frame/contract';

// Trace seam + ray-traced reflections over the SSSR miss list (SPEC "Trace seam", section 4).
export * from './trace';
