// examples/probe-core: the phase 2 probe core on a bare GPUDevice (no three.js). `window.__p.run()`
// returns the numbers scripts/run-headless.mjs checks:
//   layouts   the same captures and volumes in every layout x format, looked up at random points;
//             coverage against the volume weights computed on the CPU, radiance against cube-hw rgba16f
//   refit     a constant capture (c) with a frame irradiance of 2 pi c: the L1 SH of each probe is pi c,
//             so the re-fit doubles every lookup; plus Lagarde's specular occlusion at fixed inputs
//   sssr      the core tracer on its analytic scene (examples/sssr-core) with probeRadianceFallback: a
//             probe set holding the constant c must give the image of the constant fallback c, bit for
//             bit; a structured capture must change the fallback pixels
import {
  ProbeSet, createScreenSpaceReflections, constantRadianceFallback, probeRadianceFallback, screenSpaceInputsFromFrame, sortProbeVolumes,
  type FrameInputs, type ProbeLayoutId, type ProbeSetFormat, type ProbeVolume, type ScreenSpaceReflectionsInputs,
} from '@pmndrs/reflections/core';
import { lookAt, perspective, SCENE_WGSL } from '../../sssr-core/src/scene';

const statusEl = document.querySelector('#status')!;
const log: string[] = [];
const say = (s: string) => { log.push(s); statusEl.textContent = log.join('\n'); };

const SOURCE = 64; // capture face size (maxLod 3)
const C = [1, 0.5, 0.25] as const;

// Test captures (texture-space directions): 0 a sky gradient with a hot spot and a bright band,
// 1 the same tinted red, 2 the constant C, 3 the same tinted blue.
const CUBE_WGSL = /* wgsl */ `
@group(0) @binding(0) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(1) var<uniform> U: vec4u; // size, kind
fn faceDirUV(face: u32, u: f32, v: f32) -> vec3f {
  switch face {
    case 0u: { return vec3( 1.0, -v, -u); } case 1u: { return vec3(-1.0, -v,  u); }
    case 2u: { return vec3( u,  1.0,  v); } case 3u: { return vec3( u, -1.0, -v); }
    case 4u: { return vec3( u, -v,  1.0); } default: { return vec3(-u, -v, -1.0); }
  }
}
fn env(d: vec3f, kind: u32) -> vec3f {
  if (kind == 2u) { return vec3f(${C.join(', ')}); }
  var c = mix(vec3f(0.3, 0.25, 0.2), vec3f(0.4, 0.6, 1.0), d.y * 0.5 + 0.5);
  c += vec3f(40.0, 36.0, 30.0) * pow(max(dot(d, normalize(vec3f(0.6, 0.5, -0.6))), 0.0), 400.0);
  if (abs(d.x) < 0.08) { c += vec3f(3.0, 2.5, 2.0); }
  if (kind == 1u) { c *= vec3f(1.5, 0.4, 0.3); }
  if (kind == 3u) { c *= vec3f(0.3, 0.5, 1.6); }
  return c;
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = U.x;
  if (id.x >= n || id.y >= n) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(n) * 2.0 - 1.0;
  textureStore(dst, id.xy, id.z, vec4f(env(normalize(faceDirUV(id.z, uv.x, uv.y)), U.y), 1.0));
}`;

const EVAL_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pts: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outv: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&pts) / 3u) { return; }
  let P = pts[3u * i].xyz; let R = pts[3u * i + 1u].xyz; let r = pts[3u * i + 1u].w; let N = pts[3u * i + 2u].xyz;
  outv[3u * i] = probeRadiance(P, R, r);
  outv[3u * i + 1u] = vec4f(probeRadianceWithEnvironment(P, R, r), 1.0);
  outv[3u * i + 2u] = vec4f(probeRadianceWithEnvironmentN(P, N, R, r), probeSpecularOcclusion(pts[3u * i + 2u].w, pts[3u * i].w, r));
}`;

async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU unavailable');
  const want = (['subgroups'] as GPUFeatureName[]).filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredFeatures: want });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU uncaptured error:', (e as GPUUncapturedErrorEvent).error.message));
  const U = GPUBufferUsage;

  const cubePipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: CUBE_WGSL }), entryPoint: 'main' } });
  const cubes = [0, 1, 2, 3].map((kind) => {
    const t = device.createTexture({ size: [SOURCE, SOURCE, 6], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    const u = device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
    device.queue.writeBuffer(u, 0, new Uint32Array([SOURCE, kind, 0, 0]));
    const enc = device.createCommandEncoder();
    const p = enc.beginComputePass(); p.setPipeline(cubePipe);
    p.setBindGroup(0, device.createBindGroup({ layout: cubePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView({ dimension: '2d-array' }) }, { binding: 1, resource: { buffer: u } }] }));
    p.dispatchWorkgroups(SOURCE / 8, SOURCE / 8, 6); p.end();
    device.queue.submit([enc.finish()]);
    return t;
  });

  // the probes example's rooms: two rooms and a doorway probe that wins where they overlap
  const volumes: ProbeVolume[] = [
    { slot: 0, center: [-4, 2.5, 0], halfSize: [4.2, 2.7, 4.2], projectionSize: [8, 5, 8] },
    { slot: 1, center: [4, 2.5, 0], halfSize: [4.2, 2.7, 4.2], projectionSize: [8, 5, 8], projectionOffset: [0.5, 0, 0], origin: [4.5, 2, 0.5] },
    { slot: 2, center: [0, 1.9, 0], halfSize: [1.2, 1.9, 1.25], projectionSize: [16, 3.8, 8], fade: 0.3 },
  ];

  const readBuffer = async (b: GPUBuffer) => {
    const r = device.createBuffer({ size: b.size, usage: U.MAP_READ | U.COPY_DST });
    const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(b, 0, r, 0, b.size); device.queue.submit([enc.finish()]);
    await r.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(r.getMappedRange().slice(0)); r.destroy();
    return out;
  };

  // random lookups: P in and around the rooms, R on the sphere, roughness 0 ... 1, N near R, NdotV
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const unit = () => { for (;;) { const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; const l = Math.hypot(...v); if (l > 0.1 && l < 1) return v.map((x) => x / l); } };
  const COUNT = 4096;
  const pts = new Float32Array(COUNT * 12);
  for (let i = 0; i < COUNT; i++) {
    const P = [rnd() * 20 - 10, rnd() * 7 - 1, rnd() * 10 - 5], R = unit(), N = unit();
    pts.set([...P, rnd(), ...R, rnd(), ...N, rnd()], i * 12);
  }
  const ptsBuf = device.createBuffer({ size: pts.byteLength, usage: U.STORAGE | U.COPY_DST });
  device.queue.writeBuffer(ptsBuf, 0, pts);
  const outBuf = device.createBuffer({ size: pts.byteLength, usage: U.STORAGE | U.COPY_SRC });
  const evalBgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ] });
  const evalGroup = device.createBindGroup({ layout: evalBgl, entries: [{ binding: 0, resource: { buffer: ptsBuf } }, { binding: 1, resource: { buffer: outBuf } }] });

  /** A probe set over the rooms, captures `kinds` (slots 0..2, then the environment), looked up at every point. */
  async function evaluate(options: { layout?: ProbeLayoutId; format?: ProbeSetFormat; size?: number; lodMapping?: 'r187' | 'alpha'; refit?: boolean; frameIrradianceWgsl?: string; dominantDirection?: boolean; kinds?: number[] }) {
    const set = new ProbeSet(device, { capacity: 3, sourceSize: SOURCE, layout: options.layout, format: options.format, size: options.size, refit: options.refit, frameIrradianceWgsl: options.frameIrradianceWgsl, dominantDirection: options.dominantDirection, lodMapping: options.lodMapping });
    const kinds = options.kinds ?? [0, 1, 3, 0];
    const enc = device.createCommandEncoder();
    for (let s = 0; s < 3; s++) set.capture(enc, s, cubes[kinds[s]]);
    set.captureEnvironment(enc, cubes[kinds[3]]);
    set.setVolumes(volumes);
    set.update();
    if (options.refit) set.computeIrradiance(enc);
    const pipe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [evalBgl, set.bindGroupLayout] }),
      compute: { module: device.createShaderModule({ code: set.wgsl({ group: 1 }) + EVAL_WGSL }), entryPoint: 'main' },
    });
    const p = enc.beginComputePass(); p.setPipeline(pipe); p.setBindGroup(0, evalGroup); p.setBindGroup(1, set.bindGroup); p.dispatchWorkgroups(COUNT / 64); p.end();
    device.queue.submit([enc.finish()]);
    const out = await readBuffer(outBuf);
    set.dispose();
    return out;
  }

  // CPU volume weights (the same rule as the WGSL: lookup order, fade, remaining weight)
  const sorted = sortProbeVolumes(volumes);
  const coverageAt = (P: number[]) => {
    let remaining = 1;
    for (const v of sorted) {
      const inside = Math.min(...[0, 1, 2].map((k) => v.halfSize[k] - Math.abs(P[k] - v.center[k])));
      remaining -= Math.min(1, Math.max(0, inside / (v.fade ?? 0.5))) * remaining;
    }
    return 1 - remaining;
  };
  const tone = (x: number) => (255 * Math.max(x, 0)) / (1 + Math.max(x, 0));
  const compare = (a: Float32Array, b: Float32Array, row: number) => {
    const d: number[] = [];
    for (let i = 0; i < COUNT; i++) {
      let m = 0;
      for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(tone(a[(i * 3 + row) * 4 + c]) - tone(b[(i * 3 + row) * 4 + c])));
      d.push(m);
    }
    d.sort((x, y) => x - y);
    return { mean: d.reduce((s, x) => s + x, 0) / d.length, p99: d[Math.floor(d.length * 0.99)], max: d[d.length - 1] };
  };

  async function run() {
    log.length = 0;
    const result: Record<string, unknown> = {};
    // ---- layouts x formats
    const configs: { layout: ProbeLayoutId; format: ProbeSetFormat; size?: number; lodMapping?: 'alpha' }[] = [
      { layout: 'cube-hw', format: 'rgba16float' }, { layout: 'cube-hw', format: 'rgb9e5ufloat' },
      { layout: 'cube2d-warp', format: 'rgba16float' }, { layout: 'cube2d-none', format: 'rgba16float' },
      { layout: 'octa', format: 'rgba16float', size: 160 },
      // D101: the same atlas, blended linearly in r^2 between the sharp mips (differs only below r = 0.3)
      { layout: 'cube-hw', format: 'rgba16float', lodMapping: 'alpha' },
    ];
    const ref = await evaluate(configs[0]);
    let coverageErr = 0, composeErr = 0;
    for (let i = 0; i < COUNT; i++) {
      const P = [pts[i * 12], pts[i * 12 + 1], pts[i * 12 + 2]];
      const a = ref[i * 12 + 3];
      coverageErr = Math.max(coverageErr, Math.abs(a - coverageAt(P)));
      // full = local.rgb * a + env * (1 - a): checked through the constant run below; here rgb finite
      for (let c = 0; c < 3; c++) if (!Number.isFinite(ref[i * 12 + c]) || !Number.isFinite(ref[i * 12 + 4 + c])) composeErr = Infinity;
    }
    const layouts = [];
    for (const cfg of configs.slice(1)) {
      const out = await evaluate(cfg);
      const local = compare(out, ref, 0), full = compare(out, ref, 1);
      layouts.push({ ...cfg, local, full });
      say(`${cfg.layout}${cfg.size ? '@' + cfg.size : ''} ${cfg.format}${cfg.lodMapping ? ' lod ' + cfg.lodMapping : ''} vs cube-hw rgba16f: full mean ${full.mean.toFixed(3)} p99 ${full.p99.toFixed(2)} max ${full.max.toFixed(1)} /255`);
    }
    const covered = Array.from({ length: COUNT }, (_, i) => ref[i * 12 + 3]);
    result.layouts = { coverageErr, composeErr, layouts, inside: covered.filter((a) => a > 0.999).length, outside: covered.filter((a) => a === 0).length, fade: covered.filter((a) => a > 0 && a < 0.999).length };
    say(`coverage vs CPU: max err ${coverageErr.toExponential(2)} (${(result.layouts as { inside: number }).inside} inside, ${(result.layouts as { fade: number }).fade} in a fade, ${(result.layouts as { outside: number }).outside} outside)`);

    // ---- constant capture: lookups give C everywhere; re-fit by 2 pi C doubles them
    const constant = await evaluate({ kinds: [2, 2, 2, 2] });
    const refit = await evaluate({ kinds: [2, 2, 2, 2], refit: true, dominantDirection: true, frameIrradianceWgsl: `fn frameIrradiance(P: vec3f, N: vec3f) -> vec3f { return 6.283185307 * vec3f(${C.join(', ')}); }` });
    let constErr = 0, refitErr = 0, soErr = 0;
    for (let i = 0; i < COUNT; i++) {
      for (let c = 0; c < 3; c++) {
        constErr = Math.max(constErr, Math.abs(constant[i * 12 + 4 + c] - C[c]) / C[c]);
        refitErr = Math.max(refitErr, Math.abs(refit[i * 12 + 8 + c] - 2 * C[c]) / C[c]);
      }
      const NdotV = pts[i * 12 + 11], ao = pts[i * 12 + 3], r = pts[i * 12 + 7], a = r * r;
      const so = Math.min(1, Math.max(0, Math.pow(Math.max(NdotV + ao, 0), Math.pow(2, -16 * a - 1)) - 1 + ao));
      soErr = Math.max(soErr, Math.abs(refit[i * 12 + 11] - so));
    }
    result.refit = { constErr, refitErr, soErr };
    say(`constant capture: max rel err ${constErr.toExponential(2)}; re-fit x2: ${refitErr.toExponential(2)}; specular occlusion: ${soErr.toExponential(2)}`);

    result.sssr = await sssr();
    return result;
  }

  // ---- the SSSR radiance-fallback seam on sssr-core's analytic scene
  async function sssr() {
    const W = 480, H = 270;
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const mk = (format: GPUTextureFormat) => device.createTexture({ size: [W, H], format, usage });
    const depth = mk('r32float'), normal = mk('rgba16float'), material = mk('rgba8unorm'), color = mk('rgba16float');
    const view = lookAt([0, 1.7, 5.5], [0, 1.1, -6]);
    const projection = perspective((55 * Math.PI) / 180, W / H, 0.1, 100, false);
    const viewProj = mul(projection, view);
    const sceneU = device.createBuffer({ size: 160, usage: U.UNIFORM | U.COPY_DST });
    const d = new ArrayBuffer(160), f = new Float32Array(d), u = new Uint32Array(d);
    f.set(invert(viewProj), 0); f.set(viewProj, 16); f.set([0, 1.7, 5.5, 1], 32); u[36] = W; u[37] = H; u[38] = 0;
    device.queue.writeBuffer(sceneU, 0, d);
    const scenePipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: SCENE_WGSL }), entryPoint: 'main' } });
    {
      const enc = device.createCommandEncoder();
      const p = enc.beginComputePass(); p.setPipeline(scenePipe);
      p.setBindGroup(0, device.createBindGroup({ layout: scenePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: sceneU } }, ...[depth, normal, material, color].map((t, i) => ({ binding: i + 1, resource: t.createView() }))] }));
      p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
      device.queue.submit([enc.finish()]);
    }
    const motion = device.createTexture({ size: [W, H], format: 'rg16float', usage: GPUTextureUsage.TEXTURE_BINDING });
    const frame: FrameInputs = {
      width: W, height: H, frameIndex: 0,
      textures: { depth, normal, roughness: { texture: material, channel: 1 }, metalness: { texture: material, channel: 0 }, albedo: material, motion, sceneColor: color },
      conventions: { depthInverted: false, depthLinear: false, normalUnpackMul: 1, normalUnpackAdd: 0, roughnessIsPerceptual: true, motionVectorScale: [1, 1], sceneColorSpecular: 'none' },
      camera: { view, projection, prevView: view, prevProjection: projection, prevViewProjection: viewProj, jitter: [0, 0], near: 0.1, far: 100, position: [0, 1.7, 5.5], reversedDepth: false },
    };
    const inputs: ScreenSpaceReflectionsInputs = screenSpaceInputsFromFrame(frame, { depthInverted: false });
    // occupancy 0: deterministic between tracer instances (the occupancy exit depends on atomic order)
    const settings = { fallbackColor: C, frameIndex: 3, minTraversalOccupancy: 0 };
    const radianceOf = async (fallback: Parameters<typeof createScreenSpaceReflections>[1]['radianceFallback'], group?: GPUBindGroup) => {
      const ssr = createScreenSpaceReflections(device, { width: W, height: H, radianceFallback: fallback });
      const enc = device.createCommandEncoder();
      ssr.dispatch(enc, { ...inputs, fallbackBindGroup: group }, settings);
      const out = ssr.outputs.radiance;
      const row = Math.ceil((W * 8) / 256) * 256;
      const rb = device.createBuffer({ size: row * H, usage: U.MAP_READ | U.COPY_DST });
      enc.copyTextureToBuffer({ texture: out }, { buffer: rb, bytesPerRow: row }, [W, H]);
      device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const src = new Uint16Array(rb.getMappedRange().slice(0)); rb.destroy();
      const px = new Uint16Array(W * H * 4);
      for (let y = 0; y < H; y++) px.set(src.subarray((y * row) / 2, (y * row) / 2 + W * 4), y * W * 4);
      return px;
    };
    // pixels whose rgb differs by more than one f16 step (the prefilter of a constant rounds by up to one)
    const differing = (a: Uint16Array, b: Uint16Array) => { let n = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) if (Math.abs(a[i + c] - b[i + c]) > 1) { n++; break; } return n; };
    const probeSet = (kinds: number[]) => {
      const set = new ProbeSet(device, { capacity: 3, sourceSize: SOURCE });
      const enc = device.createCommandEncoder();
      for (let s = 0; s < 3; s++) set.capture(enc, s, cubes[kinds[s]]);
      set.captureEnvironment(enc, cubes[kinds[3]]);
      device.queue.submit([enc.finish()]);
      // the analytic scene's floor and wall sit inside one room-sized probe
      set.setVolumes([{ slot: 0, center: [0, 2.5, -1], halfSize: [8, 3, 6], projectionSize: [16, 6, 12] }]);
      set.update();
      return set;
    };
    const constant = await radianceOf(constantRadianceFallback());
    const cset = probeSet([2, 2, 2, 2]);
    const cfb = probeRadianceFallback(cset);
    const viaProbes = await radianceOf(cfb, cfb.bindGroup);
    const sset = probeSet([0, 1, 3, 0]);
    const sfb = probeRadianceFallback(sset);
    const structured = await radianceOf(sfb, sfb.bindGroup);
    const res = { pixels: W * H, constantVsProbes: differing(constant, viaProbes), structuredVsConstant: differing(constant, structured) };
    say(`sssr fallback: constant probes vs constant fallback ${res.constantVsProbes} px differ; structured probes change ${res.structuredVsConstant} of ${res.pixels} px`);
    cset.dispose(); sset.dispose();
    return res;
  }

  say('ready: window.__p.run()');
  Object.assign(window, { __p: { run, device } });
}

function mul(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}

function invert(m: Float32Array): Float32Array {
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

main().catch((e) => { console.error(e); statusEl.textContent = `error: ${e?.stack ?? e}`; });
