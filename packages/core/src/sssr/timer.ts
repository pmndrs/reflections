// Per-pass GPU timer on timestamp queries (same shape as the denoiser repo's PassTimer). Never
// blocks: results land in `timings` a few frames late, or `await read()` after a submit.

export class PassTimer {
  readonly timings = new Map<string, number>();
  private querySet: GPUQuerySet;
  private resolve: GPUBuffer;
  private free: GPUBuffer[] = [];
  private names: string[] = [];
  private capacity: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(private device: GPUDevice, maxPasses = 16) {
    this.capacity = maxPasses * 2;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: this.capacity });
    this.resolve = device.createBuffer({ size: this.capacity * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  }

  static supported(device: GPUDevice) { return device.features.has('timestamp-query'); }

  begin() { this.names = []; }

  pass(name: string): GPUComputePassTimestampWrites | undefined {
    const i = this.names.length;
    if (2 * i + 1 >= this.capacity) return undefined;
    this.names.push(name);
    return { querySet: this.querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
  }

  /** Record resolve + readback copy into `encoder`. Call `after()` once the encoder is submitted. */
  end(encoder: GPUCommandEncoder): (() => void) | undefined {
    const n = this.names.length;
    if (!n) return undefined;
    const names = this.names.slice();
    const read = this.free.pop() ?? this.device.createBuffer({ size: this.capacity * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.resolveQuerySet(this.querySet, 0, n * 2, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, read, 0, n * 16);
    return () => {
      this.pending = read.mapAsync(GPUMapMode.READ, 0, n * 16).then(() => {
        const t = new BigInt64Array(read.getMappedRange(0, n * 16));
        let total = 0;
        for (let i = 0; i < n; i++) {
          const ms = Number(t[2 * i + 1] - t[2 * i]) / 1e6;
          total += ms;
          this.timings.set(names[i], ms);
        }
        this.timings.set('total', total);
        read.unmap();
        this.free.push(read);
      }).catch(() => { /* device lost */ });
    };
  }

  /** Resolves once the last submitted frame's timings are in `timings`. */
  read(): Promise<void> { return this.pending; }

  destroy() {
    this.querySet.destroy();
    this.resolve.destroy();
    for (const b of this.free) b.destroy();
  }
}
