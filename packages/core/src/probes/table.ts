// The probe volume table: what the lookup (./lookup.ts) knows about each probe, packed as rows of
// vec4<f32> in one storage buffer. Engine-free: an adapter fills ProbeVolume from its scene objects,
// packs with `packProbeTable` and uploads the result into a buffer it binds (the core ProbeSet does
// this itself; the three adapter writes into the buffer three binds).
//
// Layout (rows of vec4<f32>; integers are stored as floats, exact below 2^24):
//   row 0           count, maxLod, enabled (0 during a capture: probes then contribute nothing),
//                   environment slot (-1: none)
//   row 1           irradiance base row (see below), re-fit clamp, 0, 0
//   rows 2, 3       reserved
//   then per volume, in lookup order (PROBE_ROWS_PER_VOLUME rows each):
//     +0  influence centre.xyz (world), blend fade distance
//     +1  influence half-size.xyz, flags (bit 0: box projection)
//     +2  projection-box offset.xyz from the centre, atlas slot
//     +3  projection-box size.xyz (full size), priority (informational: the order is what counts)
//     +4  capture point.xyz (world: centre + originOffset), 0
//   then from the irradiance base row, per atlas slot (environment included), PROBE_IRRADIANCE_ROWS
//   rows of L1 SH irradiance (see ./irradiance.ts): (L00.rgb, L1-1.r), (L1-1.gb, L10.rg), (L10.b, L11.rgb).
//   Those rows are written on the GPU by ProbeIrradiance; `packProbeTable` covers only the rows
//   before them, so an upload never overwrites them.
//
// Order is priority: the lookup walks the volumes in table order and each takes what the earlier
// ones left (Lagarde 2014 front-to-back accumulation, D58). `sortProbeVolumes` orders by `priority`
// (ascending), then by influence volume (smallest first, #35046's rule), then by input order.

export const PROBE_HEADER_ROWS = 4;
export const PROBE_ROWS_PER_VOLUME = 5;
export const PROBE_IRRADIANCE_ROWS = 3;

export type Vec3 = readonly [number, number, number];

/** One probe volume, in world units (axis-aligned; rotation is not supported, as in #35046). */
export interface ProbeVolume {
  /** Atlas slot the probe's capture lives in. */
  slot: number;
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
}

/** Rows the table needs for `capacity` volumes and `slots` atlas slots (irradiance included). */
export const probeTableRows = (capacity: number, slots: number) => PROBE_HEADER_ROWS + capacity * PROBE_ROWS_PER_VOLUME + slots * PROBE_IRRADIANCE_ROWS;
/** Row where the irradiance block starts for `capacity` volumes. */
export const probeIrradianceRow = (capacity: number) => PROBE_HEADER_ROWS + capacity * PROBE_ROWS_PER_VOLUME;

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
  const rows = PROBE_HEADER_ROWS + volumes.length * PROBE_ROWS_PER_VOLUME;
  const f = out && out.length >= rows * 4 ? out : new Float32Array(rows * 4);
  f.fill(0, 0, rows * 4);
  f.set([volumes.length, header.maxLod, header.enabled === false ? 0 : 1, header.environmentSlot], 0);
  f.set([header.irradianceRow ?? 0, header.refitClamp ?? 4, 0, 0], 4);
  volumes.forEach((v, i) => {
    const o = (PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME) * 4;
    const ps = v.projectionSize ?? [2 * v.halfSize[0], 2 * v.halfSize[1], 2 * v.halfSize[2]];
    const po = v.projectionOffset ?? [0, 0, 0];
    const origin = v.origin ?? v.center;
    f.set([...v.center, v.fade ?? 0.5], o);
    f.set([...v.halfSize, v.boxProjection === false ? 0 : 1], o + 4);
    f.set([...po, v.slot], o + 8);
    f.set([...ps, v.priority ?? 0], o + 12);
    f.set([...origin, 0], o + 16);
  });
  return f.subarray(0, rows * 4);
}
