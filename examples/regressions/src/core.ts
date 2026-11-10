// examples/regressions, stream F2: core repros on a bare GPUDevice (no three.js).
//
//  rtLimits    createTracedReflections counts every bind group's storage buffers and storage
//              textures (pass, radiance fallback, provider, hit shading) against the device's
//              per-stage limits and throws a clear error, instead of a validation error at
//              createPipelineLayout; a device with the limit raised builds the same pipeline.
import { ProbeSet, createTracedReflections, probeRadianceFallback, type TraceProvider } from '@pmndrs/reflections/core';

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
