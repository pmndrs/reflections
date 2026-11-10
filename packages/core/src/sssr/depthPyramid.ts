// Hierarchical depth for the screen-space tracer, built by the maintainer's `downsampler` (Hi-Z from
// a depth source; SPD-style: up to six levels per dispatch from a 64x64 tile in workgroup memory).
// The FidelityFX SDK's SPD depth downsample this replaced (v1.1.4 ffx_sssr_depth_downsample.h) is
// credited in NOTICE.
//
// Everything about the pyramid lives in this file. The contract:
//   format  r32float, mip count min(7, ceil(log2(max(w, h)))), floor-sized mips (WebGPU's rule)
//   mip 0   an exact copy of device depth
//   mip k   min of every texel of mip k-1 it covers (max with reverse-Z), i.e. the closest depth.
//           Where mip k-1 has an odd size the extra row/column is included (downsampler's 'exact'
//           odd-size policy), so the pyramid stays conservative at odd edges (D1600).
//
// Levels per dispatch: min(6, maxStorageTexturesPerShaderStage). Request reflectionsRequiredLimits(adapter)
// for six; at the default four downsampler splits the chain into more dispatches, same result.
// Batches also end at odd sizes (1080 -> 540 -> 270 -> 135), so 1920x1080 runs as four dispatches.

import { downsamplerFor } from '../downsample';

export interface DepthPyramidOptions {
  /** Reverse-Z (1 = near): reduce with max instead of min. */
  inverted: boolean;
}

export const depthPyramidMipCount = (width: number, height: number) => Math.min(7, Math.ceil(Math.log2(Math.max(width, height))));

export function createDepthPyramidTexture(device: GPUDevice, width: number, height: number, label = 'depth pyramid'): GPUTexture {
  return device.createTexture({
    label, size: [width, height], format: 'r32float', mipLevelCount: depthPyramidMipCount(width, height),
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
}

export interface DepthPyramidBuilder {
  /** Record the pyramid build for `depth` (a depth texture or r32float, same size as mip 0) into
   *  `pyramid` (from createDepthPyramidTexture) as one compute pass. */
  build(cmd: GPUCommandEncoder, depth: GPUTexture, pyramid: GPUTexture, timestampWrites?: GPUComputePassTimestampWrites): void;
}

export function createDepthPyramidBuilder(device: GPUDevice, { inverted }: DepthPyramidOptions): DepthPyramidBuilder {
  const downsampler = downsamplerFor(device);
  const reduction = inverted ? 'max' : 'min';
  return {
    build(cmd, depth, pyramid, timestampWrites) {
      // One pass for the whole chain (downsampler's encode() opens one per batch), so one timestamp pair.
      const pass = cmd.beginComputePass({ label: 'depth pyramid', timestampWrites });
      downsampler.encodePass(pass, pyramid, { source: { texture: depth }, reduction });
      pass.end();
    },
  };
}
