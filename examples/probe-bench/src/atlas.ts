// W62 (D4902): mixed probe sizes in ONE 2D octahedral atlas (Unity HDRP's reflection atlas since
// 14.x; Godot 4.6 and EEVEE use octahedral maps too), against one cube array per size (what
// core / three ship, D4700: one sampled-texture binding per size). Bench only: core's lookup is
// unchanged. `window.__p.atlas()` runs it; `pnpm check -- --only probe-bench --probe-atlas`.
//
// Per probe: the bench's `octa` layout (full sphere, a gutter of half a texel at the probe's last
// mip, so one trilinear sample never reads past its own square) prefiltered by LayoutPrefilter
// at side k x capture, then copied mip by mip into a tile of a 2D atlas. Tiles are powers of two
// at multiples of their own side (a buddy allocator, as HDRP's power-of-two atlas), so mip m of a
// tile is exactly the atlas's mip m texels at (x >> m, y >> m) and the atlas's hardware mip chain
// serves every probe. Each probe keeps its own maxLod (its roughness ladder, D4700), carried per
// tile; the atlas's mips past a small probe's maxLod are never read for it. Atlas texels outside
// the tiles are cleared to 1000 so any bleed across a tile edge shows.
//
// Measured: (1) every probe looked up in the atlas against the same probe in its own texture
// (`octa`, one layer): bleed shows as a difference, at every mip and between mips; (2) error against
// the GGX reference for 128 / 256 px captures, atlas vs cube-hw, seam and interior split as the
// bench's main table; (3) a 1920x1080 full-screen lookup, three probes of three sizes, one per
// screen third (coherent) or per pixel (scattered): the atlas (one binding) vs three cube arrays
// (three bindings, the lookup picks one by the probe's atlas index, as core's runtime loop does);
// (4) memory: tiles, and the atlas as allocated.

import { GGXReference, LayoutPrefilter, createProbeLayout, lodToRoughness, maxLodFor, octaGutter, probeBytes, type ProbeLayout } from '@pmndrs/reflections/core';
import { cubeEdgeTexels, errorStats, fibonacciDirs, median, octaFoldTexels } from './stats';

export interface AtlasBenchContext {
  device: GPUDevice;
  envCube(size: number): GPUTexture;
  buffer(data: ArrayBufferView | number, usage: number): GPUBuffer;
  readBuffer(src: GPUBuffer, size: number): Promise<ArrayBuffer>;
  log(s: string): void;
}

interface Tile { capture: number; maxLod: number; side: number; x: number; y: number }

/** Buddy allocation of power-of-two squares in a square atlas of side `size`, largest first. */
function pack(sides: number[], size: number): { x: number; y: number }[] | null {
  const free: { x: number; y: number; s: number }[] = [{ x: 0, y: 0, s: size }];
  const out: { x: number; y: number }[] = new Array(sides.length);
  const order = sides.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  for (const { s, i } of order) {
    free.sort((a, b) => a.s - b.s || a.y - b.y || a.x - b.x);
    const k = free.findIndex((f) => f.s >= s);
    if (k < 0) return null;
    let f = free.splice(k, 1)[0];
    while (f.s > s) { const h = f.s / 2; free.push({ x: f.x + h, y: f.y, s: h }, { x: f.x, y: f.y + h, s: h }, { x: f.x + h, y: f.y + h, s: h }); f = { x: f.x, y: f.y, s: h }; }
    out[i] = { x: f.x, y: f.y };
  }
  return out;
}

const U = () => GPUBufferUsage, T = () => GPUTextureUsage;

// WGSL: one tile per probe: (x, y, side) in atlas mip-0 texels, the gutter fraction b, maxLod.
const ATLAS_WGSL = /* wgsl */ `
struct AtlasTile { rect: vec4<f32>, info: vec4<f32> } // rect: x, y, side, -; info: b, maxLod, -, -
fn atlasSample(tex: texture_2d<f32>, samp: sampler, tile: AtlasTile, dir: vec3<f32>, lod: f32) -> vec4<f32> {
  let dim = vec2<f32>(textureDimensions(tex, 0u));
  let b = tile.info.x;
  let t = b + (pl_octaEncode(dir) * 0.5 + 0.5) * (1.0 - 2.0 * b);
  let uv = (tile.rect.xy + t * tile.rect.z) / dim;
  return textureSampleLevel(tex, samp, uv, min(lod, tile.info.y));
}`;

export async function atlasBench(ctx: AtlasBenchContext, { nDirs = 65536, runs = 9, ratio = 2, timing = true } = {}) {
  const { device, log } = ctx;
  const t0 = performance.now();
  const captures = [512, 256, 128];
  const dirsCpu = fibonacciDirs(nDirs);
  const dirs = ctx.buffer(dirsCpu, U().STORAGE);
  const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
  const octaChunk = createProbeLayout('octa', { maxLod: 4 }).chunks[0].wgsl; // pl_octa* shared maths
  const results: Record<string, unknown> & { identity: unknown[]; error: unknown[]; lookup: unknown[] } = { ratio, nDirs, identity: [], error: [], lookup: [] };

  // ---- probes: octa (standalone, 1 layer) and cube-hw, per capture size
  const probes = captures.map((N) => {
    const maxLod = maxLodFor(N), side = ratio * N;
    const src = ctx.envCube(N);
    const octa = createProbeLayout('octa', { maxLod }), cube = createProbeLayout('cube-hw', { maxLod });
    const mk = (layout: ProbeLayout, size: number) => {
      const d = layout.textureDescriptor(size, 1, 'rgba16float');
      const tex = device.createTexture({ ...d, usage: (d.usage as number) | T().COPY_SRC | T().COPY_DST });
      const pf = new LayoutPrefilter(device, layout, size, N);
      const enc = device.createCommandEncoder(); pf.encode(enc, src, tex, 0); device.queue.submit([enc.finish()]);
      pf.dispose();
      return tex;
    };
    return { N, maxLod, side, src, octa, cube, octaTex: mk(octa, side), cubeTex: mk(cube, N) };
  });

  // ---- the atlas: smallest power-of-two square that packs the tiles
  const sides = probes.map((p) => p.side);
  let size = 1; while (size * size < sides.reduce((a, s) => a + s * s, 0)) size *= 2;
  let at = pack(sides, size);
  while (!at) { size *= 2; at = pack(sides, size); }
  const tiles: Tile[] = probes.map((p, i) => ({ capture: p.N, maxLod: p.maxLod, side: p.side, x: at![i].x, y: at![i].y }));
  // the used corner of the square, rounded up to powers of two (a rectangle: tiles stay aligned)
  const pow2 = (v: number) => 2 ** Math.ceil(Math.log2(v));
  const AW = pow2(Math.max(...tiles.map((t) => t.x + t.side))), AH = pow2(Math.max(...tiles.map((t) => t.y + t.side)));
  const atlasMips = Math.max(...probes.map((p) => p.maxLod)) + 1;
  const atlas = device.createTexture({ label: 'octa atlas', size: [AW, AH], format: 'rgba16float', mipLevelCount: atlasMips, usage: T().TEXTURE_BINDING | T().COPY_DST | T().RENDER_ATTACHMENT });
  {
    const enc = device.createCommandEncoder();
    for (let m = 0; m < atlasMips; m++) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: atlas.createView({ baseMipLevel: m, mipLevelCount: 1 }), loadOp: 'clear', clearValue: [1000, 1000, 1000, 1], storeOp: 'store' }] });
      pass.end();
    }
    probes.forEach((p, i) => {
      for (let m = 0; m <= p.maxLod; m++) {
        const s = p.side >> m;
        enc.copyTextureToTexture({ texture: p.octaTex, mipLevel: m, origin: [0, 0, 0] }, { texture: atlas, mipLevel: m, origin: [tiles[i].x >> m, tiles[i].y >> m, 0] }, [s, s, 1]);
      }
    });
    device.queue.submit([enc.finish()]);
  }
  const tileData = new Float32Array(tiles.length * 8);
  tiles.forEach((t, i) => tileData.set([t.x, t.y, t.side, 0, octaGutter(t.side, t.maxLod), t.maxLod, 0, 0], i * 8));
  const tileBuf = ctx.buffer(tileData, U().STORAGE);
  const mib = (b: number) => (b / 2 ** 20).toFixed(2);
  const tileBytes = probes.reduce((a, p) => a + probeBytes(p.octa, p.side, 'rgba16float'), 0);
  let atlasBytes = 0; for (let m = 0; m < atlasMips; m++) atlasBytes += (AW >> m) * (AH >> m) * 8;
  const cubeBytes = probes.reduce((a, p) => a + probeBytes(p.cube, p.N, 'rgba16float'), 0);
  results.memory = { tiles: tiles.map((t) => ({ ...t })), atlasSize: [AW, AH], atlasMips, tileBytes, atlasBytes, cubeBytes };
  log(`octa atlas (side ${ratio} x capture): ${AW}x${AH}, ${atlasMips} mips, tiles ${tiles.map((t) => `${t.capture}px->${t.side} at (${t.x},${t.y})`).join(', ')}; `
    + `tiles ${mib(tileBytes)} MiB, atlas as allocated ${mib(atlasBytes)} MiB; cube arrays (one per size) ${mib(cubeBytes)} MiB`);

  // ---- lookups along every direction (compute)
  const evalCode = (body: string, bindings: string) => `${octaChunk}\n${ATLAS_WGSL}\n${bindings}
@group(0) @binding(2) var<storage, read> dirs: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outRad: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> P: vec4<f32>; // x = lod, y = count, z = tile
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= u32(P.y)) { return; }
  let dir = dirs[g.x].xyz;
  outRad[g.x] = ${body};
}`;
  const atlasEval = device.createComputePipeline({ layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ label: 'atlas eval', code: evalCode('atlasSample(atlas, samp, tiles[u32(P.z)], dir, P.x)',
    '@group(0) @binding(0) var atlas: texture_2d<f32>;\n@group(0) @binding(1) var samp: sampler;\n@group(0) @binding(5) var<storage, read> tiles: array<AtlasTile>;') }) } });
  const layoutEval = new Map<string, GPUComputePipeline>();
  const run = async (pipe: GPUComputePipeline, entries: GPUBindGroupEntry[], lod: number, tile: number) => {
    const out = device.createBuffer({ size: nDirs * 16, usage: U().STORAGE | U().COPY_SRC });
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [...entries,
      { binding: 2, resource: { buffer: dirs } }, { binding: 3, resource: { buffer: out } }, { binding: 4, resource: { buffer: ctx.buffer(new Float32Array([lod, nDirs, tile, 0]), U().UNIFORM) } }] }));
    pass.dispatchWorkgroups(Math.ceil(nDirs / 64)); pass.end();
    device.queue.submit([enc.finish()]);
    const r = new Float32Array(await ctx.readBuffer(out, nDirs * 16)); out.destroy();
    return r;
  };
  const viaAtlas = (lod: number, tile: number) => run(atlasEval, [{ binding: 0, resource: atlas.createView() }, { binding: 1, resource: samp }, { binding: 5, resource: { buffer: tileBuf } }], lod, tile);
  const viaLayout = (layout: ProbeLayout, tex: GPUTexture, lod: number) => {
    let pipe = layoutEval.get(layout.wgsl);
    if (!pipe) {
      pipe = device.createComputePipeline({ layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `${layout.wgsl}
@group(0) @binding(0) var tex: ${layout.textureType};
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<storage, read> dirs: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outRad: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> P: vec4<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= u32(P.y)) { return; }
  outRad[g.x] = sampleLayout(tex, samp, 0u, dirs[g.x].xyz, P.x);
}` }) } });
      layoutEval.set(layout.wgsl, pipe);
    }
    return run(pipe, [{ binding: 0, resource: tex.createView({ dimension: layout.viewDimension }) }, { binding: 1, resource: samp }], lod, 0);
  };
  const maxAbs = (a: Float32Array, b: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

  // (1) identity: atlas tile vs its probe alone, at every mip, between mips and past maxLod
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const lods = [...Array.from({ length: p.maxLod + 1 }, (_, l) => l), ...Array.from({ length: p.maxLod }, (_, l) => l + 0.5), p.maxLod + 1.5];
    let worst = 0, worstTone = 0;
    for (const lod of lods) {
      const a = await viaAtlas(lod, i), b = await viaLayout(p.octa, p.octaTex, Math.min(lod, p.maxLod));
      const d = maxAbs(a, b), e = errorStats(a, b, new Uint8Array(nDirs)).all.max;
      worst = Math.max(worst, d); worstTone = Math.max(worstTone, e);
      results.identity.push({ capture: p.N, side: p.side, lod, maxAbs: d, maxTone: e });
    }
    log(`atlas vs own texture, ${p.N} px capture (tile ${p.side} at ${tiles[i].x},${tiles[i].y}): max ${worstTone.toFixed(2)} /255 (max |radiance diff| ${worst}) over lods ${lods.join(' ')} (bleed would read the 1000 fill)`);
  }

  // (2) error against the GGX reference (128 / 256 px captures), atlas vs cube-hw
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    if (p.N > 256) continue; // the exhaustive reference over a 512 px capture takes minutes; 128 / 256 are the bench's classes
    const reference = new GGXReference(device, p.src, p.N);
    const refOut = device.createBuffer({ size: nDirs * 16, usage: U().STORAGE | U().COPY_SRC });
    const row: string[] = [];
    for (let lod = 0; lod <= p.maxLod; lod++) {
      const r = lodToRoughness(lod, p.maxLod);
      await reference.compute(dirs, refOut, nDirs, r);
      const ref = new Float32Array(await ctx.readBuffer(refOut, nDirs * 16));
      const sOcta = p.side >> lod, sCube = p.N >> lod, span = sOcta * (1 - 2 * octaGutter(p.side, p.maxLod));
      const seamOcta = new Uint8Array(nDirs), seamCube = new Uint8Array(nDirs);
      for (let k = 0; k < nDirs; k++) {
        const x = dirsCpu[k * 4], y = dirsCpu[k * 4 + 1], z = dirsCpu[k * 4 + 2];
        seamOcta[k] = octaFoldTexels(x, y, z, span) < 1 ? 1 : 0;
        seamCube[k] = cubeEdgeTexels(x, y, z, sCube) < 1 ? 1 : 0;
      }
      const a = errorStats(await viaAtlas(lod, i), ref, seamOcta), c = errorStats(await viaLayout(p.cube, p.cubeTex, lod), ref, seamCube);
      results.error.push({ capture: p.N, lod, roughness: r, atlas: a, cube: c });
      row.push(`r ${r.toFixed(2)} atlas ${a.all.mean.toFixed(2)}/${a.all.p99.toFixed(1)} (seam p99 ${a.seam.p99.toFixed(1)}) cube ${c.all.mean.toFixed(2)}/${c.all.p99.toFixed(1)} (seam ${c.seam.p99.toFixed(1)})`);
    }
    log(`error vs GGX, ${p.N} px capture, mean/p99 /255: ${row.join(' | ')}`);
    refOut.destroy();
  }

  // (3) lookup cost, 1920 x 1080, three probes of three sizes
  if (timing) {
    const W = 1920, H = 1080;
    const rt = device.createTexture({ size: [W, H], format: 'rgba16float', usage: T().RENDER_ATTACHMENT });
    const FS = (sample: string, bindings: string) => `${octaChunk}\n${ATLAS_WGSL}\n${bindings}
@group(0) @binding(9) var<uniform> P: vec4<f32>; // xy res, z scattered, w maxLod of the largest
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)); return vec4(p * 2.0 - 1.0, 0.0, 1.0); }
fn hash2(p: vec2<u32>) -> vec2<f32> {
  var x = p.x * 1664525u + p.y * 1013904223u; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u;
  var y = x * 0x846ca68bu; y ^= y >> 16u;
  return vec2(f32(x), f32(y)) * 2.3283064365386963e-10 - 0.5;
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = pos.xy / P.xy;
  let j = hash2(vec2<u32>(pos.xy));
  var az = (uv.x + j.x * 0.01) * 6.283185307; var el = (0.5 - uv.y + j.y * 0.01) * 3.14159265;
  var r = fract(uv.x * 5.0 + uv.y * 3.0);
  var probe = min(u32(uv.x * 3.0), 2u);
  if (P.z > 0.5) {
    let k = hash2(vec2<u32>(pos.yx) + 7u);
    az = j.x * 6.283185307; el = asin(clamp(j.y * 2.0, -1.0, 1.0)); r = k.x + 0.5;
    probe = min(u32((k.y + 0.5) * 3.0), 2u);
  }
  let dir = vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az));
  let lod = (P.w - f32(probe)) * r * (2.0 - r);
  ${sample}
}`;
    const cubeFs = FS(`if (probe == 0u) { return textureSampleLevel(c0, samp, dir, 0u, lod); }
  if (probe == 1u) { return textureSampleLevel(c1, samp, dir, 0u, lod); }
  return textureSampleLevel(c2, samp, dir, 0u, lod);`,
    `@group(0) @binding(0) var c0: texture_cube_array<f32>;\n@group(0) @binding(1) var c1: texture_cube_array<f32>;\n@group(0) @binding(2) var c2: texture_cube_array<f32>;\n@group(0) @binding(3) var samp: sampler;`);
    const atlasFs = FS('return atlasSample(atlas, samp, tiles[probe], dir, lod);',
      '@group(0) @binding(0) var atlas: texture_2d<f32>;\n@group(0) @binding(3) var samp: sampler;\n@group(0) @binding(5) var<storage, read> tiles: array<AtlasTile>;');
    const pipeOf = (code: string, label: string) => { const module = device.createShaderModule({ code, label }); return device.createRenderPipeline({ label, layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } }); };
    const cubePipe = pipeOf(cubeFs, 'lookup cube arrays x3'), atlasPipe = pipeOf(atlasFs, 'lookup octa atlas');
    for (const scattered of [false, true]) {
      const ub = ctx.buffer(new Float32Array([W, H, scattered ? 1 : 0, probes[0].maxLod]), U().UNIFORM);
      const cubeGroup = device.createBindGroup({ layout: cubePipe.getBindGroupLayout(0), entries: [
        ...probes.map((p, k) => ({ binding: k, resource: p.cubeTex.createView({ dimension: 'cube-array' }) })), { binding: 3, resource: samp }, { binding: 9, resource: { buffer: ub } }] });
      const atlasGroup = device.createBindGroup({ layout: atlasPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: atlas.createView() }, { binding: 3, resource: samp }, { binding: 5, resource: { buffer: tileBuf } }, { binding: 9, resource: { buffer: ub } }] });
      const N = scattered ? 4 : 32;
      const burst = (pipe: GPURenderPipeline, group: GPUBindGroup) => {
        const enc = device.createCommandEncoder();
        for (let k = 0; k < N; k++) { const pass = enc.beginRenderPass({ colorAttachments: [{ view: rt.createView(), loadOp: 'clear', storeOp: 'store' }] }); pass.setPipeline(pipe); pass.setBindGroup(0, group); pass.draw(3); pass.end(); }
        return enc.finish();
      };
      const wall = async (pipe: GPURenderPipeline, group: GPUBindGroup) => { const c0 = performance.now(); device.queue.submit([burst(pipe, group)]); await device.queue.onSubmittedWorkDone(); return (performance.now() - c0) / N; };
      device.queue.submit([burst(atlasPipe, atlasGroup), burst(cubePipe, cubeGroup)]); await device.queue.onSubmittedWorkDone();
      const a: number[] = [], c: number[] = [];
      for (let k = 0; k < runs; k++) { a.push(await wall(atlasPipe, atlasGroup)); c.push(await wall(cubePipe, cubeGroup)); }
      const row = { pattern: scattered ? 'scattered' : 'coherent', atlasMs: Math.min(...a), cubeMs: Math.min(...c), ratio: median(a.map((x, k) => x / c[k])) };
      results.lookup.push(row);
      log(`lookup 1920x1080 ${row.pattern}, 3 probes (512 / 256 / 128): octa atlas ${row.atlasMs.toFixed(3)} ms, 3 cube arrays ${row.cubeMs.toFixed(3)} ms, atlas / cubes ${row.ratio.toFixed(2)} (median of ${runs} pairs)`);
      ub.destroy();
    }
    rt.destroy();
  }
  results.seconds = (performance.now() - t0) / 1000;
  for (const p of probes) { p.src.destroy(); p.octaTex.destroy(); p.cubeTex.destroy(); }
  atlas.destroy(); tileBuf.destroy(); dirs.destroy();
  return results;
}
