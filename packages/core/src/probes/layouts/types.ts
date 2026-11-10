// Probe layouts: how a probe's directions map to texels (docs/SPEC.md, "Octahedral probes vs PMREM").
//
// A layout is a parameterization only. The prefilter plan (which roughness goes in which mip, and
// how each mip is integrated) is the same for every layout: see LayoutPrefilter in ./prefilter.
//
// Direction convention: every layout works in *texture space*, the direction space of a WebGPU
// cube texture (D3D / GL face rules, no mirroring). An adapter whose engine stores cubes mirrored
// (three's CubeCamera targets are x-mirrored) converts its world direction before calling
// `sampleLayout`, as ReflectionProbesNode's `cubeFaceUV` does today.

export type ProbeLayoutId = 'cube2d-warp' | 'cube2d-none' | 'cube-hw' | 'octa' | 'octa-hemi';

export interface ProbeLayout {
  id: ProbeLayoutId;
  /**
   * WGSL defining
   *   fn dirForTexel(texel: vec2u, layer: u32, mip: u32, size: u32) -> vec3f
   *     the (unit) direction the prefilter integrates for `texel` of layer `layer` (within one
   *     probe) at mip `mip`, for a texture whose mip 0 is `size` px;
   *   fn sampleLayout(tex: <textureType>, samp: sampler, probe: u32, dir: vec3f, lod: f32) -> vec4f
   *     the filtered radiance of probe `probe` along `dir` (need not be normalized) at mip `lod`.
   * Helper names are prefixed `pl_`. One layout per shader module (the names collide otherwise).
   */
  wgsl: string;
  /** WGSL type of the texture `sampleLayout` takes, e.g. `texture_2d_array<f32>`. */
  textureType: string;
  /** Texture shape for N probes at `size` px (mip 0 face or octa side). */
  textureDescriptor(size: number, probes: number, format: GPUTextureFormat): GPUTextureDescriptor;
  /** View dimension `sampleLayout`'s texture is bound with. */
  viewDimension: GPUTextureViewDimension;
  /** Array layers one probe takes (6 for the cube layouts, 1 for octahedral). */
  layersPerProbe: number;
  /** Roughness mips: maxLod + 1. Mip `lod` holds roughness `lodToRoughness(lod, maxLod)`. */
  mipLevelCount: number;
}

export interface ProbeLayoutOptions {
  /** Last roughness mip (`maxLodFor(captureSize)` for three r187's plan). */
  maxLod: number;
}
