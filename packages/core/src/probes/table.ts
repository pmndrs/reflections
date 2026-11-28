// The probe volume table: what the lookup (./lookup.ts) knows about each probe, packed as rows of
// vec4<f32> in one storage buffer. Engine-free: an adapter fills ProbeVolume from its scene objects,
// packs with `packProbeTable` and uploads the result into a buffer it binds (the core ProbeSet does
// this itself; the three adapter writes into the buffer three binds).
//
// Layout (rows of vec4<f32>; integers are stored as floats, exact below 2^24):
//   row 0           count, maxLod, enabled (0 during a capture: probes then contribute nothing),
//                   environment slot (-1: none)
//   row 1           irradiance base row (see below), re-fit clamp, grid row (0: no grid; W63), 0
//   row 2           maxLod of atlases 0..3 (several atlases only, D4700; zeros for one atlas, whose
//                   maxLod is row 0's)
//   row 3           first irradiance slot of atlases 0..3 (several atlases only; zeros otherwise)
//   then per volume, in lookup order (PROBE_ROWS_PER_VOLUME rows each):
//     +0  influence centre.xyz (world), blend fade distance
//     +1  influence half-size.xyz, flags (bit 0: box projection)
//     +2  projection-box offset.xyz from the centre, atlas slot
//     +3  projection-box size.xyz (full size), priority (informational: the order is what counts)
//     +4  capture point.xyz (world: centre + originOffset), atlas index (0 with one atlas)
//     +5  rotation: the unit quaternion (x, y, z, w) taking the box's local frame to world (T23, W108);
//         (0, 0, 0, 1) for an axis-aligned box. Flags bit 1 (row +1 w) is set when it is not the
//         identity: the lookup then reads this row and tests and projects in the box's local frame
//         (the influence box, its fade, the projection box and its offset all turn with it; the
//         capture point and the captures themselves stay in world space)
//   then, for a capacity of at least PROBE_GRID_MIN_VOLUMES, the volume grid (W63, D4950) from the grid
//   row (probeGridRow): a world-space grid over the volumes' influence boxes (an oriented box by its
//   world bounds), each cell listing the volumes whose box touches it, so the lookup walks only those
//   (in table order: exact):
//     +0  grid min.xyz (world), 1 / cell size
//     +1  cells per axis.xyz, rows per cell
//     +2  cells, x fastest, then y, then z; each cell `rows per cell` rows of 4 lanes, lane l bit b
//         (a float holding an integer below 2^24) set when volume 24 * l + b touches the cell
//   then from the irradiance base row, per atlas slot (environment included), PROBE_IRRADIANCE_ROWS
//   rows of L1 SH irradiance (see ./irradiance.ts): (L00.rgb, L1-1.r), (L1-1.gb, L10.rg), (L10.b, L11.rgb).
//   With several atlases (one per resolution class, D4700) the slots are numbered across them:
//   atlas a's slot s is irradiance slot `row 3[a] + s`.
//   Those rows are written on the GPU by ProbeIrradiance; `packProbeTable` covers only the rows
//   before them, so an upload never overwrites them.
//
// Order is priority: the lookup walks the volumes in table order and each takes what the earlier
// ones left (Lagarde 2014 front-to-back accumulation, D58). `sortProbeVolumes` orders by `priority`
// (ascending), then by influence volume (smallest first, #35046's rule), then by input order.

export const PROBE_HEADER_ROWS = 4;
export const PROBE_ROWS_PER_VOLUME = 6;
export const PROBE_IRRADIANCE_ROWS = 3;
/**
 * Atlases one probe table addresses: one per probe face size, so a set mixes at most four sizes
 * (D4700; maintainer-approved 2026-11-12). Why four:
 * - each size is one more sampled-texture binding in every shader that looks probes up, and WebGPU
 *   guarantees only 16 per stage, shared with the G-buffer, SSR and denoiser inputs;
 * - header rows 2 and 3 hold each atlas's last mip and first irradiance slot, one vec4 lane per atlas;
 * - four power-of-two sizes (128 / 256 / 512 / 1024) span the useful range: below 128 only rough
 *   surfaces read well, and a 2048 probe is ~268 MB.
 * Raising it needs more header rows and more of the binding budget.
 */
export const PROBE_MAX_ATLASES = 4;

export type Vec3 = readonly [number, number, number];
/** A quaternion (x, y, z, w). */
export type ProbeQuaternion = readonly [number, number, number, number];

/** Flags (volume row +1 w): bit 0 box projection, bit 1 an oriented box (row +5 holds its rotation). */
export const PROBE_FLAG_BOX_PROJECTION = 1;
export const PROBE_FLAG_ORIENTED = 2;

/**
 * One probe volume, in world units. Axis-aligned unless {@link rotation} turns it (T23; #35046's boxes
 * are always world-axis-aligned).
 */
export interface ProbeVolume {
  /** Atlas slot the probe's capture lives in (within its atlas, {@link atlas}). */
  slot: number;
  /**
   * Which of the set's atlases holds the capture (one atlas per resolution class, D4700). Default 0.
   * The lookup reads it only when compiled for several atlases (`ProbeLookupOptions.atlases`).
   */
  atlas?: number;
  /** Influence box centre (the probe's position). */
  center: Vec3;
  /** Influence box half-size. */
  halfSize: Vec3;
  /** Distance over which the influence fades in from the box faces. Default 0.5. */
  fade?: number;
  /** Projection box size (full). Default: the influence box (2 * halfSize). */
  projectionSize?: Vec3;
  /** Projection box centre offset from `center` (#35046 `projectionOffset`). Default 0. */
  projectionOffset?: Vec3;
  /** Where the capture was taken (`center` + originOffset). Default `center`. */
  origin?: Vec3;
  /** Box-project lookups inside the projection box. Default true. */
  boxProjection?: boolean;
  /**
   * Orientation of the boxes (T23): the quaternion (x, y, z, w) that takes the box's local frame to
   * world, about {@link center}. `halfSize`, `projectionSize` and `projectionOffset` are in that local
   * frame; `center` and `origin` stay world points, and the captures stay world-aligned cubes. Need not
   * be normalized. Default (or the identity): an axis-aligned box, which packs and looks up exactly
   * as before rotations existed.
   */
  rotation?: ProbeQuaternion;
  /** Lower comes first. Default: by influence volume, smallest first. */
  priority?: number;
}

export interface ProbeTableHeader {
  /** Last mip of the atlas (roughness 1). */
  maxLod: number;
  /** False while capturing: the lookup then returns zero coverage (environment only). Default true. */
  enabled?: boolean;
  /** Atlas slot of the environment, or -1 for none. */
  environmentSlot: number;
  /** First row of the irradiance block (default: right after `capacity` volumes). */
  irradianceRow?: number;
  /** Upper bound of the re-fit ratio frameIrradiance / probeIrradiance. Default 4. */
  refitClamp?: number;
  /**
   * The table's volume capacity, for the volume grid (W63): with a capacity of at least
   * PROBE_GRID_MIN_VOLUMES the grid is packed at `probeGridRow(capacity)` and the packed rows run to
   * its end. Default: no grid (the lookup then walks every volume).
   */
  capacity?: number;
  /**
   * The atlases of a set whose probes live in several (one per resolution class, D4700), at most
   * {@link PROBE_MAX_ATLASES}: each one's last mip and first irradiance slot. Atlas 0 holds the
   * environment slot and its `maxLod` should be the header's. Absent (one atlas): header rows 2 and
   * 3 stay zero, as before.
   */
  atlases?: readonly ProbeTableAtlas[];
}

/** One atlas of a multi-atlas probe table (see {@link ProbeTableHeader.atlases}). */
export interface ProbeTableAtlas {
  /** Last mip of the atlas (roughness 1). */
  maxLod: number;
  /** Irradiance slot of the atlas's slot 0 (slots are numbered across the atlases). */
  irradianceBase: number;
}

/** Rows the table needs for `capacity` volumes and `slots` atlas slots (irradiance included). */
export const probeTableRows = (capacity: number, slots: number) => probeIrradianceRow(capacity) + slots * PROBE_IRRADIANCE_ROWS;
/** Row where the irradiance block starts for `capacity` volumes (after the volumes and the volume grid). */
export function probeIrradianceRow(capacity: number) { return PROBE_HEADER_ROWS + capacity * PROBE_ROWS_PER_VOLUME + probeGridRows(capacity); }

/** Volumes one grid lane holds (an integer stored as f32 is exact below 2^24). */
export const PROBE_GRID_LANE_BITS = 24;
/** Cells a volume grid holds at most (its rows: cells x rows per cell, 64 KB per row of cells). */
export const PROBE_GRID_MAX_CELLS = 4096;
/** Capacity from which a table carries the volume grid; smaller sets walk every volume (W63). */
export const PROBE_GRID_MIN_VOLUMES = 2;
/** Rows of one grid cell for `capacity` volumes. */
export const probeGridRowsPerCell = (capacity: number) => Math.ceil(capacity / (4 * PROBE_GRID_LANE_BITS));
/** Rows the volume grid takes for `capacity` volumes (0 below PROBE_GRID_MIN_VOLUMES). */
export const probeGridRows = (capacity: number) => (capacity >= PROBE_GRID_MIN_VOLUMES ? 2 + PROBE_GRID_MAX_CELLS * probeGridRowsPerCell(capacity) : 0);
/** Row where the volume grid starts for `capacity` volumes (right after them; meaningless without a grid). */
export const probeGridRow = (capacity: number) => PROBE_HEADER_ROWS + capacity * PROBE_ROWS_PER_VOLUME;

const boxVolume = (v: ProbeVolume) => v.halfSize[0] * v.halfSize[1] * v.halfSize[2];

/** Volumes in lookup order: `priority` ascending, then smallest influence first, then input order. */
export function sortProbeVolumes(volumes: readonly ProbeVolume[]): ProbeVolume[] {
  return volumes
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (a.v.priority ?? 0) - (b.v.priority ?? 0) || boxVolume(a.v) - boxVolume(b.v) || a.i - b.i)
    .map(({ v }) => v);
}

/**
 * Packs the header and `volumes` (already in lookup order; see `sortProbeVolumes`) into `out`
 * (allocated if absent: header + volumes rows). Returns the packed rows, which stop before the
 * irradiance block.
 */
export function packProbeTable(header: ProbeTableHeader, volumes: readonly ProbeVolume[], out?: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const capacity = header.capacity ?? 0;
  if (header.capacity !== undefined && volumes.length > capacity) throw new Error(`packProbeTable: ${volumes.length} volumes, capacity ${capacity}`);
  const grid = probeGridRows(capacity) > 0 ? probeGridRow(capacity) : 0;
  const rows = grid > 0 ? grid + probeGridRows(capacity) : PROBE_HEADER_ROWS + volumes.length * PROBE_ROWS_PER_VOLUME;
  const f = out && out.length >= rows * 4 ? out : new Float32Array(rows * 4);
  f.fill(0, 0, rows * 4);
  f.set([volumes.length, header.maxLod, header.enabled === false ? 0 : 1, header.environmentSlot], 0);
  f.set([header.irradianceRow ?? 0, header.refitClamp ?? 4, grid, 0], 4);
  if (grid > 0) packProbeGrid(f, grid, probeGridRowsPerCell(capacity), volumes);
  if (header.atlases !== undefined && header.atlases.length > 0) {
    if (header.atlases.length > PROBE_MAX_ATLASES) throw new Error(`packProbeTable: ${header.atlases.length} atlases, at most ${PROBE_MAX_ATLASES}`);
    header.atlases.forEach((a, k) => { f[8 + k] = a.maxLod; f[12 + k] = a.irradianceBase; });
  }
  volumes.forEach((v, i) => {
    const o = (PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME) * 4;
    const ps = v.projectionSize ?? [2 * v.halfSize[0], 2 * v.halfSize[1], 2 * v.halfSize[2]];
    const po = v.projectionOffset ?? [0, 0, 0];
    const origin = v.origin ?? v.center;
    const q = probeVolumeRotation(v);
    f.set([...v.center, v.fade ?? 0.5], o);
    f.set([...v.halfSize, (v.boxProjection === false ? 0 : PROBE_FLAG_BOX_PROJECTION) + (q === null ? 0 : PROBE_FLAG_ORIENTED)], o + 4);
    f.set([...po, v.slot], o + 8);
    f.set([...ps, v.priority ?? 0], o + 12);
    const atlas = v.atlas ?? 0;
    if (atlas < 0 || atlas >= Math.max(1, header.atlases?.length ?? 1)) throw new Error(`packProbeTable: volume ${i} is in atlas ${atlas}, the header has ${header.atlases?.length ?? 1}`);
    f.set([...origin, atlas], o + 16);
    f.set(q ?? IDENTITY, o + 20);
  });
  return f.subarray(0, rows * 4);
}

const IDENTITY: ProbeQuaternion = [0, 0, 0, 1];

/**
 * A volume's rotation as the table holds it: the normalized quaternion with w >= 0, or null for an
 * axis-aligned box (no rotation, the identity, or a zero quaternion), which packs flags bit 1 clear
 * and row +5 the identity, so the lookup takes the axis-aligned path, bit for bit as before (T23).
 */
export function probeVolumeRotation(v: Pick<ProbeVolume, 'rotation'>): ProbeQuaternion | null {
  const q = v.rotation;
  if (q === undefined) return null;
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  const s = (q[3] < 0 ? -1 : 1) / n;
  const r: ProbeQuaternion = [q[0] * s, q[1] * s, q[2] * s, q[3] * s];
  return r[0] === 0 && r[1] === 0 && r[2] === 0 ? null : r;
}

/** `v` rotated by the unit quaternion `q` (local to world); the conjugate rotates world to local. */
export function rotateByQuat(q: ProbeQuaternion, v: Vec3): [number, number, number] {
  const [x, y, z, w] = q;
  // t = 2 cross(q.xyz, v); v + w t + cross(q.xyz, t): the lookup's form (pr_toLocal with the conjugate)
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The world point `P` in the box frame of `v`: relative to its centre, turned by the inverse rotation. */
export function probeVolumeLocal(v: Pick<ProbeVolume, 'center' | 'rotation'>, P: Vec3): [number, number, number] {
  const lp: Vec3 = [P[0] - v.center[0], P[1] - v.center[1], P[2] - v.center[2]];
  const q = probeVolumeRotation(v);
  return q === null ? [...lp] : rotateByQuat([-q[0], -q[1], -q[2], q[3]], lp);
}

/**
 * World-space half extent of a volume's influence box: its half-size for an axis-aligned box; for an
 * oriented one, the half-size of the box's world bounds (sum over its local axes of |axis| x half-size).
 */
export function probeVolumeWorldHalfSize(v: Pick<ProbeVolume, 'halfSize' | 'rotation'>): [number, number, number] {
  const q = probeVolumeRotation(v);
  if (q === null) return [...v.halfSize];
  const out: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    const axis = rotateByQuat(q, [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0]);
    for (let a = 0; a < 3; a++) out[a] += Math.abs(axis[a]) * v.halfSize[j];
  }
  return out;
}

/**
 * Writes the volume grid (see the layout above) at row `row` of `f`: cubic cells over the union of
 * the influence boxes, at most PROBE_GRID_MAX_CELLS, each listing every volume whose box (grown by
 * a hundredth of a cell, so float rounding on the GPU can't drop one) touches it; an oriented box by
 * its world bounds (T23: a cell it doesn't reach costs that cell's pixels one box test). Volumes with
 * an empty box (a negative half-size: masked out) are in no cell. The rows must be zero.
 */
function packProbeGrid(f: Float32Array, row: number, rowsPerCell: number, volumes: readonly ProbeVolume[]) {
  const live = volumes.map((v, i) => ({ v, i, h: probeVolumeWorldHalfSize(v) })).filter(({ v }) => v.halfSize[0] > 0 && v.halfSize[1] > 0 && v.halfSize[2] > 0);
  if (live.length === 0) { f.set([0, 0, 0, 1, 0, 0, 0, rowsPerCell], row * 4); return; } // no cell: every lookup misses
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { v, h } of live) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v.center[a] - h[a]); hi[a] = Math.max(hi[a], v.center[a] + h[a]); }
  const ext = lo.map((l, a) => Math.max(hi[a] - l, 1e-3));
  let cell = Math.cbrt((ext[0] * ext[1] * ext[2]) / PROBE_GRID_MAX_CELLS);
  let dims = ext.map((e) => Math.max(1, Math.ceil(e / cell)));
  while (dims[0] * dims[1] * dims[2] > PROBE_GRID_MAX_CELLS) { cell *= 1.02; dims = ext.map((e) => Math.max(1, Math.ceil(e / cell))); }
  // half a cell of margin on the low side keeps P on a box face inside the grid
  const origin = lo.map((l, a) => l - 0.5 * (dims[a] * cell - ext[a]));
  f.set([origin[0], origin[1], origin[2], 1 / cell, dims[0], dims[1], dims[2], rowsPerCell], row * 4);
  const base = (row + 2) * 4, eps = 0.01;
  for (const { v, i, h } of live) {
    const r0 = [0, 1, 2].map((a) => Math.max(0, Math.floor((v.center[a] - h[a] - origin[a]) / cell - eps)));
    const r1 = [0, 1, 2].map((a) => Math.min(dims[a] - 1, Math.floor((v.center[a] + h[a] - origin[a]) / cell + eps)));
    const lane = Math.floor(i / PROBE_GRID_LANE_BITS), bit = 2 ** (i % PROBE_GRID_LANE_BITS);
    for (let z = r0[2]; z <= r1[2]; z++) for (let y = r0[1]; y <= r1[1]; y++) for (let x = r0[0]; x <= r1[0]; x++) {
      const k = base + (x + dims[0] * (y + dims[1] * z)) * rowsPerCell * 4 + lane;
      f[k] += bit;
    }
  }
}

/** Where a probe set of mixed resolutions keeps each capture: see {@link planProbeAtlases}. */
export interface ProbeAtlasPlan {
  /** Face size of each atlas; atlas 0 is the set's default resolution and holds the environment. */
  resolutions: number[];
  /** Per probe (input order): its atlas. */
  atlas: number[];
  /** Per probe: its slot within that atlas. */
  slot: number[];
  /** Slots per atlas (the environment included in atlas 0's when `environment`). */
  slots: number[];
  /** Environment slot in atlas 0, or -1. */
  environmentSlot: number;
  /** Per atlas: the irradiance slot of its slot 0 (slots numbered across atlases, atlas 0 first). */
  irradianceBases: number[];
}

/**
 * Groups probes of mixed face sizes into one atlas per size (D4700). Atlas 0 is the set's default
 * size `primary` (it holds the environment slot, after its probes, so a set where every probe uses
 * the default is exactly the one-atlas set it always was); the other sizes follow in ascending
 * order. Within an atlas, probes keep their input order. Throws past {@link PROBE_MAX_ATLASES} sizes.
 * `resolutions[i]` null / undefined: the default.
 */
export function planProbeAtlases(resolutions: readonly (number | null | undefined)[], primary: number, { environment = true }: { environment?: boolean } = {}): ProbeAtlasPlan {
  const sizes = resolutions.map((r) => r ?? primary);
  const others = [...new Set(sizes.filter((r) => r !== primary))].sort((a, b) => a - b);
  const list = [primary, ...others];
  if (list.length > PROBE_MAX_ATLASES) throw new Error(`planProbeAtlases: ${list.length} probe resolutions (${list.join(', ')}), at most ${PROBE_MAX_ATLASES} per set`);
  const slots = list.map(() => 0);
  const atlas: number[] = [], slot: number[] = [];
  for (const r of sizes) { const a = list.indexOf(r); atlas.push(a); slot.push(slots[a]++); }
  const environmentSlot = environment ? slots[0]++ : -1;
  const irradianceBases: number[] = [];
  let base = 0;
  for (const n of slots) { irradianceBases.push(base); base += n; }
  return { resolutions: list, atlas, slot, slots, environmentSlot, irradianceBases };
}
