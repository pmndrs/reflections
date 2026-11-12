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
import type { ProbeLayout, ProbeLayoutId, ProbeLayoutOptions, ProbeWgslChunk } from './types';

export type { ProbeLayout, ProbeLayoutId, ProbeLayoutOptions, ProbeWgslChunk } from './types';

// TEXTURE_BINDING | COPY_DST | COPY_SRC (numeric, so this module loads without WebGPU globals)
const USAGE = 0x04 | 0x02 | 0x01;

function descriptor(label: string, size: number, layers: number, mips: number, format: GPUTextureFormat): GPUTextureDescriptor {
  return { label, size: [size, size, layers], format, mipLevelCount: mips, dimension: '2d', usage: USAGE };
}

// Every layout's own WGSL names start with its `prefix` (`pl_cube2d_warp_`, `pl_cube_hw_`, ...), so
// one shader module can hold several layouts (D805). The cube / octa maths they share (./common)
// goes in a chunk of its own, emitted once per module however many layouts use it.

// Cube layouts. `size` is the mip 0 face size; mip `mip` faces are size >> mip.
const cubeDirWgsl = (prefix: string, warp: boolean) => /* wgsl */ `
fn ${prefix}dirForTexel(texel: vec2<u32>, layer: u32, mip: u32, size: u32) -> vec3<f32> {
  let s = f32(max(size >> mip, 1u));
  let px = vec2<f32>(texel);
  ${warp ? 'let uv = px / max(s - 1.0, 1.0) * 2.0 - 1.0;' : 'let uv = (px + 0.5) / s * 2.0 - 1.0;'}
  return normalize(pl_faceDirUV(layer, uv.x, uv.y));
}`;

const cube2dNoneSample = (prefix: string) => /* wgsl */ `
fn ${prefix}sample(tex: texture_2d_array<f32>, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  let f = pl_cubeFaceUV(dir);
  return textureSampleLevel(tex, samp, f.xy, probe * 6u + u32(f.z), lod);
}`;

// Edge-centred texels: uv' = uv (s - 1) / s + 0.5 / s at the face size s of each mip, so the two
// mips are sampled separately (ReflectionProbesNode's 'warp', same maths).
const cube2dWarpSample = (prefix: string) => /* wgsl */ `
fn ${prefix}warpAt(tex: texture_2d_array<f32>, samp: sampler, uv: vec2<f32>, layer: u32, l: f32) -> vec4<f32> {
  let s = f32(textureDimensions(tex, u32(l)).x);
  return textureSampleLevel(tex, samp, uv * ((s - 1.0) / s) + 0.5 / s, layer, l);
}
fn ${prefix}sample(tex: texture_2d_array<f32>, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  let f = pl_cubeFaceUV(dir);
  let layer = probe * 6u + u32(f.z);
  let l0 = floor(lod);
  let l1 = min(l0 + 1.0, f32(textureNumLevels(tex) - 1u));
  return mix(${prefix}warpAt(tex, samp, f.xy, layer, l0), ${prefix}warpAt(tex, samp, f.xy, layer, l1), lod - l0);
}`;

const cubeHwSample = (prefix: string) => /* wgsl */ `
fn ${prefix}sample(tex: texture_cube_array<f32>, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  return textureSampleLevel(tex, samp, dir, probe, lod);
}`;

// OCTA: mip m of an octa probe is `size >> m` px square. The octahedron's [-1, 1]^2 square is
// inset by a gutter of b = 0.5 * 2^maxLod / size of the texture on every side: half a texel at the
// last mip, 2^(maxLod - m - 1) texels at mip m. Because b is a fixed fraction of the texture, the
// uv mapping is the same at every mip, so one trilinear sample works; because it is at least half
// a texel at every mip, a bilinear footprint inside the square never reaches past the gutter.
// Gutter texels hold the continuation across the border (pl_octaWrap), so filtering across the
// border blends the right neighbours. The prefix carries maxLod (dirForTexel depends on it).
const octaWgsl = (prefix: string, maxLod: number) => /* wgsl */ `
fn ${prefix}dirForTexel(texel: vec2<u32>, layer: u32, mip: u32, size: u32) -> vec3<f32> {
  let s = f32(max(size >> mip, 1u));
  let b = 0.5 * f32(1u << ${maxLod}u) / f32(size);
  let t = (vec2<f32>(texel) + 0.5) / s;
  let p = (t - b) / (1.0 - 2.0 * b) * 2.0 - 1.0;
  return pl_octaDecode(pl_octaWrap(p));
}
fn ${prefix}sample(tex: texture_2d_array<f32>, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  let b = 0.5 / f32(textureDimensions(tex, textureNumLevels(tex) - 1u).x);
  let t = b + (pl_octaEncode(dir) * 0.5 + 0.5) * (1.0 - 2.0 * b);
  return textureSampleLevel(tex, samp, t, probe, lod);
}`;

const CUBE_CHUNK: ProbeWgslChunk = { key: 'pl_cube', wgsl: CUBE_WGSL };
const OCTA_CHUNK: ProbeWgslChunk = { key: 'pl_octa', wgsl: OCTA_WGSL };

/** The single-layout names (`dirForTexel`, `sampleLayout`) over a layout's prefixed functions. */
const aliasesWgsl = (prefix: string, textureType: string) => /* wgsl */ `
fn dirForTexel(texel: vec2<u32>, layer: u32, mip: u32, size: u32) -> vec3<f32> { return ${prefix}dirForTexel(texel, layer, mip, size); }
fn sampleLayout(tex: ${textureType}, samp: sampler, probe: u32, dir: vec3<f32>, lod: f32) -> vec4<f32> { return ${prefix}sample(tex, samp, probe, dir, lod); }
`;

function layoutOf(id: ProbeLayoutId, prefix: string, chunks: ProbeWgslChunk[], rest: Omit<ProbeLayout, 'id' | 'wgsl' | 'chunks' | 'prefix' | 'sampleFunction' | 'dirFunction'>): ProbeLayout {
  return {
    id, prefix, chunks, sampleFunction: `${prefix}sample`, dirFunction: `${prefix}dirForTexel`,
    wgsl: chunks.map((c) => c.wgsl).join('\n') + aliasesWgsl(prefix, rest.textureType), ...rest,
  };
}

/**
 * The WGSL of several layouts for one shader module: each shared chunk once, each layout's prefixed
 * functions, and no single-layout aliases (call `layout.sampleFunction` / `layout.dirFunction`).
 */
export function probeLayoutsWgsl(layouts: readonly ProbeLayout[]): string {
  return dedupeChunks(layouts.flatMap((l) => l.chunks)).map((c) => c.wgsl).join('\n');
}

/** Chunks in first-seen order, one per key; throws if two chunks share a key but not their code. */
export function dedupeChunks(chunks: readonly ProbeWgslChunk[]): ProbeWgslChunk[] {
  const seen = new Map<string, ProbeWgslChunk>();
  for (const c of chunks) {
    const had = seen.get(c.key);
    if (had === undefined) seen.set(c.key, c);
    else if (had.wgsl !== c.wgsl) throw new Error(`probe WGSL: two different chunks named '${c.key}'`);
  }
  return [...seen.values()];
}

// A chunk in assembled WGSL text (D4901): `// #chunk <key>` ... `// #end <key>` around its code, so a
// module put together by concatenation (a pass's radiance fallback + its hit shading, both with the
// probe lookup's includes) can keep one copy of each key with `dedupeWgslChunks`.
const CHUNK_RE = /^\/\/ #chunk (\S+)\n[\s\S]*?\n\/\/ #end \1\n/gm;

/** A chunk's code with the markers {@link dedupeWgslChunks} looks for. */
export function markedChunkWgsl(c: ProbeWgslChunk): string {
  return `// #chunk ${c.key}\n${c.wgsl}\n// #end ${c.key}\n`;
}

/**
 * WGSL text with each marked chunk ({@link markedChunkWgsl}) kept at its first occurrence only, through
 * {@link dedupeChunks} (so two different chunks under one key throw). Unmarked text is left as is.
 * Passes that build a module from several seams' WGSL run their code through it (D4901).
 */
export function dedupeWgslChunks(code: string): string {
  const pieces: ProbeWgslChunk[] = [];
  let last = 0;
  for (const m of code.matchAll(CHUNK_RE)) {
    pieces.push({ key: `\u0000text${pieces.length}`, wgsl: code.slice(last, m.index) }, { key: m[1], wgsl: m[0] });
    last = m.index + m[0].length;
  }
  if (pieces.length === 0) return code;
  pieces.push({ key: `\u0000text${pieces.length}`, wgsl: code.slice(last) });
  return dedupeChunks(pieces).map((c) => c.wgsl).join('');
}

/** Gutter of an octa probe as a fraction of its side (each side), for `maxLod`. */
export const octaGutter = (size: number, maxLod: number) => (0.5 * 2 ** maxLod) / size;

/** A probe layout for `maxLod + 1` roughness mips. */
export function createProbeLayout(id: ProbeLayoutId, { maxLod }: ProbeLayoutOptions): ProbeLayout {
  const mipLevelCount = maxLod + 1;
  switch (id) {
    case 'cube2d-warp':
    case 'cube2d-none': {
      const warp = id === 'cube2d-warp';
      const prefix = warp ? 'pl_cube2d_warp_' : 'pl_cube2d_none_';
      return layoutOf(id, prefix, [CUBE_CHUNK, { key: prefix, wgsl: cubeDirWgsl(prefix, warp) + (warp ? cube2dWarpSample(prefix) : cube2dNoneSample(prefix)) }], {
        mipLevelCount, layersPerProbe: 6, viewDimension: '2d-array', textureType: 'texture_2d_array<f32>',
        textureDescriptor: (size, probes, format) => descriptor(`probes.${id}`, size, 6 * probes, mipLevelCount, format),
      });
    }
    case 'cube-hw': {
      const prefix = 'pl_cube_hw_';
      return layoutOf(id, prefix, [CUBE_CHUNK, { key: prefix, wgsl: cubeDirWgsl(prefix, false) + cubeHwSample(prefix) }], {
        mipLevelCount, layersPerProbe: 6, viewDimension: 'cube-array', textureType: 'texture_cube_array<f32>',
        textureDescriptor: (size, probes, format) => descriptor(`probes.${id}`, size, 6 * probes, mipLevelCount, format),
      });
    }
    case 'octa': {
      const prefix = `pl_octa${maxLod}_`;
      return layoutOf(id, prefix, [OCTA_CHUNK, { key: prefix, wgsl: octaWgsl(prefix, maxLod) }], {
        mipLevelCount, layersPerProbe: 1, viewDimension: '2d-array', textureType: 'texture_2d_array<f32>',
        textureDescriptor: (size, probes, format) => {
          if (size >> maxLod < 1) throw new Error(`octa: size ${size} has no mip ${maxLod}`);
          return descriptor(`probes.${id}`, size, probes, mipLevelCount, format);
        },
      });
    }
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
