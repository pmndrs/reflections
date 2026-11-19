// W76: core's default resolution (the cone + compensation at mirrorBias 0.5; 'relative' thickness 0.02 with RT) and
// the lobe split it feeds. Explicit values keep their pre-W76 meaning (the W76 review's rules).
import { describe, expect, it } from 'vitest';
import { mirrorBiasSplit, resolveScreenSpaceSettings } from '../packages/core/src/sssr/sssr';

const pick = (s: Record<string, unknown>) => {
  const r = resolveScreenSpaceSettings(s) as Record<string, unknown>;
  return { hitColorFilter: r.hitColorFilter, mirrorBias: r.mirrorBias, mirrorBiasCompensate: r.mirrorBiasCompensate, thicknessDepthMode: r.thicknessDepthMode, thicknessDepthFactor: r.thicknessDepthFactor };
};

describe('W76 defaults', () => {
  it('unset: cone + compensation at 0.5; without RT no thickness fields', () => {
    expect(pick({})).toEqual({ hitColorFilter: 'cone', mirrorBias: 0.5, mirrorBiasCompensate: true, thicknessDepthMode: undefined, thicknessDepthFactor: undefined });
  });
  it("hitColorFilter 'off' is the pre-W76 path (bias 0, no compensation in effect)", () => {
    const r = pick({ hitColorFilter: 'off' });
    expect(r.mirrorBias).toBe(0);
    expect(mirrorBiasSplit({ hitColorFilter: 'off' })).toEqual({ sample: 1, filter: 1, compensated: false });
  });
  it('an explicit mirrorBias keeps D49 (truncation): compensation defaults off with it', () => {
    expect(pick({ mirrorBias: 0.7 })).toMatchObject({ mirrorBias: 0.7, mirrorBiasCompensate: false });
    expect(mirrorBiasSplit({ mirrorBias: 0.7 })).toEqual({ sample: 1, filter: 1, compensated: false });
  });
  it('a bias of 0 is never compensated (no zero filter share)', () => {
    expect(mirrorBiasSplit({ mirrorBias: 0, mirrorBiasCompensate: true })).toEqual({ sample: 1, filter: 1, compensated: false });
    expect(mirrorBiasSplit({ mirrorBias: 0 })).toEqual({ sample: 1, filter: 1, compensated: false });
  });
  it('compensation splits the lobe as sample sqrt(1 - f), filter sqrt(f) (f 0.3: not symmetric, a swap would show)', () => {
    const s = mirrorBiasSplit({ mirrorBias: 0.3, mirrorBiasCompensate: true });
    expect(s.compensated).toBe(true);
    expect(s.sample).toBeCloseTo(Math.sqrt(0.7), 6);
    expect(s.filter).toBeCloseTo(Math.sqrt(0.3), 6);
    expect(mirrorBiasCompensateOnly()).toMatchObject({ mirrorBias: 0.5, mirrorBiasCompensate: true });
  });
  it("with RT: unset thickness = 'relative' 0.02; an explicit factor keeps 'add'; an explicit mode keeps it", () => {
    expect(pick({ missesTraced: true })).toMatchObject({ thicknessDepthMode: 'relative', thicknessDepthFactor: 0.02 });
    expect(pick({ missesTraced: true, thicknessDepthFactor: 0.01 })).toMatchObject({ thicknessDepthMode: 'add', thicknessDepthFactor: 0.01 });
    expect(pick({ missesTraced: true, thicknessDepthMode: 'add' })).toMatchObject({ thicknessDepthMode: 'add', thicknessDepthFactor: 0 });
    expect(pick({ missesTraced: true, thicknessDepthMode: 'relative' })).toMatchObject({ thicknessDepthMode: 'relative', thicknessDepthFactor: 0.02 });
  });
  it('is idempotent (outputs.settings is resolved again by the RT pass and the hybrid)', () => {
    for (const s of [{}, { missesTraced: true }, { mirrorBias: 0.3 }, { hitColorFilter: 'off' as const }, { missesTraced: true, thicknessDepthFactor: 0.01 }]) {
      const once = resolveScreenSpaceSettings(s);
      expect(resolveScreenSpaceSettings(once)).toEqual(once);
    }
  });
});

function mirrorBiasCompensateOnly() { return pick({ mirrorBiasCompensate: true }); }
