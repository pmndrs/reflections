// X0 (W70): the experiment metrics' maths (examples/shared/metrics/stats.ts) on synthetic images with known answers.
import { describe, expect, it } from 'vitest';
import { borderMask, drift, fullMask, fwhm, gradientEnergy, lineSpread, quadEnergy, speckle } from '../examples/shared/metrics/stats';

const W = 32, H = 16, N = W * H;
const img = (f: (x: number, y: number) => number) => { const l = new Float32Array(N); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) l[y * W + x] = f(x, y); return l; };

describe('X0 metrics', () => {
  it('quad energy: 0 for smooth images, 1 for flat 2x2 blocks, ~0 for a 1-px checker', () => {
    const all = fullMask(N);
    expect(quadEnergy(img((x, y) => 3 * x + 2 * y), W, H, all).ratio).toBeCloseTo(0, 6);
    const blocks = quadEnergy(img((x, y) => ((x >> 1) * 7 + (y >> 1) * 13) % 17), W, H, all);
    expect(blocks.ratio).toBeCloseTo(1, 6);
    expect(blocks.within).toBe(0);
    expect(quadEnergy(img((x, y) => ((x + y) & 1) * 10), W, H, all).ratio).toBeCloseTo(0, 6);
  });

  it('fwhm of a Gaussian is 2.355 sigma; lineSpread takes the median over columns', () => {
    const s = 3, p = Array.from({ length: 61 }, (_, i) => Math.exp(-((i - 30) ** 2) / (2 * s * s)));
    expect(fwhm(p)!.width).toBeCloseTo(2.3548 * s, 1);
    expect(fwhm([0, 1, 1, 1, 1])).toBeNull(); // runs off the window
    const l = img((_, y) => Math.exp(-((y - 8) ** 2) / 8));
    expect(lineSpread(l, W, [0, 0, W, H]).width!).toBeCloseTo(2.3548 * 2, 1);
  });

  it('speckle: an isolated hot pixel counts, a flat or smooth image does not', () => {
    const base = img((x) => 50 + x);
    expect(speckle(base, W, H, fullMask(N)).speckles).toBe(0);
    base[8 * W + 10] = 200;
    const r = speckle(base, W, H, fullMask(N));
    expect(r.speckles).toBe(1);
  });

  it('drift, border mask, gradient energy', () => {
    const a = img(() => 10), b = img((x) => (x < 16 ? 10 : 20));
    const d = drift(a, b, fullMask(N), 8);
    expect(d.mean).toBeCloseTo(5, 6);
    expect(d.pctOver).toBeCloseTo(50, 6);
    const m = borderMask(100, 50, 0.1);
    let c = 0; for (const v of m) c += v;
    expect(c).toBe(100 * 50 - 80 * 40);
    expect(gradientEnergy(img((x) => 2 * x), W, H, fullMask(N))).toBeCloseTo(((W - 1) * H * 4) / ((W - 1) * H + W * (H - 1)), 6);
  });
});
