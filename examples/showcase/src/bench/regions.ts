// Measure regions for the tuning bench (W51). Rectangles are in normalized image coordinates (0..1,
// top-left origin), so they hold at any render size. carConcept's named regions are W50's
// (docs/research/car-quality-w50.md, docs/research/w50/scripts/metrics.py), defined at W50's camera
// (the bench's pose `w50`), and W46's door (the G-buffer roughness probe of the showcase check, pose `hero`).
// Two of W50's are masks the path-traced reference defines: `band` (the floor reflection of the car's
// underside: the longest run of PT luma < 15 per column) and `lip` (the 8 px above it, on the car), and
// `door` keeps the px where the PT's luma > 60 (the red door reflected in the floor).
import type { CameraView } from '../../../shared';

export interface Region {
  name: string;
  /** x, y, w, h in 0..1 of the image. */
  rect: [number, number, number, number];
  /** A mask the reference defines inside the rect (W50). */
  mask?: 'lip' | 'band' | 'refLuma60';
  /** The camera preset it was defined at (named regions only). */
  pose?: string;
  builtin?: boolean;
  note?: string;
  /** The image aspect (w / h) it was defined at; the bench skips it at another aspect (W54's are 1:1). */
  aspect?: number;
}

/** W50's camera, rebuilt by eye from the maintainer's shots (car-quality-w50.md "Setup"). */
export const EXTRA_VIEWS: Record<string, Record<string, CameraView>> = {
  carConcept: { w50: { pos: [0.491, 2.302, 5.617], target: [0, 0.25, 0], fov: 40 } },
};

const px = (x0: number, y0: number, x1: number, y1: number, w = 960, h = 540): [number, number, number, number] => [x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h];

export const NAMED_REGIONS: Record<string, Region[]> = {
  carConcept: [
    { name: 'lip', rect: px(460, 280, 640, 400), mask: 'lip', pose: 'w50', builtin: true, note: 'the skirt\'s lower lip: the 8 px above the PT\'s dark band (W50 halo)' },
    { name: 'band', rect: px(460, 280, 640, 400), mask: 'band', pose: 'w50', builtin: true, note: 'floor reflection of the underside: PT luma < 15 (W50)' },
    { name: 'wheel', rect: px(290, 410, 400, 500), pose: 'w50', builtin: true, note: 'the front wheel reflected in the floor (W50)' },
    { name: 'door', rect: px(470, 395, 640, 445), mask: 'refLuma60', pose: 'w50', builtin: true, note: 'the red door reflected in the floor, PT luma > 60 (W50)' },
    { name: 'car', rect: px(170, 380, 780, 520), pose: 'w50', builtin: true, note: 'the whole floor reflection of the car (W50)' },
    // W54 (docs/research/car-wheels-cabin-w54.md): defined at 1280 x 1280 (the maintainer's bench size), shown at 1:1 only
    { name: 'hub', rect: px(255, 758, 395, 882, 1280, 1280), pose: 'w50', aspect: 1, builtin: true, note: 'front wheel centre: the chrome star (Rim2) and the spokes around it (W54)' },
    { name: 'wheelFace', rect: px(200, 690, 480, 960, 1280, 1280), pose: 'w50', aspect: 1, builtin: true, note: 'front wheel inside the tyre: rim, spokes, disc, caliper (W54)' },
    { name: 'cabin', rect: px(330, 390, 640, 470, 1280, 1280), pose: 'w50', aspect: 1, builtin: true, note: 'the cabin seen through the windshield, 99% glass px (W54)' },
    { name: 'floorWheel', rect: px(200, 990, 500, 1230, 1280, 1280), pose: 'w50', aspect: 1, builtin: true, note: 'the front wheel reflected in the floor at 1:1 (W54)' },
    { name: 'door (hero)', rect: px(560, 345, 721, 389, 1280, 720), pose: 'hero', builtin: true, note: 'W46\'s door paint probe (G-buffer roughness 0.25 -> 0.35)' },
  ],
  // T53 (W85): the simple flicker scenes (examples/shared/metrics/scenes.ts), rects at 960 x 540, pose `hero`
  cubeFloor: [
    { name: 'cubeRefl', rect: px(325, 330, 495, 475), pose: 'hero', builtin: true, note: 'the orange cube\'s reflection (faces and the stair-stepping diagonal edges)' },
    { name: 'slabRefl', rect: px(495, 338, 720, 390), pose: 'hero', builtin: true, note: 'the low slab\'s reflection' },
    { name: 'contact', rect: px(320, 322, 720, 358), pose: 'hero', builtin: true, note: 'the contact lines of both objects with the floor' },
  ],
  edgesFloor: [
    { name: 'panelRefl', rect: px(360, 340, 600, 462), pose: 'hero', builtin: true, note: 'the checker panel\'s reflection: sharp edges' },
  ],
  plateFloor: [
    { name: 'plateRefl', rect: px(340, 372, 650, 425), pose: 'hero', builtin: true, note: 'the plate\'s reflected underside and edge' },
    { name: 'underPlate', rect: px(340, 296, 650, 370), pose: 'hero', builtin: true, note: 'floor under the plate: thickness leaks (rays behind the thin plate)' },
  ],
};

const luma = (d: Uint8ClampedArray, o: number) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

/** The pixel indices (y * W + x) of `r` at W x H, its mask taken from the reference image `ref` (RGBA). */
export function regionPixels(r: Region, W: number, H: number, ref: Uint8ClampedArray | null): number[] {
  const x0 = Math.max(0, Math.round(r.rect[0] * W)), y0 = Math.max(0, Math.round(r.rect[1] * H));
  const x1 = Math.min(W, Math.round((r.rect[0] + r.rect[2]) * W)), y1 = Math.min(H, Math.round((r.rect[1] + r.rect[3]) * H));
  const out: number[] = [];
  if (!r.mask) { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(y * W + x); return out; }
  if (!ref) return out;
  if (r.mask === 'refLuma60') { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (luma(ref, (y * W + x) * 4) > 60) out.push(y * W + x); return out; }
  // lip / band: per column, the longest run of reference luma < 15 (at least 6 px at 960 x 540, scaled)
  const s = H / 540, minRun = Math.max(2, Math.round(6 * s)), lip = Math.max(1, Math.round(8 * s));
  for (let x = x0; x < x1; x++) {
    let best = 0, start = -1, run0 = -1;
    for (let y = y0; y <= y1; y++) {
      const dark = y < y1 && luma(ref, (y * W + x) * 4) < 15;
      if (dark) { if (run0 < 0) run0 = y; } else { if (run0 >= 0 && y - run0 > best) { best = y - run0; start = run0; } run0 = -1; }
    }
    if (start < 0 || best < minRun) continue;
    if (r.mask === 'band') for (let y = start; y < start + best; y++) out.push(y * W + x);
    else for (let y = Math.max(0, start - lip); y < start; y++) out.push(y * W + x);
  }
  return out;
}

/** `?regions=name:x,y,w,h;...` (normalized, 4 decimals). */
export const encodeRegions = (rs: Region[]) => rs.map((r) => `${r.name.replace(/[:;,]/g, ' ')}:${r.rect.map((v) => v.toFixed(4)).join(',')}`).join(';');
export function decodeRegions(s: string | null): Region[] {
  if (!s) return [];
  return s.split(';').map((part) => {
    const [name, nums] = part.split(':');
    const v = (nums ?? '').split(',').map(Number);
    return v.length === 4 && v.every(Number.isFinite) ? { name, rect: v as [number, number, number, number] } : null;
  }).filter((r): r is Region => r !== null);
}
