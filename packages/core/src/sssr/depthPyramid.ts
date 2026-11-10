// Hierarchical depth for the screen-space tracer (FidelityFX SDK v1.1.4 ffx_sssr_depth_downsample.h
// + gpu/spd/ffx_spd.h, LDS path; Copyright (C) 2024 Advanced Micro Devices, Inc., MIT; see NOTICE).
//
// Everything about the pyramid lives in this file so another builder (the maintainer's
// `downsampler`, planned after the merge) can replace it here and nowhere else. The contract:
//   format  r32float, mip count min(7, ceil(log2(max(w, h)))), floor-sized mips (WebGPU's rule)
//   mip 0   an exact copy of device depth
//   mip k   min of the 2x2 texels below (max with reverse-Z), i.e. the closest depth
//
// Core WebGPU allows 4 storage textures per stage, so this runs SPD's 64x64-tile scheme as two
// dispatches: copy + mips 1-3 from the depth input, then mips 4-6 from mip 3. Min/max are exact, so
// the result is texel for texel what one SPD dispatch writes.

export interface DepthPyramidOptions {
  /** Reverse-Z (1 = near): reduce with max instead of min. */
  inverted: boolean;
}

export const depthPyramidMipCount = (width: number, height: number) => Math.min(7, Math.ceil(Math.log2(Math.max(width, height))));

export function createDepthPyramidTexture(device: GPUDevice, width: number, height: number, label = 'depth pyramid'): GPUTexture {
  return device.createTexture({
    label, size: [width, height], format: 'r32float', mipLevelCount: depthPyramidMipCount(width, height),
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
}

interface DownsampleConfig {
  /** 'depth': texture_depth_2d input; 'float': texture_2d<f32> (r32float input or a pyramid mip). */
  source: 'depth' | 'float';
  /** Also copy the source into `out0` (mip 0). */
  copy: boolean;
  /** Number of reduced levels written (1-3). */
  levels: number;
  inverted: boolean;
}

/** A workgroup of 16x16 reduces a 64x64 tile of `src` into up to three coarser levels (32, 16, 8). */
export function downsampleWgsl(c: DownsampleConfig): string {
  const outs: string[] = [];
  let b = 1;
  if (c.copy) outs.push(`@group(0) @binding(${b++}) var out0: texture_storage_2d<r32float, write>;`);
  for (let l = 1; l <= c.levels; l++) outs.push(`@group(0) @binding(${b++}) var out${l}: texture_storage_2d<r32float, write>;`);
  const red = c.inverted ? 'max' : 'min';
  const load = c.source === 'depth' ? 'textureLoad(src, q, 0)' : 'textureLoad(src, q, 0).x';
  return /* wgsl */ `
@group(0) @binding(0) var src: ${c.source === 'depth' ? 'texture_depth_2d' : 'texture_2d<f32>'};
${outs.join('\n')}
var<workgroup> lds: array<array<f32, 16>, 16>;

fn reduce4(a: f32, b: f32, c: f32, d: f32) -> f32 { return ${red}(${red}(a, b), ${red}(c, d)); }
fn loadSrc(p: vec2i, dims: vec2i) -> f32 {
  let q = clamp(p, vec2i(0), dims - 1); // only feeds texels that are out of bounds themselves
  return ${load};
}
fn store(t: texture_storage_2d<r32float, write>, p: vec2i, v: f32) {
  if (all(p < vec2i(textureDimensions(t)))) { textureStore(t, p, vec4f(v)); }
}

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let dims = vec2i(textureDimensions(src));
  let t = vec2i(lid.xy);
  let base = vec2i(wg.xy) * 64 + t * 4;
  var s: array<f32, 16>;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let p = base + vec2i(i, j);
      let v = loadSrc(p, dims);
      s[j * 4 + i] = v;
      ${c.copy ? 'if (all(p < dims)) { textureStore(out0, p, vec4f(v)); }' : ''}
    }
  }
  // level 1: 2x2 texels per thread
  var l1: array<f32, 4>;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let k = j * 8 + i * 2;
      l1[j * 2 + i] = reduce4(s[k], s[k + 1], s[k + 4], s[k + 5]);
      store(out1, vec2i(wg.xy) * 32 + t * 2 + vec2i(i, j), l1[j * 2 + i]);
    }
  }
  ${c.levels >= 2 ? `
  // level 2: 1 texel per thread
  let l2 = reduce4(l1[0], l1[1], l1[2], l1[3]);
  store(out2, vec2i(wg.xy) * 16 + t, l2);` : ''}
  ${c.levels >= 3 ? `
  // level 3: 8x8 threads reduce through workgroup memory
  lds[lid.y][lid.x] = l2;
  workgroupBarrier();
  if (lid.x < 8u && lid.y < 8u) {
    let x = lid.x * 2u;
    let y = lid.y * 2u;
    let l3 = reduce4(lds[y][x], lds[y][x + 1u], lds[y + 1u][x], lds[y + 1u][x + 1u]);
    store(out3, vec2i(wg.xy) * 8 + t, l3);
  }` : ''}
}
`;
}

export interface DepthPyramidBuilder {
  /** Record the pyramid build for `depth` (a depth texture or r32float, same size as mip 0) into
   *  `pyramid` (from createDepthPyramidTexture) as one compute pass. */
  build(cmd: GPUCommandEncoder, depth: GPUTexture, pyramid: GPUTexture, timestampWrites?: GPUComputePassTimestampWrites): void;
}

export function createDepthPyramidBuilder(device: GPUDevice, { inverted }: DepthPyramidOptions): DepthPyramidBuilder {
  const C = 0x4; // GPUShaderStage.COMPUTE
  const pipes = new Map<string, { pipe: GPUComputePipeline; bgl: GPUBindGroupLayout }>();
  const get = (source: 'depth' | 'float', copy: boolean, levels: number) => {
    const key = `${source}/${copy}/${levels}`;
    let p = pipes.get(key);
    if (!p) {
      const bgl = device.createBindGroupLayout({
        label: `depth pyramid ${key}`,
        entries: [
          { binding: 0, visibility: C, texture: { sampleType: source === 'depth' ? 'depth' : 'unfilterable-float' } },
          ...Array.from({ length: levels + (copy ? 1 : 0) }, (_, i) => ({ binding: i + 1, visibility: C, storageTexture: { access: 'write-only' as const, format: 'r32float' as const } })),
        ],
      });
      const pipe = device.createComputePipeline({
        label: `depth pyramid ${key}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        compute: { module: device.createShaderModule({ label: `depth pyramid ${key}`, code: downsampleWgsl({ source, copy, levels, inverted }) }), entryPoint: 'main' },
      });
      pipes.set(key, (p = { pipe, bgl }));
    }
    return p;
  };
  const views = new WeakMap<GPUTexture, GPUTextureView[]>();
  const mipViews = (t: GPUTexture) => {
    let v = views.get(t);
    if (!v) views.set(t, (v = Array.from({ length: t.mipLevelCount }, (_, m) => t.createView({ baseMipLevel: m, mipLevelCount: 1 }))));
    return v;
  };

  return {
    build(cmd, depth, pyramid, timestampWrites) {
      const kind = depth.format.startsWith('depth') ? 'depth' : 'float';
      const mips = mipViews(pyramid);
      const levelsA = Math.min(3, mips.length - 1);
      const levelsB = Math.max(0, mips.length - 4);
      const W = pyramid.width, H = pyramid.height;
      const pass = cmd.beginComputePass({ label: 'depth pyramid', timestampWrites });
      const a = get(kind, true, levelsA);
      const src = kind === 'depth' ? depth.createView({ aspect: 'depth-only' }) : depth.createView();
      pass.setPipeline(a.pipe);
      pass.setBindGroup(0, device.createBindGroup({
        layout: a.bgl, entries: [{ binding: 0, resource: src }, ...mips.slice(0, levelsA + 1).map((resource, i) => ({ binding: i + 1, resource }))],
      }));
      pass.dispatchWorkgroups(Math.ceil(W / 64), Math.ceil(H / 64));
      if (levelsB > 0) {
        const b = get('float', false, levelsB);
        pass.setPipeline(b.pipe);
        pass.setBindGroup(0, device.createBindGroup({
          layout: b.bgl, entries: [{ binding: 0, resource: mips[3] }, ...mips.slice(4, 4 + levelsB).map((resource, i) => ({ binding: i + 1, resource }))],
        }));
        pass.dispatchWorkgroups(Math.ceil(Math.max(1, W >> 3) / 64), Math.ceil(Math.max(1, H >> 3) / 64));
      }
      pass.end();
    },
  };
}
