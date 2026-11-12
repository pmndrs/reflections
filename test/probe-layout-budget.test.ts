import { describe, expect, it } from 'vitest';
import { PROBE_MAX_ATLASES, createProbeLayout, planProbeAtlases, probeBytes } from '@pmndrs/reflections-core';
import {
  LAYOUT_SET_RESOLUTION, PROBE_LAYOUT_BUDGET, PROBE_LAYOUT_NAMES, PROBE_LAYOUT_TOLERANCE, cubeBytes, gridProbes, probeLayout, type LayoutRegion,
} from '../examples/shared/probeLayouts';
import type { ProbeVolume } from '../examples/shared/kit';

// W61: the probe layouts at an equal memory budget (examples/shared/probeLayouts.ts). The pure
// parts: every non-shipped layout within 10 % of the budget, at most four sizes and 41 probes per
// atlas (256 array layers), and the grid's claim that a point inside a region gets the whole weight
// from the volumes (walked as core's lookup walks them). The bakes and views run on the GPU
// (`pnpm check -- --only probe-layouts`).
const stub = (n: number, sizes: (number | undefined)[] = []): ProbeVolume[] =>
  Array.from({ length: n }, (_, i) => ({ position: [i, 1, 0], influenceSize: [2, 2, 2], ...(sizes[i] ? { resolution: sizes[i] } : {}) }));
const SHIPPED: Record<string, ProbeVolume[]> = { rooms: stub(3), offscreen: stub(3, [undefined, 512, 512]), sponza: stub(7) };

/** Core's walk (lookup.ts): volumes smallest first, each takes clamp(inside / fade) of what is left. */
function weightSum(volumes: ProbeVolume[], P: [number, number, number]) {
  const vol = (v: ProbeVolume) => v.influenceSize[0] * v.influenceSize[1] * v.influenceSize[2];
  const sorted = volumes.map((v, i) => ({ v, i })).sort((a, b) => vol(a.v) - vol(b.v) || a.i - b.i).map(({ v }) => v);
  let remaining = 1;
  for (const v of sorted) {
    const inside = Math.min(...[0, 1, 2].map((k) => v.influenceSize[k] / 2 - Math.abs(P[k] - v.position[k])));
    remaining -= Math.min(1, Math.max(0, inside / (v.blendDistance ?? 0.5))) * remaining;
  }
  return 1 - remaining;
}

describe('probe layouts at an equal memory budget (W61)', () => {
  it('counts bytes as the bake allocates them', () => {
    for (const s of [128, 256, 512, 1024]) expect(cubeBytes(s)).toBe(probeBytes(createProbeLayout('cube-hw', { maxLod: Math.log2(s) - 3 }), s, 'rgba16float'));
    expect(PROBE_LAYOUT_BUDGET).toBe(8 * cubeBytes(256) + cubeBytes(128));
  });

  for (const scene of Object.keys(SHIPPED)) {
    it(`${scene}: every layout within ${PROBE_LAYOUT_TOLERANCE * 100} % of the budget, <= 4 sizes, <= 41 probes per atlas`, () => {
      for (const name of PROBE_LAYOUT_NAMES) {
        const L = probeLayout(scene, name, SHIPPED[scene])!;
        if (name !== 'shipped') {
          expect(Math.abs(L.bytes / PROBE_LAYOUT_BUDGET - 1), `${scene} ${name}`).toBeLessThanOrEqual(PROBE_LAYOUT_TOLERANCE);
          expect(L.resolution).toBe(LAYOUT_SET_RESOLUTION);
        }
        const plan = planProbeAtlases(L.volumes.map((v) => v.resolution ?? null), L.resolution);
        expect(plan.resolutions.length).toBeLessThanOrEqual(PROBE_MAX_ATLASES);
        for (const n of plan.slots) expect(n * 6, `${scene} ${name}: array layers`).toBeLessThanOrEqual(256);
      }
      expect(probeLayout(scene, 'many', SHIPPED[scene])!.volumes.length).toBeGreaterThanOrEqual(30);
    });
  }

  it('a grid gives every point inside its regions the whole weight, at every blend', () => {
    const regions: LayoutRegion[] = [{ name: 'a', min: [-8, 0, -4], max: [0, 5, 4] }, { name: 'b', min: [0, 0, -4], max: [8, 3, 4] }];
    for (const blend of [0.05, 0.25, 0.5]) for (const cellProjection of [false, true]) {
      const { volumes } = gridProbes(regions, 32, { resolution: 128, blend, cellProjection });
      expect(volumes.length).toBe(32);
      for (let i = 0; i < 400; i++) {
        const r = regions[i % 2];
        const P = [0, 1, 2].map((k) => r.min[k] + ((i * [0.618, 0.414, 0.732][k]) % 1) * (r.max[k] - r.min[k])) as [number, number, number];
        expect(weightSum(volumes, P)).toBeCloseTo(1, 6);
      }
    }
  });

  it('mixed layouts take their floor slabs before the grid cells (smaller influence volume)', () => {
    const vol = (v: ProbeVolume) => v.influenceSize[0] * v.influenceSize[1] * v.influenceSize[2];
    for (const scene of ['rooms', 'sponza']) {
      const { volumes } = probeLayout(scene, 'mixed', SHIPPED[scene])!;
      const slabs = volumes.filter((v) => v.influenceSize[1] < 1), cells = volumes.filter((v) => v.influenceSize[1] >= 1);
      expect(slabs.length).toBeGreaterThan(0);
      expect(Math.max(...slabs.map(vol))).toBeLessThan(Math.min(...cells.map(vol)));
    }
  });
});
