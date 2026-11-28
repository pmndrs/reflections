import { describe, expect, it } from 'vitest';
import { countStageTextures, materialTextureLimitWarning, type StageBinding } from '../packages/three/src/probes/stageLimits';

// W104 (T24, D5640): a three material's sampled textures (its maps + the probe atlases) against the
// device's per-stage limits. The GPU side (WebGPU's own count, the warning once per material, a
// raised limit) is the `textureLimit` regression (`pnpm check -- --only regressions`).
const tex = (texture: unknown = {}): StageBinding => ({ isSampledTexture: true, texture });
const smp = (): StageBinding => ({ isSampler: true });
const limits = { maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16 };

describe('material texture limit (T24)', () => {
  it('counts sampled textures and samplers per stage, once each, without storage textures; marks the atlases', () => {
    const atlasA = {}, atlasB = {};
    const shared = tex();
    const counts = countStageTextures({
      vertex: { object: [{}] },
      fragment: { render: [smp(), shared, smp(), tex(atlasA)], object: [shared, tex(atlasB), { isSampledTexture: true, store: true }, {}] },
      compute: {},
    }, new Set([atlasA, atlasB]));
    expect(counts).toEqual([{ stage: 'fragment', sampledTextures: 3, samplers: 2, atlases: 2 }]);
  });

  it('warns past the sampled-texture limit with the material, the count, the limit and the fix; nothing at the limit', () => {
    const at = [{ stage: 'fragment', sampledTextures: 16, samplers: 16, atlases: 3 }];
    expect(materialTextureLimitWarning('material "Floor" (MeshStandardMaterial)', at, limits, [256, 512, 128])).toBeNull();
    const w = materialTextureLimitWarning('material "Floor" (MeshStandardMaterial)', [{ ...at[0], sampledTextures: 18 }], limits, [256, 512, 128]);
    expect(w).toMatch(/material "Floor" \(MeshStandardMaterial\) binds 18 sampled textures in its fragment shader, 3 of the textures probe atlases \(one per probe size: 256, 512, 128 px\)/);
    expect(w).toMatch(/this device allows 16 \(maxSampledTexturesPerShaderStage\)/);
    expect(w).toMatch(/reflectionsRequiredLimits\(adapter\).*fewer probe sizes/);
  });

  it('a sampler overflow names the sampler limit and does not promise reflectionsRequiredLimits fixes it', () => {
    const w = materialTextureLimitWarning('material (MeshPhysicalMaterial)', [{ stage: 'fragment', sampledTextures: 16, samplers: 17, atlases: 1 }], limits, [256]);
    expect(w).toMatch(/binds 17 samplers .*allows 16 \(maxSamplersPerShaderStage\)/);
    expect(w).toMatch(/does not raise the sampler limit/);
  });
});
