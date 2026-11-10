// BC6H (bc6h-rgb-ufloat) encoder in WebGPU compute.
//
// A WGSL port of Krzysztof Narkowicz's GPURealTimeBC6H (bin/compress.hlsl, commit 0416fd3,
// https://github.com/knarkowicz/GPURealTimeBC6H), dual-licensed public domain / MIT:
//
//   MIT License. Copyright (c) 2015 Krzysztof Narkowicz.
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
//   and associated documentation files (the "Software"), to deal in the Software without
//   restriction, including without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//   Software is furnished to do so, subject to the following conditions: The above copyright
//   notice and this permission notice shall be included in all copies or substantial portions of
//   the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
//   LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
//   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
//
// Modes: 'fast' is the original's fast preset (mode 11 only: one subset, 10-bit endpoints, 4-bit
// indices, bbox + inset + least-squares endpoints, all in log2 space). 'normal' is its quality
// preset: mode 11 plus the best of 32 two-subset partitions (picked by distance to each subset's
// bbox diagonal), encoded as mode 2 (7.6.6.6 deltas) or mode 6 (9.5.5.5), whichever has the lower
// log error.
//
// Changes from the HLSL (docs/DIVERGES.md D200-D202): texels come from textureLoad with clamped
// coordinates instead of GatherRed/Green/Blue (so mips under 4 px replicate their edge texels into
// the padding); degenerate blocks (flat colour, zero-length axis) are guarded against 0/0 instead of
// relying on HLSL NaN behaviour; inputs are clamped to [0, 65504] (ufloat); blocks go to a storage
// buffer (one vec4<u32> per block, WGSL has no 64-bit ints) and are copied into the texture with
// copyBufferToTexture, since compute can't write a BC texture.

/** Encoder settings. `fast`: mode 11 only. `normal`: mode 11 plus a two-subset partition search. */
export interface BC6HEncodeOptions { quality?: 'fast' | 'normal'; }

export interface BC6HEncoder {
  /** Encode every mip and layer of `src` into a new bc6h-rgb-ufloat texture (records and submits). */
  encode(src: GPUTexture, opts?: BC6HEncodeOptions): GPUTexture;
  /** Record the encode of every mip and layer of `src` into `dst` (same size, mips, layers). */
  encodeInto(cmd: GPUCommandEncoder, src: GPUTexture, dst: GPUTexture, opts?: BC6HEncodeOptions): void;
  destroy(): void;
}

const WGSL = /* wgsl */ `
override ENCODE_P2: bool = false;
const HALF_MAX: f32 = 65504.0;

struct Params { offset: u32, rowStride: u32, blocksX: u32, blocksY: u32 }
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> blocks: array<vec4<u32>>;
@group(0) @binding(2) var<uniform> P: Params;

var<private> texels: array<vec3f, 16>;
var<private> indices: array<u32, 16>;
var<private> PATTERNS: array<u32, 16> = array<u32, 16>(
  2290666700u, 3972591342u, 4276930688u, 3967876808u, 4293707776u, 3892379264u, 4278255592u, 4026597360u,
  9369360u, 147747072u, 1930428556u, 2362323200u, 823134348u, 913073766u, 267393000u, 966553998u);

// HLSL f32tof16 (bits as a float) / f16tof32. Clamped so pack2x16float never sees a non-f16 value.
fn h(x: f32) -> f32 { return f32(pack2x16float(vec2f(clamp(x, -HALF_MAX, HALF_MAX), 0.0)) & 0xffffu); }
fn h3(x: vec3f) -> vec3f { return vec3f(h(x.x), h(x.y), h(x.z)); }
fn f16tof32(u: vec3u) -> vec3f {
  return vec3f(unpack2x16float(u.x).x, unpack2x16float(u.y).x, unpack2x16float(u.z).x);
}

fn calcMSLE(a: vec3f, b: vec3f) -> f32 {
  let delta = log2((b + 1.0) / (a + 1.0));
  let d2 = delta * delta * vec3f(0.299, 0.587, 0.114);
  return d2.x + d2.y + d2.z;
}

fn patternFixupID(i: u32) -> u32 {
  var ret = 15u;
  if (((3441033216u >> i) & 1u) != 0u) { ret = 2u; }
  if (((845414400u >> i) & 1u) != 0u) { ret = 8u; }
  return ret;
}
fn pattern(p: u32, i: u32) -> u32 {
  var enc = PATTERNS[p >> 1u];
  if ((p & 1u) != 0u) { enc = enc >> 16u; }
  return (enc >> i) & 1u;
}

fn quantize7(x: vec3f) -> vec3f { return (h3(x) * 128.0) / 31744.0; }
fn quantize9(x: vec3f) -> vec3f { return (h3(x) * 512.0) / 31744.0; }
fn quantize10(x: vec3f) -> vec3f { return (h3(x) * 1024.0) / 31744.0; }
fn unquantize7(x: vec3f) -> vec3f { return (x * 65536.0 + 32768.0) / 128.0; }
fn unquantize9(x: vec3f) -> vec3f { return (x * 65536.0 + 32768.0) / 512.0; }
fn unquantize10(x: vec3f) -> vec3f { return (x * 65536.0 + 32768.0) / 1024.0; }
fn finishUnquantize(e0: vec3f, e1: vec3f, w: f32) -> vec3f {
  let comp = (e0 * (64.0 - w) + e1 * w + 32.0) * (31.0 / 4096.0);
  return f16tof32(vec3u(max(comp, vec3f(0.0))));
}

// Guarded: a flat block (e1 == e0) puts every texel on index 0 instead of HLSL's NaN path.
fn ratio(t: f32, e0: f32, e1: f32) -> f32 {
  let d = e1 - e0;
  return select((t - e0) / d, 0.0, d == 0.0);
}
fn computeIndex3(t: f32, e0: f32, e1: f32) -> u32 { return u32(clamp(ratio(t, e0, e1) * 6.98182 + 0.00909 + 0.5, 0.0, 7.0)); }
fn computeIndex4(t: f32, e0: f32, e1: f32) -> u32 { return u32(clamp(ratio(t, e0, e1) * 14.93333 + 0.03333 + 0.5, 0.0, 15.0)); }

// Axis scaled so its components sum to 1 (as the HLSL), or (1/3, 1/3, 1/3) for a zero axis.
fn sumNormalize(v: vec3f) -> vec3f {
  let s = v.x + v.y + v.z;
  return select(v / s, vec3f(1.0 / 3.0), s == 0.0);
}
fn safeNormalize(v: vec3f) -> vec3f {
  let l = length(v);
  return select(v / l, vec3f(0.0), l == 0.0);
}

fn signExtend(v1: vec3f, mask: i32, signFlag: i32) -> vec3f {
  let v = vec3i(v1);
  return vec3f(vec3i(
    (v.x & mask) | select(0, signFlag, v.x < 0),
    (v.y & mask) | select(0, signFlag, v.y < 0),
    (v.z & mask) | select(0, signFlag, v.z < 0)));
}

fn insetColorBBoxP1(bmin: ptr<function, vec3f>, bmax: ptr<function, vec3f>) {
  var rmin = *bmax;
  var rmax = *bmin;
  for (var i = 0u; i < 16u; i++) {
    let t = texels[i];
    rmin = min(rmin, select(t, rmin, t == *bmin));
    rmax = max(rmax, select(t, rmax, t == *bmax));
  }
  let lrmax = log2(rmax + 1.0);
  let lrmin = log2(rmin + 1.0);
  var lmax = log2(*bmax + 1.0);
  var lmin = log2(*bmin + 1.0);
  let ext = (lmax - lmin) * (1.0 / 32.0);
  lmin += min(lrmin - lmin, ext);
  lmax -= min(lmax - lrmax, ext);
  *bmin = exp2(lmin) - 1.0;
  *bmax = exp2(lmax) - 1.0;
}

fn optimizeEndpointsP1(bmin: ptr<function, vec3f>, bmax: ptr<function, vec3f>, minNI: vec3f, maxNI: vec3f) {
  let dir = sumNormalize(*bmax - *bmin);
  let e0 = h(dot(*bmin, dir));
  let e1 = h(dot(*bmax, dir));
  var aT = vec3f(0.0); var bT = vec3f(0.0);
  var ab = 0.0; var aa = 0.0; var bb = 0.0;
  for (var i = 0u; i < 16u; i++) {
    let idx = computeIndex4(h(dot(texels[i], dir)), e0, e1);
    let beta = saturate(f32(idx) / 15.0);
    let alpha = 1.0 - beta;
    let tf16 = h3(texels[i]);
    aT += alpha * tf16; bT += beta * tf16;
    ab += alpha * beta; aa += alpha * alpha; bb += beta * beta;
  }
  let det = aa * bb - ab * ab;
  if (abs(det) > 0.00001) {
    let r = 1.0 / det;
    *bmin = clamp(f16tof32(vec3u(clamp(r * (aT * bb - bT * ab), vec3f(0.0), vec3f(HALF_MAX)))), minNI, maxNI);
    *bmax = clamp(f16tof32(vec3u(clamp(r * (bT * aa - aT * ab), vec3f(0.0), vec3f(HALF_MAX)))), minNI, maxNI);
  }
}

fn optimizeEndpointsP2(pat: u32, sel: u32, bmin: ptr<function, vec3f>, bmax: ptr<function, vec3f>) {
  let dir = sumNormalize(*bmax - *bmin);
  let e0 = h(dot(*bmin, dir));
  let e1 = h(dot(*bmax, dir));
  var aT = vec3f(0.0); var bT = vec3f(0.0);
  var ab = 0.0; var aa = 0.0; var bb = 0.0;
  for (var i = 0u; i < 16u; i++) {
    if (pattern(pat, i) == sel) {
      let idx = computeIndex3(h(dot(texels[i], dir)), e0, e1);
      let beta = saturate(f32(idx) / 7.0);
      let alpha = 1.0 - beta;
      let tf16 = h3(texels[i]);
      aT += alpha * tf16; bT += beta * tf16;
      ab += alpha * beta; aa += alpha * alpha; bb += beta * beta;
    }
  }
  let det = aa * bb - ab * ab;
  if (abs(det) > 0.00001) {
    let r = 1.0 / det;
    *bmin = f16tof32(vec3u(clamp(r * (aT * bb - bT * ab), vec3f(0.0), vec3f(HALF_MAX))));
    *bmax = f16tof32(vec3u(clamp(r * (bT * aa - aT * ab), vec3f(0.0), vec3f(HALF_MAX))));
  }
}

// Mode 11: one subset, 10-bit endpoints, 4-bit indices.
fn encodeP1(block: ptr<function, vec4u>, blockMSLE: ptr<function, f32>) {
  var bmin = texels[0];
  var bmax = texels[0];
  for (var i = 1u; i < 16u; i++) { bmin = min(bmin, texels[i]); bmax = max(bmax, texels[i]); }
  let minNI = bmin;
  let maxNI = bmax;
  insetColorBBoxP1(&bmin, &bmax);
  optimizeEndpointsP1(&bmin, &bmax, minNI, maxNI);

  let dir = sumNormalize(bmax - bmin);
  var ep0 = quantize10(bmin);
  var ep1 = quantize10(bmax);
  var e0 = h(dot(bmin, dir));
  var e1 = h(dot(bmax, dir));

  // The fixup texel (0) must have index MSB 0: swap endpoints if it would not.
  if (computeIndex4(h(dot(texels[0], dir)), e0, e1) > 7u) {
    let t = e0; e0 = e1; e1 = t;
    let v = ep0; ep0 = ep1; ep1 = v;
  }
  for (var i = 0u; i < 16u; i++) { indices[i] = computeIndex4(h(dot(texels[i], dir)), e0, e1); }

  let u0 = unquantize10(ep0);
  let u1 = unquantize10(ep1);
  var msle = 0.0;
  for (var i = 0u; i < 16u; i++) {
    let w = floor((f32(indices[i]) * 64.0) / 15.0 + 0.5);
    msle += calcMSLE(texels[i], finishUnquantize(u0, u1, w));
  }
  *blockMSLE = msle;

  let a = vec3u(ep0);
  let b = vec3u(ep1);
  var blk = vec4u(3u, 0u, 0u, 0u);
  blk.x |= a.x << 5u;
  blk.x |= a.y << 15u;
  blk.x |= a.z << 25u;
  blk.y |= a.z >> 7u;
  blk.y |= b.x << 3u;
  blk.y |= b.y << 13u;
  blk.y |= b.z << 23u;
  blk.z |= b.z >> 9u;
  blk.z |= indices[0] << 1u;
  blk.z |= indices[1] << 4u;
  blk.z |= indices[2] << 8u;
  blk.z |= indices[3] << 12u;
  blk.z |= indices[4] << 16u;
  blk.z |= indices[5] << 20u;
  blk.z |= indices[6] << 24u;
  blk.z |= indices[7] << 28u;
  blk.w |= indices[8] << 0u;
  blk.w |= indices[9] << 4u;
  blk.w |= indices[10] << 8u;
  blk.w |= indices[11] << 12u;
  blk.w |= indices[12] << 16u;
  blk.w |= indices[13] << 20u;
  blk.w |= indices[14] << 24u;
  blk.w |= indices[15] << 28u;
  *block = blk;
}

fn distToLineSq(p: vec3f, d: vec3f, x: vec3f) -> f32 {
  let w = x - p;
  let v = w - dot(w, d) * d;
  return dot(v, v);
}

// How well a two-subset partition fits: summed squared distance to each subset's bbox diagonal.
fn evaluateP2Pattern(pat: u32) -> f32 {
  var p0min = vec3f(HALF_MAX); var p0max = vec3f(0.0);
  var p1min = vec3f(HALF_MAX); var p1max = vec3f(0.0);
  for (var i = 0u; i < 16u; i++) {
    if (pattern(pat, i) == 0u) { p0min = min(p0min, texels[i]); p0max = max(p0max, texels[i]); }
    else { p1min = min(p1min, texels[i]); p1max = max(p1max, texels[i]); }
  }
  let d0 = safeNormalize(p0max - p0min);
  let d1 = safeNormalize(p1max - p1min);
  var s = 0.0;
  for (var i = 0u; i < 16u; i++) {
    if (pattern(pat, i) == 0u) { s += distToLineSq(p0min, d0, texels[i]); }
    else { s += distToLineSq(p1min, d1, texels[i]); }
  }
  return s;
}

fn swapf(a: ptr<function, f32>, b: ptr<function, f32>) { let t = *a; *a = *b; *b = t; }
fn swap3(a: ptr<function, vec3f>, b: ptr<function, vec3f>) { let t = *a; *a = *b; *b = t; }

// Modes 2 (7-bit base, 6-bit deltas) and 6 (9-bit base, 5-bit deltas): two subsets, 3-bit indices.
fn encodeP2Pattern(block: ptr<function, vec4u>, blockMSLE: ptr<function, f32>, pat: u32) {
  var p0min = vec3f(HALF_MAX); var p0max = vec3f(0.0);
  var p1min = vec3f(HALF_MAX); var p1max = vec3f(0.0);
  for (var i = 0u; i < 16u; i++) {
    if (pattern(pat, i) == 0u) { p0min = min(p0min, texels[i]); p0max = max(p0max, texels[i]); }
    else { p1min = min(p1min, texels[i]); p1max = max(p1max, texels[i]); }
  }
  optimizeEndpointsP2(pat, 0u, &p0min, &p0max);
  optimizeEndpointsP2(pat, 1u, &p1min, &p1max);

  let d0 = sumNormalize(p0max - p0min);
  let d1 = sumNormalize(p1max - p1min);
  var p0e0 = h(dot(p0min, d0));
  var p0e1 = h(dot(p0max, d0));
  var p1e0 = h(dot(p1min, d1));
  var p1e1 = h(dot(p1max, d1));

  let fixupID = patternFixupID(pat);
  if (computeIndex3(h(dot(texels[0], d0)), p0e0, p0e1) > 3u) { swapf(&p0e0, &p0e1); swap3(&p0min, &p0max); }
  if (computeIndex3(h(dot(texels[fixupID], d1)), p1e0, p1e1) > 3u) { swapf(&p1e0, &p1e1); swap3(&p1min, &p1max); }

  for (var i = 0u; i < 16u; i++) {
    let i0 = computeIndex3(h(dot(texels[i], d0)), p0e0, p0e1);
    let i1 = computeIndex3(h(dot(texels[i], d1)), p1e0, p1e1);
    indices[i] = select(i1, i0, pattern(pat, i) == 0u);
  }

  let e760 = floor(quantize7(p0min));
  var e761 = floor(quantize7(p0max));
  var e762 = floor(quantize7(p1min));
  var e763 = floor(quantize7(p1max));
  let e950 = floor(quantize9(p0min));
  var e951 = floor(quantize9(p0max));
  var e952 = floor(quantize9(p1min));
  var e953 = floor(quantize9(p1max));

  e761 = clamp(e761 - e760, vec3f(-31.0), vec3f(31.0));
  e762 = clamp(e762 - e760, vec3f(-31.0), vec3f(31.0));
  e763 = clamp(e763 - e760, vec3f(-31.0), vec3f(31.0));
  e951 = clamp(e951 - e950, vec3f(-15.0), vec3f(15.0));
  e952 = clamp(e952 - e950, vec3f(-15.0), vec3f(15.0));
  e953 = clamp(e953 - e950, vec3f(-15.0), vec3f(15.0));

  let u760 = unquantize7(e760);
  let u761 = unquantize7(e760 + e761);
  let u762 = unquantize7(e760 + e762);
  let u763 = unquantize7(e760 + e763);
  let u950 = unquantize9(e950);
  let u951 = unquantize9(e950 + e951);
  let u952 = unquantize9(e950 + e952);
  let u953 = unquantize9(e950 + e953);

  var msle76 = 0.0;
  var msle95 = 0.0;
  for (var i = 0u; i < 16u; i++) {
    let s0 = pattern(pat, i) == 0u;
    let w = floor((f32(indices[i]) * 64.0) / 7.0 + 0.5);
    msle76 += calcMSLE(texels[i], finishUnquantize(select(u762, u760, s0), select(u763, u761, s0), w));
    msle95 += calcMSLE(texels[i], finishUnquantize(select(u952, u950, s0), select(u953, u951, s0), w));
  }

  let p2MSLE = min(msle76, msle95);
  if (!(p2MSLE < *blockMSLE)) { return; }
  *blockMSLE = p2MSLE;
  var blk = vec4u(0u);

  if (p2MSLE == msle76) {
    // Mode 2 (7.6.6.6)
    let A = vec3u(e760);
    let B = vec3u(signExtend(e761, 0x1f, 0x20));
    let C = vec3u(signExtend(e762, 0x1f, 0x20));
    let D = vec3u(signExtend(e763, 0x1f, 0x20));
    blk.x = 1u;
    blk.x |= (C.y & 0x20u) >> 3u;
    blk.x |= (D.y & 0x10u) >> 1u;
    blk.x |= (D.y & 0x20u) >> 1u;
    blk.x |= A.x << 5u;
    blk.x |= (D.z & 0x01u) << 12u;
    blk.x |= (D.z & 0x02u) << 12u;
    blk.x |= (C.z & 0x10u) << 10u;
    blk.x |= A.y << 15u;
    blk.x |= (C.z & 0x20u) << 17u;
    blk.x |= (D.z & 0x04u) << 21u;
    blk.x |= (C.y & 0x10u) << 20u;
    blk.x |= A.z << 25u;
    blk.y |= (D.z & 0x08u) >> 3u;
    blk.y |= (D.z & 0x20u) >> 4u;
    blk.y |= (D.z & 0x10u) >> 2u;
    blk.y |= B.x << 3u;
    blk.y |= (C.y & 0x0Fu) << 9u;
    blk.y |= B.y << 13u;
    blk.y |= (D.y & 0x0Fu) << 19u;
    blk.y |= B.z << 23u;
    blk.y |= (C.z & 0x07u) << 29u;
    blk.z |= (C.z & 0x08u) >> 3u;
    blk.z |= C.x << 1u;
    blk.z |= D.x << 7u;
  } else {
    // Mode 6 (9.5.5.5)
    let A = vec3u(e950);
    let B = vec3u(signExtend(e951, 0xf, 0x10));
    let C = vec3u(signExtend(e952, 0xf, 0x10));
    let D = vec3u(signExtend(e953, 0xf, 0x10));
    blk.x = 0xEu;
    blk.x |= A.x << 5u;
    blk.x |= (C.z & 0x10u) << 10u;
    blk.x |= A.y << 15u;
    blk.x |= (C.y & 0x10u) << 20u;
    blk.x |= A.z << 25u;
    blk.y |= A.z >> 7u;
    blk.y |= (D.z & 0x10u) >> 2u;
    blk.y |= B.x << 3u;
    blk.y |= (D.y & 0x10u) << 4u;
    blk.y |= (C.y & 0x0Fu) << 9u;
    blk.y |= B.y << 13u;
    blk.y |= (D.z & 0x01u) << 18u;
    blk.y |= (D.y & 0x0Fu) << 19u;
    blk.y |= B.z << 23u;
    blk.y |= (D.z & 0x02u) << 27u;
    blk.y |= C.z << 29u;
    blk.z |= (C.z & 0x08u) >> 3u;
    blk.z |= C.x << 1u;
    blk.z |= (D.z & 0x04u) << 4u;
    blk.z |= D.x << 7u;
    blk.z |= (D.z & 0x08u) << 9u;
  }

  blk.z |= pat << 13u;
  if (fixupID == 15u) {
    blk.z |= indices[0] << 18u;
    blk.z |= indices[1] << 20u;
    blk.z |= indices[2] << 23u;
    blk.z |= indices[3] << 26u;
    blk.z |= indices[4] << 29u;
    blk.w |= indices[5] << 0u;
    blk.w |= indices[6] << 3u;
    blk.w |= indices[7] << 6u;
    blk.w |= indices[8] << 9u;
    blk.w |= indices[9] << 12u;
    blk.w |= indices[10] << 15u;
    blk.w |= indices[11] << 18u;
    blk.w |= indices[12] << 21u;
    blk.w |= indices[13] << 24u;
    blk.w |= indices[14] << 27u;
    blk.w |= indices[15] << 30u;
  } else if (fixupID == 2u) {
    blk.z |= indices[0] << 18u;
    blk.z |= indices[1] << 20u;
    blk.z |= indices[2] << 23u;
    blk.z |= indices[3] << 25u;
    blk.z |= indices[4] << 28u;
    blk.z |= indices[5] << 31u;
    blk.w |= indices[5] >> 1u;
    blk.w |= indices[6] << 2u;
    blk.w |= indices[7] << 5u;
    blk.w |= indices[8] << 8u;
    blk.w |= indices[9] << 11u;
    blk.w |= indices[10] << 14u;
    blk.w |= indices[11] << 17u;
    blk.w |= indices[12] << 20u;
    blk.w |= indices[13] << 23u;
    blk.w |= indices[14] << 26u;
    blk.w |= indices[15] << 29u;
  } else {
    blk.z |= indices[0] << 18u;
    blk.z |= indices[1] << 20u;
    blk.z |= indices[2] << 23u;
    blk.z |= indices[3] << 26u;
    blk.z |= indices[4] << 29u;
    blk.w |= indices[5] << 0u;
    blk.w |= indices[6] << 3u;
    blk.w |= indices[7] << 6u;
    blk.w |= indices[8] << 9u;
    blk.w |= indices[9] << 11u;
    blk.w |= indices[10] << 14u;
    blk.w |= indices[11] << 17u;
    blk.w |= indices[12] << 20u;
    blk.w |= indices[13] << 23u;
    blk.w |= indices[14] << 26u;
    blk.w |= indices[15] << 29u;
  }
  *block = blk;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.blocksX || id.y >= P.blocksY) { return; }
  // Texel i of the block is (i % 4, i / 4). Reads clamp to the mip, so mips under 4 px repeat
  // their edge texels into the padding.
  let lim = vec2i(textureDimensions(src)) - 1;
  let base = vec2i(id.xy) * 4;
  for (var i = 0; i < 16; i++) {
    let p = min(base + vec2i(i & 3, i >> 2), lim);
    let t = textureLoad(src, p, id.z, 0).rgb;
    texels[i] = clamp(select(t, vec3f(0.0), t != t), vec3f(0.0), vec3f(HALF_MAX));
  }
  var block = vec4u(0u);
  var blockMSLE = 0.0;
  encodeP1(&block, &blockMSLE);
  if (ENCODE_P2) {
    var bestScore = evaluateP2Pattern(0u);
    var bestPattern = 0u;
    for (var p = 1u; p < 32u; p++) {
      let s = evaluateP2Pattern(p);
      if (s < bestScore) { bestScore = s; bestPattern = p; }
    }
    encodeP2Pattern(&block, &blockMSLE, bestPattern);
  }
  blocks[P.offset + (id.z * P.blocksY + id.y) * P.rowStride + id.x] = block;
}`;

const align = (n: number, a: number) => Math.ceil(n / a) * a;

/** Per-mip layout of the block buffer: copyBufferToTexture needs bytesPerRow % 256 == 0. */
function mipLayout(width: number, height: number, mips: number, layers: number) {
  const out: { blocksX: number; blocksY: number; bytesPerRow: number; offset: number; w: number; h: number }[] = [];
  let offset = 0;
  for (let m = 0; m < mips; m++) {
    const mw = Math.max(1, width >> m), mh = Math.max(1, height >> m);
    const blocksX = Math.ceil(mw / 4), blocksY = Math.ceil(mh / 4);
    const bytesPerRow = align(blocksX * 16, 256);
    out.push({ blocksX, blocksY, bytesPerRow, offset, w: blocksX * 4, h: blocksY * 4 });
    offset = align(offset + bytesPerRow * blocksY * layers, 256);
  }
  return { mips: out, size: offset };
}

/**
 * Create a GPU BC6H encoder on `device`. Throws unless the device was created with the
 * `texture-compression-bc` feature. Sources must be rgba16float (or any float-sampled format) 2D or
 * 2D-array/cube textures with TEXTURE_BINDING usage and mip 0 a multiple of 4 px.
 */
export function createBC6HEncoder(device: GPUDevice): BC6HEncoder {
  if (!device.features.has('texture-compression-bc')) {
    throw new Error("createBC6HEncoder: the device lacks the 'texture-compression-bc' feature (request it in requestDevice({ requiredFeatures })).");
  }
  const module = device.createShaderModule({ label: 'bc6h encode', code: WGSL });
  const layout = device.createBindGroupLayout({
    label: 'bc6h encode',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipelines = new Map<string, GPUComputePipeline>();
  const pipelineFor = (quality: 'fast' | 'normal') => {
    let p = pipelines.get(quality);
    if (!p) {
      p = device.createComputePipeline({
        label: `bc6h encode (${quality})`, layout: pipelineLayout,
        compute: { module, entryPoint: 'main', constants: { ENCODE_P2: quality === 'normal' ? 1 : 0 } },
      });
      pipelines.set(quality, p);
    }
    return p;
  };
  // Shared scratch for blocks. Reusing it across encodes recorded into one command encoder is safe:
  // WebGPU orders each pass's writes before the following copy and the next pass. When it grows,
  // the old buffer is dropped (not destroyed) in case an unsubmitted encoder still references it.
  let scratch: GPUBuffer | null = null;

  function encodeInto(cmd: GPUCommandEncoder, src: GPUTexture, dst: GPUTexture, opts: BC6HEncodeOptions = {}) {
    if (dst.format !== 'bc6h-rgb-ufloat') throw new Error(`BC6H encodeInto: dst format is ${dst.format}, expected bc6h-rgb-ufloat`);
    if (dst.width !== src.width || dst.height !== src.height || dst.depthOrArrayLayers < src.depthOrArrayLayers || dst.mipLevelCount < src.mipLevelCount) {
      throw new Error('BC6H encodeInto: dst must match src in size and have at least its layers and mips');
    }
    const layers = src.depthOrArrayLayers, mips = src.mipLevelCount;
    const L = mipLayout(src.width, src.height, mips, layers);
    if (!scratch || scratch.size < L.size) {
      scratch = device.createBuffer({ label: 'bc6h blocks', size: L.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    }
    const params = device.createBuffer({ label: 'bc6h params', size: 256 * mips, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    const pu = new Uint32Array(params.getMappedRange());
    L.mips.forEach((m, i) => pu.set([m.offset / 16, m.bytesPerRow / 16, m.blocksX, m.blocksY], i * 64));
    params.unmap();

    const pass = cmd.beginComputePass({ label: 'bc6h encode' });
    pass.setPipeline(pipelineFor(opts.quality ?? 'fast'));
    L.mips.forEach((m, i) => {
      pass.setBindGroup(0, device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: src.createView({ dimension: '2d-array', baseMipLevel: i, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: layers }) },
          { binding: 1, resource: { buffer: scratch! } },
          { binding: 2, resource: { buffer: params, offset: i * 256, size: 16 } },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(m.blocksX / 8), Math.ceil(m.blocksY / 8), layers);
    });
    pass.end();
    L.mips.forEach((m, i) => {
      cmd.copyBufferToTexture(
        { buffer: scratch!, offset: m.offset, bytesPerRow: m.bytesPerRow, rowsPerImage: m.blocksY },
        { texture: dst, mipLevel: i },
        { width: m.w, height: m.h, depthOrArrayLayers: layers },
      );
    });
  }

  return {
    encode(src, opts) {
      if (src.width % 4 || src.height % 4) throw new Error(`BC6H encode: mip 0 must be a multiple of 4 px (got ${src.width}x${src.height})`);
      const dst = device.createTexture({
        label: `${src.label || 'texture'} (bc6h)`,
        size: [src.width, src.height, src.depthOrArrayLayers],
        mipLevelCount: src.mipLevelCount,
        format: 'bc6h-rgb-ufloat',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      const cmd = device.createCommandEncoder({ label: 'bc6h encode' });
      encodeInto(cmd, src, dst, opts);
      device.queue.submit([cmd.finish()]);
      return dst;
    },
    encodeInto,
    destroy() { scratch?.destroy(); scratch = null; pipelines.clear(); },
  };
}
