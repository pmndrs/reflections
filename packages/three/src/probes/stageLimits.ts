// Material-side texture limit (T24, W104, D5640). A three material that samples a probe set binds the
// set's atlases (one per probe size, D4700) next to its own maps, shadow maps and three's own
// textures. Past the device's `maxSampledTexturesPerShaderStage` (or `maxSamplersPerShaderStage`:
// three gives each filterable texture its own sampler) WebGPU rejects the material's pipeline and the
// mesh doesn't draw; the only message is WebGPU's validation error, which names neither the material
// nor the probes. Core passes count their bindings at build (limits.ts, D4900); three builds the
// materials, so the count happens here: ReflectionProbesNode.setup hooks the builder that compiles the
// material, and once three has collected the shader's bindings (`buildCode`, before any pipeline is
// created) we count each stage's sampled textures and samplers and warn once per material.

import type { ReflectionProbes } from './ReflectionProbes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any; // three's NodeBuilder: internal fields only (bindings, material, object, renderer)

/** A binding of three's NodeBuilder, as far as the count needs it. */
export interface StageBinding { isSampledTexture?: boolean; isSampler?: boolean; store?: boolean; texture?: unknown }

/** Sampled textures and samplers of one shader stage, and how many of the textures are probe atlases. */
export interface StageTextureCount { stage: string; sampledTextures: number; samplers: number; atlases: number }

/**
 * Counts a NodeBuilder's bindings per shader stage (`builder.bindings[stage][group]`, what three
 * turns into the bind group layouts): sampled textures (not storage textures) and samplers, each
 * binding once per stage. `atlases`: the textures among them that are in `atlasTextures`.
 */
export function countStageTextures(bindings: Record<string, Record<string, readonly StageBinding[]>>, atlasTextures: ReadonlySet<unknown> = new Set()): StageTextureCount[] {
  const out: StageTextureCount[] = [];
  for (const stage of Object.keys(bindings)) {
    const seen = new Set<StageBinding>();
    let sampledTextures = 0, samplers = 0, atlases = 0;
    for (const group of Object.values(bindings[stage] ?? {})) {
      for (const b of group) {
        if (seen.has(b)) continue;
        seen.add(b);
        if (b.isSampledTexture === true && b.store !== true) {
          sampledTextures++;
          if (atlasTextures.has(b.texture)) atlases++;
        } else if (b.isSampler === true) samplers++;
      }
    }
    if (sampledTextures > 0 || samplers > 0) out.push({ stage, sampledTextures, samplers, atlases });
  }
  return out;
}

/** Device limits the count is checked against. */
export interface TextureStageLimits { maxSampledTexturesPerShaderStage: number; maxSamplersPerShaderStage: number }

/**
 * The warning for a material whose stage counts pass the device's limits, or null when every stage
 * fits. `what` names the material (and its mesh); `sizes` are the probe set's atlas sizes in px.
 */
export function materialTextureLimitWarning(what: string, counts: readonly StageTextureCount[], limits: TextureStageLimits, sizes: readonly number[]): string | null {
  for (const c of counts) {
    const textures = c.sampledTextures > limits.maxSampledTexturesPerShaderStage;
    const samplers = c.samplers > limits.maxSamplersPerShaderStage;
    if (!textures && !samplers) continue;
    const over = [
      textures ? `${c.sampledTextures} sampled textures` : '',
      samplers ? `${c.samplers} samplers` : '',
    ].filter(Boolean).join(' and ');
    const atlases = c.atlases > 0 ? `, ${c.atlases} of the textures probe atlases (one per probe size: ${sizes.join(', ')} px)` : '';
    const allowed = [
      textures ? `${limits.maxSampledTexturesPerShaderStage} (maxSampledTexturesPerShaderStage)` : '',
      samplers ? `${limits.maxSamplersPerShaderStage} (maxSamplersPerShaderStage)` : '',
    ].filter(Boolean).join(' and ');
    const fix = textures
      ? 'Fix: create the renderer with new WebGPURenderer({ requiredLimits: reflectionsRequiredLimits(adapter) }) (asks for up to 32 sampled textures where the adapter has them), or use fewer probe sizes (or fewer maps on this material).'
      : 'Fix: use fewer probe sizes (or fewer maps on this material); reflectionsRequiredLimits does not raise the sampler limit (16 on most adapters).';
    return `ReflectionProbes: ${what} binds ${over} in its ${c.stage} shader${atlases}; this device allows ${allowed}, so WebGPU will reject its pipeline and it will not draw. ${fix}`;
  }
  return null;
}

/** Materials (or composites) already warned about. */
const warned = new WeakSet<object>();
/** Builders already hooked, with the probe sets whose atlases they bind. */
const hooked = new WeakMap<Builder, Set<ReflectionProbes>>();

/** `"name" (Type)`, plus the mesh's name when it has one. */
function describe(builder: Builder): string {
  const m = builder.material, o = builder.object;
  const material = m ? `material ${m.name ? `"${m.name}" ` : ''}(${m.type})` : 'a compute shader';
  return o?.name ? `${material} on "${o.name}"` : material;
}

/**
 * Called from a probe node's setup: once the builder has its bindings, count them against the device
 * and warn once per material. A no-op where three's internals are not what we expect.
 */
export function watchTextureLimits(builder: Builder, probes: ReflectionProbes) {
  const sets = hooked.get(builder);
  if (sets !== undefined) { sets.add(probes); return; }
  const device: GPUDevice | undefined = builder?.renderer?.backend?.device;
  if (device === undefined || typeof builder.buildCode !== 'function' || typeof builder.bindings !== 'object') return;
  const own = new Set<ReflectionProbes>([probes]);
  hooked.set(builder, own);
  const buildCode = builder.buildCode;
  builder.buildCode = function (this: Builder, ...args: unknown[]) {
    // three has collected every binding of the shader by now; the pipeline comes later
    try {
      const key: object = this.material ?? this;
      if (!warned.has(key)) {
        const atlasTextures = new Set<unknown>();
        const sizes: number[] = [];
        for (const set of own) { for (const t of set.textures) atlasTextures.add(t); sizes.push(...set.bakedResolutions); }
        const message = materialTextureLimitWarning(describe(this), countStageTextures(this.bindings, atlasTextures), device.limits as unknown as TextureStageLimits, sizes);
        if (message !== null) { warned.add(key); console.warn(message); }
      }
    } catch { /* the count is advice; never break a build over it */ }
    return buildCode.apply(this, args);
  };
}
