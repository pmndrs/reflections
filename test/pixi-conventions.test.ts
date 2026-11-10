import { describe, expect, it } from 'vitest';
import { mat4Multiply } from '../packages/core/src/frame/contract';
import { CUBE_FACE_BASES, mat4FromBasis, mat4LookAt, mat4Ortho, mat4Perspective } from '../packages/pixi/src/math';

// column-major matrix times a point
const apply = (m: ArrayLike<number>, p: number[]) => [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);

describe('pixi adapter conventions (the frame contract\'s own)', () => {
  const view = mat4LookAt([0.3, 1.5, 5.5], [0, 1, -3]);
  const projection = mat4Perspective(0.87, 16 / 9, 0.05, 100);

  it('view space is right-handed with -Z forward; clip z is WebGPU [0, 1], 0 at near', () => {
    expect(apply(view, [0, 1, -3, 1])[2]).toBeLessThan(0);
    const near = apply(projection, [0, 0, -0.05, 1]), far = apply(projection, [0, 0, -100, 1]);
    expect(near[2] / near[3]).toBeCloseTo(0, 6);
    expect(far[2] / far[3]).toBeCloseTo(1, 6);
    const p = apply(mat4Multiply(projection, view), [0, 1, -3, 1]);
    expect(p[0] / p[3]).toBeCloseTo(0, 6);
    expect(p[1] / p[3]).toBeCloseTo(0, 6);
  });

  it('ortho maps the box to clip x, y in [-1, 1] and z in [0, 1]', () => {
    const o = mat4Ortho(-2, 2, -1, 1, 0.5, 10);
    const a = apply(o, [2, 1, -0.5, 1]), b = apply(o, [-2, -1, -10, 1]);
    expect(a.slice(0, 3)).toEqual([1, 1, 0].map((x) => expect.closeTo(x, 6)));
    expect(b.slice(0, 3)).toEqual([-1, -1, 1].map((x) => expect.closeTo(x, 6)));
  });

  it('cube capture faces put texel (u, v) on the direction a WebGPU texture_cube lookup maps it to', () => {
    // WebGPU / D3D cube addressing: major axis, then (sc, tc) per face; u = (sc / |ma| + 1) / 2, v likewise (rows top-down)
    const lookup = (d: number[]) => {
      const [x, y, z] = d, ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
      let face, sc, tc, ma;
      if (ax >= ay && ax >= az) { face = x > 0 ? 0 : 1; ma = ax; sc = x > 0 ? -z : z; tc = -y; }
      else if (ay >= az) { face = y > 0 ? 2 : 3; ma = ay; sc = x; tc = y > 0 ? z : -z; }
      else { face = z > 0 ? 4 : 5; ma = az; sc = z > 0 ? x : -x; tc = -y; }
      return { face, u: (sc / ma + 1) / 2, v: (tc / ma + 1) / 2 };
    };
    const proj = mat4Perspective(Math.PI / 2, 1, 0.1, 10);
    CUBE_FACE_BASES.forEach((f, face) => {
      const back = f.forward.map((c) => -c) as [number, number, number];
      const vp = mat4Multiply(proj, mat4FromBasis([0, 0, 0], f.right, f.up, back));
      for (const [u, v] of [[0.2, 0.3], [0.8, 0.1], [0.5, 0.5], [0.1, 0.9]]) {
        // the direction the capture renders at texel (u, v): invert the view basis by hand
        const sx = u * 2 - 1, sy = 1 - v * 2;
        const dir = [0, 1, 2].map((i) => f.forward[i] + sx * f.right[i] + sy * f.up[i]);
        const c = apply(vp, [...dir, 1]);
        expect(c[0] / c[3]).toBeCloseTo(sx, 5);
        expect(c[1] / c[3]).toBeCloseTo(sy, 5);
        const hit = lookup(dir);
        expect(hit.face).toBe(face);
        expect(hit.u).toBeCloseTo(u, 5);
        expect(hit.v).toBeCloseTo(v, 5);
      }
    });
  });
});
