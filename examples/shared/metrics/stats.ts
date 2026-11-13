// X0 (W70): the experiment plan's yardsticks as pure functions over frames (docs/plans/ssr-sources-experiments.md,
// "X0"). No DOM, no GPU, no three: the drivers (./run.ts on a page, the bench's PT metrics) read frames and hand
// them here, and test/metrics-stats.test.ts checks the maths on synthetic images.
//
// Conventions:
// - A frame is a luma array (Float32Array, length w * h, row-major, top row first). Display frames are 8-bit
//   luma (0..255, Rec. 709 weights over the sRGB bytes, as the bench's Measure and W36/W39); linear frames
//   (the raw signal, the denoised output) are linear luminance in scene units.
// - A region is a Uint8Array mask of the same size (1 = in). Every function takes one and reports its px.
// - Numbers are plain JS numbers; nothing here rounds.

export type Luma = Float32Array;
export type Mask = Uint8Array;

/** Rec. 709 luma of RGBA bytes (8-bit display units). */
export function lumaOfRGBA(d: ArrayLike<number>, n = d.length >> 2): Luma {
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  return l;
}

/** Linear luminance of RGBA floats (a half-float texture read back as floats). */
export function luminanceOfRGBA(d: ArrayLike<number>, n = d.length >> 2): Luma {
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  return l;
}

/** sRGB byte (0..255) to linear 0..1 (the sRGB EOTF). */
export const srgbToLinear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

export const count = (m: Mask) => { let c = 0; for (let i = 0; i < m.length; i++) c += m[i]; return c; };
export const fullMask = (n: number): Mask => new Uint8Array(n).fill(1);

/** The outer `border` share of the screen on each side (x < b w or x >= (1 - b) w, same in y): the edge-pan region. */
export function borderMask(w: number, h: number, border = 0.1, inside = false): Mask {
  const m = new Uint8Array(w * h);
  const bx = Math.round(w * border), by = Math.round(h * border);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const edge = x < bx || x >= w - bx || y < by || y >= h - by;
    m[y * w + x] = (edge !== inside) ? 1 : 0;
  }
  return m;
}
export const and = (a: Mask, b: Mask): Mask => { const m = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) m[i] = a[i] & b[i]; return m; };

/** A mask at w0 x h0 resampled (nearest) to w1 x h1, for linear textures at the render size under `?upscale=`. */
export function resampleMask(m: Mask, w0: number, h0: number, w1: number, h1: number): Mask {
  if (w0 === w1 && h0 === h1) return m;
  const out = new Uint8Array(w1 * h1);
  for (let y = 0; y < h1; y++) {
    const sy = Math.min(h0 - 1, Math.floor(((y + 0.5) * h0) / h1));
    for (let x = 0; x < w1; x++) out[y * w1 + x] = m[sy * w0 + Math.min(w0 - 1, Math.floor(((x + 0.5) * w0) / w1))];
  }
  return out;
}

// ---- rest drift ------------------------------------------------------------------------------------------

export interface DriftStats { px: number; mean: number; pctOver: number; threshold: number; p99: number }
/**
 * Rest drift: two frames of a still camera (the plan: frames 120 and 240 after a reset). `mean` = mean |a - b|
 * over the region (8-bit), `pctOver` = % of its px with |a - b| > `threshold` (default 8/255), p99 of |a - b|.
 */
export function drift(a: Luma, b: Luma, mask: Mask, threshold = 8): DriftStats {
  let px = 0, s = 0, over = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < a.length; i++) {
    if (!mask[i]) continue;
    const d = Math.abs(a[i] - b[i]);
    px++; s += d; if (d > threshold) over++;
    hist[Math.min(255, Math.round(d))]++;
  }
  return { px, mean: px ? s / px : 0, pctOver: px ? (100 * over) / px : 0, threshold, p99: percentile(hist, px, 0.99) };
}

function percentile(hist: Uint32Array, n: number, q: number) {
  if (!n) return 0;
  let acc = 0;
  for (let v = 0; v < hist.length; v++) { acc += hist[v]; if (acc >= n * q) return v; }
  return hist.length - 1;
}

// ---- temporal statistics -----------------------------------------------------------------------------------

/** Per-pixel running sums for a temporal mean / std over frames (8-bit luma or linear). */
export class Accumulator {
  readonly sum: Float64Array; readonly sq: Float64Array; frames = 0;
  constructor(readonly n: number) { this.sum = new Float64Array(n); this.sq = new Float64Array(n); }
  add(l: Luma) { for (let i = 0; i < this.n; i++) { const v = l[i]; this.sum[i] += v; this.sq[i] += v * v; } this.frames++; }
  mean(): Float32Array { const m = new Float32Array(this.n); for (let i = 0; i < this.n; i++) m[i] = this.sum[i] / Math.max(1, this.frames); return m; }
  /** Mean over the region of the per-pixel temporal std (unbiased, n - 1). */
  std(mask: Mask): number {
    const f = this.frames; if (f < 2) return 0;
    let px = 0, s = 0;
    for (let i = 0; i < this.n; i++) {
      if (!mask[i]) continue;
      const m = this.sum[i] / f, v = Math.max(0, this.sq[i] / f - m * m) * f / (f - 1);
      s += Math.sqrt(v); px++;
    }
    return px ? s / px : 0;
  }
  /** Mean over the region of the per-pixel temporal mean. */
  regionMean(mask: Mask): number { let px = 0, s = 0; for (let i = 0; i < this.n; i++) if (mask[i]) { s += this.sum[i]; px++; } return px ? s / px / Math.max(1, this.frames) : 0; }
}

/** Second temporal difference |x_t - 2 x_t-1 + x_t-2| (W36 / W39: cancels smooth motion), running over a frame stream. */
export class SecondDifference {
  private a: Luma | null = null; private b: Luma | null = null;
  s = 0; c = 0; over = 0; d1 = 0; c1 = 0; over1 = 0;
  constructor(readonly mask: Mask, readonly threshold = 4) {}
  /** `restart`: the motion changes direction or jumps here (W39's pendulum halves): no difference across it. */
  add(x: Luma, restart = false) {
    if (restart) { this.a = this.b = null; }
    const m = this.mask, t = this.threshold;
    if (this.b) for (let i = 0; i < x.length; i++) { if (!m[i]) continue; const d = Math.abs(x[i] - this.b[i]); this.d1 += d; this.c1++; if (d > t) this.over1++; }
    if (this.a && this.b) for (let i = 0; i < x.length; i++) { if (!m[i]) continue; const d = Math.abs(x[i] - 2 * this.b[i] + this.a[i]); this.s += d; this.c++; if (d > t) this.over++; }
    this.a = this.b; this.b = x;
  }
  result() { return { d1: this.c1 ? this.d1 / this.c1 : 0, pctD1Over: this.c1 ? (100 * this.over1) / this.c1 : 0, d2: this.c ? this.s / this.c : 0, pctD2Over: this.c ? (100 * this.over) / this.c : 0, threshold: this.threshold }; }
}

// ---- 2x2 energy --------------------------------------------------------------------------------------------

export interface QuadEnergy {
  /** Pixel pairs in the region (both px in it). */
  pairs: number;
  /** Mean squared neighbour difference across quad boundaries (pairs (2k+1, 2k+2)) and inside quads ((2k, 2k+1)), x and y. */
  across: number; within: number;
  /**
   * `across - within` (8-bit^2 for display frames): the power of the neighbour difference's alternation at the
   * Nyquist rate of the pixel grid, which is the quad grid's (half the pixel rate) signature. 0 for an image
   * with no 2x2 structure; positive when quads are flat inside and step at their borders (FFX's quad copy).
   */
  power: number;
  /** `(across - within) / (across + within)`: 0 = no grid, 1 = every quad flat. Scale-free; use it across scenes. */
  ratio: number;
}
/**
 * 2x2 energy: the quad-copy grid made visible (the plan's "power at the half-Nyquist frequency of the reflection
 * region"). Squared first differences between horizontal and vertical neighbours, split by whether the pair
 * straddles a 2x2 quad boundary (quads at even coordinates, as SSSR's) or lies inside a quad. The split is the
 * period-2 component of the difference signal, i.e. the image's power at the quad grid's frequency.
 * Frames at another size than the trace (under `?upscale=`) smear the grid: compare like with like.
 */
export function quadEnergy(l: Luma, w: number, h: number, mask: Mask): QuadEnergy {
  let sa = 0, ca = 0, sw = 0, cw = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x + 1 < w; x++) {
      const i = row + x; if (!mask[i] || !mask[i + 1]) continue;
      const d = l[i + 1] - l[i];
      if (x & 1) { sa += d * d; ca++; } else { sw += d * d; cw++; }
    }
  }
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!mask[i] || !mask[i + w]) continue;
      const d = l[i + w] - l[i];
      if (y & 1) { sa += d * d; ca++; } else { sw += d * d; cw++; }
    }
  }
  const across = ca ? sa / ca : 0, within = cw ? sw / cw : 0;
  return { pairs: ca + cw, across, within, power: across - within, ratio: across + within > 0 ? (across - within) / (across + within) : 0 };
}

// ---- speckle -------------------------------------------------------------------------------------------------

export interface Speckle { px: number; speckles: number; pct: number; sigma: number }
/**
 * Raw speckle count: px brighter than their 5x5 neighbourhood (the 24 others) by more than `sigma` standard
 * deviations, and by more than `floor` absolute and 5 % relative (so a flat area's last bits don't count).
 * `floor`: 2 for 8-bit display frames, ~1e-3 for linear signal frames.
 */
export function speckle(l: Luma, w: number, h: number, mask: Mask, sigma = 3, floor = 2): Speckle {
  let px = 0, sp = 0;
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    px++;
    let s = 0, q = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      const v = l[i + dy * w + dx]; s += v; q += v * v;
    }
    const m = s / 24, sd = Math.sqrt(Math.max(0, q / 24 - m * m));
    const e = l[i] - m;
    if (e > sigma * sd && e > floor && e > 0.05 * Math.abs(m)) sp++;
  }
  return { px, speckles: sp, pct: px ? (100 * sp) / px : 0, sigma };
}

// ---- error, gradients, line spread ---------------------------------------------------------------------------

/** Mean |a - b| over the region (same units as the frames). */
export function mad(a: ArrayLike<number>, b: ArrayLike<number>, mask: Mask) {
  let px = 0, s = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { s += Math.abs(a[i] - b[i]); px++; }
  return px ? s / px : 0;
}
/** Mean signed a - b over the region. */
export function bias(a: ArrayLike<number>, b: ArrayLike<number>, mask: Mask) {
  let px = 0, s = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { s += a[i] - b[i]; px++; }
  return px ? s / px : 0;
}
export function regionMean(a: ArrayLike<number>, mask: Mask) { let px = 0, s = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) { s += a[i]; px++; } return px ? s / px : 0; }

/**
 * Gradient energy: mean squared forward difference (x and y) over pairs inside the region. Compared with the
 * reference's: ours / PT < 1 = over-blurred, > 1 = sharper than the PT or noisy (read it with the MAD).
 */
export function gradientEnergy(l: ArrayLike<number>, w: number, h: number, mask: Mask) {
  let s = 0, c = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    if (x + 1 < w && mask[i + 1]) { const d = l[i + 1] - l[i]; s += d * d; c++; }
    if (y + 1 < h && mask[i + w]) { const d = l[i + w] - l[i]; s += d * d; c++; }
  }
  return c ? s / c : 0;
}

/**
 * Full width at half maximum of a 1-D profile, in samples (linear interpolation at both crossings). The base is
 * the profile's minimum unless given; null when the peak doesn't clear the base by `minContrast` or a crossing is
 * missing (the line runs off the window).
 */
export function fwhm(p: ArrayLike<number>, base?: number, minContrast = 1e-6): { width: number; peak: number; at: number; base: number } | null {
  let pk = -Infinity, at = -1, lo = Infinity;
  for (let i = 0; i < p.length; i++) { if (p[i] > pk) { pk = p[i]; at = i; } if (p[i] < lo) lo = p[i]; }
  const b = base ?? lo;
  if (at < 0 || pk - b < minContrast) return null;
  const half = b + (pk - b) / 2;
  let l = at; while (l > 0 && p[l - 1] > half) l--;
  let r = at; while (r < p.length - 1 && p[r + 1] > half) r++;
  if (l === 0 || r === p.length - 1) return null;
  const xl = l - 1 + (half - p[l - 1]) / (p[l] - p[l - 1]); // crossing between l-1 and l
  const xr = r + (p[r] - half) / (p[r] - p[r + 1]); // between r and r+1
  return { width: xr - xl, peak: pk, at, base: b };
}

/**
 * Line spread across a horizontal line in an image: for each column of the rect, the vertical profile's FWHM;
 * returns the median width (px) over the columns where it's defined, their count, and the median peak.
 * `l` should be linear (decode sRGB first: {@link srgbToLinear}) so half maximum means half the energy density.
 */
export function lineSpread(l: ArrayLike<number>, w: number, rect: [number, number, number, number]): { width: number | null; columns: number; peak: number; widths: number[] } {
  const [x0, y0, x1, y1] = rect;
  const widths: number[] = [], peaks: number[] = [];
  const prof = new Float32Array(y1 - y0);
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) prof[y - y0] = l[y * w + x];
    const r = fwhm(prof);
    if (r) { widths.push(r.width); peaks.push(r.peak); }
  }
  const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  return { width: med(widths), columns: widths.length, peak: med(peaks) ?? 0, widths };
}
