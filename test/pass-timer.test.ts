// PassTimer must not allocate a readback buffer per frame when the caller reads timings only now
// and then (W12: ScreenSpaceReflectionsPass with `timestamps: true` leaked one per frame).
import { describe, expect, it } from 'vitest';
import { PassTimer } from '../packages/core/src/sssr/timer';

(globalThis as Record<string, unknown>).GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 };
(globalThis as Record<string, unknown>).GPUMapMode ??= { READ: 1 };

function mockDevice() {
  const buffers: { destroyed: boolean }[] = [];
  const device = {
    features: new Set(['timestamp-query']),
    createQuerySet: () => ({ destroy() {} }),
    createBuffer: () => {
      const b = {
        destroyed: false,
        mapAsync: () => Promise.resolve(),
        getMappedRange: () => new BigInt64Array(32).buffer,
        unmap() {},
        destroy() { b.destroyed = true; },
      };
      buffers.push(b);
      return b;
    },
  };
  const encoder = { resolveQuerySet() {}, copyBufferToBuffer() {} };
  return { device: device as unknown as GPUDevice, encoder: encoder as unknown as GPUCommandEncoder, buffers };
}

describe('PassTimer', () => {
  it('reuses the readback buffer when the callbacks are dropped', () => {
    const { device, encoder, buffers } = mockDevice();
    const timer = new PassTimer(device);
    const before = buffers.length; // the resolve buffer
    for (let i = 0; i < 100; i++) {
      timer.begin();
      timer.pass('a');
      timer.end(encoder); // callback dropped: timings never read
    }
    expect(buffers.length - before).toBe(1);
  });

  it('still reads when the callback runs, and a superseded callback is a no-op', async () => {
    const { device, encoder } = mockDevice();
    const timer = new PassTimer(device);
    timer.begin(); timer.pass('a');
    const stale = timer.end(encoder)!;
    timer.begin(); timer.pass('a');
    const fresh = timer.end(encoder)!;
    stale();
    fresh();
    await timer.read();
    expect(timer.timings.has('a')).toBe(true);
  });
});
