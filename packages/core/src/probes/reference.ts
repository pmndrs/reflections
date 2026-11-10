// Brute-force GGX reference for the probe prefilter (docs/SPEC.md, phase 1 "Metrics").
//
// For each direction N of a list, the radiance a probe *should* return at roughness r: the GGX
// lobe with V = N = R (the prefilter's assumption) integrated over mip 0 of the captured cube,
//   ref(N) = ∫ L(l) D(h) (N·l) dl / ∫ D(h) (N·l) dl.
// No layout, no mip chain, no filtered importance sampling: only the capture.
//
// Two estimators of the same integral; `auto` picks per roughness from the lobe's width in mip 0
// texels (about 4 α size / π):
//   'qmc'         `samples` GGX samples (default 65536) (Hammersley, randomly rotated per direction), each a
//                 bilinear hardware-cube sample of mip 0. For narrow lobes, where every sample
//                 lands among a few texels.
//   'exhaustive'  a weighted sum over every texel of mip 0 (6 size^2), weight D (N·l) dΩ. No
//                 noise; treats texels as constant, which is exact enough once the lobe spans
//                 tens of texels. For broad lobes, where QMC would miss a small bright sun.
// r = 0 is one bilinear sample of mip 0 (a mirror).

const COMMON = /* wgsl */ `
struct R { count: u32, offset: u32, samples: u32, size: u32, roughness: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var srcFaces: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read> dirs: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outRad: array<vec4<f32>>;
@group(0) @binding(5) var<uniform> P: R;
fn faceDirUV(face: u32, u: f32, v: f32) -> vec3<f32> {
  switch face {
    case 0u: { return vec3( 1.0, -v, -u); }
    case 1u: { return vec3(-1.0, -v,  u); }
    case 2u: { return vec3( u,  1.0,  v); }
    case 3u: { return vec3( u, -1.0, -v); }
    case 4u: { return vec3( u, -v,  1.0); }
    default: { return vec3(-u, -v, -1.0); }
  }
}
fn hash(x0: u32) -> u32 { var x = x0; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
`;

const QMC_WGSL = /* wgsl */ `${COMMON}
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x + P.offset;
  if (i >= P.count) { return; }
  let N = normalize(dirs[i].xyz);
  if (P.roughness <= 0.0) { outRad[i] = vec4(textureSampleLevel(src, samp, N, 0.0).rgb, 1.0); return; }
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  let up = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let T = normalize(cross(up, N)); let B = cross(N, T);
  let rot = f32(hash(i)) * 2.3283064365386963e-10;
  let jit = f32(hash(i ^ 0x9e3779b9u)) * 2.3283064365386963e-10;
  var col = vec3(0.0); var w = 0.0;
  for (var k = 0u; k < P.samples; k++) {
    let xi = vec2(fract(f32(k) / f32(P.samples) + jit / f32(P.samples)), fract(f32(reverseBits(k)) * 2.3283064365386963e-10 + rot));
    let invQ = 1.0 / ((1.0 - xi.x) + a2 * xi.x);
    let NdotL = ((1.0 - xi.x) - a2 * xi.x) * invQ;
    if (NdotL > 0.0) {
      let phi = xi.y * 6.283185307;
      let sinT = alpha * 2.0 * sqrt(xi.x * (1.0 - xi.x)) * invQ;
      let Ld = N * NdotL + (T * cos(phi) + B * sin(phi)) * sinT;
      col += textureSampleLevel(src, samp, Ld, 0.0).rgb * NdotL; w += NdotL;
    }
  }
  outRad[i] = vec4(col / w, 1.0);
}`;

// One thread per direction; mip 0 texels staged 64 at a time through workgroup memory.
const EXHAUSTIVE_WGSL = /* wgsl */ `${COMMON}
var<workgroup> tDir: array<vec4<f32>, 64>;
var<workgroup> tCol: array<vec4<f32>, 64>;
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let i = gid.x + P.offset;
  let N = normalize(dirs[min(i, P.count - 1u)].xyz);
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  let n = P.size; let per = n * n; let total = 6u * per;
  let inv = 2.0 / f32(n);
  var acc = vec4(0.0);
  for (var base = 0u; base < total; base += 64u) {
    let k = base + li;
    let f = k / per; let r = k - f * per;
    let x = r % n; let y = r / n;
    let u = (f32(x) + 0.5) * inv - 1.0; let v = (f32(y) + 0.5) * inv - 1.0;
    let rl = inverseSqrt(1.0 + u * u + v * v);
    tDir[li] = vec4(faceDirUV(f, u, v) * rl, rl * rl * rl);
    tCol[li] = textureLoad(srcFaces, vec2<i32>(i32(x), i32(y)), i32(f), 0);
    workgroupBarrier();
    for (var j = 0u; j < 64u; j++) {
      let d = tDir[j];
      let NdotL = dot(N, d.xyz);
      if (NdotL > 0.0) {
        let dd = (1.0 + NdotL) * 0.5 * (a2 - 1.0) + 1.0;
        let wt = NdotL / (dd * dd) * d.w;
        acc += vec4(tCol[j].rgb * wt, wt);
      }
    }
    workgroupBarrier();
  }
  if (i < P.count) { outRad[i] = vec4(acc.rgb / acc.w, 1.0); }
}`;

export type ReferenceMode = 'auto' | 'qmc' | 'exhaustive';

/** Lobe width of roughness `r` in mip 0 texels of a `size` px cube (about 4 α size / π). */
export const lobeTexels = (roughness: number, size: number) => (4 * roughness * roughness * size) / Math.PI;

/** The estimator `auto` uses: QMC while the lobe spans fewer than 32 mip 0 texels. */
export const referenceModeFor = (roughness: number, size: number): 'qmc' | 'exhaustive' => (lobeTexels(roughness, size) < 32 ? 'qmc' : 'exhaustive');

/**
 * Brute-force GGX reference over mip 0 of a captured cube (`source`: rgba16float, `size` px faces,
 * TEXTURE_BINDING). Directions are a storage buffer of vec4f (xyz used).
 */
export class GGXReference {
  private readonly device: GPUDevice;
  private readonly size: number;
  private readonly qmc: GPUComputePipeline;
  private readonly exhaustive: GPUComputePipeline;
  private readonly views: { cube: GPUTextureView; faces: GPUTextureView; samp: GPUSampler };

  constructor(device: GPUDevice, source: GPUTexture, size: number) {
    this.device = device;
    this.size = size;
    const make = (code: string, label: string) => device.createComputePipeline({ label, layout: 'auto', compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' } });
    this.qmc = make(QMC_WGSL, 'GGXReference.qmc');
    this.exhaustive = make(EXHAUSTIVE_WGSL, 'GGXReference.exhaustive');
    this.views = {
      cube: source.createView({ dimension: 'cube', baseMipLevel: 0, mipLevelCount: 1 }),
      faces: source.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }),
      samp: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    };
  }

  /**
   * Reference radiance along `count` directions of `dirs` at `roughness`, written to `out`
   * (vec4f per direction). Submits in chunks so no single dispatch runs long; resolves when done.
   */
  async compute(dirs: GPUBuffer, out: GPUBuffer, count: number, roughness: number, { mode = 'auto', samples = 65536, chunk = 0 }: { mode?: ReferenceMode; samples?: number; chunk?: number } = {}) {
    const m = roughness <= 0 ? 'qmc' : mode === 'auto' ? referenceModeFor(roughness, this.size) : mode;
    const pipe = m === 'qmc' ? this.qmc : this.exhaustive;
    // work per direction: samples (qmc) or 6 size^2 texels; aim for ~2^30 per submit
    const perDir = m === 'qmc' ? Math.max(samples, 1) : 6 * this.size * this.size;
    const step = chunk || Math.max(64, Math.min(count, 64 * Math.floor(2 ** 30 / perDir / 64)));
    for (let offset = 0; offset < count; offset += step) {
      const u = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const data = new ArrayBuffer(32);
      new Uint32Array(data, 0, 4).set([count, offset, samples, this.size]);
      new Float32Array(data, 16, 1).set([roughness]);
      this.device.queue.writeBuffer(u, 0, data);
      const group = this.device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          ...(m === 'qmc' ? [{ binding: 0, resource: this.views.cube }, { binding: 2, resource: this.views.samp }] : [{ binding: 1, resource: this.views.faces }]),
          { binding: 3, resource: { buffer: dirs } },
          { binding: 4, resource: { buffer: out } },
          { binding: 5, resource: { buffer: u } },
        ],
      });
      const enc = this.device.createCommandEncoder({ label: 'GGXReference' });
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(Math.min(step, count - offset) / 64));
      pass.end();
      this.device.queue.submit([enc.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      u.destroy();
    }
    return m;
  }
}
