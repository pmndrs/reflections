// The two rooms of examples/shared/rooms.ts as plain data for the raw-WebGPU page: triangle meshes (position + normal),
// a model matrix, a material (linear base colour, perceptual roughness, metalness) and the probes and lights. No engine:
// the generators follow three's (BoxGeometry, SphereGeometry, CylinderGeometry, TorusKnotGeometry) so the rooms match.

export type V3 = [number, number, number];
/** Column-major 4 x 4 (WGSL mat4x4f). */
export type M4 = Float32Array;

export interface Geometry { vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }
export interface SceneMesh {
  name: string;
  geometry: Geometry;
  model: M4;
  /** Linear base colour, perceptual roughness, metalness. */
  color: V3; roughness: number; metalness: number;
  castShadow: boolean; receiveShadow: boolean;
  /** In the probe captures (the mirror ball is not: it would paint itself into the rooms). */
  inProbes: boolean;
}

// ---- matrices ---------------------------------------------------------------------------------------------------
export const identity = (): M4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Translation t, then rotation about x by rx, about y by ry (three's Object3D with Euler 'XYZ', one axis at a time). */
export function transform(t: V3, rx = 0, ry = 0, sx = 1): M4 {
  const [cx, sxn, cy, sy] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry)];
  // R = Rx * Ry (three's XYZ order: rotate by y first, then x), times scale on x
  return new Float32Array([
    cy * sx, sxn * sy * sx, -cx * sy * sx, 0,
    0, cx, sxn, 0,
    sy, -sxn * cy, cx * cy, 0,
    t[0], t[1], t[2], 1,
  ]);
}
/** WebGPU perspective (depth 0 at near, 1 at far), right-handed, looking down -z: three's PerspectiveCamera. */
export function perspective(fovY: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (far * near) / (near - far), 0]);
}
/** World to view with the view's x, y axes `right`, `up` and looking along `forward` (rows right, up, -forward). */
export function viewMatrix(eye: V3, right: V3, up: V3, forward: V3): M4 {
  const d = (a: V3) => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  return new Float32Array([
    right[0], up[0], -forward[0], 0,
    right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0,
    -d(right), -d(up), d(forward), 1,
  ]);
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export function lookAt(eye: V3, target: V3): M4 {
  const f = norm(sub(target, eye)), r = norm(cross(f, [0, 1, 0]));
  return viewMatrix(eye, r, cross(r, f), f);
}
/**
 * The six cube faces in WebGPU's cube convention (+X, -X, +Y, -Y, +Z, -Z): right, up, forward of a 90-degree camera
 * whose image is the face as a `texture_cube` reads it (no mirroring to undo, unlike three's CubeCamera).
 */
export const CUBE_FACES: readonly [V3, V3, V3][] = [
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]], [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
];

// ---- geometry (three's generators) ------------------------------------------------------------------------------
function build(verts: number[], idx: number[]): Geometry { return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) }; }

function box(w: number, h: number, d: number, inward = false): Geometry {
  const v: number[] = [], i: number[] = [];
  const s = inward ? -1 : 1;
  // each face: normal axis, u axis, v axis
  const faces: [V3, V3, V3][] = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  const half: V3 = [w / 2, h / 2, d / 2];
  for (const [n, u, t] of faces) {
    const base = v.length / 6;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) v.push((n[k] + a * u[k] + b * t[k]) * half[k]);
      v.push(n[0] * s, n[1] * s, n[2] * s);
    }
    // counter-clockwise seen from the side the normal points to (inward: the other way round)
    i.push(...(inward ? [base, base + 2, base + 1, base, base + 3, base + 2] : [base, base + 1, base + 2, base, base + 2, base + 3]));
  }
  return build(v, i);
}
const plane = (w: number, h: number): Geometry =>
  build([-w / 2, -h / 2, 0, 0, 0, 1, w / 2, -h / 2, 0, 0, 0, 1, w / 2, h / 2, 0, 0, 0, 1, -w / 2, h / 2, 0, 0, 0, 1], [0, 1, 2, 0, 2, 3]);

/** A (columns + 1) x (rows + 1) grid of vertices from f(u, v) -> [position, normal], two triangles per cell (CCW when dP/dv x dP/du is the normal). */
function grid(cols: number, rows: number, f: (u: number, v: number) => [V3, V3]): Geometry {
  const v: number[] = [], i: number[] = [];
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= cols; x++) { const [p, n] = f(x / cols, y / rows); v.push(...p, ...n); }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const a = y * (cols + 1) + x, b = a + cols + 1;
    i.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return build(v, i);
}
const sphere = (r: number, ws: number, hs: number) => grid(ws, hs, (u, v) => {
  const phi = u * 2 * Math.PI, theta = v * Math.PI;
  const n: V3 = [-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)];
  return [[n[0] * r, n[1] * r, n[2] * r], n];
});
function merge(...gs: Geometry[]): Geometry {
  const v: number[] = [], i: number[] = [];
  for (const g of gs) { const base = v.length / 6; v.push(...g.vertices); i.push(...[...g.indices].map((k) => k + base)); }
  return build(v, i);
}
function cylinder(rTop: number, rBottom: number, h: number, radial: number): Geometry {
  const slope = (rBottom - rTop) / h;
  const side = grid(radial, 1, (u, v) => {
    const t = u * 2 * Math.PI, r = v * (rBottom - rTop) + rTop;
    return [[r * Math.sin(t), -v * h + h / 2, r * Math.cos(t)], norm([Math.sin(t), slope, Math.cos(t)])];
  });
  const cap = (r: number, y: number, ny: number) => {
    const v: number[] = [0, y, 0, 0, ny, 0], i: number[] = [];
    for (let k = 0; k <= radial; k++) { const t = (k / radial) * 2 * Math.PI; v.push(r * Math.sin(t), y, r * Math.cos(t), 0, ny, 0); }
    for (let k = 1; k <= radial; k++) i.push(...(ny > 0 ? [0, k, k + 1] : [0, k + 1, k]));
    return build(v, i);
  };
  return merge(side, ...(rTop > 0 ? [cap(rTop, h / 2, 1)] : []), cap(rBottom, -h / 2, -1));
}
function torusKnot(radius: number, tube: number, tubular: number, radial: number, p = 2, q = 3): Geometry {
  const at = (u: number): V3 => {
    const qu = (q / p) * u, cs = Math.cos(qu);
    return [radius * (2 + cs) * 0.5 * Math.cos(u), radius * (2 + cs) * Math.sin(u) * 0.5, radius * Math.sin(qu) * 0.5];
  };
  return grid(radial, tubular, (j, i) => {
    const u = i * p * Math.PI * 2, p1 = at(u), p2 = at(u + 0.01);
    const T = sub(p2, p1), B = norm(cross(T, [p1[0] + p2[0], p1[1] + p2[1], p1[2] + p2[2]])), N = norm(cross(B, T));
    const v = j * Math.PI * 2, cx = -tube * Math.cos(v), cy = tube * Math.sin(v);
    const P: V3 = [p1[0] + cx * N[0] + cy * B[0], p1[1] + cx * N[1] + cy * B[1], p1[2] + cx * N[2] + cy * B[2]];
    return [P, norm(sub(P, p1))];
  });
}

// ---- the rooms --------------------------------------------------------------------------------------------------
const srgb = (c: number) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
/** A colour as three takes `0xrrggbb`: sRGB, converted to linear. */
export const linear = (hex: number): V3 => [srgb(((hex >> 16) & 255) / 255), srgb(((hex >> 8) & 255) / 255), srgb((hex & 255) / 255)];

export function buildRooms() {
  const meshes: SceneMesh[] = [];
  const add = (name: string, geometry: Geometry, model: M4, hex: number, roughness = 1, metalness = 0, cast = true, receive = true) => {
    const m: SceneMesh = { name, geometry, model, color: linear(hex), roughness, metalness, castShadow: cast, receiveShadow: receive, inProbes: true };
    meshes.push(m);
    return m;
  };
  add('shell', box(16, 5, 8, true), transform([0, 2.5, 0]), 0xcccccc, 1, 0, false);
  add('floor', plane(16, 8), transform([0, 0.002, 0], -Math.PI / 2), 0x5c5650, 0.12, 0, false);
  add('redWall', plane(8, 5), transform([-7.99, 2.5, 0], 0, Math.PI / 2), 0xdd2200, 1, 0, false, false);
  add('blueWall', plane(8, 5), transform([7.99, 2.5, 0], 0, -Math.PI / 2), 0x0044ff, 1, 0, false, false);
  const gap = 1.25;
  add('divider', box(0.3, 5, 4 - gap), transform([0, 2.5, -(gap + (4 - gap) / 2)]), 0xcccccc);
  add('divider', box(0.3, 5, 4 - gap), transform([0, 2.5, gap + (4 - gap) / 2]), 0xcccccc);
  add('lintel', box(0.3, 1.2, gap * 2), transform([0, 4.4, 0]), 0xcccccc);
  const column = cylinder(0.3, 0.3, 4, 16);
  for (const x of [-6, -2, 2, 6]) for (const z of [-2.5, 2.5]) add('column', column, transform([x, 2, z]), 0xeeeeee);
  add('table', box(2.4, 0.12, 1.4), transform([-4, 1, 0]), 0x886644);
  const leg = box(0.1, 1, 0.1);
  for (const x of [-5.05, -2.95]) for (const z of [-0.55, 0.55]) add('leg', leg, transform([x, 0.5, z]), 0x886644, 1, 0, true, false);
  add('gold', sphere(0.35, 32, 32), transform([-4, 1.41, 0]), 0xffd700, 0.4, 0.3);
  add('step', box(1.5, 0.5, 1), transform([-7, 0.25, 0]), 0xeeeeee);
  add('step', box(1, 1, 1), transform([-7, 0.5, 0]), 0xeeeeee);
  add('step', box(0.5, 1.5, 1), transform([-7, 0.75, 0]), 0xeeeeee);
  add('plinth', box(0.8, 1.2, 0.8), transform([4, 0.6, 0]), 0xeeeeee);
  const knot = add('knot', torusKnot(0.3, 0.1, 64, 16), transform([4, 1.65, 0]), 0xff44aa, 0.5, 0.2);
  add('cone', cylinder(0, 0.4, 2.5, 5), transform([6.5, 1.25, -1.5]), 0xeeeeee);
  const ball = add('mirrorBall', sphere(4.5 * 0.12, 48, 32), transform([0, 1.2, 0]), 0xffffff, 0, 1);
  ball.inProbes = false;
  const update = (t: number) => {
    knot.model = transform([4, 1.65, 0], 0, t * 0.5);
    const phase = (t + 2.2) * 0.35;
    ball.model = transform([5.6 * Math.sin(phase), 1.2, 1.4 * Math.sin(2 * phase)]);
  };
  update(0);
  return {
    meshes, update,
    /** Point lights: position, linear colour x intensity (three's PointLight(color, 30), inverse-square falloff). */
    lights: ([[0xffaa44, -4], [0x88bbff, 4]] as const).map(([hex, x]) => ({ position: [x, 4.5, 0] as V3, color: linear(hex).map((c) => c * 30) as V3 })),
    /** rooms.ts's probes after floorProbe(): influence boxes reach 0.6 m under the floor; capture points stay put. */
    probes: [
      { center: [-4, 2.3, 0] as V3, size: [8.4, 5.8, 8.4] as V3, projectionSize: [8, 5, 8] as V3, offset: [0, 0.2, 0] as V3 },
      { center: [4, 2.3, 0] as V3, size: [8.4, 5.8, 8.4] as V3, projectionSize: [8, 5, 8] as V3, offset: [0, 0.2, 0] as V3 },
      { center: [0, 1.6, 0] as V3, size: [2.4, 4.4, 2.5] as V3, projectionSize: [16, 3.8, 8] as V3, offset: [0, 0.3, 0] as V3 },
    ],
    views: {
      default: { pos: [0, 2.3, 8.5], target: [0, 2.05, 0] },
      ball: { pos: [-3.0, 1.6, 3.85], target: [-4.6, 0.3, 0.8] },
      table: { pos: [-1.3, 0.55, 2.3], target: [-4.2, 0.45, -0.2] },
      stale: { pos: [-2.9, 2.2, 3.7], target: [-4.8, 0.4, -1.5] },
      doorway: { pos: [6.6, 1.5, 1.9], target: [-4.0, 0.9, -0.4] },
      explore: { pos: [-6.2, 2.1, 3.1], target: [1.0, 1.0, -0.8] },
    } as Record<string, { pos: V3; target: V3 }>,
  };
}
