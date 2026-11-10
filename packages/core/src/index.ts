// Engine-agnostic public surface: everything here runs on a bare GPUDevice.
export { ProbePrefilter, LOD_MIN, maxLodFor, lodToRoughness } from './probes/prefilter';
export { createBC6HEncoder, type BC6HEncodeOptions, type BC6HEncoder } from './encode/bc6h';
// Probe layouts (phase 1 bench, docs/research/probe-layouts.md): parameterizations, the
// layout-generic prefilter, storage formats, and the brute-force GGX reference.
export { createProbeLayout, probeBytes, bytesPerTexel, octaGutter, type ProbeLayout, type ProbeLayoutId, type ProbeLayoutOptions } from './probes/layouts';
export { LayoutPrefilter } from './probes/layouts/prefilter';
export { ProbeFormatWriter, type ProbeFormat, type BC6HEncoderLike } from './probes/layouts/formats';
export { GGXReference, lobeTexels, referenceModeFor, type ReferenceMode } from './probes/reference';
