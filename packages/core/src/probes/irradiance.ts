// L1 SH irradiance of each probe, from its own capture, on the GPU: the `probeIrradiance` side of
// the re-fit (SPEC "Probe re-fit", D60). Layout-generic: it integrates the radiance along a
// spherical-Fibonacci set of world directions through the layout's `sampleLayout`, so any atlas
// works, and writes three rows per atlas slot into the volume table's irradiance block (see
// ./table.ts): (L00.rgb, L1-1.r), (L1-1.gb, L10.rg), (L10.b, L11.rgb), radiance SH coefficients
// L_lm = integral of L(w) Y_lm(w) dw. The lookup turns them into irradiance at N (pr_shIrradiance).
//
// It reads a sharp mip (default maxLod - 2: 32 px faces for a 128 px probe), not mip 0: L1 needs only
// the low frequencies, and the GGX lobe of that mip (r = 0.29 at 128 px) is far narrower than the
// cosine lobe, so the bias is small while 16384 samples stay well above the mip's texel count.

import type { ProbeLayout } from './layouts/types';
import { captureAxesWgsl, resolveCaptureTransform, type ProbeCaptureTransform } from './capture';
import { PROBE_IRRADIANCE_ROWS } from './table';

const WG = 256;

const shaderWgsl = (layout: ProbeLayout, transform: ProbeCaptureTransform) => /* wgsl */ `${layout.wgsl}
struct U { slot: u32, row: u32, samples: u32, pad: u32, lod: f32, pad1: f32, pad2: f32, pad3: f32 }
@group(0) @binding(0) var atlas: ${layout.textureType};
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<storage, read_write> table: array<vec4f>;
@group(0) @binding(3) var<uniform> u: U;
var<workgroup> s0: array<vec4f, ${WG}>;
var<workgroup> s1: array<vec4f, ${WG}>;
var<workgroup> s2: array<vec4f, ${WG}>;
@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_index) li: u32) {
  var L00 = vec3f(0.0); var Ly = vec3f(0.0); var Lz = vec3f(0.0); var Lx = vec3f(0.0);
  let n = u.samples;
  for (var i = li; i < n; i += ${WG}u) {
    // spherical Fibonacci: uniform in z, golden-angle azimuth
    let z = 1.0 - (2.0 * f32(i) + 1.0) / f32(n);
    let rxy = sqrt(max(1.0 - z * z, 0.0));
    let phi = f32(i) * 2.399963229728653;
    let d = vec3f(rxy * cos(phi), rxy * sin(phi), z);
    let t = ${captureAxesWgsl(transform, 'd')};
    let c = sampleLayout(atlas, samp, u.slot, t, u.lod).rgb;
    L00 += c; Ly += c * d.y; Lz += c * d.z; Lx += c * d.x;
  }
  // weight 4 pi / n per sample; Y00 = 0.282095, Y1m = 0.488603 * (y, z, x)
  let w = 12.566370614 / f32(n);
  L00 *= 0.282095 * w; Ly *= 0.488603 * w; Lz *= 0.488603 * w; Lx *= 0.488603 * w;
  s0[li] = vec4f(L00, Ly.x); s1[li] = vec4f(Ly.yz, Lz.xy); s2[li] = vec4f(Lz.z, Lx);
  workgroupBarrier();
  for (var s = ${WG / 2}u; s > 0u; s >>= 1u) {
    if (li < s) { s0[li] += s0[li + s]; s1[li] += s1[li + s]; s2[li] += s2[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    let r = u.row + u.slot * ${PROBE_IRRADIANCE_ROWS}u;
    table[r] = s0[0]; table[r + 1u] = s1[0]; table[r + 2u] = s2[0];
  }
}`;

export interface ProbeIrradianceOptions {
  /** The atlas holds x-mirrored captures (three's CubeCamera): an alias of `captureTransform: CAPTURE_MIRROR_X`. Default false. */
  mirrorX?: boolean;
  /** The captures' transform (./capture.ts); its `axes` apply to the integrated directions. Not together with `mirrorX`. */
  captureTransform?: ProbeCaptureTransform;
  /** Directions integrated per probe. Default 16384. */
  samples?: number;
}

/**
 * Computes L1 SH radiance coefficients of atlas slots into a volume table (rows `irradianceRow +
 * 3 * slot`). The table buffer needs STORAGE usage; the atlas view is the layout's view dimension.
 */
export class ProbeIrradiance {
  readonly layout: ProbeLayout;
  private readonly device: GPUDevice;
  private readonly pipe: GPUComputePipeline;
  private readonly samples: number;
  private readonly sampler: GPUSampler;

  constructor(device: GPUDevice, layout: ProbeLayout, options: ProbeIrradianceOptions = {}) {
    this.device = device;
    this.layout = layout;
    this.samples = options.samples ?? 16384;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.pipe = device.createComputePipeline({
      label: `ProbeIrradiance.${layout.id}`, layout: 'auto',
      compute: { module: device.createShaderModule({ code: shaderWgsl(layout, resolveCaptureTransform(options)), label: `probe-irradiance.${layout.id}` }), entryPoint: 'main' },
    });
  }

  /** Mip read by default: maxLod - 2 (or 0). */
  defaultLod() { return Math.max(0, this.layout.mipLevelCount - 3); }

  /**
   * Records the integration of `slots` of `atlas` into `table`. Each call gets its own parameter
   * buffer, filled at creation (not by queue.writeBuffer, which would run before the submit and
   * let a later call in the same encoder overwrite it). It is left to the garbage collector: the
   * command buffer keeps it alive until it ran.
   */
  encode(encoder: GPUCommandEncoder, atlas: GPUTextureView, table: GPUBuffer, irradianceRow: number, slots: readonly number[], lod = this.defaultLod()) {
    if (slots.length === 0) return;
    const stride = Math.max(32, this.device.limits.minUniformBufferOffsetAlignment);
    const params = this.device.createBuffer({ label: 'ProbeIrradiance.params', size: stride * slots.length, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    const mapped = params.getMappedRange();
    slots.forEach((slot, k) => {
      new Uint32Array(mapped, k * stride, 3).set([slot, irradianceRow, this.samples]);
      new Float32Array(mapped, k * stride + 16, 1).set([lod]);
    });
    params.unmap();
    const pass = encoder.beginComputePass({ label: 'ProbeIrradiance' });
    pass.setPipeline(this.pipe);
    slots.forEach((_, k) => {
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.pipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: atlas }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: table } }, { binding: 3, resource: { buffer: params, offset: k * stride, size: 32 } }],
      }));
      pass.dispatchWorkgroups(1);
    });
    pass.end();
  }

  dispose() {}
}
