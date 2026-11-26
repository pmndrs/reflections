// W86: NRC (pmndrs/pathtracer's bench-only hash radiance cache) as the hit shading of ray-traced mirror reflections, against
// the default (probes) and rtShade, with a path-traced reference. Experimental, examples only; nothing in packages/ changes.
//
// What runs: the pathtracer bench's own consumer kernel (`bench/nrc/reflection-consumer-wgsl.ts`: primary ray -> one mirror
// bounce -> the receiver is shaded) on core's `createRaytracerTraceProvider`, once per method:
//   probes   core `probeHitShading` over a `ProbeSet` baked from the traced scene (an IDEAL bake: path-traced radiance at the
//            probe, so it is the best case of the default, not three's rasterised bake)
//   rtshade  core `raytracerHitShading` (traceHitShade: emission + one light sample + shadow ray; no indirect)
//   nrc      the bench consumer: full direct at the hit + the hash cache's strict indirect (the cache trains every frame)
//   nrc-frozen   the same lookups with training stopped (separates cache learning from lookup flicker)
//   traced   full direct + the strict indirect traced (no cache): the cache's own target, as a quality bound
// The sibling's modules are resolved by examples/vite.config.ts (`__NRC_AVAILABLE__`); without it the page is a notice.

import { createRaytracerTraceProvider, HIT_WGSL, ProbeSet, probeHitShading, raytracerHitShading } from '@pmndrs/reflections/core';
import * as bvh from '@pmndrs/bvh';
import { Accumulator, drift, SecondDifference } from '../../shared/metrics/stats';

const status = document.getElementById('status')!;
const say = (s: string) => { status.textContent += '\n' + s; console.log(s); };
const win = window as unknown as { __p: Record<string, unknown> };

export type Arm = 'probes' | 'rtshade' | 'nrc' | 'nrc-frozen' | 'traced';
const ARMS: Arm[] = ['probes', 'rtshade', 'nrc', 'nrc-frozen', 'traced'];
const OUT = 20; // words per pixel of the consumer's output (5 vec4)

// The bench kernel's two bench-owned seams, patched here (not in the sibling): a training stride (train 1 pixel in N, hashed
// per frame) and ray counting for the training dispatch (count[2]; count is 4 words, the grid uses 0 and 1).
function consumerWgsl(consumerWgslFn: (env: boolean) => string, env: boolean) {
  let code = consumerWgslFn(env);
  const a = 'let train = frame.options.x == 0u;';
  const b = 'rcStoreRecord(p, rcSuffix(p, seed, maxBounces, false).indirect, pixel);';
  if (!code.includes(a) || !code.includes(b)) throw new Error('the pathtracer sibling changed its consumer kernel (seams not found)');
  code = code.replace(a, a + '\n  if (train && frame.options.z > 1u && (rcHash(pixel * 2246822519u + frame.dims.z * 3266489917u) % frame.options.z) != 0u) { return; }');
  code = code.replace(b, 'let ts = rcSuffix(p, seed, maxBounces, false); rcStoreRecord(p, ts.indirect, pixel); atomicAdd(&count[2], 2u + ts.continuationRays + ts.shadowRays);');
  return code;
}

// Ideal probe bake: path-traced radiance (mirror chains followed, first diffuse hit: emission + direct + strict indirect) per cube texel.
const CAPTURE_WGSL = /* wgsl */ `
struct CapU { origin: vec4f, info: vec4u } // info: size, seed, spp, bounces
@group(0) @binding(0) var<uniform> cu: CapU;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
fn traceLightVisible(P: vec3f, N: vec3f, L: vec3f, tMax: f32) -> bool { return !traceAny(rtOffsetOrigin(P, rtSideNormal(N, L)), L, tMax); }
fn rtHitSpecularOn() -> bool { return true; }
fn faceDirUV(face: u32, u: f32, v: f32) -> vec3f {
  switch face {
    case 0u: { return vec3( 1.0, -v, -u); } case 1u: { return vec3(-1.0, -v,  u); }
    case 2u: { return vec3( u,  1.0,  v); } case 3u: { return vec3( u, -1.0, -v); }
    case 4u: { return vec3( u, -v,  1.0); } default: { return vec3(-u, -v, -1.0); }
  }
}
fn captureRadiance(o: vec3f, d: vec3f, seed: u32) -> vec3f {
  var origin = o; var dir = d; var beta = vec3f(1.0);
  for (var b = 0u; b < 4u; b++) {
    let h = traceFirstHit(origin, dir, 1e30);
    if (h.t < 0.0) { return beta * rtShadeMiss(dir); }
    let p = rtShadePoint(rtpRtHit(h), RtRay(origin, 0.0, dir, h.t));
    if (rcMirror(p)) {
      beta *= rcMirrorWeight(p);
      dir = reflect(dir, p.normal);
      origin = rtOffsetOrigin(p.position, rtSideNormal(p.geometricNormal, dir));
      continue;
    }
    return beta * (rtShadeEmission(p) + rcDirect(p, seed, 2u).direct + rcSuffix(p, seed, cu.info.w, false).indirect);
  }
  return vec3f(0.0);
}
@compute @workgroup_size(8, 8, 1)
fn capture(@builtin(global_invocation_id) id: vec3u) {
  let n = cu.info.x;
  if (id.x >= n || id.y >= n) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(n) * 2.0 - 1.0;
  let dir = normalize(faceDirUV(id.z, uv.x, uv.y));
  var sum = vec3f(0.0);
  for (var s = 0u; s < cu.info.z; s++) {
    let seed = rcHash(((id.z * n + id.y) * n + id.x) * 2654435761u + (cu.info.y + s) * 0x68bc21ebu);
    let r = captureRadiance(cu.origin.xyz, dir, seed);
    sum += min(r, vec3f(64.0));
  }
  textureStore(dst, id.xy, id.z, vec4f(sum / f32(cu.info.z), 1.0));
}
`;

const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const lumLin = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

async function setup() {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const [hashMod, consumerMod, transportMod, metricsMod, localityMod, sceneMod, geomMod, pt, rt] = await Promise.all([
    import('@nrc-bench/nrc/hash-grid.ts'), import('@nrc-bench/nrc/reflection-consumer-wgsl.ts'), import('@nrc-bench/nrc/reflection-transport.ts'),
    import('@nrc-bench/metrics/metrics.ts'), import('@nrc-bench/scenes/tier2/nrc-locality.ts'), import('@nrc-bench/scenes/to-scene-copy.ts'),
    import('@nrc-bench/scenes/geometry.ts'), import('@pmndrs/pathtracer'), import('@pmndrs/raytracer'),
  ]) as any[];
  const { HashGrid } = hashMod, { reflectionConsumerWgsl } = consumerMod, { REFLECTION_TRANSPORT_WGSL } = transportMod;
  const { compareImages } = metricsMod, { movingCardFixture, thinWallFixture } = localityMod, { sceneDescToCopyInput } = sceneMod, { identity } = geomMod;
  const { PtMegakernel, ptCameraBasis } = pt, { detectCaps, requestDeviceForCaps, sceneFormatOf } = rt;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No usable GPU');
  const { device, caps } = await requestDeviceForCaps(adapter, detectCaps(adapter), { label: 'nrc' });
  const deviceErrors: string[] = [];
  device.addEventListener('uncapturederror', (e: GPUUncapturedErrorEvent) => deviceErrors.push(e.error.message));
  return { HashGrid, reflectionConsumerWgsl, REFLECTION_TRANSPORT_WGSL, compareImages, movingCardFixture, thinWallFixture, sceneDescToCopyInput, identity, PtMegakernel, ptCameraBasis, rt, device, caps, sceneFormatOf, deviceErrors };
}
type Lib = Awaited<ReturnType<typeof setup>>;

interface View { tag: string; camera: any; crop: [number, number, number, number] }
interface Options { res?: [number, number]; spp?: number; refSpp?: number; warm?: number; stride?: number; history?: number; probeZ?: number }

/** One fixture on the GPU: provider, reference tracer, hash grid, the five methods, probes. */
async function createRig(L: Lib, name: 'mirror' | 'thin' | 'cut' | 'moving', o: Required<Options>) {
  const { device } = L;
  const [width, height] = o.res;
  const pixels = width * height;
  const thin = name === 'thin' || name === 'cut';
  const fixture = thin ? L.thinWallFixture(width, height, 0.008) : L.movingCardFixture(width, height);
  const scene = (() => {
    const s = fixture.scene; const metal = s.materials.metal;
    return { ...s, integrator: { maxDepth: s.integrator.maxDepth }, materials: { ...s.materials, metal: { ...metal, roughness: 0 } } };
  })();
  const cardInstance = scene.meshes.findIndex((m: any) => m.name === 'moving-card');
  const views: View[] = name === 'mirror'
    ? [{ tag: 'offscreen', camera: { ...scene.camera, target: [-0.66, -0.46, -1.36], yFovDeg: 7 }, crop: [0.12, 0.12, 0.88, 0.88] }]
    : thin ? fixture.views.map((v: any) => ({ ...v, crop: [0.16, 0.82, 0.84, 0.97] })) : fixture.views;
  const input = L.sceneDescToCopyInput(scene);
  const provider = await createRaytracerTraceProvider(device, {
    meshes: input.meshes,
    instances: input.instances.map((i: any) => ({ mesh: i.meshIndex, matrixWorld: i.objectToWorld, material: i.material })),
    materials: input.materials.map((openpbr: any) => ({ albedo: openpbr.baseColor ?? [0.5, 0.5, 0.5], openpbr })),
    lights: { sun: input.sun, environment: input.environment },
  } as any, { module: L.rt, bvhModule: bvh, shade: { envSampling: 'cosine' }, minify: false } as any);

  const grid = await L.HashGrid.create(device, { log2Entries: 15, minSamples: 16, cellPixels: 4, fallbackLevels: 2, pyramid: true, historyFrames: o.history }, { yFovDeg: views[0].camera.yFovDeg, filmHeight: height });
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const frameData = new ArrayBuffer(96);
  const frameFloats = new Float32Array(frameData, 0, 16), frameInts = new Uint32Array(frameData, 64);
  const params = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: pixels * OUT * 4, usage: S });
  const records = device.createBuffer({ size: pixels * 64, usage: S });
  const count = device.createBuffer({ size: 16, usage: S });
  const staging = device.createBuffer({ size: output.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const countStaging = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  grid.bindRecords(records, count, pixels);

  // shadings
  const hook = grid.displayHook;
  const C = GPUShaderStage.COMPUTE;
  const ioLayout = device.createBindGroupLayout({ entries: [0, 1, 2, 3].map((binding) => ({ binding, visibility: C, buffer: { type: binding === 0 ? 'uniform' : 'storage' } })) });
  const providerLayout = device.createBindGroupLayout({ entries: provider.entries.map((entry: any, binding: number) => ({ ...entry, binding })) });
  const emptyLayout = device.createBindGroupLayout({ entries: [] });
  const cacheLayout = device.createBindGroupLayout({ entries: hook.bindings });
  const ioGroup = device.createBindGroup({ layout: ioLayout, entries: [params, output, records, count].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const providerGroup = () => device.createBindGroup({ layout: providerLayout, entries: provider.resources().map((resource: any, binding: number) => ({ binding, resource })) });
  let sceneGroup = providerGroup();
  const cacheGroup = device.createBindGroup({ layout: cacheLayout, entries: hook.entries });
  const rtShading = raytracerHitShading(device, { samples: 1 });

  // probes: an ideal bake at the current scene state. thin / cut: one probe per side of the partition.
  const probeSize = 128;
  const b = fixture.bounds;
  const probeSpecs = thin
    ? [{ slot: 0, o: [0, 1.2, o.probeZ], lo: [-4, 0, 0], hi: [4, 3, 4] }, { slot: 1, o: [0, 1.2, -o.probeZ], lo: [-4, 0, -4], hi: [4, 3, 0] }]
    : [{ slot: 0, o: [0, 1.2, -0.9], lo: [b.min[0], 0, -1.72], hi: [b.max[0], 3, b.max[2]] }];
  const probeSet = new ProbeSet(device, { capacity: probeSpecs.length, sourceSize: probeSize, environment: false });
  probeSet.setVolumes(probeSpecs.map((p) => ({
    slot: p.slot, center: p.lo.map((v, i) => (v + p.hi[i]) / 2) as [number, number, number], halfSize: p.lo.map((v, i) => (p.hi[i] - v) / 2) as [number, number, number],
    fade: 0.002, boxProjection: true, origin: p.o as [number, number, number],
  })));
  probeSet.update();
  const probeShading = probeHitShading(device, probeSet);
  probeShading.setLighting(1, {});
  const probeGroup = probeShading.createBindGroup({ atlas: probeSet.atlasView, sampler: probeSet.sampler, table: probeSet.table, atlases: probeSet.atlasViews.slice(1) });

  const compile = async (label: string, code: string, g3: GPUBindGroupLayout) => {
    const module = device.createShaderModule({ code, label });
    const errs = (await module.getCompilationInfo()).messages.filter((m: any) => m.type === 'error');
    if (errs.length) throw new Error(`${label}: ` + errs.map((d: any) => `${d.lineNum}:${d.linePos} ${d.message}`).join('\n'));
    return device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [ioLayout, providerLayout, emptyLayout, g3] }), compute: { module, entryPoint: 'renderConsumer' } });
  };
  const pre = [HIT_WGSL, provider.code({ group: 1, firstBinding: 0 }), L.REFLECTION_TRANSPORT_WGSL];
  const [nrcPipe, rtPipe, probePipe] = await Promise.all([
    compile('nrc', [...pre, hook.wgsl, consumerWgsl(L.reflectionConsumerWgsl, false)].join('\n'), cacheLayout),
    compile('rtshade', [...pre, rtShading.wgsl, consumerWgsl(L.reflectionConsumerWgsl, true)].join('\n'), rtShading.layout!),
    compile('probes', [...pre, probeShading.wgsl, consumerWgsl(L.reflectionConsumerWgsl, true)].join('\n'), probeShading.layout!),
  ]);
  const armSetup: Record<Arm, { pipe: GPUComputePipeline; g3: GPUBindGroup; mode: number }> = {
    probes: { pipe: probePipe, g3: probeGroup, mode: 2 },
    rtshade: { pipe: rtPipe, g3: rtShading.bindGroup, mode: 2 },
    nrc: { pipe: nrcPipe, g3: cacheGroup, mode: 1 },
    'nrc-frozen': { pipe: nrcPipe, g3: cacheGroup, mode: 1 },
    traced: { pipe: nrcPipe, g3: cacheGroup, mode: 2 },
  };

  // probe bake pipeline
  const capLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: C, buffer: { type: 'uniform' } }, { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } }] });
  const capPipe = await (async () => {
    const code = [...pre, CAPTURE_WGSL].join('\n');
    const module = device.createShaderModule({ code, label: 'probe capture' });
    const errs = (await module.getCompilationInfo()).messages.filter((m: any) => m.type === 'error');
    if (errs.length) throw new Error('capture: ' + errs.map((d: any) => `${d.lineNum}:${d.linePos} ${d.message}`).join('\n'));
    return device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [capLayout, providerLayout] }), compute: { module, entryPoint: 'capture' } });
  })();
  /** Bake every probe from the scene as it is now. Returns the traced rays it cost (estimate: texels x spp x ~(1 + 1 shadow + 5 x 2)). */
  async function bakeProbes(spp = 16, seed = 1) {
    for (const p of probeSpecs) {
      const cube = device.createTexture({ size: [probeSize, probeSize, 6], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      const u = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const data = new ArrayBuffer(32);
      new Float32Array(data, 0, 4).set([...p.o, 0]); new Uint32Array(data, 16, 4).set([probeSize, seed, spp, scene.integrator.maxDepth - 1]);
      device.queue.writeBuffer(u, 0, data);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass(); pass.setPipeline(capPipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: capLayout, entries: [{ binding: 0, resource: { buffer: u } }, { binding: 1, resource: cube.createView({ dimension: '2d-array' }) }] }));
      pass.setBindGroup(1, sceneGroup);
      pass.dispatchWorkgroups(probeSize / 8, probeSize / 8, 6); pass.end();
      probeSet.capture(enc, p.slot, cube);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      cube.destroy(); u.destroy();
    }
    return probeSpecs.length * 6 * probeSize * probeSize * spp * 12;
  }

  // reference path tracer
  const pt = await L.PtMegakernel.create(device, L.caps, {
    format: L.sceneFormatOf(provider.traceBuffers), layout: provider.sceneCopy.layout, scenePacking: (provider.sceneCopyBuffers as any).packing, integrator: { counters: true },
  });
  pt.setFilm(width, height); pt.setLimits(scene.integrator);

  let frameNo = 0;
  function dispatch(view: View, arm: Arm, mode: number, seed: number, clear: boolean, stride = 0) {
    const basis = L.ptCameraBasis(view.camera, width, height);
    frameFloats.set([...basis.origin, 0, ...basis.right, 0, ...basis.up, 0, ...basis.forward, 0]);
    frameInts.set([width, height, seed >>> 0, scene.integrator.maxDepth, mode, cardInstance >>> 0, stride, 0]);
    device.queue.writeBuffer(params, 0, frameData);
    const a = armSetup[arm];
    if (arm === 'rtshade') rtShading.setFrame(seed);
    const enc = device.createCommandEncoder();
    if (clear) enc.clearBuffer(output);
    if (mode === 0) enc.clearBuffer(count);
    const pass = enc.beginComputePass(); pass.setPipeline(a.pipe);
    pass.setBindGroup(0, ioGroup); pass.setBindGroup(1, sceneGroup); pass.setBindGroup(3, a.g3);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    if (mode === 0) { grid.encodeUpdate(enc); enc.copyBufferToBuffer(count, 0, countStaging, 0, 16); }
    device.queue.submit([enc.finish()]);
  }

  /** One training frame of the cache at `view` (a pixel stride `stride`); returns rays per pixel of the full frame. */
  async function trainFrame(view: View, stride = o.stride) {
    grid.setCameraPosition(view.camera.position);
    dispatch(view, 'nrc', 0, 7371 + frameNo++, false, stride);
    await countStaging.mapAsync(GPUMapMode.READ);
    const w = new Uint32Array(countStaging.getMappedRange().slice(0)); countStaging.unmap();
    return { raysPerPixel: w[2] / pixels, records: w[1] };
  }

  /** Mean over `spp` dispatches. `rgb`: linear RGBA (alpha 1); `rays`: per pixel per sample, counted in the kernel plus the analytic hit-shading rays. */
  async function render(view: View, arm: Arm, spp: number, seedBase: number) {
    grid.setCameraPosition(view.camera.position);
    const a = armSetup[arm];
    for (let n = 0; n < spp; n++) dispatch(view, arm, a.mode, seedBase * 1024 + n, n === 0);
    const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(output, 0, staging, 0, output.size); device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap();
    const rgb = new Float32Array(pixels * 4);
    let prim = 0, refl = 0, tail = 0, shadow = 0, mirrors = 0;
    for (let p = 0; p < pixels; p++) {
      for (let c = 0; c < 3; c++) rgb[p * 4 + c] = data[p * OUT + c] / spp;
      rgb[p * 4 + 3] = 1;
      mirrors += data[p * OUT + 3]; prim += data[p * OUT + 8]; refl += data[p * OUT + 9]; tail += data[p * OUT + 10]; shadow += data[p * OUT + 11];
    }
    // per mirror sample (the kernel reports the mirror plane only). Env arms (probes, rtshade): the kernel counts the mirror ray, the primary
    // ray is 1 per mirror sample, rtShade adds one shadow ray, the probe lookup none. The cache arms add their counted tail / shadow rays.
    const m = Math.max(1, mirrors);
    const rays = (m + refl + (arm === 'probes' ? 0 : arm === 'rtshade' ? m : tail + shadow)) / m;
    for (let p = 0; p < pixels; p++) if (!Number.isFinite(rgb[p * 4]) || !Number.isFinite(rgb[p * 4 + 1]) || !Number.isFinite(rgb[p * 4 + 2])) throw new Error(`non-finite radiance (${arm})`);
    return { rgb, rays, hits: data };
  }

  async function reference(view: View, samples: number, seed: number) {
    pt.setScene(provider.traceBuffers, provider.sceneCopyBuffers); pt.setCamera(view.camera); pt.setSeed(seed);
    for (let n = 0; n < samples;) {
      const enc = device.createCommandEncoder();
      if (n === 0) pt.reset(enc);
      const batch = Math.min(64, samples - n);
      pt.encode(enc, batch); device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone(); n += batch;
    }
    return { width, height, channels: 4, data: new Float32Array((await pt.readImage()).data) };
  }
  const crop = (data: Float32Array, v: View) => {
    const [x0, y0, x1, y1] = v.crop;
    const x = Math.floor(x0 * width), y = Math.floor(y0 * height), w = Math.floor(x1 * width) - x, h = Math.floor(y1 * height) - y;
    const out = new Float32Array(w * h * 4);
    for (let i = 0; i < h; i++) out.set(data.subarray(((y + i) * width + x) * 4, ((y + i) * width + x + w) * 4), i * w * 4);
    return { width: w, height: h, channels: 4, data: out };
  };
  const mask = (v: View) => {
    const [x0, y0, x1, y1] = v.crop;
    const m = new Uint8Array(pixels);
    for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) m[y * width + x] = 1;
    return m;
  };
  const error = (rgb: Float32Array, ref: Float32Array, v: View) => {
    const m = L.compareImages(crop(rgb, v), crop(ref, v));
    if (m.nonFiniteTest || m.nonFiniteRef) throw new Error('invalid radiance in the error crop');
    return { relMse: m.relMse as number, relBias: m.relBias as number };
  };
  const moveCard = () => {
    if (!fixture.movedScene) throw new Error('no moved scene');
    provider.setTransforms(fixture.movedScene.meshes.map((m: any) => m.transform ?? L.identity()));
    sceneGroup = providerGroup();
  };
  const destroy = () => {
    for (const buf of [params, output, records, count, staging, countStaging]) buf.destroy();
    pt.destroy(); grid.destroy(); probeSet.dispose(); probeShading.destroy(); rtShading.destroy(); provider.destroy();
  };
  return { name, views, width, height, pixels, grid, trainFrame, render, reference, crop, mask, error, bakeProbes, moveCard, destroy, scene, fixture, provider };
}
type Rig = Awaited<ReturnType<typeof createRig>>;

// ---- experiments ----------------------------------------------------------------------------------------------------------

const DEFAULTS: Required<Options> = { res: [128, 72], spp: 64, refSpp: 2048, warm: 128, stride: 1, history: 32, probeZ: 0.9 };
const withDefaults = (o: Options): Required<Options> => ({ ...DEFAULTS, ...o });

/** Warm the cache (every view, round robin), bake the probes. Returns the training rays per pixel of one frame. */
async function warmUp(rig: Rig, views: View[], frames: number, stride: number) {
  let rays = 0;
  for (let i = 0; i < frames; i++) rays = (await rig.trainFrame(views[i % views.length], stride)).raysPerPixel;
  return rays;
}

/** Accuracy vs the path-traced reference, per scene x method, in the bench crop. */
async function errors(L: Lib, opts: Options = {}, scenes: ('mirror' | 'thin')[] = ['mirror', 'thin']) {
  const o = withDefaults(opts);
  const out: Record<string, unknown> = {};
  for (const name of scenes) {
    const rig = await createRig(L, name, o);
    await rig.bakeProbes();
    const trainRays = await warmUp(rig, rig.views, o.warm, o.stride);
    for (const view of rig.views) {
      const ref = (await rig.reference(view, o.refSpp, 5731)).data;
      const row: Record<string, unknown> = {};
      for (const arm of ARMS) {
        const r = await rig.render(view, arm, o.spp, 277);
        row[arm] = { ...rig.error(r.rgb, ref, view), raysPerPixel: +r.rays.toFixed(2) };
        if (arm === 'nrc') (row[arm] as any).trainRaysPerPixel = +trainRays.toFixed(2);
        showImage(`${name}/${view.tag} ${arm}`, rig.crop(r.rgb, view));
      }
      showImage(`${name}/${view.tag} reference`, rig.crop(ref, view));
      out[`${name}/${view.tag}`] = row;
      say(`errors ${name}/${view.tag}: ` + ARMS.map((a) => `${a} ${(row[a] as any).relMse.toFixed(4)} (${((row[a] as any).relBias * 100).toFixed(1)}%)`).join('  '));
    }
    rig.destroy();
  }
  return out;
}

function showImage(label: string, im: { width: number; height: number; data: Float32Array }) {
  const host = document.getElementById('images'); if (!host) return;
  let mean = 0; for (let i = 0; i < im.data.length; i += 4) mean += lumLin(im.data[i], im.data[i + 1], im.data[i + 2]); mean /= im.width * im.height;
  const k = mean > 0 ? 0.18 / mean : 1;
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const ctx = c.getContext('2d')!; const id = ctx.createImageData(im.width, im.height);
  for (let i = 0; i < im.width * im.height; i++) { for (let ch = 0; ch < 3; ch++) id.data[i * 4 + ch] = Math.round(255 * srgb(Math.min(1, im.data[i * 4 + ch] * k))); id.data[i * 4 + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  const f = document.createElement('figure'); f.append(c, label); host.append(f);
}

/** 8-bit sRGB luma of a linear frame, with a fixed exposure. */
function luma8(rgb: Float32Array, k: number) {
  const n = rgb.length >> 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 255 * srgb(Math.min(1, k * lumLin(rgb[i * 4], rgb[i * 4 + 1], rgb[i * 4 + 2])));
  return out;
}
const orbitCamera = (cam: any, deg: number) => {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = cam.position[0] - cam.target[0], dz = cam.position[2] - cam.target[2];
  return { ...cam, position: [cam.target[0] + c * dx + s * dz, cam.position[1], cam.target[2] - s * dx + c * dz] };
};

/** Flicker at rest and over a slow orbit (display-space 8-bit luma over the crop; `spp` samples per frame stand for the denoiser's input). */
async function flicker(L: Lib, opts: Options & { restFrames?: number; passes?: number; deg?: number; half?: number } = {}, scenes: ('mirror' | 'thin')[] = ['mirror', 'thin']) {
  const o = withDefaults({ spp: 8, ...opts });
  const restFrames = opts.restFrames ?? 96, passes = opts.passes ?? 8, deg = opts.deg ?? 0.2, half = opts.half ?? 12;
  const out: Record<string, unknown> = {};
  for (const name of scenes) {
    const rig = await createRig(L, name, o);
    await rig.bakeProbes();
    const view = rig.views[0], m = rig.mask(view);
    await warmUp(rig, [view], o.warm, o.stride);
    // fixed exposure per scene: the crop of the traced arm at 0.18 mean
    const probe = await rig.render(view, 'traced', 32, 99);
    let s = 0, c = 0; for (let i = 0; i < rig.pixels; i++) if (m[i]) { s += lumLin(probe.rgb[i * 4], probe.rgb[i * 4 + 1], probe.rgb[i * 4 + 2]); c++; }
    const k = 0.18 / (s / c);
    const row: Record<string, unknown> = { exposure: +k.toFixed(3) };
    for (const arm of ARMS) {
      // ---- rest
      const acc = new Accumulator(rig.pixels), sd = new SecondDifference(m, 4), first = new Float32Array(rig.pixels), last = new Float32Array(rig.pixels);
      const nHalf = Math.min(32, restFrames >> 1);
      for (let f = 0; f < restFrames; f++) {
        if (arm === 'nrc') await rig.trainFrame(view, o.stride);
        const l = luma8((await rig.render(view, arm, o.spp, 1000 + f)).rgb, k);
        acc.add(l); sd.add(l);
        if (f < nHalf) for (let i = 0; i < l.length; i++) first[i] += l[i] / nHalf;
        if (f >= restFrames - nHalf) for (let i = 0; i < l.length; i++) last[i] += l[i] / nHalf;
      }
      const d = drift(first, last, m, 2), sdr = sd.result();
      // ---- orbit: W39's pendulum about the view target, `half / 2` frames out at `deg` per frame and back, both sides, `passes` times
      const acc2 = new Accumulator(rig.pixels), sd2 = new SecondDifference(m, 4);
      const q = half >> 1;
      let t = 0;
      for (let pass = 0; pass < passes; pass++) {
        for (let seg = 0; seg < 4; seg++) {
          const sign = seg < 2 ? 1 : -1, dir = seg % 2 === 0 ? 1 : -1;
          for (let j = 1; j <= q; j++) {
            const angle = sign * deg * (dir > 0 ? j : q - j);
            const cam = orbitCamera(view.camera, angle), v2 = { ...view, camera: cam };
            if (arm === 'nrc') await rig.trainFrame(v2, o.stride);
            const l = luma8((await rig.render(v2, arm, o.spp, 5000 + t++)).rgb, k);
            sd2.add(l, j === 1 && pass + seg > 0 ? true : false);
            if (angle === 0) acc2.add(l);
          }
        }
      }
      const od = sd2.result();
      row[arm] = {
        rest: { stdOverTime: +acc.std(m).toFixed(3), d1: +sdr.d1.toFixed(3), driftMean: +d.mean.toFixed(3), driftP99: d.p99, driftPctOver2: +d.pctOver.toFixed(2) },
        orbit: { startPoseStd: +acc2.std(m).toFixed(3), d2: +od.d2.toFixed(3), pctD2Over4: +od.pctD2Over.toFixed(2), d1: +od.d1.toFixed(3) },
      };
      say(`flicker ${name} ${arm}: rest std ${acc.std(m).toFixed(2)} d1 ${sdr.d1.toFixed(2)} drift ${d.mean.toFixed(2)} | orbit std ${acc2.std(m).toFixed(2)} d2 ${od.d2.toFixed(2)}`);
    }
    out[`${name}/${view.tag}`] = row;
    rig.destroy();
  }
  return out;
}

/** Recovery in frames: from a cold cache, after the card moves, after a camera cut. Error vs the PT reference at the crop. */
async function recovery(L: Lib, opts: Options & { checkpoints?: number[] } = {}) {
  const o = withDefaults({ spp: 64, ...opts });
  const cps = opts.checkpoints ?? [0, 1, 2, 4, 8, 16, 32, 64, 128];
  const out: Record<string, unknown> = {};
  const settle = (series: Record<number, number>, floor: number) => {
    const frames = Object.keys(series).map(Number).sort((a, b) => a - b);
    const first = (x: number) => frames.find((f) => series[f] <= x) ?? null;
    return { within2x: first(2 * floor), within1_25x: first(1.25 * floor) };
  };
  // cold start (mirror)
  {
    const rig = await createRig(L, 'mirror', o);
    const view = rig.views[0], ref = (await rig.reference(view, o.refSpp, 5731)).data;
    const series: Record<number, number> = {}; const bias: Record<number, number> = {};
    let done = 0;
    for (const cp of cps) {
      while (done < cp) { await rig.trainFrame(view, o.stride); done++; }
      const e = rig.error((await rig.render(view, 'nrc-frozen', o.spp, 7)).rgb, ref, view); series[cp] = e.relMse; bias[cp] = e.relBias;
    }
    const traced = rig.error((await rig.render(view, 'traced', o.spp, 7)).rgb, ref, view).relMse;
    await rig.bakeProbes();
    const probes = rig.error((await rig.render(view, 'probes', o.spp, 7)).rgb, ref, view).relMse;
    const rt = rig.error((await rig.render(view, 'rtshade', o.spp, 7)).rgb, ref, view).relMse;
    out.cold = { nrcRelMse: series, nrcRelBias: bias, tracedRelMse: traced, probesRelMse: probes, rtshadeRelMse: rt, settle: settle(series, series[cps[cps.length - 1]]) };
    say(`cold start relMSE by train frames: ${cps.map((c) => `${c}:${series[c].toFixed(4)}`).join(' ')}; traced ${traced.toFixed(4)} probes ${probes.toFixed(4)} rtshade ${rt.toFixed(4)}`);
    rig.destroy();
  }
  // moving card
  {
    const rig = await createRig(L, 'moving', o);
    const view = rig.views[0];
    await rig.bakeProbes();
    await warmUp(rig, [view], o.warm, o.stride);
    const before = (await rig.reference(view, o.refSpp, 5731)).data;
    const pre = { nrc: rig.error((await rig.render(view, 'nrc-frozen', o.spp, 7)).rgb, before, view), probes: rig.error((await rig.render(view, 'probes', o.spp, 7)).rgb, before, view) };
    rig.moveCard();
    const after = (await rig.reference(view, o.refSpp, 5732)).data;
    const series: Record<number, number> = {}; const bias: Record<number, number> = {};
    let done = 0;
    const rtError = rig.error((await rig.render(view, 'rtshade', o.spp, 7)).rgb, after, view);
    const tracedError = rig.error((await rig.render(view, 'traced', o.spp, 7)).rgb, after, view);
    const staleProbes = rig.error((await rig.render(view, 'probes', o.spp, 7)).rgb, after, view);
    for (const cp of cps) {
      while (done < cp) { await rig.trainFrame(view, o.stride); done++; }
      const e = rig.error((await rig.render(view, 'nrc-frozen', o.spp, 7)).rgb, after, view); series[cp] = e.relMse; bias[cp] = e.relBias;
    }
    const rebakeRays = await rig.bakeProbes(16, 2);
    const rebaked = rig.error((await rig.render(view, 'probes', o.spp, 7)).rgb, after, view);
    out.moved = { before: pre, nrcRelMse: series, nrcRelBias: bias, staleProbes, rebakedProbes: rebaked, rebakeRaysTotal: rebakeRays, rebakeFramesEquivalent: +(rebakeRays / (rig.pixels * 3)).toFixed(1), rtshade: rtError, traced: tracedError, settle: settle(series, series[cps[cps.length - 1]]) };
    say(`moved card: nrc relMSE by update frames ${cps.map((c) => `${c}:${series[c].toFixed(4)}(${(bias[c] * 100).toFixed(1)}%)`).join(' ')}; stale probes ${staleProbes.relMse.toFixed(4)} rebaked ${rebaked.relMse.toFixed(4)} rtshade ${rtError.relMse.toFixed(4)} traced ${tracedError.relMse.toFixed(4)}`);
    rig.destroy();
  }
  // camera cut (thin wall: warm the red side only, then look at the blue side)
  {
    const rig = await createRig(L, 'cut', o);
    const [red, blue] = rig.views;
    await rig.bakeProbes();
    await warmUp(rig, [red], o.warm, o.stride);
    const ref = (await rig.reference(blue, o.refSpp, 5731)).data;
    const series: Record<number, number> = {}; const bias: Record<number, number> = {};
    let done = 0;
    for (const cp of cps) {
      while (done < cp) { await rig.trainFrame(blue, o.stride); done++; }
      const e = rig.error((await rig.render(blue, 'nrc-frozen', o.spp, 7)).rgb, ref, blue); series[cp] = e.relMse; bias[cp] = e.relBias;
    }
    const probes = rig.error((await rig.render(blue, 'probes', o.spp, 7)).rgb, ref, blue).relMse;
    const rt = rig.error((await rig.render(blue, 'rtshade', o.spp, 7)).rgb, ref, blue).relMse;
    const traced = rig.error((await rig.render(blue, 'traced', o.spp, 7)).rgb, ref, blue).relMse;
    out.cut = { nrcRelMse: series, nrcRelBias: bias, probesRelMse: probes, rtshadeRelMse: rt, tracedRelMse: traced, settle: settle(series, series[cps[cps.length - 1]]) };
    say(`cut red->blue: nrc relMSE by blue-side frames ${cps.map((c) => `${c}:${series[c].toFixed(4)}`).join(' ')}; probes ${probes.toFixed(4)} rtshade ${rt.toFixed(4)} traced ${traced.toFixed(4)}`);
    rig.destroy();
  }
  return out;
}

/** Tiny end-to-end run for `pnpm check`: every method renders finite output on the mirror fixture, the cache learns, no validation errors. */
async function smoke(L: Lib) {
  const o = withDefaults({ res: [64, 36], spp: 4, refSpp: 32, warm: 8 });
  const rig = await createRig(L, 'mirror', o);
  await rig.bakeProbes(4);
  await warmUp(rig, rig.views, o.warm, 1);
  const view = rig.views[0];
  const ref = (await rig.reference(view, o.refSpp, 1)).data;
  const rows: Record<string, unknown> = {};
  for (const arm of ARMS) rows[arm] = { ...rig.error((await rig.render(view, arm, o.spp, 3)).rgb, ref, view) };
  rig.destroy();
  await L.device.queue.onSubmittedWorkDone();
  return { rows, deviceErrors: L.deviceErrors.slice() };
}

async function main() {
  if (!__NRC_AVAILABLE__) {
    status.textContent = 'The pmndrs/pathtracer checkout (bench/nrc, @pmndrs/pathtracer) was not found next to this repo; set NRC_PATHTRACER_REPO=<pathtracer checkout>. Nothing to run.';
    win.__p = { available: false };
    return;
  }
  const L = await setup();
  status.textContent = 'ready';
  win.__p = {
    available: true,
    errors: (o?: Options, scenes?: ('mirror' | 'thin')[]) => errors(L, o, scenes),
    flicker: (o?: Parameters<typeof flicker>[1], scenes?: ('mirror' | 'thin')[]) => flicker(L, o, scenes),
    recovery: (o?: Parameters<typeof recovery>[1]) => recovery(L, o),
    smoke: () => smoke(L),
    deviceErrors: () => L.deviceErrors.slice(),
  };
}

main().catch((e) => { status.textContent += '\nFAILED: ' + (e instanceof Error ? e.stack ?? e.message : String(e)); win.__p = { available: false, error: String(e) }; });
