import { describe, expect, it } from 'vitest';
import {
  PROBE_FLAG_BOX_PROJECTION, PROBE_FLAG_ORIENTED, PROBE_HEADER_ROWS, PROBE_ROWS_PER_VOLUME, createProbeLayout, packProbeTable, probeLookupFunctionWgsl,
  probeProxyShareFunctionWgsl, probeVolumeLocal, probeVolumeRotation, probeVolumeWorldHalfSize, rotateByQuat, type ProbeQuaternion, type ProbeVolume,
} from '@pmndrs/reflections-core';

// T23 (W108): oriented probe boxes. The table carries a rotation per volume (row +5, a unit quaternion
// local -> world) and flags bit 1; an axis-aligned volume packs exactly as before (bit clear, identity
// row) so the lookup takes its old path. The grid lists an oriented box by its world bounds.

const f32 = Math.fround;
const rand = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
/** Quaternion of a rotation by `angle` about the unit `axis`. */
const axisAngle = (axis: number[], angle: number): ProbeQuaternion => {
  const l = Math.hypot(...axis), s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
/** Rodrigues' rotation of v about the unit axis k by angle (an independent reference for rotateByQuat). */
const rodrigues = (k: number[], angle: number, v: number[]) => {
  const l = Math.hypot(...k), [x, y, z] = k.map((c) => c / l), c = Math.cos(angle), s = Math.sin(angle);
  const dot = x * v[0] + y * v[1] + z * v[2];
  const cr = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]];
  return [0, 1, 2].map((a) => v[a] * c + cr[a] * s + [x, y, z][a] * dot * (1 - c));
};
const row = (t: Float32Array, i: number, r: number) => [...t.subarray((PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME + r) * 4, (PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME + r + 1) * 4)];

describe('oriented probe volumes (T23)', () => {
  const base: ProbeVolume = { slot: 0, center: [1, 2, 3], halfSize: [2, 1, 0.5], projectionSize: [5, 3, 2], projectionOffset: [0.5, 0, 0], origin: [1.2, 2, 3] };
  const header = { maxLod: 5, environmentSlot: 1 };

  it('packs an axis-aligned volume as before: flag clear, identity rotation row, rows 0-4 unchanged', () => {
    const plain = packProbeTable(header, [base]);
    expect(PROBE_ROWS_PER_VOLUME).toBe(6);
    expect(row(plain, 0, 1)[3]).toBe(PROBE_FLAG_BOX_PROJECTION);
    expect(row(plain, 0, 5)).toEqual([0, 0, 0, 1]);
    // no rotation, the identity, its negative and a zero quaternion are all axis-aligned
    for (const rotation of [[0, 0, 0, 1], [0, 0, 0, -3], [0, 0, 0, 0]] as ProbeQuaternion[]) {
      expect(probeVolumeRotation({ rotation })).toBeNull();
      expect([...packProbeTable(header, [{ ...base, rotation }])]).toEqual([...plain]);
    }
    expect(probeVolumeRotation({})).toBeNull();
  });

  it('packs an oriented volume: flag bit 1, the normalized quaternion with w >= 0, sizes and offsets as given (local frame)', () => {
    const q = axisAngle([0, 1, 0], 0.7);
    const t = packProbeTable(header, [{ ...base, rotation: [-2 * q[0], -2 * q[1], -2 * q[2], -2 * q[3]], boxProjection: false }]);
    expect(row(t, 0, 1)).toEqual([2, 1, 0.5, PROBE_FLAG_ORIENTED].map(f32));
    row(t, 0, 5).forEach((x, k) => expect(x).toBeCloseTo(q[k], 6));
    expect(row(t, 0, 0)).toEqual([1, 2, 3, 0.5]);
    expect(row(t, 0, 2).slice(0, 3)).toEqual([0.5, 0, 0]);
    expect(row(t, 0, 3).slice(0, 3)).toEqual([5, 3, 2]);
    expect(row(t, 0, 4)).toEqual([1.2, 2, 3, 0].map(f32));
    const both = packProbeTable(header, [{ ...base, rotation: q }]);
    expect(row(both, 0, 1)[3]).toBe(PROBE_FLAG_BOX_PROJECTION + PROBE_FLAG_ORIENTED);
  });

  it('rotates like the rotation matrix of its quaternion; the local frame is its inverse', () => {
    const r = rand(3);
    for (let k = 0; k < 200; k++) {
      const axis = [r() - 0.5, r() - 0.5, r() - 0.5], angle = (r() - 0.5) * 7;
      const v: [number, number, number] = [r() * 4 - 2, r() * 4 - 2, r() * 4 - 2];
      const q = axisAngle(axis, angle);
      const want = rodrigues(axis, angle, v);
      rotateByQuat(q, v).forEach((x, a) => expect(x).toBeCloseTo(want[a], 10));
      // P = centre + R v  ->  local v
      const vol = { center: [1, -2, 0.5] as const, rotation: q };
      const P = rotateByQuat(q, v).map((x, a) => x + vol.center[a]) as [number, number, number];
      probeVolumeLocal(vol, P).forEach((x, a) => expect(x).toBeCloseTo(v[a], 10));
    }
    // axis-aligned: just P - centre
    expect(probeVolumeLocal({ center: [1, 1, 1] }, [2, 3, 4])).toEqual([1, 2, 3]);
  });

  it("gives an oriented box's world bounds", () => {
    expect(probeVolumeWorldHalfSize({ halfSize: [2, 1, 0.5] })).toEqual([2, 1, 0.5]);
    const h = probeVolumeWorldHalfSize({ halfSize: [2, 1, 0.5], rotation: axisAngle([0, 1, 0], Math.PI / 4) });
    const c = Math.SQRT1_2;
    expect(h[0]).toBeCloseTo(2 * c + 0.5 * c, 10);
    expect(h[1]).toBeCloseTo(1, 10);
    expect(h[2]).toBeCloseTo(2 * c + 0.5 * c, 10);
    // every corner of the box lies within the bounds
    const r = rand(5);
    for (let k = 0; k < 50; k++) {
      const q = axisAngle([r() - 0.5, r() - 0.5, r() - 0.5], r() * 6);
      const half: [number, number, number] = [r() * 3 + 0.1, r() * 3 + 0.1, r() * 3 + 0.1];
      const b = probeVolumeWorldHalfSize({ halfSize: half, rotation: q });
      for (const s of [[-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]]) {
        const w = rotateByQuat(q, [s[0] * half[0], s[1] * half[1], s[2] * half[2]]);
        w.forEach((x, a) => expect(Math.abs(x)).toBeLessThanOrEqual(b[a] + 1e-9));
      }
    }
  });

  it('lists every oriented volume that weights P in P\'s grid cell (the local box test, in f32 as the WGSL)', () => {
    const r = rand(11);
    for (const n of [2, 8, 33]) {
      const volumes: ProbeVolume[] = Array.from({ length: n }, (_, i) => ({
        slot: i, center: [r() * 30 - 15, r() * 6, r() * 20 - 10], halfSize: [0.3 + r() * 5, 0.3 + r() * 3, 0.3 + r() * 5], fade: 0.2,
        ...(i % 3 === 2 ? {} : { rotation: axisAngle([r() - 0.5, r() - 0.5, r() - 0.5], r() * 6) }),
      }));
      const t = packProbeTable({ maxLod: 5, environmentSlot: n, capacity: n }, volumes);
      const g = t[6];
      expect(g).toBeGreaterThan(0);
      const g0 = t.subarray(g * 4, g * 4 + 4), g1 = t.subarray(g * 4 + 4, g * 4 + 8);
      let tested = 0;
      for (let k = 0; k < 6000; k++) {
        const v = volumes[Math.floor(r() * n)];
        // points near and inside the chosen box: a local point scaled past the faces, to world
        const local: [number, number, number] = [0, 1, 2].map((a) => (r() * 2.2 - 1.1) * v.halfSize[a]) as [number, number, number];
        const P = (v.rotation ? rotateByQuat(probeVolumeRotation(v)!, local) : local).map((x, a) => x + v.center[a]);
        const want: number[] = [];
        volumes.forEach((u, i) => {
          // the WGSL: lp = toLocal(q, P - centre) in f32, inside = min(half - |lp|) > 0
          const lp = probeVolumeLocal(u, P.map(f32) as [number, number, number]).map(f32);
          if (Math.min(...[0, 1, 2].map((a) => f32(u.halfSize[a] - Math.abs(lp[a])))) > 0) want.push(i);
        });
        const c = [0, 1, 2].map((a) => Math.floor(f32(f32(P[a] - g0[a]) * g0[3])));
        expect(c.every((x, a) => x >= 0 && x < g1[a]) || want.length === 0).toBe(true);
        if (want.length === 0) continue;
        const cell = g + 2 + (c[0] + g1[0] * (c[1] + g1[1] * c[2])) * g1[3];
        const got: number[] = [];
        for (let l = 0; l * 24 < n; l++) {
          const m = t[(cell + (l >> 2)) * 4 + (l & 3)];
          for (let b = 0; b < 24; b++) if (Math.floor(m / 2 ** b) % 2 === 1) got.push(l * 24 + b);
        }
        for (const i of want) expect(got).toContain(i);
        tested++;
      }
      expect(tested).toBeGreaterThan(1000);
    }
  }, 30_000);

  it('compiles the oriented path by default and leaves it out with orientedVolumes: false', () => {
    const layout = createProbeLayout('cube-hw', { maxLod: 5 });
    for (const count of [undefined, 3, 12]) {
      expect(probeLookupFunctionWgsl({ layout, count })).toContain('pr_toLocal(pr_q, lp)');
      const off = probeLookupFunctionWgsl({ layout, count, orientedVolumes: false });
      expect(off).not.toContain('pr_or');
      expect(off).toContain('let lp = P - r0.xyz;');
      expect(probeProxyShareFunctionWgsl({ count })).toContain('pr_toLocal(pr_q, dir)');
      expect(probeProxyShareFunctionWgsl({ count, orientedVolumes: false })).not.toContain('pr_or');
    }
    // the seam options (distance roughness: t in the local frame for an oriented volume)
    expect(probeLookupFunctionWgsl({ layout, distanceRoughness: true })).toContain('if (pr_or) { t = pr_parallaxDistance(lp, pr_toLocal(pr_q, dir), r3.xyz, r2.xyz); }');
  });
});
