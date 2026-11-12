// Probe layouts at an equal memory budget (W61): few large, medium, many small (a Ben-style grid)
// and a mixed-size layout (W60's per-probe resolution), per scene, beside the scene's shipped set.
// Pure data: the pages bake what this returns (examples/ssr `?probeLayout=`, the showcase compare
// page's 'probes' / 'ours-*' methods `?probeLayout=`); `pnpm check -- --only probe-layouts` renders them.
//
// Budget: 8 probes' worth of 256 px cubes plus a 128 px environment slot (rgba16float, 6 faces,
// every mip down to 8 px): 34.6 MB. Every non-shipped layout bakes with the set's default at 128
// px, so the environment slot costs the same 1.05 MB everywhere and each probe names its own size:
//   few     2 x 512   hand placed (the scene's own large volumes)
//   medium  8 x 256   the grid below, 8 cells
//   many    32 x 128  the grid below, 32 cells (Ben's demos: many small probes)
//   manyCell          many, each cell projected onto its own box instead of its region's walls
//   mixed             512 where the receivers are mirror-grade, 256 for glossy floors, a 128 grid elsewhere
//
// The grid ("systematic", what a user would do without tuning per probe): the scene's walkable
// regions (rooms, aisles, galleries: axis-aligned boxes from floor to ceiling or roof line) share
// the cells in proportion to floor area (at least one each, largest remainder), each region is cut
// into nx x nz columns (the factor pair of its share with the squarest cells), one layer from floor
// to ceiling. A cell's probe is captured at the cell's centre (the default, as the shipped probes),
// projected onto its region's box (the walls it stands between), and its influence box is the cell
// grown by the blend distance b on every side: neighbours overlap by 2b, so a point inside the
// region gets the full weight from its own cell however the lookup orders equal volumes (each
// volume takes `clamp(inside / b) x remaining`, smallest first, D58), and the seam is a ramp b
// wide on one side of the cell face. b = `blend` x the cell's shorter side (default 0.25).
import type { ProbeVolume, Vec3 } from './kit';

/** Bytes of one rgba16float cube of `size` px with every mip down to 8 px (`probeAtlasBytes`'s sum). */
export function cubeBytes(size: number): number {
  let b = 0;
  for (let s = size; s >= 8; s >>= 1) b += s * s * 6 * 8;
  return b;
}

/** Bytes of a set's atlases: every probe at its own size (or the set's), plus the environment slot at the set's. */
export function layoutBytes(volumes: readonly ProbeVolume[], setResolution = 256): number {
  return volumes.reduce((b, v) => b + cubeBytes(v.resolution ?? setResolution), cubeBytes(setResolution));
}

/** W61's budget: 8 x 256 px + a 128 px environment slot. */
export const PROBE_LAYOUT_BUDGET = 8 * cubeBytes(256) + cubeBytes(128);
/** Non-shipped layouts must land within this share of the budget (the check's tolerance). */
export const PROBE_LAYOUT_TOLERANCE = 0.1;
/** The set default every non-shipped layout bakes with (the environment slot's size). */
export const LAYOUT_SET_RESOLUTION = 128;

export const PROBE_LAYOUT_NAMES = ['shipped', 'few', 'medium', 'many', 'manyCell', 'mixed'] as const;
/**
 * W62 (D4900): Sponza's mixed layout with fewer probe sizes (each size is one sampled-texture
 * binding wherever the set is sampled). Not held to the budget; memory is reported.
 *   twoSize      512 courtyard floor slab, everything else at 256 (aisle slabs, the 8-cell grid, the environment)
 *   twoSizeFew   512 courtyard floor slab, 256 aisle slabs, few's two volumes at 256, environment 256 (near the budget)
 *   mixedDown    mixed with its 256 aisle slabs merged down to 128 (what merging the middle size away gives)
 *   oneSize256   mixed's volumes all at 256 (one size per set: Unreal's / Godot's model)
 *   oneSize128   mixed's volumes all at 128
 */
export const PROBE_BINDING_LAYOUT_NAMES = ['twoSize', 'twoSizeFew', 'mixedDown', 'oneSize256', 'oneSize128'] as const;
export type ProbeLayoutName = (typeof PROBE_LAYOUT_NAMES)[number] | (typeof PROBE_BINDING_LAYOUT_NAMES)[number];

export interface ProbeLayout {
  name: ProbeLayoutName;
  /** One line for the HUD. */
  description: string;
  volumes: ProbeVolume[];
  /** The set's default face size (`bake({ resolution })`): the environment slot's and every probe without its own. */
  resolution: number;
  /** Planned atlas bytes ({@link layoutBytes}); the page reports what the bake allocated. */
  bytes: number;
  /** Grid layouts: the mean cell size (shorter side, m) and the blend distance as a share of it. */
  spacing?: number;
  blend?: number;
}

/** A walkable region: an axis-aligned box from its floor (min y) to its ceiling or roof line (max y). */
export interface LayoutRegion { name: string; min: Vec3; max: Vec3 }

export interface GridOptions {
  /** Face size of every cell's probe. */
  resolution: number;
  /** Blend distance as a share of each cell's shorter side. Default 0.25. */
  blend?: number;
  /** Project each cell onto its own box (cell footprint x region height) instead of the region's. */
  cellProjection?: boolean;
}

/** Splits `n` cells over the regions by floor area: at least one each, then largest remainder. */
function allocate(regions: readonly LayoutRegion[], n: number): number[] {
  const area = regions.map((r) => (r.max[0] - r.min[0]) * (r.max[2] - r.min[2]));
  const total = area.reduce((a, b) => a + b, 0);
  const share = area.map((a) => (a / total) * n);
  const out = share.map((s) => Math.max(1, Math.floor(s)));
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = share.map((s, i) => ({ i, r: s - Math.floor(s) })).sort((a, b) => b.r - a.r);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out;
}

/** The factor pair nx x nz = n whose cells over an L x D footprint are squarest. */
function factor(n: number, L: number, D: number): [number, number] {
  let best: [number, number] = [n, 1], score = Infinity;
  for (let nz = 1; nz <= n; nz++) {
    if (n % nz) continue;
    const nx = n / nz, a = L / nx / (D / nz);
    const s = Math.max(a, 1 / a);
    if (s < score) { score = s; best = [nx, nz]; }
  }
  return best;
}

/** The systematic grid: `n` probes over `regions` (see the file header). */
export function gridProbes(regions: readonly LayoutRegion[], n: number, o: GridOptions): { volumes: ProbeVolume[]; spacing: number } {
  const volumes: ProbeVolume[] = [];
  const counts = allocate(regions, n);
  let spacing = 0;
  regions.forEach((r, ri) => {
    const L = r.max[0] - r.min[0], H = r.max[1] - r.min[1], D = r.max[2] - r.min[2];
    const [nx, nz] = factor(counts[ri], L, D);
    const dx = L / nx, dz = D / nz;
    const b = (o.blend ?? 0.25) * Math.min(dx, dz);
    const rc: Vec3 = [(r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2, (r.min[2] + r.max[2]) / 2];
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
      const c: Vec3 = [r.min[0] + (ix + 0.5) * dx, rc[1], r.min[2] + (iz + 0.5) * dz];
      volumes.push({
        position: c,
        influenceSize: [dx + 2 * b, H + 2 * b, dz + 2 * b],
        projectionSize: o.cellProjection ? [dx, H, dz] : [L, H, D],
        projectionOffset: o.cellProjection ? [0, 0, 0] : [rc[0] - c[0], 0, rc[2] - c[2]],
        blendDistance: b,
        resolution: o.resolution,
      });
      spacing += Math.min(dx, dz);
    }
  });
  return { volumes, spacing: spacing / volumes.length };
}

/**
 * A thin slab over a region's floor for its glossy floor alone (W38's offscreen floor probe, made
 * generic): influence 0.6 m tall around the floor (so its volume is below the grid cells' and the
 * lookup takes it first), projected onto the region's box, captured 0.2 m above the floor.
 */
export function floorSlab(r: LayoutRegion, resolution: number, pad = 0.3): ProbeVolume {
  const L = r.max[0] - r.min[0], H = r.max[1] - r.min[1], D = r.max[2] - r.min[2];
  const c: Vec3 = [(r.min[0] + r.max[0]) / 2, r.min[1], (r.min[2] + r.max[2]) / 2];
  return {
    position: c, influenceSize: [L + 2 * pad, 0.6, D + 2 * pad], blendDistance: 0.15,
    projectionSize: [L, H, D], projectionOffset: [0, H / 2, 0], originOffset: [0, 0.2, 0], resolution,
  };
}

interface SceneLayouts {
  regions: LayoutRegion[];
  /** 2 x 512 by hand, from the shipped volumes. */
  few(shipped: readonly ProbeVolume[]): ProbeVolume[];
  /** Sizes where the receivers need them (W60). */
  mixed(shipped: readonly ProbeVolume[], blend: number): ProbeVolume[];
  mixedNote: string;
}

const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): LayoutRegion => ({ name, min: [x0, y0, z0], max: [x1, y1, z1] });
const sized = (v: ProbeVolume, resolution: number): ProbeVolume => ({ ...v, resolution });

/** Sponza's regions as the showcase's seven probes cut it (examples/showcase/src/scenes.ts). */
const SPONZA_REGIONS = [
  box('courtyard', -11.4, 10.4, 0, 10.4, -2.5, 1.9),
  box('south aisle', -11.4, 10.4, 0, 3.6, -5.2, -2.5), box('north aisle', -11.4, 10.4, 0, 3.6, 1.9, 4.6),
  box('south gallery', -11.4, 10.4, 3.6, 8.2, -5.2, -2.5), box('north gallery', -11.4, 10.4, 3.6, 8.2, 1.9, 4.6),
];

const SCENES: Record<string, SceneLayouts> = {
  // Ben's two rooms (rooms.ts): x -8..0 and 0..8, z -4..4, 5 m high; a polished floor (r 0.12)
  rooms: {
    regions: [box('left room', -8, 0, 0, 5, -4, 4), box('right room', 0, 8, 0, 5, -4, 4)],
    few: (s) => [sized(s[0], 512), sized(s[1], 512)],
    // the floor is glossy (r 0.12: 256 by the sizing note) in both rooms; the rest is rough
    mixed: (_s, blend) => [
      ...SCENES.rooms.regions.map((r) => floorSlab(r, 256)),
      ...gridProbes(SCENES.rooms.regions, 24, { resolution: 128, blend }).volumes,
    ],
    mixedNote: 'a 256 px floor slab per room (r 0.12), 24 x 128 px grid',
  },
  // offscreen: one room box x -7..7, z -4..8, 5 m (no ceiling); mirror floor r 0.02, wall mirror r 0
  offscreen: {
    regions: [box('room', -7, 7, 0, 5, -4, 8)],
    // the room and the floor probe lidded at the ring (W38), both 512
    few: (s) => [sized(s[0], 512), sized(s[1], 512)],
    // W60's kit with the room at 128: the floor and the wall mirror are the mirror-grade receivers
    mixed: (s) => [sized(s[0], 128), sized(s[1], 512), sized(s[2], 512)],
    mixedNote: 'the kit (room, lidded floor, wall mirror) with floor + mirror 512, room 128',
  },
  // the showcase's Sponza (polished floor r 0.06)
  sponza: {
    regions: SPONZA_REGIONS,
    // the courtyard and one probe over the whole building (aisles and galleries), both 512
    few: (s) => [sized(s[0], 512), {
      position: [-0.5, 4.8, -0.3], influenceSize: [21.8, 11.2, 9.8], projectionSize: [21.8, 10.4, 9.8], projectionOffset: [0, 0.4, 0], blendDistance: 0.8, resolution: 512,
    }],
    // the courtyard floor near-mirror (r 0.06) at 512, the aisle floors 256, an 8 x 128 px grid for the rest
    mixed: (_s, blend) => [
      floorSlab(SPONZA_REGIONS[0], 512), floorSlab(SPONZA_REGIONS[1], 256), floorSlab(SPONZA_REGIONS[2], 256),
      ...gridProbes(SPONZA_REGIONS, 8, { resolution: 128, blend }).volumes,
    ],
    mixedNote: 'courtyard floor slab 512, aisle floor slabs 256, 8 x 128 px grid',
  },
};
/** Page scene ids that are another page's scene (examples/ssr loads the showcase's Sponza as `showcaseSponza`). */
const ALIASES: Record<string, string> = { showcaseSponza: 'sponza' };

/** Scene ids with layouts. */
export const PROBE_LAYOUT_SCENES = Object.keys(SCENES);
export const hasProbeLayouts = (sceneId: string) => !!SCENES[ALIASES[sceneId] ?? sceneId];

/**
 * The layout `name` for `sceneId` (null when the scene has none). `shipped` is the scene's own
 * volumes; `blend` (share of the cell's shorter side) applies to the grid layouts.
 */
export function probeLayout(sceneId: string, name: ProbeLayoutName, shipped: readonly ProbeVolume[], opts: { blend?: number; shippedResolution?: number } = {}): ProbeLayout | null {
  const s = SCENES[ALIASES[sceneId] ?? sceneId];
  if (!s) return null;
  const blend = opts.blend ?? 0.25;
  const R = LAYOUT_SET_RESOLUTION;
  const make = (volumes: ProbeVolume[], description: string, resolution = R, grid?: { spacing: number }): ProbeLayout => ({
    name, description, volumes, resolution, bytes: layoutBytes(volumes, resolution), ...(grid ? { spacing: grid.spacing, blend } : {}),
  });
  switch (name) {
    case 'shipped': return make(shipped.map((v) => ({ ...v })), `the scene's own ${shipped.length} probes`, opts.shippedResolution ?? 256);
    case 'few': return make(s.few(shipped), '2 x 512 px, hand placed');
    case 'medium': { const g = gridProbes(s.regions, 8, { resolution: 256, blend }); return make(g.volumes, `${g.volumes.length} x 256 px grid`, R, g); }
    case 'many': { const g = gridProbes(s.regions, 32, { resolution: 128, blend }); return make(g.volumes, `${g.volumes.length} x 128 px grid`, R, g); }
    case 'manyCell': { const g = gridProbes(s.regions, 32, { resolution: 128, blend, cellProjection: true }); return make(g.volumes, `${g.volumes.length} x 128 px grid, each projected onto its own cell`, R, g); }
    case 'mixed': return make(s.mixed(shipped, blend), s.mixedNote, R);
  }
  // W62: fewer sizes (Sponza's slabs + grid geometry, or few's volumes)
  if (s !== SCENES.sponza) return null;
  const at = (vs: ProbeVolume[], f: (r: number) => number) => vs.map((v) => sized(v, f(v.resolution ?? R)));
  const mixed = s.mixed(shipped, blend);
  switch (name) {
    case 'twoSize': return make(at(mixed, (r) => (r === 512 ? 512 : 256)), 'courtyard floor slab 512, the rest (aisle slabs, 8-cell grid, environment) 256', 256);
    case 'twoSizeFew': return make([...mixed.slice(0, 3), ...at(s.few(shipped), () => 256)], 'courtyard floor slab 512, aisle slabs 256, two room volumes 256, environment 256', 256);
    case 'mixedDown': return make(at(mixed, (r) => (r === 256 ? 128 : r)), 'mixed with the 256 aisle slabs at 128 (512 + 128)', R);
    case 'oneSize256': return make(at(mixed, () => 256), "mixed's 11 volumes and the environment all at 256", 256);
    case 'oneSize128': return make(at(mixed, () => 128), "mixed's 11 volumes and the environment all at 128", 128);
  }
  return null;
}

/**
 * W63: an `n`-cell grid (every cell 128 px unless `resolution`) over the scene's regions, for the
 * lookup-cost sweep at 4 / 8 / 16 / 32 volumes. Null when the scene has no layouts.
 */
export function probeGrid(sceneId: string, n: number, opts: { resolution?: number; blend?: number } = {}): ProbeVolume[] | null {
  const s = SCENES[ALIASES[sceneId] ?? sceneId];
  return s ? gridProbes(s.regions, n, { resolution: opts.resolution ?? 128, blend: opts.blend ?? 0.25 }).volumes : null;
}
