// Column-major 4x4 helpers for the adapter's 3-D layer (pixi is 2-D and has no 3-D matrices). The
// frame contract's conventions are three's (right-handed, the camera looks down -Z, WebGPU clip z in
// [0, 1]), so these build exactly those matrices and the camera passes to core as is.
export type Vec3 = readonly [number, number, number];
export type Mat4 = Float32Array;

export const mat4Identity = (out: Mat4 = new Float32Array(16)): Mat4 => {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
};

export function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>, out: Mat4 = new Float32Array(16)): Mat4 {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
    r[c * 4 + row] = s;
  }
  out.set(r);
  return out;
}

export function mat4Invert(m: ArrayLike<number>, out: Mat4 = new Float32Array(16)): Mat4 {
  const a = Array.from(m);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = det ? 1 / det : 0;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

export function mat4Transpose(m: ArrayLike<number>, out: Mat4 = new Float32Array(16)): Mat4 {
  const a = Array.from(m);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r * 4 + c];
  return out;
}

const sub = (a: Vec3, b: Vec3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const normalize3 = (a: Vec3): [number, number, number] => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A view matrix from its basis: view x = right, y = up, z = back (-forward). The basis may be left-handed (cube faces). */
export function mat4FromBasis(eye: Vec3, right: Vec3, up: Vec3, back: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  out.set([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1,
  ]);
  return out;
}

/** Right-handed look-at view matrix (camera looks down -Z), as three's camera.matrixWorldInverse. */
export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0], out: Mat4 = new Float32Array(16)): Mat4 {
  const back = normalize3(sub(eye, target));
  let right = cross(up, back);
  if (Math.hypot(...right) < 1e-6) right = cross([0, 0, 1], back);
  right = normalize3(right);
  return mat4FromBasis(eye, right, cross(back, right), back, out);
}

/** WebGPU perspective (clip z in [0, 1], 0 at near), vertical fov in radians. */
export function mat4Perspective(fovY: number, aspect: number, near: number, far: number, out: Mat4 = new Float32Array(16)): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (near * far) / (near - far);
  return out;
}

/** WebGPU orthographic projection (clip z in [0, 1]). */
export function mat4Ortho(l: number, r: number, b: number, t: number, near: number, far: number, out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = 2 / (r - l);
  out[5] = 2 / (t - b);
  out[10] = 1 / (near - far);
  out[12] = (l + r) / (l - r);
  out[13] = (t + b) / (b - t);
  out[14] = near / (near - far);
  out[15] = 1;
  return out;
}

/** Translation * rotation (Euler XYZ, radians, three's default order) * scale. */
export function mat4Compose(position: Vec3, rotation: Vec3, scale: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  const [x, y, z] = rotation;
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  // three's Matrix4.makeRotationFromEuler, order 'XYZ'
  const m = [
    c * e, af + be * d, bf - ae * d, 0,
    -c * f, ae - bf * d, be + af * d, 0,
    d, -b * c, a * c, 0,
    0, 0, 0, 1,
  ];
  for (let i = 0; i < 3; i++) { m[i] *= scale[0]; m[4 + i] *= scale[1]; m[8 + i] *= scale[2]; }
  m[12] = position[0]; m[13] = position[1]; m[14] = position[2];
  out.set(m);
  return out;
}
