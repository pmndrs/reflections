import { describe, expect, it } from 'vitest';
import {
  integrateSplitSumDFG, SPLIT_SUM_DFG_SIZE as N, SPLIT_SUM_DFG_TABLES, splitSumDFGWgsl, type SplitSumVisibility,
} from '../packages/core/src/brdf/splitSum';

const forms: SplitSumVisibility[] = ['height-correlated', 'separable'];

describe('split-sum DFG (D2004)', () => {
  it('each table is the integrator at texel centres', () => {
    for (const form of forms) {
      const t = SPLIT_SUM_DFG_TABLES[form];
      expect(t.length).toBe(N * N * 2);
      for (const [j, i] of [[0, 0], [0, N - 1], [7, 4], [N - 1, 0], [N - 1, N - 1], [3, 27]]) {
        const [a, b] = integrateSplitSumDFG((j + 0.5) / N, (i + 0.5) / N, 65536, form);
        expect(t[2 * (j * N + i)]).toBeCloseTo(a, 4);
        expect(t[2 * (j * N + i) + 1]).toBeCloseTo(b, 4);
      }
    }
  });

  it('a mirror reduces to Schlick in both forms: scale 1 - Fc, bias Fc', () => {
    for (const form of forms) {
      for (const nv of [0.05, 0.3, 0.7, 1]) {
        const [a, b] = integrateSplitSumDFG(nv, 0, 4096, form);
        const fc = (1 - nv) ** 5;
        expect(a).toBeCloseTo(1 - fc, 2); // separable G1 at alpha 1e-4 (the clamp) still loses ~0.1% at grazing
        expect(b).toBeCloseTo(fc, 2);
      }
    }
  });

  it('height-correlated visibility keeps more energy than separable at mid roughness', () => {
    const [ha, hb] = integrateSplitSumDFG(0.5, 0.5, 4096, 'height-correlated');
    const [sa, sb] = integrateSplitSumDFG(0.5, 0.5, 4096, 'separable');
    expect(ha + hb).toBeGreaterThan(sa + sb);
  });

  it('the WGSL embeds every texel of the chosen table', () => {
    for (const form of forms) {
      const w = splitSumDFGWgsl(form);
      expect(w.match(/vec2f\(/g)!.length).toBeGreaterThanOrEqual(N * N);
      expect(w).toContain('fn splitSumDFG(NdotV: f32, roughness: f32) -> vec2f');
      expect(w).toContain(form);
    }
  });
});
