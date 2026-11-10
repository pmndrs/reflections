import { describe, expect, it } from 'vitest';
import { LOD_MIN, lodToRoughness, maxLodFor } from '@pmndrs/reflections-core';

// GPU-free: the roughness <-> mip mapping the prefilter writes and every lookup reads.
// It must stay three r187's cube PMREM mapping (docs/SPEC.md, "Probes").
describe('probe mip chain', () => {
  it('stops at 8 px faces', () => {
    expect(LOD_MIN).toBe(3);
    expect(maxLodFor(256)).toBe(5);
    expect(maxLodFor(128)).toBe(4);
  });
  it('maps lod 0 to mirror and the last lod to fully rough', () => {
    expect(lodToRoughness(0, 5)).toBe(0);
    expect(lodToRoughness(5, 5)).toBe(1);
    expect(lodToRoughness(0, 0)).toBe(0);
  });
  it('inverts the lookup mapping lod = maxLod * r * (2 - r)', () => {
    const maxLod = 5;
    for (let lod = 0; lod <= maxLod; lod++) {
      const r = lodToRoughness(lod, maxLod);
      expect(maxLod * r * (2 - r)).toBeCloseTo(lod, 10);
    }
  });
});
