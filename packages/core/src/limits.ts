// Per-stage binding counts of a compute pipeline against the device's limits (W62, D4900). A pass
// adds up its own bindings and the seams plugged into it (radiance fallback, hit shading, trace
// provider), so a combination that doesn't fit fails at build with what to change, not as a
// validation error at createPipelineLayout or a pipeline that silently never runs.

/** Bindings of one part of a pipeline in one shader stage. Missing counts are 0. */
export interface StageBindingCounts {
  storageBuffers?: number;
  storageTextures?: number;
  /** Sampled textures (any `texture_*` binding that is not a storage texture). */
  sampledTextures?: number;
}

const ROWS: readonly [string, keyof GPUSupportedLimits, keyof StageBindingCounts][] = [
  ['storage buffers', 'maxStorageBuffersPerShaderStage', 'storageBuffers'],
  ['storage textures', 'maxStorageTexturesPerShaderStage', 'storageTextures'],
  ['sampled textures', 'maxSampledTexturesPerShaderStage', 'sampledTextures'],
];

/** Counts the bindings of layout entries (for parts whose layout descriptor is at hand). */
export function countStageBindings(entries: readonly GPUBindGroupLayoutEntry[]): Required<StageBindingCounts> {
  const out = { storageBuffers: 0, storageTextures: 0, sampledTextures: 0 };
  for (const e of entries) {
    if (e.storageTexture !== undefined) out.storageTextures++;
    else if (e.texture !== undefined || e.externalTexture !== undefined) out.sampledTextures++;
    else if (e.buffer !== undefined && (e.buffer.type === 'storage' || e.buffer.type === 'read-only-storage')) out.storageBuffers++;
  }
  return out;
}

/**
 * Throws when the parts of a pipeline together pass one of the device's per-stage limits.
 * `prefix` starts the message (e.g. 'rt: the trace pipeline'); `parts` are [name, counts] in order.
 */
export function checkStageLimits(device: GPUDevice, prefix: string, parts: readonly (readonly [string, StageBindingCounts])[], hint = 'or use a fallback / hit shading that binds fewer'): void {
  for (const [what, limit, key] of ROWS) {
    const counts = parts.map(([, c]) => c[key] ?? 0);
    const total = counts.reduce((a, b) => a + b, 0), max = device.limits[limit] as number;
    if (total <= max) continue;
    throw new Error(`${prefix} binds ${total} ${what} in the compute stage (${parts.map(([name], i) => `${name} ${counts[i]}`).join(', ')}); `
      + `the device allows ${max} (${limit}). Request more at requestDevice ({ requiredLimits: reflectionsRequiredLimits(adapter) } asks for up to what the adapter has, `
      + `or { ${limit}: adapter.limits.${limit} }; three: new WebGPURenderer({ requiredLimits: { ${limit}: ${total} } })), ${hint}.`);
  }
}
