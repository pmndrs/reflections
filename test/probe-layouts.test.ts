import { describe, expect, it } from 'vitest';
import { createProbeLayout, octaGutter, probeBytes } from '@pmndrs/reflections-core';

// GPU-free parts of the probe layouts: texture shapes and memory. The WGSL is checked on the GPU
// by examples/probe-bench (pnpm check).
describe('probe layouts', () => {
  it('shapes textures per layout', () => {
    const cube = createProbeLayout('cube2d-warp', { maxLod: 4 });
    expect(cube.textureDescriptor(128, 3, 'rgba16float').size).toEqual([128, 128, 18]);
    expect(cube.mipLevelCount).toBe(5);
    const hw = createProbeLayout('cube-hw', { maxLod: 4 });
    expect(hw.viewDimension).toBe('cube-array');
    const octa = createProbeLayout('octa', { maxLod: 4 });
    expect(octa.textureDescriptor(256, 3, 'rgba16float').size).toEqual([256, 256, 3]);
    expect(octa.layersPerProbe).toBe(1);
  });
  it('counts memory per probe over every mip', () => {
    const cube = createProbeLayout('cube2d-none', { maxLod: 4 });
    // 6 faces x (128^2 + 64^2 + 32^2 + 16^2 + 8^2) texels
    expect(probeBytes(cube, 128, 'rgba16float')).toBe(6 * 21824 * 8);
    expect(probeBytes(cube, 128, 'bc6h-rgb-ufloat')).toBe(6 * 21824);
    expect(probeBytes(cube, 128, 'rgb9e5ufloat')).toBe(6 * 21824 * 4);
  });
  it('puts half a texel of octa gutter at the last mip', () => {
    expect(octaGutter(256, 4) * (256 >> 4)).toBe(0.5);
  });
});
