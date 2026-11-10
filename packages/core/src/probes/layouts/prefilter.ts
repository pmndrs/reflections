// Layout-generic GGX prefilter: three r187's cube PMREM plan (as ../prefilter.ts), writing any
// ProbeLayout through its `dirForTexel`.
//
// Same plan and kernels as ProbePrefilter (vendored from @pmndrs/sky 0.6.0, MIT): lod 0 is a copy
// (a bilinear sample of the capture at the texel's direction), the sharp levels use 256 GGX
// samples (filtered importance sampling from a box-filtered source mip chain), the last three
// levels weight every texel of the 16 px source mip; lod `l` holds roughness
// `lodToRoughness(l, maxLod)`. The only change is where each output texel's direction comes from:
// `faceDir` (cube faces, optional warp) became the layout's `dirForTexel`, so for the cube2d
// layouts the output is bit-identical to ProbePrefilter's (the probe bench checks this).
//
// Output goes to an rgba16float scratch texture of one probe's shape (layout layers, every mip),
// then is copied into a slot of the target. Other storage formats pack from that scratch
// (./formats).

import { lodToRoughness } from '../lod';
import type { ProbeLayout } from './types';

const INTEGRATION_SIZE = 16;
const INTEGRATION_LEVELS = 3;
const GGX_SAMPLES = 256;

const COMMON = /* wgsl */ `
fn hammersley(i: u32, n: u32) -> vec2<f32> {
  return vec2(f32(i) / f32(n), f32(reverseBits(i)) * 2.3283064365386963e-10);
}
fn ggxWeight(NdotL: f32, a2: f32) -> f32 {
  let dd = (1.0 + NdotL) * 0.5 * (a2 - 1.0) + 1.0;
  return NdotL / (dd * dd);
}
// Same face rules as the layouts' pl_faceDirUV (the integration walks the source cube's faces).
fn srcFaceDirUV(face: u32, u: f32, v: f32) -> vec3<f32> {
  switch face {
    case 0u: { return vec3( 1.0, -v, -u); }
    case 1u: { return vec3(-1.0, -v,  u); }
    case 2u: { return vec3( u,  1.0,  v); }
    case 3u: { return vec3( u, -1.0, -v); }
    case 4u: { return vec3( u, -v,  1.0); }
    default: { return vec3(-u, -v, -1.0); }
  }
}`;

const fisWgsl = (layout: string) => /* wgsl */ `${layout}${COMMON}
struct L { outSize: u32, samples: u32, roughness: f32, lodBias: f32, mip: u32, size0: u32, layers: u32, pad: u32 }
@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> P: L;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.outSize || id.y >= P.outSize) { return; }
  let N = dirForTexel(id.xy, id.z, P.mip, P.size0);
  if (P.roughness <= 0.0) { textureStore(dst, id.xy, id.z, textureSampleLevel(src, samp, N, 0.0)); return; }
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  let up = select(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let T = normalize(cross(up, N)); let B = cross(N, T);
  var col = vec3(0.0); var w = 0.0;
  for (var i = 0u; i < P.samples; i++) {
    let xi = hammersley(i, P.samples);
    let invQ = 1.0 / ((1.0 - xi.x) + a2 * xi.x);
    let NdotL = ((1.0 - xi.x) - a2 * xi.x) * invQ;
    if (NdotL > 0.0) {
      let phi = xi.y * 6.283185307;
      let sinT = alpha * 2.0 * sqrt(xi.x * (1.0 - xi.x)) * invQ;
      let Ld = N * NdotL + (T * cos(phi) + B * sin(phi)) * sinT;
      let lod = max(log2(a2 * invQ) + P.lodBias, 0.0);
      col += textureSampleLevel(src, samp, Ld, lod).rgb * NdotL; w += NdotL;
    }
  }
  textureStore(dst, id.xy, id.z, vec4(col / w, 1.0));
}`;

const integWgsl = (layout: string) => /* wgsl */ `${layout}${COMMON}
struct I { outSize: u32, srcSize: u32, roughness: f32, pad: f32, mip: u32, size0: u32, layers: u32, pad2: u32 }
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> P: I;
var<workgroup> sCol: array<vec4<f32>, 64>;
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let ox = wg.x % P.outSize; let oy = wg.x / P.outSize;
  let N = dirForTexel(vec2(ox, oy), wg.y, P.mip, P.size0);
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  let n = P.srcSize; let per = n * n; let total = 6u * per;
  let inv = 2.0 / f32(n);
  var acc = vec4(0.0);
  for (var k = li; k < total; k += 64u) {
    let f = k / per; let r = k - f * per;
    let x = r % n; let y = r / n;
    let u = (f32(x) + 0.5) * inv - 1.0; let v = (f32(y) + 0.5) * inv - 1.0;
    let rl = inverseSqrt(1.0 + u * u + v * v);
    let Ld = srcFaceDirUV(f, u, v) * rl;
    let NdotL = dot(N, Ld);
    if (NdotL > 0.0) {
      let wt = ggxWeight(NdotL, a2) * rl * rl * rl;
      acc += vec4(textureLoad(src, vec2<i32>(i32(x), i32(y)), i32(f), 0).rgb * wt, wt);
    }
  }
  sCol[li] = acc;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s >>= 1u) {
    if (li < s) { sCol[li] += sCol[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    let t = sCol[0];
    textureStore(dst, vec2(ox, oy), wg.y, vec4(t.rgb / t.w, 1.0));
  }
}`;

const tiledWgsl = (layout: string) => /* wgsl */ `${layout}${COMMON}
struct I { outSize: u32, srcSize: u32, roughness: f32, pad: f32, mip: u32, size0: u32, layers: u32, pad2: u32 }
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> P: I;
var<workgroup> tDir: array<vec4<f32>, 64>;
var<workgroup> tCol: array<vec4<f32>, 64>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let inside = id.x < P.outSize && id.y < P.outSize;
  let N = dirForTexel(id.xy, id.z, P.mip, P.size0);
  let alpha = P.roughness * P.roughness; let a2 = alpha * alpha;
  let n = P.srcSize; let per = n * n; let total = 6u * per;
  let inv = 2.0 / f32(n);
  var acc = vec4(0.0);
  for (var base = 0u; base < total; base += 64u) {
    let k = base + li;
    if (k < total) {
      let f = k / per; let r = k - f * per;
      let x = r % n; let y = r / n;
      let u = (f32(x) + 0.5) * inv - 1.0; let v = (f32(y) + 0.5) * inv - 1.0;
      let rl = inverseSqrt(1.0 + u * u + v * v);
      tDir[li] = vec4(srcFaceDirUV(f, u, v) * rl, rl * rl * rl);
      tCol[li] = textureLoad(src, vec2<i32>(i32(x), i32(y)), i32(f), 0);
    } else {
      tDir[li] = vec4(0.0); tCol[li] = vec4(0.0);
    }
    workgroupBarrier();
    for (var j = 0u; j < 64u; j++) {
      let d = tDir[j];
      let NdotL = dot(N, d.xyz);
      if (NdotL > 0.0) {
        let wt = ggxWeight(NdotL, a2) * d.w;
        acc += vec4(tCol[j].rgb * wt, wt);
      }
    }
    workgroupBarrier();
  }
  if (inside) { textureStore(dst, id.xy, id.z, vec4(acc.rgb / acc.w, 1.0)); }
}`;

const DOWNSAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> size: vec4<u32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= size.x || id.y >= size.x) { return; }
  let p = vec2<i32>(id.xy) * 2; let f = i32(id.z);
  let c = textureLoad(src, p, f, 0) + textureLoad(src, p + vec2(1, 0), f, 0)
        + textureLoad(src, p + vec2(0, 1), f, 0) + textureLoad(src, p + vec2(1, 1), f, 0);
  textureStore(dst, id.xy, id.z, c * 0.25);
}`;

interface Pass { pipe: GPUComputePipeline; group: GPUBindGroup; wg: [number, number, number] }
interface Pipes { down: GPUComputePipeline; fis: GPUComputePipeline; integ: GPUComputePipeline; tiled: GPUComputePipeline }

const _pipes = new WeakMap<GPUDevice, Map<string, Pipes>>();

function pipesFor(device: GPUDevice, layout: ProbeLayout): Pipes {
  let byDevice = _pipes.get(device);
  if (!byDevice) _pipes.set(device, (byDevice = new Map()));
  let p = byDevice.get(layout.wgsl);
  if (!p) {
    const make = (code: string, label: string) => device.createComputePipeline({
      label: `LayoutPrefilter.${layout.id}.${label}`,
      layout: 'auto',
      compute: { module: device.createShaderModule({ code, label: `${layout.id}.${label}` }), entryPoint: 'main' },
    });
    p = { down: make(DOWNSAMPLE_WGSL, 'down'), fis: make(fisWgsl(layout.wgsl), 'fis'), integ: make(integWgsl(layout.wgsl), 'integ'), tiled: make(tiledWgsl(layout.wgsl), 'tiled') };
    byDevice.set(layout.wgsl, p);
  }
  return p;
}

/**
 * Prefilters captured cubes (faces of `sourceSize` px, mip 0 read) into one probe of `layout` at
 * `size` px (mip 0 face, or octa side). The roughness levels are the layout's mips
 * (`layout.mipLevelCount - 1` = maxLod, normally `maxLodFor(sourceSize)`).
 */
export class LayoutPrefilter {
  readonly layout: ProbeLayout;
  readonly size: number;
  readonly sourceSize: number;
  readonly maxLod: number;
  /** rgba16float, one probe of the layout (layersPerProbe layers, every mip): the last result. */
  readonly scratch: GPUTexture;
  private readonly device: GPUDevice;
  private readonly src: GPUTexture;
  private readonly passes: Pass[] = [];
  private readonly owned: (GPUTexture | GPUBuffer)[] = [];

  constructor(device: GPUDevice, layout: ProbeLayout, size: number, sourceSize: number) {
    if (!Number.isInteger(Math.log2(sourceSize)) || sourceSize < 2 * INTEGRATION_SIZE) throw new Error(`LayoutPrefilter: sourceSize must be a power of two >= ${2 * INTEGRATION_SIZE}, got ${sourceSize}.`);
    this.device = device;
    this.layout = layout;
    this.size = size;
    this.sourceSize = sourceSize;
    this.maxLod = layout.mipLevelCount - 1;
    // any size that halves exactly down to the last mip (octa can sit between powers of two)
    if (this.maxLod < INTEGRATION_LEVELS || size % (1 << this.maxLod) !== 0) throw new Error(`LayoutPrefilter: ${layout.mipLevelCount} mips need a size divisible by ${1 << this.maxLod}, got ${size}.`);
    const pipes = pipesFor(device, layout);
    const U = GPUTextureUsage;
    const srcMips = Math.log2(sourceSize) + 1;
    const layers = layout.layersPerProbe;
    this.src = device.createTexture({ label: 'LayoutPrefilter.source', size: [sourceSize, sourceSize, 6], format: 'rgba16float', mipLevelCount: srcMips, usage: U.STORAGE_BINDING | U.TEXTURE_BINDING | U.COPY_DST });
    this.scratch = device.createTexture({ label: `LayoutPrefilter.${layout.id}.out`, size: [size, size, layers], format: 'rgba16float', mipLevelCount: this.maxLod + 1, usage: U.STORAGE_BINDING | U.TEXTURE_BINDING | U.COPY_SRC });
    this.owned.push(this.src, this.scratch);
    const level = (t: GPUTexture, mip: number) => t.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const srcCube = this.src.createView({ dimension: 'cube' });
    const srcInteg = level(this.src, Math.log2(sourceSize / INTEGRATION_SIZE));

    for (let m = 1; m < srcMips; m++) {
      const s = sourceSize >> m;
      this.add(pipes.down, [Math.ceil(s / 8), Math.ceil(s / 8), 6], [level(this.src, m - 1), level(this.src, m), { buffer: this.uniform(new Uint32Array([s, 0, 0, 0]).buffer) }]);
    }
    for (let lod = 0; lod <= this.maxLod; lod++) {
      const s = Math.max(size >> lod, 1);
      const r = lodToRoughness(lod, this.maxLod);
      const u = new ArrayBuffer(32);
      new Uint32Array(u, 16, 3).set([lod, size, layers]);
      if (lod > this.maxLod - INTEGRATION_LEVELS && lod > 0) {
        new Uint32Array(u, 0, 2).set([s, INTEGRATION_SIZE]);
        new Float32Array(u, 8, 1).set([r]);
        const tiled = s >= 32;
        this.add(tiled ? pipes.tiled : pipes.integ, tiled ? [Math.ceil(s / 8), Math.ceil(s / 8), layers] : [s * s, layers, 1], [srcInteg, level(this.scratch, lod), { buffer: this.uniform(u) }]);
      } else {
        // 1 / (samples * pdf) in source texels, with a half-mip bias against sampling noise (three r187)
        const lodBias = r > 0 ? Math.log2(sourceSize) + 0.5 * Math.log2(6 / (GGX_SAMPLES * Math.pow(r, 4))) + 0.5 : 0;
        new Uint32Array(u, 0, 2).set([s, lod === 0 ? 1 : GGX_SAMPLES]);
        new Float32Array(u, 8, 2).set([r, lodBias]);
        this.add(pipes.fis, [Math.ceil(s / 8), Math.ceil(s / 8), layers], [srcCube, sampler, level(this.scratch, lod), { buffer: this.uniform(u) }]);
      }
    }
  }

  /** Records the prefilter of `source` (a cube texture of sourceSize px faces) into `scratch`. */
  encodeScratch(encoder: GPUCommandEncoder, source: GPUTexture, timestampWrites?: GPUComputePassTimestampWrites) {
    const n = this.sourceSize;
    encoder.copyTextureToTexture({ texture: source, mipLevel: 0 }, { texture: this.src, mipLevel: 0 }, [n, n, 6]);
    const pass = encoder.beginComputePass({ label: `LayoutPrefilter.${this.layout.id}`, timestampWrites });
    for (const p of this.passes) {
      pass.setPipeline(p.pipe);
      pass.setBindGroup(0, p.group);
      pass.dispatchWorkgroups(...p.wg);
    }
    pass.end();
  }

  /** Copies `scratch` into probe slot `slot` of `target` (rgba16float, the layout's descriptor). */
  copyScratch(encoder: GPUCommandEncoder, target: GPUTexture, slot: number) {
    const L = this.layout.layersPerProbe;
    for (let lod = 0; lod <= this.maxLod; lod++) {
      const s = Math.max(this.size >> lod, 1);
      encoder.copyTextureToTexture({ texture: this.scratch, mipLevel: lod }, { texture: target, mipLevel: lod, origin: [0, 0, slot * L] }, [s, s, L]);
    }
  }

  /** Prefilter + copy into slot `slot` of an rgba16float `target`. */
  encode(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTexture, slot: number) {
    this.encodeScratch(encoder, source);
    this.copyScratch(encoder, target, slot);
  }

  dispose() {
    for (const r of this.owned) r.destroy();
    this.owned.length = 0;
  }

  private uniform(data: ArrayBuffer) {
    const buf = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data);
    this.owned.push(buf);
    return buf;
  }

  private add(pipe: GPUComputePipeline, wg: [number, number, number], resources: GPUBindingResource[]) {
    const group = this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
    this.passes.push({ pipe, group, wg });
  }
}

