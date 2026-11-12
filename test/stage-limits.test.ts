import { describe, expect, it } from 'vitest';
import { REFLECTIONS_SAMPLED_TEXTURES_PER_STAGE, checkStageLimits, countStageBindings, reflectionsRequiredLimits } from '@pmndrs/reflections-core';

// W62 (D4900): the sampled-texture limit. The GPU side (a four-size set in the SSSR intersect at
// the default 16, Sponza's three-size set in three's composite) runs in `pnpm check`.
const adapter = (limits: Record<string, number>) => ({ limits: { maxStorageTexturesPerShaderStage: 8, maxColorAttachmentBytesPerSample: 32, ...limits } }) as unknown as GPUAdapter;
const device = (limits: Record<string, number>) => ({ limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4, maxSampledTexturesPerShaderStage: 16, ...limits } }) as unknown as GPUDevice;

describe('sampled textures per stage (W62)', () => {
  it('reflectionsRequiredLimits asks for up to 32, never past the adapter, nothing at the default', () => {
    expect(reflectionsRequiredLimits(adapter({ maxSampledTexturesPerShaderStage: 48 })).maxSampledTexturesPerShaderStage).toBe(REFLECTIONS_SAMPLED_TEXTURES_PER_STAGE);
    expect(reflectionsRequiredLimits(adapter({ maxSampledTexturesPerShaderStage: 20 })).maxSampledTexturesPerShaderStage).toBe(20);
    expect(reflectionsRequiredLimits(adapter({ maxSampledTexturesPerShaderStage: 16 })).maxSampledTexturesPerShaderStage).toBeUndefined();
  });

  it('counts layout entries and names every part when a stage overflows', () => {
    const C = 4;
    expect(countStageBindings([
      { binding: 0, visibility: C, texture: {} }, { binding: 1, visibility: C, sampler: {} }, { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: C, buffer: { type: 'uniform' } }, { binding: 4, visibility: C, storageTexture: { format: 'r32float' } },
    ])).toEqual({ storageBuffers: 1, storageTextures: 1, sampledTextures: 1 });
    const parts = [['pass', { sampledTextures: 10 }], ['radiance fallback', { sampledTextures: 4 }], ['hit shading', { sampledTextures: 4 }]] as const;
    expect(() => checkStageLimits(device({}), 'ssr: the intersect pipeline', parts)).toThrow(/18 sampled textures .*pass 10, radiance fallback 4, hit shading 4.*maxSampledTexturesPerShaderStage/);
    expect(() => checkStageLimits(device({ maxSampledTexturesPerShaderStage: 32 }), 'ssr: the intersect pipeline', parts)).not.toThrow();
  });
});
