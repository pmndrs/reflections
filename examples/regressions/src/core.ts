// examples/regressions, stream F2: core repros on a bare GPUDevice (no three.js).
//
//  rtLimits    createTracedReflections counts every bind group's storage buffers and storage
//              textures (pass, radiance fallback, provider, hit shading) against the device's
//              per-stage limits and throws a clear error, instead of a validation error at
//              createPipelineLayout; a device with the limit raised builds the same pipeline.
//  probeEnvDominant  the dominant direction bends the environment sample too (inside a volume,
//              in its fade band and outside it agree).
import { ProbeSet, createTracedReflections, probeRadianceFallback, type TraceProvider } from '@pmndrs/reflections/core';
import { readBufferF32 } from './util';

const C = 0x4; // GPUShaderStage.COMPUTE

async function newDevice(requiredLimits?: Record<string, number>) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  return { adapter, device: await adapter.requestDevice({ requiredLimits }) };
}

/** A provider that binds `buffers` read-only storage buffers and `textures` write-only storage textures and never hits. */
function fakeProvider(device: GPUDevice, buffers: number, textures = 0): TraceProvider {
  const bufs = Array.from({ length: buffers }, () => device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE }));
  const texs = Array.from({ length: textures }, () => device.createTexture({ size: [1, 1], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING }));
  return {
    name: `fake-${buffers}b-${textures}t`,
    code: (slot) => {
      const decl = [
        ...bufs.map((_, i) => `@group(${slot.group}) @binding(${slot.firstBinding + i}) var<storage, read> fk_b${i}: array<u32>;`),
        ...texs.map((_, i) => `@group(${slot.group}) @binding(${slot.firstBinding + buffers + i}) var fk_t${i}: texture_storage_2d<r32float, write>;`),
      ].join('\n');
      const use = [...bufs.map((_, i) => `s += fk_b${i}[0];`), ...texs.map((_, i) => `textureStore(fk_t${i}, vec2u(0u), vec4f(0.0));`)].join(' ');
      return `${decl}\nfn traceFirstHit(origin: vec3f, dir: vec3f, tMax: f32) -> Hit { var s = 0u; ${use} var h = noHit(); h.t = -1.0 - f32(s); return h; }\n`;
    },
    entries: [
      ...bufs.map(() => ({ visibility: C, buffer: { type: 'read-only-storage' as const } })),
      ...texs.map(() => ({ visibility: C, storageTexture: { access: 'write-only' as const, format: 'r32float' as const } })),
    ],
    resources: () => [...bufs.map((buffer) => ({ buffer })), ...texs.map((t) => t.createView())],
    version: 0,
    storageBufferCount: buffers,
    capabilities: { hitNormal: false, hitMaterial: false },
  };
}

/** Build the traced pass; report whether it threw (and what) and any validation error it raised. */
async function attempt(device: GPUDevice, provider: TraceProvider, probes: boolean) {
  const set = probes ? new ProbeSet(device, { capacity: 1, sourceSize: 64 }) : null;
  device.pushErrorScope('validation');
  let threw: string | null = null;
  try {
    const rt = createTracedReflections(device, { width: 64, height: 64, provider, radianceFallback: set ? probeRadianceFallback(set) : undefined });
    rt.destroy();
  } catch (e) { threw = String((e as Error).message ?? e); }
  const err = await device.popErrorScope();
  set?.dispose();
  return { threw, validationError: err?.message ?? null };
}

export async function rtLimitChecks() {
  const { adapter, device } = await newDevice();
  const out: Record<string, unknown> = {
    limits: { maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage, maxStorageTexturesPerShaderStage: device.limits.maxStorageTexturesPerShaderStage },
  };
  // 3 (pass) + 5 (provider) + 1 (probe table) = 9 storage buffers on a default device (8)
  out.fiveBuffersAndProbes = await attempt(device, fakeProvider(device, 5), true);
  // 3 + 4 + 1 = 8: fits (three-mesh-bvh's provider binds 4)
  out.fourBuffersAndProbes = await attempt(device, fakeProvider(device, 4), true);
  // 4 (pass) + 1 (provider) storage textures on a default device (4)
  out.oneStorageTexture = await attempt(device, fakeProvider(device, 0, 1), false);
  // the same 9 buffers with the limit raised (if the adapter allows it)
  const max = adapter.limits.maxStorageBuffersPerShaderStage;
  if (max >= 9) {
    const raised = (await newDevice({ maxStorageBuffersPerShaderStage: 9 })).device;
    out.raised = await attempt(raised, fakeProvider(raised, 5), true);
    raised.destroy();
  } else out.raised = { skipped: `adapter allows ${max}` };
  device.destroy();
  return out;
}

// ---- probes ---------------------------------------------------------------------------------------

/** A cube (rgba16float, 6 layers) with one flat colour per face: +x, -x, +y, -y, +z, -z. */
export const FACE_COLOURS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1]];
export function faceCube(device: GPUDevice, size: number, colours: number[][] = FACE_COLOURS) {
  const t = device.createTexture({ size: [size, size, 6], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const e = device.createCommandEncoder();
  colours.forEach((c, face) => e.beginRenderPass({ colorAttachments: [{
    view: t.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: [c[0], c[1], c[2], 1],
  }] }).end());
  device.queue.submit([e.finish()]);
  return t;
}

/** Runs `body` (WGSL statements writing `outv[i]`) once over a probe set's lookup module; returns `count` rgb triples. */
async function probeEval(device: GPUDevice, set: ProbeSet, count: number, body: string) {
  const outBuf = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: C, buffer: { type: 'storage' } }] });
  const pipe = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl, set.bindGroupLayout] }),
    compute: { module: device.createShaderModule({ code: `${set.wgsl({ group: 1 })}
@group(0) @binding(0) var<storage, read_write> outv: array<vec4f>;
@compute @workgroup_size(1) fn main() {
${body}
}` }), entryPoint: 'main' },
  });
  const e = device.createCommandEncoder();
  const p = e.beginComputePass(); p.setPipeline(pipe);
  p.setBindGroup(0, device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: outBuf } }] }));
  p.setBindGroup(1, set.bindGroup); p.dispatchWorkgroups(1); p.end();
  device.queue.submit([e.finish()]);
  const f = await readBufferF32(device, outBuf);
  outBuf.destroy();
  return Array.from({ length: count }, (_, i) => Array.from(f.slice(i * 4, i * 4 + 3)));
}

/**
 * probeEnvDominant (the reviewer's repro): an environment and a probe holding the same cube with a
 * different colour per face, N = +y, R = (1, 0.3, 0), r = 0.7, dominant direction on. The lookup must
 * bend the direction the same way inside the volume, in its fade band and outside it (environment
 * only), so all three equal the environment sampled along the dominant direction.
 */
export async function probeEnvDominantChecks() {
  const { device } = await newDevice();
  const cube = faceCube(device, 64);
  const set = new ProbeSet(device, { capacity: 1, sourceSize: 64, dominantDirection: true });
  const e = device.createCommandEncoder();
  set.capture(e, 0, cube); set.captureEnvironment(e, cube);
  device.queue.submit([e.finish()]);
  set.setVolumes([{ slot: 0, center: [0, 0, 0], halfSize: [2, 2, 2], fade: 1, boxProjection: false }]);
  set.update();
  const r = 0.7, a = r * r, s = 1 - a, k = s * (Math.sqrt(s) + a);
  const R = [1, 0.3, 0].map((x) => x / Math.hypot(1, 0.3)), N = [0, 1, 0];
  const D = N.map((n, i) => n + (R[i] - n) * k);
  const v = (x: number[]) => `vec3f(${x.map((c) => c.toFixed(8)).join(', ')})`;
  const [inside, fade, outside, refDominant, refPlain] = await probeEval(device, set, 5, `
  outv[0] = vec4f(probeRadianceWithEnvironmentN(vec3f(0.0), ${v(N)}, ${v(R)}, ${r}), 1.0);
  outv[1] = vec4f(probeRadianceWithEnvironmentN(vec3f(1.5, 0.0, 0.0), ${v(N)}, ${v(R)}, ${r}), 1.0);
  outv[2] = vec4f(probeRadianceWithEnvironmentN(vec3f(5.0, 0.0, 0.0), ${v(N)}, ${v(R)}, ${r}), 1.0);
  outv[3] = vec4f(probeRadianceWithEnvironment(vec3f(5.0, 0.0, 0.0), ${v(D)}, ${r}), 1.0);
  outv[4] = vec4f(probeRadianceWithEnvironment(vec3f(5.0, 0.0, 0.0), ${v(R)}, ${r}), 1.0);`);
  const diff = (x: number[], y: number[]) => Math.max(...x.map((c, i) => Math.abs(c - y[i])));
  set.dispose(); cube.destroy(); device.destroy();
  return {
    inside, fade, outside, refDominant, refPlain,
    insideVsDominant: diff(inside, refDominant), fadeVsDominant: diff(fade, refDominant), outsideVsDominant: diff(outside, refDominant),
    plainVsDominant: diff(refPlain, refDominant),
  };
}

/**
 * probeIrradiance: two computeIrradiance() calls recorded into one encoder before a submit keep
 * their own slot parameters. Slots 0 and 1 hold constant captures c0 and c1, so their L00 is
 * c * Y00 * 4 pi = 3.5449 c.
 */
export async function probeIrradianceChecks() {
  const { device } = await newDevice();
  const c0 = [1, 0.5, 0.25], c1 = [0.25, 0.5, 2];
  const cubes = [c0, c1].map((c) => faceCube(device, 64, Array(6).fill(c)));
  const set = new ProbeSet(device, { capacity: 2, sourceSize: 64, refit: true });
  set.setVolumes([{ slot: 0, center: [0, 0, 0], halfSize: [1, 1, 1] }, { slot: 1, center: [5, 0, 0], halfSize: [1, 1, 1] }]);
  set.update();
  const e = device.createCommandEncoder();
  set.capture(e, 0, cubes[0]); set.capture(e, 1, cubes[1]);
  set.computeIrradiance(e, [0]);
  set.computeIrradiance(e, [1]);
  device.queue.submit([e.finish()]);
  const t = await readBufferF32(device, set.table);
  const L00 = (slot: number) => Array.from(t.slice((set.irradianceRow + 3 * slot) * 4, (set.irradianceRow + 3 * slot) * 4 + 3));
  const k = 0.282095 * 4 * Math.PI;
  const relErr = (got: number[], c: number[]) => Math.max(...got.map((g, i) => Math.abs(g - c[i] * k) / (c[i] * k)));
  const out = { slot0: L00(0), slot1: L00(1), expected0: c0.map((x) => x * k), expected1: c1.map((x) => x * k), err0: relErr(L00(0), c0), err1: relErr(L00(1), c1) };
  set.dispose(); cubes.forEach((c) => c.destroy()); device.destroy();
  return out;
}

/** probeSourceSize: the smallest sourceSize the docs promise works, and a smaller one fails saying the real minimum. */
export async function probeSourceSizeChecks() {
  const { device } = await newDevice();
  const tryMake = (sourceSize: number) => {
    try { new ProbeSet(device, { capacity: 1, sourceSize }).dispose(); return { ok: true, error: null }; } catch (e) { return { ok: false, error: String((e as Error).message) }; }
  };
  // the minimum the ProbeSetOptions doc states
  const src = (await import('../../../packages/core/src/probes/set.ts?raw')).default as string;
  const documented = Number(/Capture face size, a power of two >= (\d+)/.exec(src)?.[1] ?? NaN);
  const out = { documented, atDocumented: tryMake(documented), half: tryMake(documented / 2), s32: tryMake(32), s64: tryMake(64) };
  device.destroy();
  return out;
}
