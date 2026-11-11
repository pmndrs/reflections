// examples/probe-core: the phase 2 probe core on a bare GPUDevice (no three.js). `window.__p.run()`
// returns the numbers scripts/run-headless.mjs checks:
//   layouts   the same captures and volumes in every layout x format, looked up at random points;
//             coverage against the volume weights computed on the CPU, radiance against cube-hw rgba16f
//   refit     a constant capture (c) with a frame irradiance of 2 pi c: the L1 SH of each probe is pi c,
//             so the re-fit doubles every lookup; plus Lagarde's specular occlusion at fixed inputs
//   mixed     D805: sets of three layouts (cube2d-warp, cube-hw, octa) in one shader module
//             (probeLookupWgsl([...]) with suffixes), each against its own single-set module, bit for bit
//   transform D1805 / D2104 (W35): the capture transform. Captures in three's (x-mirrored),
//             Babylon's (y-mirrored) and pixi-3d's (camera images) conventions, made from the test
//             captures by a face remap, each looked up through its transform against the plain set
//   sssr      the core tracer on its analytic scene (examples/sssr-core) with probeRadianceFallback: a
//             probe set holding the constant c must give the image of the constant fallback c, bit for
//             bit; a structured capture must change the fallback pixels
import {
  ProbeSet, probeLookupWgsl, ProbeCaptureRemap, LayoutPrefilter, createProbeLayout, maxLodFor, CAPTURE_MIRROR_X, CAPTURE_MIRROR_Y, CAPTURE_BABYLON_FACES, CAPTURE_CAMERA_FACES, type ProbeCaptureTransform,
  createScreenSpaceReflections, createTracedReflections, constantRadianceFallback, type TraceProvider, type TracedReflectionsStats, probeRadianceFallback, screenSpaceInputsFromFrame, sortProbeVolumes,
  type FrameInputs, type ProbeLayoutId, type ProbeSetFormat, type ProbeVolume, type ScreenSpaceReflectionsInputs, reflectionsRequiredLimits,
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
  const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits: reflectionsRequiredLimits(adapter) });
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
    if (options.refit ?? options.frameIrradianceWgsl !== undefined) set.computeIrradiance(enc);
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
    const configs: { layout: ProbeLayoutId; format: ProbeSetFormat; size?: number; lodMapping?: 'r187' }[] = [
      { layout: 'cube-hw', format: 'rgba16float' }, { layout: 'cube-hw', format: 'rgb9e5ufloat' },
      { layout: 'cube2d-warp', format: 'rgba16float' }, { layout: 'cube2d-none', format: 'rgba16float' },
      { layout: 'octa', format: 'rgba16float', size: 160 },
      // D101: the same atlas with r187's lod mapping (the default 'alpha' blends linearly in r^2
      // between the sharp mips; they differ only below r = 0.3)
      { layout: 'cube-hw', format: 'rgba16float', lodMapping: 'r187' },
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
    const frameIrradianceWgsl = `fn frameIrradiance(P: vec3f, N: vec3f) -> vec3f { return 6.283185307 * vec3f(${C.join(', ')}); }`;
    const refit = await evaluate({ kinds: [2, 2, 2, 2], refit: true, dominantDirection: true, frameIrradianceWgsl });
    // D803: a frame irradiance provider turns the re-fit on by itself; refit: false keeps it off
    const auto = await evaluate({ kinds: [2, 2, 2, 2], frameIrradianceWgsl });
    const off = await evaluate({ kinds: [2, 2, 2, 2], refit: false, frameIrradianceWgsl });
    let constErr = 0, refitErr = 0, soErr = 0, autoErr = 0, offErr = 0;
    for (let i = 0; i < COUNT; i++) {
      for (let c = 0; c < 3; c++) {
        constErr = Math.max(constErr, Math.abs(constant[i * 12 + 4 + c] - C[c]) / C[c]);
        refitErr = Math.max(refitErr, Math.abs(refit[i * 12 + 8 + c] - 2 * C[c]) / C[c]);
        autoErr = Math.max(autoErr, Math.abs(auto[i * 12 + 4 + c] - 2 * C[c]) / C[c]);
        offErr = Math.max(offErr, Math.abs(off[i * 12 + 4 + c] - C[c]) / C[c]);
      }
      const NdotV = pts[i * 12 + 11], ao = pts[i * 12 + 3], r = pts[i * 12 + 7], a = r * r;
      const so = Math.min(1, Math.max(0, Math.pow(Math.max(NdotV + ao, 0), Math.pow(2, -16 * a - 1)) - 1 + ao));
      soErr = Math.max(soErr, Math.abs(refit[i * 12 + 11] - so));
    }
    result.refit = { constErr, refitErr, soErr, autoErr, offErr };
    say(`constant capture: max rel err ${constErr.toExponential(2)}; re-fit x2: ${refitErr.toExponential(2)}; specular occlusion: ${soErr.toExponential(2)}`);

    result.mixed = await mixed();
    result.transform = await transform();
    result.sssr = await sssr();
    return result;
  }

  // ---- D1805 / D2104: the capture transform
  async function transform() {
    const kinds = [0, 1, 3, 0];
    // a capture in another engine's convention, made from a WebGPU-convention cube by a face remap
    const derive = (faces: ProbeCaptureTransform) => {
      const remap = new ProbeCaptureRemap(device, faces);
      const enc = device.createCommandEncoder();
      const out = kinds.map((k) => {
        const t = device.createTexture({ size: [SOURCE, SOURCE, 6], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
        remap.encode(enc, cubes[k], t);
        return t;
      });
      device.queue.submit([enc.finish()]);
      remap.dispose();
      return out;
    };
    // the world mirrored in x (three's CubeCamera): ±X swapped, every face flipped in x; the world
    // mirrored in y (a Babylon ReflectionProbe on WebGPU): ±Y swapped, rows flipped (both are their
    // own inverse); camera images (pixi-3d): every face flipped in x
    const three = derive({ faces: [1, 0, 2, 3, 4, 5].map((layer) => ({ layer, flipX: true })) });
    const babylon = derive(CAPTURE_BABYLON_FACES);
    const camera = derive(CAPTURE_CAMERA_FACES);
    const run = async (sources: GPUTexture[], o: { mirrorX?: boolean; captureTransform?: ProbeCaptureTransform }) => {
      const set = new ProbeSet(device, { capacity: 3, sourceSize: SOURCE, ...o });
      const enc = device.createCommandEncoder();
      for (let s = 0; s < 3; s++) set.capture(enc, s, sources[s]);
      set.captureEnvironment(enc, sources[3]);
      set.setVolumes(volumes);
      set.update();
      set.computeIrradiance(enc);
      const pipe = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [evalBgl, set.bindGroupLayout] }),
        compute: { module: device.createShaderModule({ code: set.wgsl({ group: 1 }) + EVAL_WGSL }), entryPoint: 'main' },
      });
      const p = enc.beginComputePass(); p.setPipeline(pipe); p.setBindGroup(0, evalGroup); p.setBindGroup(1, set.bindGroup); p.dispatchWorkgroups(COUNT / 64); p.end();
      device.queue.submit([enc.finish()]);
      const out = await readBuffer(outBuf);
      const table = await readBuffer(set.table);
      const irr = table.slice(set.irradianceRow * 4);
      set.dispose();
      return { out, irr };
    };
    const ref = await run(kinds.map((k) => cubes[k]), {});
    const exact = (a: Float32Array, b: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Number.isFinite(a[i]) && Number.isFinite(b[i]) ? Math.abs(a[i] - b[i]) : Infinity); return m; };
    // L1 SH rows (radiance coefficients) against the plain set's, relative to its largest
    const irrErr = (a: Float32Array) => { let m = 0, s = 0; for (let i = 0; i < ref.irr.length; i++) { m = Math.max(m, Math.abs(a[i] - ref.irr[i])); s = Math.max(s, Math.abs(ref.irr[i])); } return m / s; };
    const rows: Record<string, unknown>[] = [];
    const add = async (name: string, sources: GPUTexture[], o: { mirrorX?: boolean; captureTransform?: ProbeCaptureTransform }) => {
      const r = await run(sources, o);
      const row = { name, exact: exact(r.out, ref.out), full: compare(r.out, ref.out, 1), local: compare(r.out, ref.out, 0), irr: irrErr(r.irr), out: r.out };
      rows.push(row);
      say(`capture transform ${name} vs plain: max ${row.exact.toExponential(1)}; full mean ${row.full.mean.toFixed(3)} p99 ${row.full.p99.toFixed(2)} max ${row.full.max.toFixed(1)} /255; SH rel err ${row.irr.toExponential(1)}`);
      return row;
    };
    const alias = await add('three mirrorX', three, { mirrorX: true });
    const axesX = await add('three axes [-x, y, z]', three, { captureTransform: CAPTURE_MIRROR_X });
    await add('babylon faces (D1805 pass)', babylon, { captureTransform: CAPTURE_BABYLON_FACES });
    await add('babylon axes [x, -y, z]', babylon, { captureTransform: CAPTURE_MIRROR_Y });
    await add('pixi-3d camera faces', camera, { captureTransform: CAPTURE_CAMERA_FACES });
    const aliasErr = exact(alias.out as Float32Array, axesX.out as Float32Array);
    let both = '';
    try { new ProbeSet(device, { capacity: 1, sourceSize: SOURCE, mirrorX: true, captureTransform: CAPTURE_MIRROR_Y }).dispose(); } catch (e) { both = String((e as Error).message); }
    for (const t of [...three, ...babylon, ...camera]) t.destroy();
    return { aliasErr, both, rows: rows.map(({ out: _out, ...r }) => r) };
  }

  // ---- D805: three layouts in one module, against each layout's own module (evaluate())
  async function mixed() {
    const cfgs: { layout: ProbeLayoutId; size?: number; suffix: string }[] = [
      { layout: 'cube2d-warp', suffix: '' }, { layout: 'cube-hw', suffix: 'Hw' }, { layout: 'octa', size: 160, suffix: 'Octa' },
    ];
    const kinds = [0, 1, 3, 0];
    const sets = cfgs.map((c) => {
      const set = new ProbeSet(device, { capacity: 3, sourceSize: SOURCE, layout: c.layout, size: c.size });
      const enc = device.createCommandEncoder();
      for (let s = 0; s < 3; s++) set.capture(enc, s, cubes[kinds[s]]);
      set.captureEnvironment(enc, cubes[kinds[3]]);
      device.queue.submit([enc.finish()]);
      set.setVolumes(volumes);
      set.update();
      return set;
    });
    const out = device.createBuffer({ size: COUNT * cfgs.length * 2 * 16, usage: U.STORAGE | U.COPY_SRC });
    const code = probeLookupWgsl(sets.map((set, k) => set.lookupOptions({ group: k + 1, suffix: cfgs[k].suffix }))) + /* wgsl */ `
@group(0) @binding(0) var<storage, read> pts: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> outv: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&pts) / 3u) { return; }
  let P = pts[3u * i].xyz; let R = pts[3u * i + 1u].xyz; let r = pts[3u * i + 1u].w;
${cfgs.map((c, k) => `  outv[${cfgs.length * 2}u * i + ${2 * k}u] = probeRadiance${c.suffix}(P, R, r);
  outv[${cfgs.length * 2}u * i + ${2 * k + 1}u] = vec4f(probeRadianceWithEnvironment${c.suffix}(P, R, r), 1.0);`).join('\n')}
}`;
    const pipe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [evalBgl, ...sets.map((s) => s.bindGroupLayout)] }),
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    const enc = device.createCommandEncoder();
    const p = enc.beginComputePass(); p.setPipeline(pipe);
    p.setBindGroup(0, device.createBindGroup({ layout: evalBgl, entries: [{ binding: 0, resource: { buffer: ptsBuf } }, { binding: 1, resource: { buffer: out } }] }));
    sets.forEach((set, k) => p.setBindGroup(k + 1, set.bindGroup));
    p.dispatchWorkgroups(COUNT / 64); p.end();
    device.queue.submit([enc.finish()]);
    const shared = await readBuffer(out);
    out.destroy();
    for (const set of sets) set.dispose();
    const res = [];
    for (let k = 0; k < cfgs.length; k++) {
      const own = await evaluate({ layout: cfgs[k].layout, size: cfgs[k].size, kinds });
      let maxAbs = 0;
      for (let i = 0; i < COUNT; i++) for (let row = 0; row < 2; row++) for (let c = 0; c < 4; c++) {
        const a = shared[(i * cfgs.length * 2 + 2 * k + row) * 4 + c], b = own[(i * 3 + row) * 4 + c];
        maxAbs = Math.max(maxAbs, Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : Infinity);
      }
      res.push({ layout: cfgs[k].layout, suffix: cfgs[k].suffix, maxAbs });
    }
    say(`mixed layouts in one module vs their own: ${res.map((r) => `${r.layout} max ${r.maxAbs}`).join(', ')}`);
    return res;
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
    // The trace seam (W8's pass) with an analytic provider: the back wall z = -6 (|x| < 4, 0 < y < 4),
    // no bindings, no materials (grey). Traced misses and hit shading both go through the fallback.
    const wall: TraceProvider = {
      name: 'analytic-wall', entries: [], resources: () => [], version: 0, storageBufferCount: 0,
      capabilities: { hitNormal: true, hitMaterial: false },
      code: () => /* wgsl */ `
fn traceFirstHit(origin: vec3f, dir: vec3f, tMax: f32) -> Hit {
  if (dir.z >= -1e-4) { return noHit(); }
  let t = (-6.0 - origin.z) / dir.z;
  let p = origin + dir * t;
  if (t <= 0.0 || t > tMax || abs(p.x) > 4.0 || p.y < 0.0 || p.y > 4.0) { return noHit(); }
  return Hit(t, 0u, vec2f(0.0), 0u, 0u, vec3f(0.0, 0.0, 1.0), true);
}`,
    };
    let rtStats: TracedReflectionsStats | null = null;
    const radianceOf = async (fallback: Parameters<typeof createScreenSpaceReflections>[1]['radianceFallback'], group?: GPUBindGroup, traced = false) => {
      const ssr = createScreenSpaceReflections(device, { width: W, height: H, radianceFallback: fallback, missList: traced });
      const rt = traced ? createTracedReflections(device, { width: W, height: H, provider: wall, radianceFallback: fallback }) : null;
      const enc = device.createCommandEncoder();
      ssr.dispatch(enc, { ...inputs, fallbackBindGroup: group }, settings);
      rt?.dispatch(enc, { tracer: ssr, inputs, fallbackBindGroup: group }, { fallbackColor: C });
      const out = ssr.outputs.radiance;
      const row = Math.ceil((W * 8) / 256) * 256;
      const rb = device.createBuffer({ size: row * H, usage: U.MAP_READ | U.COPY_DST });
      enc.copyTextureToBuffer({ texture: out }, { buffer: rb, bytesPerRow: row }, [W, H]);
      device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const src = new Uint16Array(rb.getMappedRange().slice(0)); rb.destroy();
      const px = new Uint16Array(W * H * 4);
      for (let y = 0; y < H; y++) px.set(src.subarray((y * row) / 2, (y * row) / 2 + W * 4), y * W * 4);
      if (rt) { rtStats = await rt.readStats(); rt.destroy(); }
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
    // + the traced pass: misses and grey hits shaded by the same fallback
    const rtConstant = await radianceOf(constantRadianceFallback(), undefined, true);
    const rtViaProbes = await radianceOf(cfb, cfb.bindGroup, true);
    const rtStructured = await radianceOf(sfb, sfb.bindGroup, true);
    const res = {
      pixels: W * H, constantVsProbes: differing(constant, viaProbes), structuredVsConstant: differing(constant, structured),
      rt: { stats: rtStats as TracedReflectionsStats | null, constantVsProbes: differing(rtConstant, rtViaProbes), structuredVsConstant: differing(rtConstant, rtStructured), changedByTrace: differing(viaProbes, rtViaProbes) },
    };
    say(`sssr fallback: constant probes vs constant fallback ${res.constantVsProbes} px differ; structured probes change ${res.structuredVsConstant} of ${res.pixels} px`);
    say(`rt (analytic wall): ${JSON.stringify(res.rt)}`);
    cset.dispose(); sset.dispose();
    return res;
  }

  // ---- D2204 (W35): compatibility mode. A device without 'core-features-and-limits' fixes each
  // texture's binding view dimension at creation (textureBindingViewDimension).
  async function compat() {
    const a = await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' } as GPURequestAdapterOptions);
    if (!a) return { available: false };
    const dev = await a.requestDevice({});
    const isCompat = !dev.features.has('core-features-and-limits' as GPUFeatureName);
    const errors: string[] = [];
    dev.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
    // which binding view dimensions does it allow a 6-layer texture to be created with and bound as?
    const bind = async (declared: GPUTextureViewDimension, dim: GPUTextureViewDimension) => {
      dev.pushErrorScope('validation');
      const t = dev.createTexture({ size: [8, 8, 6], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING, textureBindingViewDimension: declared } as GPUTextureDescriptor);
      const created = await dev.popErrorScope();
      if (created) { t.destroy(); return `create: ${created.message.split('\n')[0].slice(0, 120)}`; }
      dev.pushErrorScope('validation');
      const bgl = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: dim } }] });
      dev.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: t.createView({ dimension: dim }) }] });
      const e = await dev.popErrorScope();
      t.destroy();
      return e ? `bind: ${e.message.split('\n')[0].slice(0, 120)}` : 'ok';
    };
    const dims = {
      cubeArrayAsCubeArray: await bind('cube-array', 'cube-array'), cubeArrayAs2dArray: await bind('cube-array', '2d-array'),
      cubeAsCube: await bind('cube', 'cube'), arrayAs2dArray: await bind('2d-array', '2d-array'), arrayAsCube: await bind('2d-array', 'cube'),
    };
    // the probe core on this device: the same capture and lookups as evaluate() on the core device
    const cubeOn = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: CUBE_WGSL }), entryPoint: 'main' } });
    const cube = dev.createTexture({ size: [SOURCE, SOURCE, 6], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    {
      const u = dev.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
      dev.queue.writeBuffer(u, 0, new Uint32Array([SOURCE, 0, 0, 0]));
      const enc = dev.createCommandEncoder();
      const p = enc.beginComputePass(); p.setPipeline(cubeOn);
      p.setBindGroup(0, dev.createBindGroup({ layout: cubeOn.getBindGroupLayout(0), entries: [{ binding: 0, resource: cube.createView({ dimension: '2d-array' }) }, { binding: 1, resource: { buffer: u } }] }));
      p.dispatchWorkgroups(SOURCE / 8, SOURCE / 8, 6); p.end();
      dev.queue.submit([enc.finish()]);
    }
    const ptsOn = dev.createBuffer({ size: pts.byteLength, usage: U.STORAGE | U.COPY_DST });
    dev.queue.writeBuffer(ptsOn, 0, pts);
    const outOn = dev.createBuffer({ size: pts.byteLength, usage: U.STORAGE | U.COPY_SRC });
    const readOn = async (b: GPUBuffer) => {
      const r = dev.createBuffer({ size: b.size, usage: U.MAP_READ | U.COPY_DST });
      const enc = dev.createCommandEncoder(); enc.copyBufferToBuffer(b, 0, r, 0, b.size); dev.queue.submit([enc.finish()]);
      await r.mapAsync(GPUMapMode.READ);
      const o = new Float32Array(r.getMappedRange().slice(0)); r.destroy();
      return o;
    };
    const sets: Record<string, unknown>[] = [];
    for (const layout of [undefined, 'cube2d-none', 'cube-hw'] as (ProbeLayoutId | undefined)[]) {
      const row: Record<string, unknown> = { asked: layout ?? 'default' };
      dev.pushErrorScope('validation');
      try {
        const set = new ProbeSet(dev, { capacity: 3, sourceSize: SOURCE, layout });
        row.layout = set.layout.id;
        const enc = dev.createCommandEncoder();
        for (let k = 0; k < 3; k++) set.capture(enc, k, cube);
        set.captureEnvironment(enc, cube);
        set.setVolumes(volumes); set.update();
        set.computeIrradiance(enc);
        const bgl = dev.createBindGroupLayout({ entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        ] });
        const pipe = dev.createComputePipeline({
          layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl, set.bindGroupLayout] }),
          compute: { module: dev.createShaderModule({ code: set.wgsl({ group: 1 }) + EVAL_WGSL }), entryPoint: 'main' },
        });
        const p = enc.beginComputePass(); p.setPipeline(pipe);
        p.setBindGroup(0, dev.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ptsOn } }, { binding: 1, resource: { buffer: outOn } }] }));
        p.setBindGroup(1, set.bindGroup); p.dispatchWorkgroups(COUNT / 64); p.end();
        dev.queue.submit([enc.finish()]);
        const out = await readOn(outOn);
        set.dispose();
        // against the same set on the core device
        const ref = await evaluate({ layout: set.layout.id, kinds: [0, 0, 0, 0] });
        let m = 0; for (let i = 0; i < out.length; i++) m = Math.max(m, Number.isFinite(out[i]) ? Math.abs(out[i] - ref[i]) : Infinity);
        row.vsCore = m;
      } catch (e) { row.throws = String((e as Error).message).slice(0, 160); }
      const e = await dev.popErrorScope();
      if (e) row.error = e.message.split('\n').slice(0, 2).join(' / ').slice(0, 200);
      sets.push(row);
    }
    cube.destroy(); ptsOn.destroy(); outOn.destroy();
    dev.destroy();
    // the compatibility-mode prefilter path (GGX levels from a cube-only copy of the source chain),
    // run on the core device, against the default path: the scratch must be identical
    const scratchOf = async (cubeSourceCopy: boolean) => {
      const lf = new LayoutPrefilter(device, createProbeLayout('cube2d-none', { maxLod: maxLodFor(SOURCE) }), SOURCE, SOURCE, { cubeSourceCopy });
      const t = lf.scratch;
      let bytes = 0;
      for (let m = 0; m < t.mipLevelCount; m++) { const w = Math.max(1, t.width >> m); bytes += Math.ceil((w * 8) / 256) * 256 * w * 6; }
      const b = device.createBuffer({ size: bytes, usage: U.COPY_DST | U.MAP_READ });
      const enc = device.createCommandEncoder();
      lf.encodeScratch(enc, cubes[0]);
      let off = 0;
      for (let m = 0; m < t.mipLevelCount; m++) {
        const w = Math.max(1, t.width >> m), row = Math.ceil((w * 8) / 256) * 256;
        enc.copyTextureToBuffer({ texture: t, mipLevel: m }, { buffer: b, offset: off, bytesPerRow: row, rowsPerImage: w }, [w, w, 6]);
        off += row * w * 6;
      }
      device.queue.submit([enc.finish()]);
      await b.mapAsync(GPUMapMode.READ);
      const out = new Uint16Array(b.getMappedRange().slice(0)); b.destroy(); lf.dispose();
      return out;
    };
    const plain = await scratchOf(false), copied = await scratchOf(true);
    let prefilterDiffering = 0; for (let i = 0; i < plain.length; i++) if (plain[i] !== copied[i]) prefilterDiffering++;
    return { available: true, isCompat, dims, sets, prefilterDiffering, prefilterValues: plain.length, errors: errors.slice(0, 4) };
  }

  say('ready: window.__p.run()');
  Object.assign(window, { __p: { run, compat, device } });
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
