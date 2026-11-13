// Core screen-space reflections on analytic inputs, raw WebGPU (no three.js).
// `window.__p` drives it headlessly: parity() runs the subgroup and workgroup variants on one frame
// and diffs lists (sorted) and images (bit for bit); stats() reports the hit fraction on the mirror
// floor; time(n) gives median GPU ms per pass with the loop stopped (there is no loop: frames render
// on demand); shot() returns the canvas as a PNG data URL.
import {
  createScreenSpaceReflections, DEFAULT_ROUGHNESS_THRESHOLD, environmentRadianceFallback, screenSpaceInputsFromFrame, type FrameInputs, type RadianceFallback, type ScreenSpaceReflections, type ScreenSpaceReflectionsInputs,
  type ScreenSpaceReflectionsSettings, type ScreenSpaceVariant, reflectionsRequiredLimits,
} from '@pmndrs/reflections/core';
import { lookAt, perspective, SCENE_WGSL } from './scene';

const q = new URLSearchParams(location.search);
const statusEl = document.querySelector('#status')!;
const setStatus = (s: string) => { statusEl.textContent = s; };

const DEBUG_WGSL = /* wgsl */ `
struct D { size: vec2u, pad: vec2u };
@group(0) @binding(0) var<uniform> U: D;
@group(0) @binding(1) var<storage, read> rayList: array<u32>;
@group(0) @binding(2) var<storage, read> rayCounter: array<u32, 4>;
@group(0) @binding(3) var<storage, read> missList: array<vec2u>;
@group(0) @binding(4) var<storage, read> missCounter: array<u32, 4>;
@group(0) @binding(5) var<storage, read_write> mask: array<atomic<u32>>;
fn px(p: vec2u) -> u32 { return p.y * U.size.x + p.x; }
// 2-D grids of 64-wide groups (x <= 65535), so 4K and up stay within the dispatch limit
fn flat(id: vec3u, nwg: vec3u) -> u32 { return id.y * nwg.x * 64u + id.x; }
@compute @workgroup_size(64) fn clear(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = flat(id, nwg);
  if (i < U.size.x * U.size.y) { atomicStore(&mask[i], 0u); }
}
@compute @workgroup_size(64) fn mark(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = flat(id, nwg);
  if (i < rayCounter[1]) {
    let r = rayList[i];
    let c = vec2u(r & 32767u, (r >> 15u) & 16383u);
    let t = c ^ vec2u(1u);
    atomicOr(&mask[px(c)], 1u);
    if (((r >> 29u) & 1u) != 0u) { atomicOr(&mask[px(vec2u(t.x, c.y))], 2u); }
    if (((r >> 30u) & 1u) != 0u) { atomicOr(&mask[px(vec2u(c.x, t.y))], 2u); }
    if (((r >> 31u) & 1u) != 0u) { atomicOr(&mask[px(t)], 2u); }
  }
  if (i < missCounter[1]) {
    let r = missList[i].x;
    atomicOr(&mask[px(vec2u(r & 32767u, (r >> 15u) & 16383u))], 4u);
  }
}
`;

const DISPLAY_WGSL = /* wgsl */ `
struct V { size: vec2u, view: u32, mip: u32, canvas: vec2f, threshold: f32, pad: f32 };
@group(0) @binding(0) var<uniform> U: V;
@group(0) @binding(1) var t_color: texture_2d<f32>;
@group(0) @binding(2) var t_normal: texture_2d<f32>;
@group(0) @binding(3) var t_material: texture_2d<f32>;
@group(0) @binding(4) var t_radiance: texture_2d<f32>;
@group(0) @binding(5) var t_hit: texture_2d<f32>;
@group(0) @binding(6) var t_pyramid: texture_2d<f32>;
@group(0) @binding(7) var<storage, read> mask: array<u32>;
@group(0) @binding(8) var<storage, read> tileFlags: array<u32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
fn tone(c: vec3f) -> vec3f { return pow(c / (1.0 + c), vec3f(1.0 / 2.2)); }
fn panel(k: u32, p: vec2i) -> vec3f {
  let m = textureLoad(t_material, p, 0);
  let id = u32(round(m.a * 255.0));
  switch (k) {
    case 0u: { return tone(textureLoad(t_color, p, 0).rgb); }
    case 1u: { return textureLoad(t_normal, p, 0).xyz * 0.5 + 0.5; }
    case 2u: { let a = m.g * m.g; return select(vec3f(m.g), vec3f(1.0, 0.2, 0.2) * m.g, a >= U.threshold || id == 0u); }
    case 3u: { return tone(textureLoad(t_radiance, p, 0).rgb); }
    case 4u: {
      let a = m.g * m.g;
      let w = select(0.0, select(0.5, 0.9, id == 1u), id == 1u || id == 2u) * (1.0 - min(a / 0.25, 1.0) * 0.5);
      return tone(textureLoad(t_color, p, 0).rgb + textureLoad(t_radiance, p, 0).rgb * w);
    }
    case 5u: { let d = textureLoad(t_hit, p, 0).x; return select(vec3f(0.05, 0.0, 0.08), vec3f(1.0 - exp(-d * 0.15)), d > 0.0); }
    case 6u: {
      let b = mask[u32(p.y) * U.size.x + u32(p.x)];
      let tf = tileFlags[u32(p.y / 8) * ((U.size.x + 7u) / 8u) + u32(p.x / 8)];
      var c = tone(textureLoad(t_color, p, 0).rgb) * 0.25;
      if ((tf & 1u) != 0u) { c += select(vec3f(0.25, 0.0, 0.3), vec3f(0.0, 0.05, 0.25), (tf & 2u) != 0u); }
      if ((b & 1u) != 0u) { c = vec3f(0.1, 0.9, 0.2); } else if ((b & 2u) != 0u) { c = vec3f(0.9, 0.8, 0.1); }
      return c;
    }
    case 7u: {
      let b = mask[u32(p.y) * U.size.x + u32(p.x)];
      var c = tone(textureLoad(t_color, p, 0).rgb) * 0.3;
      if ((b & 1u) != 0u) { c += vec3f(0.0, 0.15, 0.0); }
      if ((b & 4u) != 0u) { c = vec3f(1.0, 0.15, 0.1); }
      return c;
    }
    default: {
      let mp = p >> vec2u(U.mip);
      let d = textureLoad(t_pyramid, clamp(mp, vec2i(0), vec2i(textureDimensions(t_pyramid, U.mip)) - 1), U.mip).x;
      return vec3f(pow(clamp(select(d, 1.0 - d, U.pad > 0.5), 0.0, 1.0), 40.0));
    }
  }
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  var k = U.view;
  var uv = fc.xy / U.canvas;
  if (k == 99u) {
    let cell = min(vec2u(uv * 3.0), vec2u(2u));
    k = cell.y * 3u + cell.x;
    uv = fract(uv * 3.0);
  }
  let p = vec2i(min(vec2u(uv * vec2f(U.size)), U.size - 1u));
  return vec4f(panel(k, p), 1.0);
}
`;

const VIEWS = ['grid', 'color', 'normal', 'roughness', 'radiance', 'composite', 'hit distance', 'ray list', 'misses', 'depth pyramid'];

async function main() {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no adapter');
  const want = (['subgroups', 'timestamp-query'] as GPUFeatureName[]).filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits: reflectionsRequiredLimits(adapter) });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU uncaptured error:', (e as GPUUncapturedErrorEvent).error.message));
  const hasSubgroups = device.features.has('subgroups' as GPUFeatureName);

  const W = Number(q.get('w') ?? 960), H = Number(q.get('h') ?? 540);
  const reverse = q.has('reverse');
  const forced = q.get('variant') as ScreenSpaceVariant | null;

  // ---- analytic inputs
  const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
  const mk = (label: string, format: GPUTextureFormat) => device.createTexture({ label, size: [W, H], format, usage });
  const depth = mk('depth', 'r32float'), normal = mk('normal', 'rgba16float');
  const material = mk('material', 'rgba8unorm'), color = mk('color', 'rgba16float');
  const view = lookAt([0, 1.7, 5.5], [0, 1.1, -6]);
  const projection = perspective((55 * Math.PI) / 180, W / H, 0.1, 100, reverse);
  const mul = (a: Float32Array, b: Float32Array) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
    return o;
  };
  const viewProj = mul(projection, view);
  const sceneU = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  {
    const d = new ArrayBuffer(160), f = new Float32Array(d), u = new Uint32Array(d);
    // invViewProj via a generic inverse (the core's helper is internal; this one is local)
    f.set(invert(viewProj), 0); f.set(viewProj, 16); f.set([0, 1.7, 5.5, 1], 32);
    u[36] = W; u[37] = H; u[38] = reverse ? 1 : 0; u[39] = q.has('allmirror') ? 1 : 0;
    device.queue.writeBuffer(sceneU, 0, d);
  }
  const scenePipe = device.createComputePipeline({ label: 'analytic scene', layout: 'auto', compute: { module: device.createShaderModule({ code: SCENE_WGSL }), entryPoint: 'main' } });
  const sceneGroup = device.createBindGroup({
    layout: scenePipe.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: sceneU } }, ...[depth, normal, material, color].map((t, i) => ({ binding: i + 1, resource: t.createView() }))],
  });
  {
    const enc = device.createCommandEncoder();
    const p = enc.beginComputePass(); p.setPipeline(scenePipe); p.setBindGroup(0, sceneGroup); p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
    device.queue.submit([enc.finish()]);
  }
  // The analytic targets described as the general frame contract (core/frame/contract.ts), then
  // mapped to the tracer's inputs. Roughness sits in the material's g channel; normals are raw floats.
  const motion = device.createTexture({ label: 'motion (still)', size: [W, H], format: 'rg16float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const frameInputs: FrameInputs = {
    width: W, height: H, frameIndex: 0,
    textures: {
      depth, normal, roughness: { texture: material, channel: 1 }, metalness: { texture: material, channel: 0 },
      albedo: material, motion, sceneColor: color,
    },
    conventions: {
      depthInverted: reverse, depthLinear: false, normalUnpackMul: 1, normalUnpackAdd: 0, roughnessIsPerceptual: true,
      motionVectorScale: [1, 1], sceneColorSpecular: 'none',
    },
    camera: {
      view, projection, prevView: view, prevProjection: projection, prevViewProjection: viewProj, jitter: [0, 0],
      near: 0.1, far: 100, position: [0, 1.7, 5.5], reversedDepth: reverse,
    },
  };
  const inputs: ScreenSpaceReflectionsInputs = screenSpaceInputsFromFrame(frameInputs, { depthInverted: reverse });
  const baseSettings: ScreenSpaceReflectionsSettings = { fallbackColor: [0.35, 0.45, 0.6] };

  // ?env: the radiance-fallback seam with a cube environment (a procedural sky, 32 px, 6 mips)
  // instead of the constant colour.
  let radianceFallback: RadianceFallback | undefined;
  if (q.has('env')) {
    const env = environmentRadianceFallback(device);
    const size = 32, mips = 6;
    const cube = device.createTexture({ size: [size, size, 6], format: 'rgba16float', mipLevelCount: mips, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const faceDir = (f: number, u: number, v: number) => [[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]][f];
    for (let m = 0; m < mips; m++) {
      const s = size >> m, data = new Uint16Array(s * s * 4);
      for (let f = 0; f < 6; f++) {
        for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
          const d = faceDir(f, ((x + 0.5) / s) * 2 - 1, ((y + 0.5) / s) * 2 - 1);
          const up = d[1] / Math.hypot(...d);
          const sun = Math.max(0, (-0.4 * d[0] + 0.8 * d[1] + 0.5 * d[2]) / Math.hypot(...d)) ** 32 * 8 / (1 + m);
          const c = up > 0 ? [0.3 + sun, 0.5 + sun, 1.0 + sun * 0.8] : [0.25, 0.2, 0.15];
          data.set([...c, 1].map(half), (y * s + x) * 4);
        }
        device.queue.writeTexture({ texture: cube, mipLevel: m, origin: [0, 0, f] }, data, { bytesPerRow: s * 8 }, [s, s, 1]);
      }
    }
    radianceFallback = env;
    inputs.fallbackBindGroup = env.createBindGroup(cube.createView({ dimension: 'cube' }));
  }

  // ---- tracers: the page's variant, plus the other one for parity when subgroups exist
  const make = (variant: ScreenSpaceVariant) => createScreenSpaceReflections(device, {
    width: W, height: H, variant, depthInverted: reverse, missList: true, timestamps: true, radianceFallback,
  });
  const main: ScreenSpaceReflections = make(forced ?? (hasSubgroups ? 'subgroups' : 'workgroup'));
  let other: ScreenSpaceReflections | undefined;
  const getOther = () => (other ??= make(main.variant === 'subgroups' ? 'workgroup' : 'subgroups'));

  // ---- debug + display
  const debugU = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(debugU, 0, new Uint32Array([W, H, 0, 0]));
  const mask = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.STORAGE });
  const debugModule = device.createShaderModule({ code: DEBUG_WGSL });
  const clearPipe = device.createComputePipeline({ layout: 'auto', compute: { module: debugModule, entryPoint: 'clear' } });
  const markPipe = device.createComputePipeline({ layout: 'auto', compute: { module: debugModule, entryPoint: 'mark' } });
  const o = main.outputs;
  const markGroup = device.createBindGroup({
    layout: markPipe.getBindGroupLayout(0),
    entries: [debugU, o.rayList, o.rayCounter, o.missList!, o.missCounter!, mask].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const clearGroup = device.createBindGroup({ layout: clearPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: debugU } }, { binding: 5, resource: { buffer: mask } }] });

  const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
  const ctx = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const displayModule = device.createShaderModule({ code: DISPLAY_WGSL });
  const displayPipe = device.createRenderPipeline({
    layout: 'auto', vertex: { module: displayModule, entryPoint: 'vs' },
    fragment: { module: displayModule, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' },
  });
  const displayU = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const displayGroup = device.createBindGroup({
    layout: displayPipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: displayU } },
      ...[color, normal, material, o.radiance, o.hitDistance, o.depthHierarchy].map((t, i) => ({ binding: i + 1, resource: t.createView() })),
      { binding: 7, resource: { buffer: mask } }, { binding: 8, resource: { buffer: o.tileFlags } },
    ],
  });

  let viewIndex = 0, pyramidMip = 2;
  let settings: ScreenSpaceReflectionsSettings = { ...baseSettings };

  function frame(extra: ScreenSpaceReflectionsSettings = {}) {
    const enc = device.createCommandEncoder({ label: 'sssr-core frame' });
    main.dispatch(enc, inputs, { ...settings, ...extra });
    const n = Math.ceil((W * H) / 64), gx = Math.min(n, 65535), gy = Math.ceil(n / gx);
    let p = enc.beginComputePass(); p.setPipeline(clearPipe); p.setBindGroup(0, clearGroup); p.dispatchWorkgroups(gx, gy); p.end();
    p = enc.beginComputePass(); p.setPipeline(markPipe); p.setBindGroup(0, markGroup); p.dispatchWorkgroups(gx, gy); p.end();
    const vu = new ArrayBuffer(32), vf = new Float32Array(vu), vi = new Uint32Array(vu);
    vi[0] = W; vi[1] = H; vi[2] = viewIndex === 0 ? 99 : viewIndex - 1; vi[3] = Math.min(pyramidMip, main.mipCount - 1);
    vf[4] = canvas.width; vf[5] = canvas.height; vf[6] = (settings.roughnessThreshold ?? DEFAULT_ROUGHNESS_THRESHOLD) ** 2; // alpha, as the tracer compares vf[7] = reverse ? 1 : 0;
    device.queue.writeBuffer(displayU, 0, vu);
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    rp.setPipeline(displayPipe); rp.setBindGroup(0, displayGroup); rp.draw(3); rp.end();
    device.queue.submit([enc.finish()]);
  }

  // ---- readback helpers
  async function readBuffer(b: GPUBuffer, size = b.size): Promise<ArrayBuffer> {
    const r = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(b, 0, r, 0, size); device.queue.submit([enc.finish()]);
    await r.mapAsync(GPUMapMode.READ);
    const out = r.getMappedRange().slice(0); r.destroy();
    return out;
  }
  async function readTexture(t: GPUTexture, mip = 0): Promise<Uint8Array> {
    const bpp = { rgba16float: 8, r32float: 4, rgba8unorm: 4 }[t.format as string] ?? 4;
    const w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip);
    const row = Math.ceil((w * bpp) / 256) * 256;
    const r = device.createBuffer({ size: row * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: t, mipLevel: mip }, { buffer: r, bytesPerRow: row }, [w, h]);
    device.queue.submit([enc.finish()]);
    await r.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(r.getMappedRange()), out = new Uint8Array(w * h * bpp);
    for (let y = 0; y < h; y++) out.set(src.subarray(y * row, y * row + w * bpp), y * w * bpp);
    r.unmap(); r.destroy();
    return out;
  }
  const u32 = (b: ArrayBuffer, n?: number) => new Uint32Array(b, 0, n);

  /** Everything one dispatch produced, lists cut to their counts. */
  async function capture(s: ScreenSpaceReflections) {
    const o = s.outputs;
    const counter = u32(await readBuffer(o.rayCounter));
    const missCounter = u32(await readBuffer(o.missCounter!));
    const rays = u32(await readBuffer(o.rayList), counter[1]);
    const tiles = u32(await readBuffer(o.denoiserTileList), counter[3]);
    const missRaw = u32(await readBuffer(o.missList!), missCounter[1] * 2);
    const misses = Array.from({ length: missCounter[1] }, (_, i) => `${missRaw[2 * i]}:${missRaw[2 * i + 1]}`);
    const pyramid: Uint8Array[] = [];
    for (let m = 0; m < s.mipCount; m++) pyramid.push(await readTexture(o.depthHierarchy, m));
    return {
      counter: Array.from(counter), missCounter: Array.from(missCounter), rays, tiles, misses,
      tileFlags: u32(await readBuffer(o.tileFlags)), radiance: await readTexture(o.radiance), hit: await readTexture(o.hitDistance),
      roughness: await readTexture(o.extractedRoughness), blueNoise: await readTexture(o.blueNoise), pyramid,
    };
  }
  const sameSorted = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    if (a.length !== b.length) return false;
    const x = Array.from(a).sort((p, q) => p - q), y = Array.from(b).sort((p, q) => p - q);
    return x.every((v, i) => v === y[i]);
  };
  const bytesDiff = (a: Uint8Array, b: Uint8Array, stride = 1) => {
    let n = 0;
    for (let i = 0; i < a.length; i += stride) { for (let k = 0; k < stride; k++) if (a[i + k] !== b[i + k]) { n++; break; } }
    return a.length === b.length ? n : -1;
  };

  /** Run both variants on the same frame and compare. */
  async function parity(extra: ScreenSpaceReflectionsSettings = {}) {
    if (!hasSubgroups) return { skipped: 'device has no subgroups feature' };
    const b = getOther();
    const s = { ...settings, frameIndex: 7, ...extra };
    const enc = device.createCommandEncoder();
    main.dispatch(enc, inputs, s);
    b.dispatch(enc, inputs, s);
    device.queue.submit([enc.finish()]);
    const A = await capture(main), B = await capture(b);
    const res = {
      variants: [main.variant, b.variant],
      settings: { minTraversalOccupancy: s.minTraversalOccupancy ?? 4, samplesPerQuad: s.samplesPerQuad ?? 1 },
      rays: [A.counter[1], B.counter[1]], tiles: [A.counter[3], B.counter[3]], misses: [A.missCounter[1], B.missCounter[1]],
      rayListSame: A.counter[1] === B.counter[1] && sameSorted(A.rays, B.rays),
      tileListSame: A.counter[3] === B.counter[3] && sameSorted(A.tiles, B.tiles),
      tileFlagsSame: sameSorted(A.tileFlags, B.tileFlags) && A.tileFlags.every((v, i) => v === B.tileFlags[i]),
      missListSame: A.misses.length === B.misses.length && [...A.misses].sort().join() === [...B.misses].sort().join(),
      radianceDiffPixels: bytesDiff(A.radiance, B.radiance, 8),
      hitDiffPixels: bytesDiff(A.hit, B.hit, 4),
      roughnessDiffPixels: bytesDiff(A.roughness, B.roughness, 4),
      pyramidDiffTexels: A.pyramid.reduce((n, m, i) => n + bytesDiff(m, B.pyramid[i], 4), 0),
      blueNoiseDiff: bytesDiff(A.blueNoise, B.blueNoise, 4),
    };
    frame();
    return res;
  }

  /**
   * W71 (X1): the same frame dispatched with settings `a`, then with `b` (frameIndex 7, occupancy 0
   * unless given), lists compared sorted and images bit for bit. A setting at its default must give
   * no difference against the setting absent.
   */
  async function identity(a: ScreenSpaceReflectionsSettings = {}, b: ScreenSpaceReflectionsSettings = {}) {
    const base = { ...settings, frameIndex: 7, minTraversalOccupancy: 0 };
    const run = async (x: ScreenSpaceReflectionsSettings) => {
      const enc = device.createCommandEncoder();
      main.dispatch(enc, inputs, { ...base, ...x });
      device.queue.submit([enc.finish()]);
      return capture(main);
    };
    const A = await run(a), B = await run(b);
    frame();
    return {
      rays: [A.counter[1], B.counter[1]], misses: [A.missCounter[1], B.missCounter[1]],
      listsSame: A.counter[1] === B.counter[1] && sameSorted(A.rays, B.rays) && sameSorted(A.tiles, B.tiles) &&
        A.misses.length === B.misses.length && [...A.misses].sort().join() === [...B.misses].sort().join(),
      radianceDiffPixels: bytesDiff(A.radiance, B.radiance, 8), hitDiffPixels: bytesDiff(A.hit, B.hit, 4),
    };
  }
  /** W71 (X1 #1): which quad corner the rays that carry copies trace from, as counts [tl, tr, bl, br], for one frame. */
  async function quadCorners(extra: ScreenSpaceReflectionsSettings = {}) {
    const enc = device.createCommandEncoder();
    main.dispatch(enc, inputs, { ...settings, minTraversalOccupancy: 0, ...extra });
    device.queue.submit([enc.finish()]);
    const A = await capture(main);
    const n = [0, 0, 0, 0];
    let copies = 0;
    for (const r of A.rays) {
      const f = r >>> 29;
      if (!f) continue;
      copies += ((f & 1) + ((f >> 1) & 1) + ((f >> 2) & 1));
      n[(r & 1) + 2 * ((r >>> 15) & 1)]++;
    }
    frame();
    return { corners: n, copies, rays: A.counter[1] };
  }

  /** Ray, tile and miss counts and the hit fraction on the mirror floor (id 1) for one frame. */
  async function stats(extra: ScreenSpaceReflectionsSettings = {}) {
    frame(extra);
    const A = await capture(main);
    const mat = await readTexture(material);
    const hit = new Float32Array(A.hit.buffer);
    const rough = new Float32Array(A.roughness.buffer);
    let mirror = 0, mirrorHit = 0, ramp = 0, rampTraced = 0;
    const traced = new Uint8Array(W * H);
    for (const r of A.rays) {
      const x = r & 32767, y = (r >>> 15) & 16383;
      traced[y * W + x] = 1;
      if ((r >>> 29) & 1) traced[y * W + (x ^ 1)] = 1;
      if ((r >>> 30) & 1) traced[(y ^ 1) * W + x] = 1;
      if ((r >>> 31) & 1) traced[(y ^ 1) * W + (x ^ 1)] = 1;
    }
    let maxRough = 0, minUntraced = Infinity;
    for (let i = 0; i < W * H; i++) {
      const id = mat[i * 4 + 3];
      if (id === 1) { mirror++; if (hit[i] > 0) mirrorHit++; }
      if (id === 2) { ramp++; if (traced[i]) rampTraced++; }
      if (traced[i]) maxRough = Math.max(maxRough, rough[i]);
      else if (id === 2) {
        // only the quad's base pixel (FFX's spq-1 base ray, x and y even), and only in quads that are all
        // ramp: a glossy pixel whose base pixel is rough or another surface gets no ray to share (as in FFX)
        const x = i % W, y = Math.floor(i / W);
        const allRamp = x + 1 < W && y + 1 < H && mat[(i + 1) * 4 + 3] === 2 && mat[(i + W) * 4 + 3] === 2 && mat[(i + W + 1) * 4 + 3] === 2;
        if ((x & 1) === 0 && (y & 1) === 0 && allRamp) minUntraced = Math.min(minUntraced, rough[i]);
      }
    }
    return {
      variant: main.variant, size: [W, H], mipCount: main.mipCount, rays: A.counter[1], tiles: A.counter[3],
      misses: A.missCounter[1], missDropped: A.missCounter[3],
      mirrorPixels: mirror, mirrorHitFraction: mirror ? mirrorHit / mirror : 0,
      rampPixels: ramp, rampTracedFraction: ramp ? rampTraced / ramp : 0, maxTracedRoughness: maxRough,
      /** The threshold in the tracer's units (alpha), and the smallest untraced reflective alpha above it. */
      thresholdAlpha: (settings.roughnessThreshold ?? DEFAULT_ROUGHNESS_THRESHOLD) ** 2, minUntracedRampRoughness: minUntraced,
    };
  }

  /**
   * `fallbackRoughness` 'mirror' vs 'surface' (D1806, use with ?env). The reference is the lookup at
   * the pixel's own roughness along its mirror direction: a dispatch with roughnessThreshold 0 sends
   * every pixel down the rough path. iblFactor 0 isolates the hit part (confidence x hit), so for any
   * confidence the expected 'surface' radiance is (1 - c) ref + that. Distances are per channel in
   * the page's display tone (0-255), over traced floor pixels.
   */
  async function fallbackRoughness() {
    const base = { ...settings, frameIndex: 7, minTraversalOccupancy: 0, hitShading: 'off' as const }; // hits as the screen colour (W44): the check isolates the fallback
    const run = async (s: ScreenSpaceReflectionsSettings) => {
      const enc = device.createCommandEncoder();
      main.dispatch(enc, inputs, { ...base, ...s });
      device.queue.submit([enc.finish()]);
      const counter = u32(await readBuffer(main.outputs.rayCounter));
      return {
        rad: await readTexture(main.outputs.radiance), conf: new Float32Array((await readTexture(main.outputs.confidence)).buffer),
        rough: new Float32Array((await readTexture(main.outputs.extractedRoughness)).buffer), rays: u32(await readBuffer(main.outputs.rayList), counter[1]),
      };
    };
    const ref = await run({ roughnessThreshold: 0 });
    const zero = await run({ iblFactor: 0 });
    const mir = await run({ fallbackRoughness: 'mirror' });
    const sur = await run({ fallbackRoughness: 'surface' });
    const mat = await readTexture(material);
    const traced = new Uint8Array(W * H);
    for (const r of mir.rays) {
      const x = r & 32767, y = (r >>> 15) & 16383;
      traced[y * W + x] = 1;
      if ((r >>> 29) & 1) traced[y * W + (x ^ 1)] = 1;
      if ((r >>> 30) & 1) traced[(y ^ 1) * W + x] = 1;
      if ((r >>> 31) & 1) traced[(y ^ 1) * W + (x ^ 1)] = 1;
    }
    const h16 = (b: Uint8Array) => new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
    const R = h16(ref.rad), Z = h16(zero.rad), M = h16(mir.rad), S = h16(sur.rad);
    const tone = (c: number) => 255 * Math.pow(Math.max(c, 0) / (1 + Math.max(c, 0)), 1 / 2.2);
    const groups = { mirror: [] as number[], surface: [] as number[] }, partial = { mirror: [] as number[], surface: [] as number[] };
    let misses = 0, partials = 0, mirrors = 0, mirrorsDiffer = 0, confident = 0, confidentDiffer = 0;
    const same = (i: number) => M[i * 4] === S[i * 4] && M[i * 4 + 1] === S[i * 4 + 1] && M[i * 4 + 2] === S[i * 4 + 2] && M[i * 4 + 3] === S[i * 4 + 3];
    for (let i = 0; i < W * H; i++) {
      const id = mat[i * 4 + 3];
      if (!traced[i] || (id !== 1 && id !== 2)) continue;
      const c = mir.conf[i];
      if (mir.rough[i] < 0.0001) { mirrors++; if (!same(i)) mirrorsDiffer++; continue; }
      if (c >= 1) { confident++; if (!same(i)) confidentDiffer++; continue; }
      const into = c > 0 ? partial : groups;
      if (c > 0) partials++; else misses++;
      for (let k = 0; k < 3; k++) {
        const want = tone((1 - c) * f16(R[i * 4 + k]) + f16(Z[i * 4 + k]));
        into.mirror.push(Math.abs(tone(f16(M[i * 4 + k])) - want));
        into.surface.push(Math.abs(tone(f16(S[i * 4 + k])) - want));
      }
    }
    const sum = (a: number[]) => {
      if (!a.length) return { mean: 0, p99: 0, max: 0 };
      const s = Float64Array.from(a).sort();
      return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p99: +s[Math.floor(0.99 * (s.length - 1))].toFixed(3), max: +s[s.length - 1].toFixed(3) };
    };
    frame();
    return {
      misses, partials, mirrors, mirrorsDiffer, confident, confidentDiffer,
      missMirror: sum(groups.mirror), missSurface: sum(groups.surface), partialMirror: sum(partial.mirror), partialSurface: sum(partial.surface),
    };
  }

  /** Median GPU ms per pass over n on-demand frames (each submitted and awaited alone). */
  async function time(n = 20) {
    const runs: Record<string, number[]> = {};
    for (let i = 0; i < n; i++) {
      const enc = device.createCommandEncoder();
      main.dispatch(enc, inputs, settings);
      device.queue.submit([enc.finish()]);
      const t = await main.readTimings();
      await device.queue.onSubmittedWorkDone();
      for (const [k, v] of t) (runs[k] ??= []).push(v);
    }
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return { variant: main.variant, size: [W, H], frames: n, ms: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, +med(v).toFixed(4)])) };
  }

  // ---- controls
  const controls = document.querySelector('#controls')!;
  const sel = document.createElement('select');
  VIEWS.forEach((v, i) => sel.add(new Option(v, String(i))));
  sel.onchange = () => { viewIndex = Number(sel.value); frame(); };
  const lbl = document.createElement('label'); lbl.append('view ', sel); controls.append(lbl);
  const spq = document.createElement('select');
  for (const v of [1, 2, 4]) spq.add(new Option(String(v), String(v)));
  spq.onchange = () => { settings.samplesPerQuad = Number(spq.value) as 1 | 2 | 4; frame(); };
  const lbl2 = document.createElement('label'); lbl2.append('samples per quad ', spq); controls.append(lbl2);
  const fi = document.createElement('input'); fi.type = 'range'; fi.min = '0'; fi.max = '255'; fi.value = '0';
  fi.oninput = () => { settings.frameIndex = Number(fi.value); frame(); };
  const lbl3 = document.createElement('label'); lbl3.append('frame index ', fi); controls.append(lbl3);

  frame({ frameIndex: 0 });
  const st = await stats({ frameIndex: 0 });
  setStatus(`variant ${main.variant} (subgroups ${hasSubgroups ? 'available' : 'not available'}), ${W}x${H}, ${main.mipCount} depth mips${reverse ? ', reverse-Z' : ''}\n` +
    `rays ${st.rays}, denoiser tiles ${st.tiles}, misses ${st.misses}; mirror-floor hit fraction ${(st.mirrorHitFraction * 100).toFixed(1)}%`);

  (window as unknown as { __p: unknown }).__p = {
    device, main, hasSubgroups, parity, stats, time, fallbackRoughness, identity, quadCorners,
    render: (s: ScreenSpaceReflectionsSettings = {}) => { settings = { ...baseSettings, ...s }; frame(); return true; },
    setView: (name: string) => { viewIndex = Math.max(0, VIEWS.indexOf(name)); frame(); return true; },
    setMip: (m: number) => { pyramidMip = m; frame(); return true; },
    shot: async () => { await device.queue.onSubmittedWorkDone(); frame(); await device.queue.onSubmittedWorkDone(); return canvas.toDataURL('image/png'); },
  };
}

/** f16 bits -> number. */
function f16(h: number): number {
  const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** f32 -> f16 bits (round to nearest, no denormals; enough for a test sky). */
function half(v: number): number {
  const f = new Float32Array([v]), u = new Uint32Array(f.buffer)[0];
  const sign = (u >>> 16) & 0x8000, e = ((u >>> 23) & 0xff) - 127 + 15, m = u & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | ((m + 0x1000) >>> 13);
}

function invert(m: Float32Array): Float32Array {
  // Gauss-Jordan on a row-major copy; plenty for an example.
  const a = Array.from({ length: 4 }, (_, r) => Array.from({ length: 8 }, (_, c) => (c < 4 ? m[c * 4 + r] : c - 4 === r ? 1 : 0)));
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c]; for (let k = 0; k < 8; k++) a[c][k] /= d;
    for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r][c]; for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k]; }
  }
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = a[r][c + 4];
  return o;
}

main().catch((e) => { console.error(e); setStatus(`error: ${e?.message ?? e}`); });
