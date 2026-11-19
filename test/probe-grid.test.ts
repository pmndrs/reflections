import { describe, expect, it } from 'vitest';
import {
  PROBE_HEADER_ROWS, PROBE_ROWS_PER_VOLUME, packProbeTable, probeIrradianceRow, probeTableRows, sortProbeVolumes, type ProbeVolume,
} from '@pmndrs/reflections-core';

// The volume grid (W63, D4950): the lookup walks only the volumes listed in P's cell, so the grid
// must list every volume that gives P weight (P strictly inside its influence box), in table order.
// This walks the packed rows on the CPU as the WGSL does (f32 maths) at random points and compares
// against the full walk's set of volumes with weight > 0.

const f32 = Math.fround;
/** Indices the lookup's grid walk visits at P (an empty list outside the grid). */
function gridList(t: Float32Array, P: readonly number[]): number[] | null {
  const g = t[4 + 2];
  if (g === 0) return null;
  const g0 = t.subarray(g * 4, g * 4 + 4), g1 = t.subarray(g * 4 + 4, g * 4 + 8);
  const c = [0, 1, 2].map((a) => Math.floor(f32(f32(P[a] - g0[a]) * g0[3])));
  if (c.some((x, a) => x < 0 || x >= g1[a])) return [];
  const cell = g + 2 + (c[0] + g1[0] * (c[1] + g1[1] * c[2])) * g1[3];
  const count = t[0], out: number[] = [];
  for (let l = 0; l * 24 < count; l++) {
    const m = t[(cell + (l >> 2)) * 4 + (l & 3)];
    for (let b = 0; b < 24; b++) if (Math.floor(m / 2 ** b) % 2 === 1) out.push(l * 24 + b);
  }
  return out;
}
/** Indices the full walk gives weight at P: P strictly inside the influence box (f32, as the WGSL). */
function weighted(t: Float32Array, P: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < t[0]; i++) {
    const b = (PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME) * 4;
    const inside = Math.min(...[0, 1, 2].map((a) => f32(t[b + 4 + a] - Math.abs(f32(P[a] - t[b + a])))));
    if (inside > 0) out.push(i);
  }
  return out;
}

const rand = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

describe('probe volume grid (W63)', () => {
  it('lists every weighted volume, in table order, for random grids of 2 to 120 volumes', () => {
    const r = rand(7);
    for (const n of [2, 4, 8, 16, 33, 64, 120]) {
      const volumes: ProbeVolume[] = Array.from({ length: n }, (_, i) => ({
        slot: i, center: [r() * 40 - 20, r() * 6, r() * 30 - 15], halfSize: [0.5 + r() * 6, 0.5 + r() * 3, 0.5 + r() * 6], fade: 0.3,
      }));
      // a masked-out volume (three's one-atlas pack): empty box, in no cell
      volumes[1] = { ...volumes[1], halfSize: [-1, -1, -1] };
      const sorted = sortProbeVolumes(volumes);
      const t = packProbeTable({ maxLod: 5, environmentSlot: n, capacity: n, irradianceRow: probeIrradianceRow(n) }, sorted);
      expect(t.length / 4).toBeLessThanOrEqual(probeIrradianceRow(n));
      expect(probeTableRows(n, n + 1)).toBe(probeIrradianceRow(n) + 3 * (n + 1));
      let listed = 0, hits = 0;
      for (let k = 0; k < 4000; k++) {
        // points near box faces too: a face coordinate plus a tiny offset
        const v = sorted[Math.floor(r() * n)];
        const P = k % 2 === 0
          ? [r() * 50 - 25, r() * 10 - 2, r() * 40 - 20]
          : [0, 1, 2].map((a) => v.center[a] + (r() < 0.5 ? -1 : 1) * v.halfSize[a] * (r() < 0.3 ? 1 : r()) + (r() - 0.5) * 1e-5);
        const want = weighted(t, P), got = gridList(t, P)!;
        for (const i of want) expect(got).toContain(i);
        expect([...got].sort((a, b) => a - b)).toEqual(got); // table order
        listed += got.length; hits += want.length;
      }
      // the grid prunes: far fewer listed than n per point
      expect(listed / 4000).toBeLessThan(Math.max(4, hits / 4000 * 4));
    }
  }, 30_000); // ~1-2 s idle; timed out at the 5 s default under load (W80, W82 logs)

  it('packs no grid without a capacity, or below two volumes', () => {
    const v: ProbeVolume = { slot: 0, center: [0, 0, 0], halfSize: [1, 1, 1] };
    expect(packProbeTable({ maxLod: 5, environmentSlot: 1 }, [v])[6]).toBe(0);
    expect(packProbeTable({ maxLod: 5, environmentSlot: 1, capacity: 1 }, [v])[6]).toBe(0);
    expect(probeIrradianceRow(1)).toBe(PROBE_HEADER_ROWS + PROBE_ROWS_PER_VOLUME);
    expect(packProbeTable({ maxLod: 5, environmentSlot: 2, capacity: 2 }, [v, v])[6]).toBe(PROBE_HEADER_ROWS + 2 * PROBE_ROWS_PER_VOLUME);
  });
});
