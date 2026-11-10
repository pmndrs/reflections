// The probe layouts of docs/SPEC.md's phase 1 bench. See ./types for the contract.
//
//   cube2d-warp  6 layers per probe in a 2D array, edge texels centred on the cube edges (today's
//                three path, ReflectionProbesNode 'warp'). Lookup: face pick + 2 bilinear samples.
//   cube2d-none  6 layers per probe, plain texel centres. Lookup: face pick + 1 trilinear sample;
//                clamp-to-edge at face edges (a crease of up to half a texel per mip).
//   cube-hw      a real cube array (`texture_cube_array`, raw WebGPU). Lookup: 1 hardware sample,
//                seamless. Texel centres are those of cube2d-none.
//   octa         1 layer per probe, full-sphere octahedral (+y pole), a gutter at every mip so one
//                trilinear sample never reads past the border. See OCTA below.

import { CUBE_WGSL, OCTA_WGSL } from './common';
import type { ProbeLayout, ProbeLayoutId, ProbeLayoutOptions } from './types';

export type { ProbeLayout, ProbeLayoutId, ProbeLayoutOptions } from './types';

// TEXTURE_BINDING | COPY_DST | COPY_SRC (numeric, so this module loads without WebGPU globals)
const USAGE = 0x04 | 0x02 | 0x01;

function descriptor(label: string, size: number, layers: number, mips: number, format: GPUTextureFormat): GPUTextureDescriptor {
  return { label, size: [size, size, layers], format, mipLevelCount: mips, dimension: '2d', usage: USAGE };
}

// Cube layouts. `size` is the mip 0 face size; mip `mip` faces are size >> mip.
const cubeDirWgsl = (warp: boolean) => /* wgsl */ `
fn dirForTexel(texel: vec2<u32>, layer: u32, mip: u32, size: u32) -> vec3<f32> {
  let s = f32(max(size >> mip, 1u));
  let px = vec2<f32>(texel);
  ${warp ? 'let uv = px / max(s - 1.0, 1.0) * 2.0 - 1.0;' : 'let uv = (px + 0.5) / s * 2.0 - 1.0;'}
  return normalize(pl_faceDirUV(layer, uv.x, uv.y));
}`;

const CUBE2D_NONE_SAMPLE = /* wgsl */ `
fn sampleLayout(tex: texture_2d_array<f32>, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  let f = pl_cubeFaceUV(dir);
  return textureSampleLevel(tex, samp, f.xy, probe * 6u + u32(f.z), lod);
}`;

// Edge-centred texels: uv' = uv (s - 1) / s + 0.5 / s at the face size s of each mip, so the two
// mips are sampled separately (ReflectionProbesNode's 'warp', same maths).
const CUBE2D_WARP_SAMPLE = /* wgsl */ `
fn pl_warpAt(tex: texture_2d_array<f32>, samp: sampler, uv: vec2<f32>, layer: u32, l: f32) -> vec4<f32> {
  let s = f32(textureDimensions(tex, u32(l)).x);
  return textureSampleLevel(tex, samp, uv * ((s - 1.0) / s) + 0.5 / s, layer, l);
}
fn sampleLayout(tex: texture_2d_array<f32>, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  let f = pl_cubeFaceUV(dir);
  let layer = probe * 6u + u32(f.z);
  let l0 = floor(lod);
  let l1 = min(l0 + 1.0, f32(textureNumLevels(tex) - 1u));
  return mix(pl_warpAt(tex, samp, f.xy, layer, l0), pl_warpAt(tex, samp, f.xy, layer, l1), lod - l0);
}`;

const CUBE_HW_SAMPLE = /* wgsl */ `
fn sampleLayout(tex: texture_cube_array<f32>, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  return textureSampleLevel(tex, samp, dir, probe, lod);
}`;

// OCTA: mip m of an octa probe is `size >> m` px square. The octahedron's [-1, 1]^2 square is
// inset by a gutter of b = 0.5 * 2^maxLod / size of the texture on every side: half a texel at the
// last mip, 2^(maxLod - m - 1) texels at mip m. Because b is a fixed fraction of the texture, the
// uv mapping is the same at every mip, so one trilinear sample works; because it is at least half
// a texel at every mip, a bilinear footprint inside the square never reaches past the gutter.
// Gutter texels hold the continuation across the border (pl_octaWrap), so filtering across the
// border blends the right neighbours.
const octaWgsl = (maxLod: number) => /* wgsl */ `
const PL_OCTA_MAX_LOD: u32 = ${maxLod}u;
fn dirForTexel(texel: vec2<u32>, layer: u32, mip: u32, size: u32) -> vec3<f32> {
  let s = f32(max(size >> mip, 1u));
  let b = 0.5 * f32(1u << PL_OCTA_MAX_LOD) / f32(size);
  let t = (vec2<f32>(texel) + 0.5) / s;
  let p = (t - b) / (1.0 - 2.0 * b) * 2.0 - 1.0;
  return pl_octaDecode(pl_octaWrap(p));
}
fn sampleLayout(tex: texture_2d_array<f32>, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  let b = 0.5 / f32(textureDimensions(tex, textureNumLevels(tex) - 1u).x);
  let t = b + (pl_octaEncode(dir) * 0.5 + 0.5) * (1.0 - 2.0 * b);
  return textureSampleLevel(tex, samp, t, probe, lod);
}`;

/** Gutter of an octa probe as a fraction of its side (each side), for `maxLod`. */
export const octaGutter = (size: number, maxLod: number) => (0.5 * 2 ** maxLod) / size;

/** A probe layout for `maxLod + 1` roughness mips. */
export function createProbeLayout(id: ProbeLayoutId, { maxLod }: ProbeLayoutOptions): ProbeLayout {
  const mipLevelCount = maxLod + 1;
  switch (id) {
    case 'cube2d-warp':
    case 'cube2d-none': {
      const warp = id === 'cube2d-warp';
      return {
        id, mipLevelCount, layersPerProbe: 6, viewDimension: '2d-array', textureType: 'texture_2d_array<f32>',
        wgsl: CUBE_WGSL + cubeDirWgsl(warp) + (warp ? CUBE2D_WARP_SAMPLE : CUBE2D_NONE_SAMPLE),
        textureDescriptor: (size, probes, format) => descriptor(`probes.${id}`, size, 6 * probes, mipLevelCount, format),
      };
    }
    case 'cube-hw':
      return {
        id, mipLevelCount, layersPerProbe: 6, viewDimension: 'cube-array', textureType: 'texture_cube_array<f32>',
        wgsl: CUBE_WGSL + cubeDirWgsl(false) + CUBE_HW_SAMPLE,
        textureDescriptor: (size, probes, format) => descriptor(`probes.${id}`, size, 6 * probes, mipLevelCount, format),
      };
    case 'octa':
      return {
        id, mipLevelCount, layersPerProbe: 1, viewDimension: '2d-array', textureType: 'texture_2d_array<f32>',
        wgsl: OCTA_WGSL + octaWgsl(maxLod),
        textureDescriptor: (size, probes, format) => {
          if (size >> maxLod < 1) throw new Error(`octa: size ${size} has no mip ${maxLod}`);
          return descriptor(`probes.${id}`, size, probes, mipLevelCount, format);
        },
      };
    default:
      throw new Error(`createProbeLayout: '${id}' is not implemented`);
  }
}

/** Bytes per texel (BC6H: 16-byte 4x4 blocks, 1 byte per texel). */
export function bytesPerTexel(format: GPUTextureFormat): number {
  switch (format) {
    case 'rgba16float': return 8;
    case 'rg11b10ufloat': case 'rgb9e5ufloat': case 'rgba8unorm': return 4;
    case 'bc6h-rgb-ufloat': case 'bc6h-rgb-float': return 1;
    default: throw new Error(`bytesPerTexel: ${format}`);
  }
}

/** GPU memory of one probe in `layout` at `size` px and `format` (every mip, every layer). */
export function probeBytes(layout: ProbeLayout, size: number, format: GPUTextureFormat): number {
  const block = format.startsWith('bc') ? 4 : 1;
  let texels = 0;
  for (let m = 0; m < layout.mipLevelCount; m++) {
    const s = Math.max(size >> m, 1);
    const p = Math.ceil(s / block) * block;
    texels += p * p;
  }
  return texels * layout.layersPerProbe * bytesPerTexel(format);
}
