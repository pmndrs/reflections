// W55: small reflection probes inside carConcept (bench setting `carProbes`, default `wheels` at 64 px since W102): one per wheel well
// and one for the cabin, beside the stage probe. W54 (D3680, D3681) found the wheel interiors, the chrome hub
// and the cabin too bright against the path tracer because the car's only probe captures the open studio from
// above the car, so three's base IBL and our hit shading treat the enclosed spaces as open.
//
// Every box comes from the car's geometry, not from hand-tuned numbers:
//   - wheel: the wheel group's world bounds (rim, tyre, disc, caliper), its bottom lifted off the floor, then
//     shrunk until no exterior-body vertex (paint, mirror, glass) is inside, so the arches' paint stays on the
//     stage probe;
//   - cabin: grown from the seats' centre, one face at a time in 1 cm steps, until the next step would take in
//     a vertex (or triangle centroid) of the glass or the painted shell, and never below the floor mats. So the
//     glass, whose reflection matched the path tracer (W54), stays outside the box and on the stage probe.
// Probes are world-axis-aligned boxes (#35046; rotation is ignored) and the stage turns the car by -1.0 rad,
// so a box fits a space only where the space's own bounds allow it (see docs/research/car-interior-probes-w55.md).
// The capture point is the candidate inside the box (and, for a wheel, inside the wheel's cylinder) farthest
// from every vertex of the car, so the capture camera doesn't sit inside a part.
import * as THREE from 'three/webgpu';
import type { Vec3 } from '../../shared';
import type { ShowcaseScene } from './scenes';

export type CarProbesMode = 'off' | 'wheels' | 'cabin' | 'both' | 'cabinGlass';
export const CAR_PROBES_MODES: CarProbesMode[] = ['off', 'wheels', 'cabin', 'both', 'cabinGlass'];

/**
 * W102 (T21, decision 18): the showcase's and the bench's default, the four wheel-well probes at 64 px (W55: hub
 * 44 -> 27 vs the PT's 28; 64 = 128 = 256 there). `?carProbes=off` turns them off. Only carConcept has them.
 */
export const CAR_PROBES_DEFAULT: { mode: CarProbesMode; resolution: number } = { mode: 'wheels', resolution: 64 };

/** `?carProbes=` / `?carProbeRes=` over {@link CAR_PROBES_DEFAULT}. */
export function carProbesFromQuery(q: URLSearchParams): { mode: CarProbesMode; resolution: number } {
  const m = q.get('carProbes') as CarProbesMode | null;
  return {
    mode: m && CAR_PROBES_MODES.includes(m) ? m : CAR_PROBES_DEFAULT.mode,
    resolution: q.has('carProbeRes') ? Number(q.get('carProbeRes')) : CAR_PROBES_DEFAULT.resolution,
  };
}

export interface CarProbeVolume {
  name: string;
  position: Vec3;
  influenceSize: Vec3;
  originOffset: Vec3;
  blendDistance: number;
  resolution: number | null;
}

const WHEEL = /^Wheel(Front|Rear)(L|R)$/;
const STEP = 0.01;

// by name too: the bench's ?glass=black makes the glass opaque before the probes are placed, and the box must not move
const isGlass = (m: THREE.Material) => ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0 || /^Glass/.test(m.name);
const isPaint = (m: THREE.Material) => /^(Paint|Mirror)/.test(m.name);

/** World-space points of a mesh: every vertex, plus every triangle's centroid (catches big triangles). */
function meshPoints(mesh: THREE.Mesh, out: number[], stride = 1) {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const idx = mesh.geometry.index;
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e = mesh.matrixWorld;
  for (let i = 0; i < pos.count; i += stride) { v.fromBufferAttribute(pos, i).applyMatrix4(e); out.push(v.x, v.y, v.z); }
  if (stride !== 1) return;
  const n = idx ? idx.count : pos.count;
  for (let t = 0; t + 2 < n; t += 3) {
    const [i0, i1, i2] = idx ? [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)] : [t, t + 1, t + 2];
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    v.copy(a).add(b).add(c).divideScalar(3).applyMatrix4(e);
    out.push(v.x, v.y, v.z);
  }
}

const anyInside = (pts: Float32Array, min: THREE.Vector3, max: THREE.Vector3) => {
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    if (x > min.x && x < max.x && y > min.y && y < max.y && z > min.z && z < max.z) return true;
  }
  return false;
};

/**
 * The box grown from `seed` inside `cap`, one face at a time in STEP increments, while it holds none of `stop`.
 * Faces take turns, so the box stays near the seed's shape until a face meets the shell.
 */
function grow(seed: THREE.Vector3, cap: THREE.Box3, stop: Float32Array): THREE.Box3 {
  const box = new THREE.Box3(seed.clone().subScalar(STEP), seed.clone().addScalar(STEP));
  box.intersect(cap);
  const keys = ['x', 'y', 'z'] as const;
  for (let grew = true; grew;) {
    grew = false;
    for (const k of keys) for (const side of ['min', 'max'] as const) {
      const lim = cap[side][k];
      const cur = box[side][k];
      const next = side === 'min' ? Math.max(lim, cur - STEP) : Math.min(lim, cur + STEP);
      if (next === cur) continue;
      // test only the new slab
      const sMin = box.min.clone(), sMax = box.max.clone();
      if (side === 'min') { sMin[k] = next; sMax[k] = cur; } else { sMin[k] = cur; sMax[k] = next; }
      if (anyInside(stop, sMin, sMax)) continue;
      box[side][k] = next;
      grew = true;
    }
  }
  return box;
}

/** The largest box inside `cap` that holds none of `stop`, shrunk from `cap` face by face (smallest loss first). */
function shrink(cap: THREE.Box3, stop: Float32Array): THREE.Box3 {
  const box = cap.clone();
  const keys = ['x', 'y', 'z'] as const;
  for (let guard = 0; guard < 2000 && anyInside(stop, box.min, box.max); guard++) {
    // move the face whose slab of STEP holds the most stop points (ties: the first)
    let best: { k: 'x' | 'y' | 'z'; side: 'min' | 'max'; n: number } | null = null;
    for (const k of keys) for (const side of ['min', 'max'] as const) {
      const sMin = box.min.clone(), sMax = box.max.clone();
      if (side === 'min') sMax[k] = box.min[k] + STEP; else sMin[k] = box.max[k] - STEP;
      let n = 0;
      for (let i = 0; i < stop.length; i += 3) {
        const x = stop[i], y = stop[i + 1], z = stop[i + 2];
        if (x > sMin.x && x < sMax.x && y > sMin.y && y < sMax.y && z > sMin.z && z < sMax.z) n++;
      }
      if (!best || n > best.n) best = { k, side, n };
    }
    if (!best) break;
    if (best.side === 'min') box.min[best.k] += STEP; else box.max[best.k] -= STEP;
    if (box.isEmpty()) break;
  }
  return box;
}

/** Of the candidates, the one farthest from every point of `pts` (min distance, maximised). */
function clearest(candidates: THREE.Vector3[], pts: Float32Array): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null, bestD = -1;
  for (const c of candidates) {
    let d = Infinity;
    for (let i = 0; i < pts.length && d > bestD; i += 3) {
      const dx = pts[i] - c.x, dy = pts[i + 1] - c.y, dz = pts[i + 2] - c.z;
      const q = dx * dx + dy * dy + dz * dz;
      if (q < d) d = q;
    }
    if (d > bestD) { bestD = d; best = c; }
  }
  return best;
}

function gridIn(box: THREE.Box3, n: number, inset = 0.1): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const s = box.getSize(new THREE.Vector3());
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    const f = (t: number) => inset + (1 - 2 * inset) * (t + 0.5) / n;
    out.push(new THREE.Vector3(box.min.x + s.x * f(i), box.min.y + s.y * f(j), box.min.z + s.z * f(k)));
  }
  return out;
}

const volumeOf = (name: string, box: THREE.Box3, capture: THREE.Vector3, resolution: number | null): CarProbeVolume => {
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  return {
    name, position: c.toArray() as Vec3, influenceSize: s.toArray() as Vec3,
    originOffset: capture.clone().sub(c).toArray() as Vec3,
    // 10 % of the shortest side: the small box takes over within a few cm of its faces
    blendDistance: 0.1 * Math.min(s.x, s.y, s.z),
    resolution,
  };
};

/** carConcept's four wheel groups (W55 `?carProbeCapture=noWheels` hides them from every capture). */
export function carWheels(kit: ShowcaseScene): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  kit.hero?.traverse((o) => { if (WHEEL.test(o.name)) out.push(o); });
  return out;
}

/**
 * carConcept's interior probes for `mode` (none for 'off' or another scene), each at `resolution` px
 * (null = the set's default). Volumes in world space, for `ReflectionProbe`s next to the stage probe.
 */
export function carInteriorProbes(kit: ShowcaseScene, mode: CarProbesMode, resolution: number | null): CarProbeVolume[] {
  if (mode === 'off' || kit.id !== 'carConcept' || !kit.hero) return [];
  const hero = kit.hero;
  hero.updateMatrixWorld(true);
  const shell: number[] = [], paint: number[] = [], all: number[] = [];
  const wheels: THREE.Object3D[] = [];
  hero.traverse((o) => {
    if (WHEEL.test(o.name)) wheels.push(o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshPoints(mesh, all, 3);
    const ms = ([] as THREE.Material[]).concat(mesh.material);
    if (ms.some(isPaint)) { meshPoints(mesh, shell); meshPoints(mesh, paint); } else if (ms.some(isGlass)) meshPoints(mesh, shell);
  });
  const shellPts = new Float32Array(shell), paintPts = new Float32Array(paint), allPts = new Float32Array(all);
  const out: CarProbeVolume[] = [];

  if (mode === 'wheels' || mode === 'both') {
    for (const w of wheels) {
      const cap = new THREE.Box3().setFromObject(w, true);
      // lift the bottom off the floor (the floor stays on the stage probe): 2 % of the wheel's height
      cap.min.y += 0.02 * (cap.max.y - cap.min.y);
      const box = shrink(cap, shellPts);
      // capture inside the wheel's cylinder: candidates in the wheel's own frame, within 0.85 R of the axle
      const inv = new THREE.Matrix4().copy(w.matrixWorld).invert();
      const local = new THREE.Box3();
      const v = new THREE.Vector3();
      w.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const pos = m.geometry.attributes.position as THREE.BufferAttribute;
        const toLocal = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
        for (let i = 0; i < pos.count; i += 7) local.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(toLocal));
      });
      const ls = local.getSize(new THREE.Vector3()), lc = local.getCenter(new THREE.Vector3());
      const axis = ls.x <= ls.y && ls.x <= ls.z ? 'x' : ls.y <= ls.z ? 'y' : 'z';
      const R = Math.max(...(['x', 'y', 'z'] as const).filter((k) => k !== axis).map((k) => ls[k] / 2));
      const cands = gridIn(local, 9, 0.05).filter((p) => {
        let r2 = 0; for (const k of ['x', 'y', 'z'] as const) if (k !== axis) r2 += (p[k] - lc[k]) ** 2;
        return r2 < (0.85 * R) ** 2;
      }).map((p) => p.applyMatrix4(w.matrixWorld)).filter((p) => box.containsPoint(p));
      const capture = clearest(cands, allPts) ?? box.getCenter(new THREE.Vector3());
      out.push(volumeOf(w.name, box, capture, resolution));
    }
  }

  // 'cabinGlass' (experiment): the cabin grown against the paint only, so it takes in the glass (and its reflection)
  if (mode === 'cabin' || mode === 'both' || mode === 'cabinGlass') {
    const seats = new THREE.Box3();
    const mats = new THREE.Box3();
    hero.traverse((o) => {
      if (/^InteriorSeatsColor/.test(o.name)) seats.expandByObject(o, true);
      if (o.name === 'InteriorFloormats') mats.expandByObject(o, true);
    });
    const car = new THREE.Box3().setFromObject(hero, true);
    const cap = car.clone();
    if (!mats.isEmpty()) cap.min.y = mats.max.y;
    const box = grow(seats.getCenter(new THREE.Vector3()), cap, mode === 'cabinGlass' ? paintPts : shellPts);
    const capture = clearest(gridIn(box, 8), allPts) ?? box.getCenter(new THREE.Vector3());
    out.push(volumeOf('cabin', box, capture, resolution));
  }
  return out;
}
