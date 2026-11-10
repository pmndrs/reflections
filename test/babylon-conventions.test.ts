import { describe, expect, it } from 'vitest';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { mat4Multiply } from '../packages/core/src/frame/contract';
import { tracerProjection, tracerView } from '../packages/babylon/src/conventions';

// column-major matrix times a point
const apply = (m: ArrayLike<number>, p: number[]) => [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);

describe('babylon conventions (D1800, D1801)', () => {
  // a left-handed Babylon camera at +z looking toward -z, WebGPU [0, 1] depth
  const view = Matrix.LookAtLH(new Vector3(0.3, 1.5, 5.5), new Vector3(0, 1, -3), Vector3.Up());
  const projection = Matrix.PerspectiveFovLH(0.87, 16 / 9, 0.05, 100, undefined, undefined, true);
  const point = [0.4, 0.8, -1.2, 1];

  it('the tracer view is right-handed: points in front of the camera have view z < 0', () => {
    expect(apply(view.m, point)[2]).toBeGreaterThan(0); // Babylon: +z forward
    expect(apply(tracerView(view.m), point)[2]).toBeLessThan(0);
  });

  it('tracer clip = Babylon clip with y negated (Y-flipped targets), depth unchanged', () => {
    const babylon = apply(mat4Multiply(projection.m, view.m), point);
    const tracer = apply(mat4Multiply(tracerProjection(projection.m), tracerView(view.m)), point);
    expect(tracer[0]).toBeCloseTo(babylon[0], 5);
    expect(tracer[1]).toBeCloseTo(-babylon[1], 5);
    expect(tracer[2]).toBeCloseTo(babylon[2], 5);
    expect(tracer[3]).toBeCloseTo(babylon[3], 5);
    const depth = tracer[2] / tracer[3];
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(1);
  });
});
