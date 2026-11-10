import { describe, expect, it } from 'vitest';
import { mat4Multiply } from '../packages/core/src/frame/contract';
import { cameraFromPixi3D, eyeFromView, mat4Invert, projectionToZeroOne } from '../packages/pixi/src/frame';

// column-major matrix times a point
const apply = (m: ArrayLike<number>, p: number[]) => [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);

// A GL perspective (clip z in [-w, w]), the convention pixi-3d's Camera3D builds.
function glPerspective(fovY: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovY / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}
// World to camera for an eye looking at a target (right-handed, -Z forward), column-major.
function lookAtView(eye: number[], target: number[]) {
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = norm(sub(eye, target)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

describe('pixi adapter: a pixi-3d camera as the frame contract wants it', () => {
  const eye = [0.3, 1.5, 5.5], target = [0, 1, -3];
  const view = lookAtView(eye, target);
  const gl = glPerspective(0.87, 16 / 9, 0.05, 100);

  it('remaps GL clip z to WebGPU [0, 1] (0 at near, 1 at far) and keeps x, y', () => {
    const p = projectionToZeroOne(gl);
    const near = apply(p, [0, 0, -0.05, 1]), far = apply(p, [0, 0, -100, 1]);
    expect(near[2] / near[3]).toBeCloseTo(0, 6);
    expect(far[2] / far[3]).toBeCloseTo(1, 5);
    const a = apply(gl, [0.4, -0.2, -3, 1]), b = apply(p, [0.4, -0.2, -3, 1]);
    expect(b[0] / b[3]).toBeCloseTo(a[0] / a[3], 6);
    expect(b[1] / b[3]).toBeCloseTo(a[1] / a[3], 6);
  });

  it('finds the eye from the view matrix', () => {
    expect(eyeFromView(view).map((x) => Number(x.toFixed(5)))).toEqual(eye);
  });

  it('cameraFromPixi3D: the target projects to the centre, the inverse undoes the view-projection', () => {
    const cam = cameraFromPixi3D({ view: { elements: view }, unjitteredProjection: { elements: gl }, projection: { elements: gl }, near: 0.05, far: 100 });
    const vp = mat4Multiply(cam.projection, cam.view);
    const c = apply(vp, [...target, 1]);
    expect(c[0] / c[3]).toBeCloseTo(0, 6);
    expect(c[1] / c[3]).toBeCloseTo(0, 6);
    const back = apply(mat4Invert(vp), c);
    expect(back.slice(0, 3).map((x) => x / back[3])).toEqual(target.map((x) => expect.closeTo(x, 4)));
    expect(cam.jitter).toEqual([0, 0]);
  });
});
