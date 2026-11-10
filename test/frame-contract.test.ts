import { describe, expect, it } from 'vitest';
import { FrameCameraHistory, mat4Multiply } from '../packages/core/src/frame/contract';

// column-major helpers
const translate = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale = (s: number) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];

describe('frame contract', () => {
  it('mat4Multiply is column-major a·b', () => {
    // (T · S) p = T(S p): scale first, then translate
    const m = mat4Multiply(translate(1, 2, 3), scale(2));
    expect([...m.slice(12, 15)]).toEqual([1, 2, 3]);
    expect(m[0]).toBe(2);
    const n = mat4Multiply(scale(2), translate(1, 2, 3));
    expect([...n.slice(12, 15)]).toEqual([2, 4, 6]);
  });

  it('FrameCameraHistory hands back last frame as prev; prevViewProjection = prevProjection · prevView', () => {
    const h = new FrameCameraHistory();
    const base = { near: 0.1, far: 100, position: [0, 0, 0] as const };
    const f0 = h.update({ ...base, view: translate(0, 0, -1), projection: scale(3) });
    expect(Array.from(f0.prevView)).toEqual(Array.from(f0.view)); // first frame: no history, prev = current
    const f1 = h.update({ ...base, view: translate(0, 0, -2), projection: scale(3) });
    expect(Array.from(f1.prevView)).toEqual(translate(0, 0, -1));
    expect(Array.from(f1.prevViewProjection)).toEqual([...mat4Multiply(scale(3), translate(0, 0, -1))]);
    expect(f1.jitter).toEqual([0, 0]);
    h.reset();
    const f2 = h.update({ ...base, view: translate(0, 0, -5), projection: scale(3) });
    expect(Array.from(f2.prevView)).toEqual(translate(0, 0, -5));
  });
});
