// Storage formats for prefiltered probes (docs/SPEC.md, "Storage format, a second axis").
//
// The prefilter always writes rgba16float (compute can store it). From there:
//   rgba16float      copied as is.
//   rg11b10ufloat    no storage binding in core WebGPU, and renderable only with the optional
//                    `rg11b10ufloat-renderable` feature, so compute packs it into a buffer and
//                    copyBufferToTexture writes it (works on every device).
//   rgb9e5ufloat     sampleable but neither renderable nor storage: same buffer path.
//   bc6h-rgb-ufloat  a GPU encoder (packages/core/src/encode, the W2 stream) turns the scratch into
//                    blocks; passed in as `bc6h`, since the encoder is optional.

import type { ProbeLayout } from './types';

export type ProbeFormat = 'rgba16float' | 'rg11b10ufloat' | 'rgb9e5ufloat' | 'bc6h-rgb-ufloat';

/** The slice of the BC6H encoder (docs/HANDOFF.md, "BC6H encoder") the probes use. */
export interface BC6HEncoderLike {
  encodeInto(cmd: GPUCommandEncoder, src: GPUTexture, dst: GPUTexture, opts?: { quality?: 'fast' | 'normal' }): void;
}

// Unsigned small floats from f16 bits (round to nearest; the f16 conversion rounds first).
const PACK_WGSL = /* wgsl */ `
override FORMAT: u32 = 0u; // 0 = rg11b10ufloat, 1 = rgb9e5ufloat
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> P: vec4<u32>; // x = size, y = layers, z = row stride in u32
fn uf(x: f32, drop: u32, maxBits: u32) -> u32 {
  let h = pack2x16float(vec2(clamp(x, 0.0, 65000.0), 0.0)) & 0x7fffu;
  return min((h + (1u << (drop - 1u))) >> drop, maxBits);
}
fn rg11b10(c: vec3<f32>) -> u32 {
  return uf(c.r, 4u, 0x7bfu) | (uf(c.g, 4u, 0x7bfu) << 11u) | (uf(c.b, 5u, 0x3dfu) << 22u);
}
// EXT_texture_shared_exponent's reference encoder (N = 9, B = 15, Emax = 31).
fn rgb9e5(c0: vec3<f32>) -> u32 {
  let c = clamp(c0, vec3(0.0), vec3(65408.0));
  let m = max(max(c.r, c.g), max(c.b, 1e-30));
  var e = max(-16.0, floor(log2(m))) + 16.0;
  if (floor(m / exp2(e - 24.0) + 0.5) >= 512.0) { e += 1.0; }
  let s = vec3<u32>(floor(c / exp2(e - 24.0) + 0.5));
  return min(s.r, 511u) | (min(s.g, 511u) << 9u) | (min(s.b, 511u) << 18u) | (u32(e) << 27u);
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.x || id.y >= P.x || id.z >= P.y) { return; }
  let c = textureLoad(src, vec2<i32>(id.xy), i32(id.z), 0).rgb;
  let v = select(rg11b10(c), rgb9e5(c), FORMAT == 1u);
  dst[(id.z * P.x + id.y) * P.z + id.x] = v;
}`;

/**
 * Writes the prefilter's rgba16float scratch (one probe of `layout` at `size` px) into a probe slot
 * of a target in `format`. Owns its pack pipelines and staging buffer.
 */
export class ProbeFormatWriter {
  readonly format: ProbeFormat;
  private readonly device: GPUDevice;
  private readonly layout: ProbeLayout;
  private readonly size: number;
  private readonly owned: (GPUBuffer | GPUTexture)[] = [];
  private readonly mips: { group: GPUBindGroup; s: number; offset: number; bytesPerRow: number }[] = [];
  private pipe: GPUComputePipeline | null = null;
  private buffer: GPUBuffer | null = null;
  private bc6hDst: GPUTexture | null = null;
  private readonly bc6h: BC6HEncoderLike | null;

  private readonly bc6hQuality: 'fast' | 'normal';

  constructor(device: GPUDevice, layout: ProbeLayout, size: number, format: ProbeFormat, scratch: GPUTexture, bc6h: BC6HEncoderLike | null = null, bc6hQuality: 'fast' | 'normal' = 'normal') {
    this.device = device; this.layout = layout; this.size = size; this.format = format; this.bc6h = bc6h; this.bc6hQuality = bc6hQuality;
    const L = layout.layersPerProbe;
    if (format === 'rg11b10ufloat' || format === 'rgb9e5ufloat') {
      this.pipe = device.createComputePipeline({
        label: `ProbeFormatWriter.${format}`, layout: 'auto',
        compute: { module: device.createShaderModule({ code: PACK_WGSL, label: 'probe-pack' }), entryPoint: 'main', constants: { FORMAT: format === 'rgb9e5ufloat' ? 1 : 0 } },
      });
      let offset = 0;
      const layouts: { s: number; offset: number; bytesPerRow: number }[] = [];
      for (let m = 0; m < layout.mipLevelCount; m++) {
        const s = Math.max(size >> m, 1);
        const bytesPerRow = Math.ceil((s * 4) / 256) * 256;
        layouts.push({ s, offset, bytesPerRow });
        offset += bytesPerRow * s * L;
      }
      this.buffer = device.createBuffer({ label: 'ProbeFormatWriter.staging', size: offset, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.owned.push(this.buffer);
      for (const l of layouts) {
        const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(u, 0, new Uint32Array([l.s, L, l.bytesPerRow / 4, 0]));
        this.owned.push(u);
        const m = layouts.indexOf(l);
        const group = device.createBindGroup({
          layout: this.pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: scratch.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1 }) },
            { binding: 1, resource: { buffer: this.buffer, offset: l.offset, size: l.bytesPerRow * l.s * L } },
            { binding: 2, resource: { buffer: u } },
          ],
        });
        this.mips.push({ group, ...l });
      }
    } else if (format === 'bc6h-rgb-ufloat') {
      if (!bc6h) throw new Error('ProbeFormatWriter: bc6h-rgb-ufloat needs an encoder');
      this.bc6hDst = device.createTexture({ ...layout.textureDescriptor(size, 1, 'bc6h-rgb-ufloat'), label: 'ProbeFormatWriter.bc6h' });
      this.owned.push(this.bc6hDst);
    }
  }

  /** Records the conversion of `scratch` into slot `slot` of `target` (the layout's descriptor in `format`). */
  encode(encoder: GPUCommandEncoder, scratch: GPUTexture, target: GPUTexture, slot: number, timestampWrites?: GPUComputePassTimestampWrites) {
    const L = this.layout.layersPerProbe;
    if (this.format === 'rgba16float') {
      for (let m = 0; m < this.layout.mipLevelCount; m++) {
        const s = Math.max(this.size >> m, 1);
        encoder.copyTextureToTexture({ texture: scratch, mipLevel: m }, { texture: target, mipLevel: m, origin: [0, 0, slot * L] }, [s, s, L]);
      }
      return;
    }
    if (this.format === 'bc6h-rgb-ufloat') {
      this.bc6h!.encodeInto(encoder, scratch, this.bc6hDst!, { quality: this.bc6hQuality });
      for (let m = 0; m < this.layout.mipLevelCount; m++) {
        const s = Math.max(this.size >> m, 1);
        const p = Math.ceil(s / 4) * 4;
        encoder.copyTextureToTexture({ texture: this.bc6hDst!, mipLevel: m }, { texture: target, mipLevel: m, origin: [0, 0, slot * L] }, [p, p, L]);
      }
      return;
    }
    const pass = encoder.beginComputePass({ label: `ProbeFormatWriter.${this.format}`, timestampWrites });
    pass.setPipeline(this.pipe!);
    for (const m of this.mips) {
      pass.setBindGroup(0, m.group);
      pass.dispatchWorkgroups(Math.ceil(m.s / 8), Math.ceil(m.s / 8), L);
    }
    pass.end();
    for (let i = 0; i < this.mips.length; i++) {
      const m = this.mips[i];
      encoder.copyBufferToTexture(
        { buffer: this.buffer!, offset: m.offset, bytesPerRow: m.bytesPerRow, rowsPerImage: m.s },
        { texture: target, mipLevel: i, origin: [0, 0, slot * L] }, [m.s, m.s, L],
      );
    }
  }

  dispose() {
    for (const r of this.owned) r.destroy();
    this.owned.length = 0;
  }
}
