// reflectionsRequiredLimits asks for the G-buffer's color bytes per sample, capped at the adapter (D4600).
import { describe, expect, it } from 'vitest';
import { reflectionsRequiredLimits } from '../packages/core/src/downsample';

const adapter = (limits: Record<string, number>) => ({ limits: { maxStorageTexturesPerShaderStage: 8, ...limits } }) as unknown as GPUAdapter;

describe('reflectionsRequiredLimits', () => {
  it('asks for 64 color bytes when the adapter allows more', () => {
    expect(reflectionsRequiredLimits(adapter({ maxColorAttachmentBytesPerSample: 128 })).maxColorAttachmentBytesPerSample).toBe(64);
  });
  it('caps the request at the adapter limit', () => {
    expect(reflectionsRequiredLimits(adapter({ maxColorAttachmentBytesPerSample: 48 })).maxColorAttachmentBytesPerSample).toBe(48);
  });
  it('leaves the default alone on a 32-byte adapter', () => {
    expect(reflectionsRequiredLimits(adapter({ maxColorAttachmentBytesPerSample: 32 }))).not.toHaveProperty('maxColorAttachmentBytesPerSample');
  });
});
