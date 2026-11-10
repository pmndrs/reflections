// CPU side of the bench: test directions, seam classification, the error metric.

/** `n` directions spread evenly over the sphere (Fibonacci lattice), as vec4f (w = 0). */
export function fibonacciDirs(n: number): Float32Array {
  const out = new Float32Array(n * 4);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = i * ga;
    out.set([r * Math.cos(phi), y, r * Math.sin(phi), 0], i * 4);
  }
  return out;
}

/** Distance in texels (at face size `s`) from a direction to the nearest cube face edge. */
export function cubeEdgeTexels(x: number, y: number, z: number, s: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let ma: number, a: number, b: number;
  if (ax >= ay && ax >= az) { ma = ax; a = ay; b = az; } else if (ay >= az) { ma = ay; a = ax; b = az; } else { ma = az; a = ax; b = ay; }
  return (1 - Math.max(a, b) / ma) * (s / 2);
}

/** The octahedral map of layouts/common.ts (pole +y), in JS. */
export function octaEncode(x: number, y: number, z: number): [number, number] {
  const n = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let px = x / n, py = z / n;
  if (y < 0) {
    const sx = px >= 0 ? 1 : -1, sy = py >= 0 ? 1 : -1;
    [px, py] = [(1 - Math.abs(py)) * sx, (1 - Math.abs(px)) * sy];
  }
  return [px, py];
}

/**
 * Distance in texels (interior span `s` texels for [-1, 1]) from a direction to the nearest octa
 * fold: the square's border (where the map wraps) or the diamond |x| + |y| = 1 (the horizon, where
 * it kinks).
 */
export function octaFoldTexels(x: number, y: number, z: number, s: number): number {
  const [px, py] = octaEncode(x, y, z);
  const border = 1 - Math.max(Math.abs(px), Math.abs(py));
  const diamond = Math.abs(Math.abs(px) + Math.abs(py) - 1) / Math.SQRT2;
  return Math.min(border, diamond) * (s / 2);
}

const srgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
/** The fixed tone map of the error metric: Reinhard per channel, sRGB encode, 0-255. */
export const tone = (x: number) => 255 * srgb(Math.max(x, 0) / (1 + Math.max(x, 0)));

export interface ErrStats { n: number; mean: number; p99: number; max: number }

function summarize(v: Float32Array, n: number): ErrStats {
  if (n === 0) return { n: 0, mean: 0, p99: 0, max: 0 };
  const a = v.subarray(0, n).sort();
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return { n, mean: s / n, p99: a[Math.min(n - 1, Math.floor(0.99 * n))], max: a[n - 1] };
}

/**
 * Per-direction error, max over channels of |tone(a) - tone(b)| (0-255), summarized for all
 * directions, the seam class (`seam[i]`), the rest, and `bright` (reference luminance > 2, the
 * glow around the sun, lamp and windows: where banding and colour shifts of small floats show).
 */
export function errorStats(test: Float32Array, ref: Float32Array, seam: Uint8Array) {
  const n = seam.length;
  const all = new Float32Array(n), se = new Float32Array(n), inn = new Float32Array(n), br = new Float32Array(n);
  let ns = 0, ni = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(tone(test[i * 4 + c]) - tone(ref[i * 4 + c])));
    all[i] = e;
    if (seam[i]) se[ns++] = e; else inn[ni++] = e;
    const lum = 0.2126 * ref[i * 4] + 0.7152 * ref[i * 4 + 1] + 0.0722 * ref[i * 4 + 2];
    if (lum > 2) br[nb++] = e;
  }
  return { all: summarize(all, n), seam: summarize(se, ns), interior: summarize(inn, ni), bright: summarize(br, nb) };
}

export const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
