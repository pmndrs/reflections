// GGX prefilter for reflection probes into a 2D array of cube faces (slot `i` = layers 6 i ... 6 i + 5),
// three r187's cube PMREM plan. Kept for its phase 0 API: since phase 2 it is a thin wrapper over the
// layout-generic LayoutPrefilter (./layouts/prefilter.ts) with the `cube2d-warp` or `cube2d-none`
// layout, which the phase 1 bench proved bit-identical to the kernels this class used to carry
// (0 of 2,096,640 half values differ at 256 px; docs/research/probe-layouts.md). Kernels vendored
// from @pmndrs/sky 0.6.0 (MIT, (c) Dennis Smolek); see NOTICE.
//
// Edge warp (`warp`): a 2D array has no seamless cube filtering, so each face's edge texels are
// centred ON the edge (texel x at u = x / (size - 1)); the lookup scales uv by (size - 1) / size per
// mip (the `cube2d-warp` layout's sampleLayout), so it is continuous across edges and corners.

import { createProbeLayout } from './layouts';
import { LayoutPrefilter } from './layouts/prefilter';
import { maxLodFor } from './lod';

export { LOD_MIN, maxLodFor, lodToRoughness } from './lod';

/**
 * Prefilters captured cubes of one face size into probe slots of a 2D array texture (rgba16float,
 * `size` px layers, at least `maxLod + 1` mips). Owns a scratch source cube and a scratch output,
 * reused for every probe and every bake.
 */
export class ProbePrefilter {
  readonly size: number;
  readonly maxLod: number;
  readonly warp: boolean;
  private readonly inner: LayoutPrefilter;

  constructor(device: GPUDevice, size: number, warp = false) {
    this.size = size;
    this.warp = warp;
    this.maxLod = maxLodFor(size);
    this.inner = new LayoutPrefilter(device, createProbeLayout(warp ? 'cube2d-warp' : 'cube2d-none', { maxLod: this.maxLod }), size, size);
  }

  /** Records the prefilter of `source` (a cube of `size` px faces, mip 0 read) into slot `slot` of `target`. */
  encode(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTexture, slot: number) {
    this.inner.encode(encoder, source, target, slot);
  }

  dispose() {
    this.inner.dispose();
  }
}
