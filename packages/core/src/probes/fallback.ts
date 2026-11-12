// The SSSR radiance-fallback seam (docs/HANDOFF.md, "Radiance fallback") filled by a ProbeSet:
// rays that miss and pixels too rough to trace take the probe lookup, with the environment slot for
// what no probe covers. Plug it into createScreenSpaceReflections:
//
//   const fallback = probeRadianceFallback(set);
//   const ssr = createScreenSpaceReflections(device, { ..., radianceFallback: fallback });
//   ssr.dispatch(encoder, { ...inputs, fallbackBindGroup: fallback.bindGroup }, settings);
//
// The seam calls sampleRadianceFallback(P, dir, roughness) with world-space P and dir and perceptual
// roughness (0 for screen-space misses), and lets the snippet read the tracer's uniform block `P`
// (here: `P.iblFactor` scales the result, as in the default fallbacks).

import type { ProbeSet } from './set';

export interface ProbeRadianceFallback {
  /** WGSL for the seam: the lookup module at @group(1) plus sampleRadianceFallback. */
  wgsl: string;
  /** Layout of @group(1) (the set's). */
  layout: GPUBindGroupLayout;
  /** Bind group for `inputs.fallbackBindGroup` (the set's). */
  bindGroup: GPUBindGroup;
  /** The volume table (1). */
  storageBufferCount: number;
  /** One atlas per probe size (D4700, D4900). */
  sampledTextureCount: number;
}

/** WGSL of sampleRadianceFallback over the probe lookup module (which must be in the same module). */
export const PROBE_FALLBACK_WGSL = /* wgsl */ `
fn sampleRadianceFallback(P_world: vec3f, dir: vec3f, roughness: f32) -> vec3f {
  return probeRadianceWithEnvironment(P_world, dir, roughness) * P.iblFactor;
}
`;

/** The radiance-fallback seam over `set` (its bind group at @group(1); visibility must include COMPUTE). */
export function probeRadianceFallback(set: ProbeSet): ProbeRadianceFallback {
  return { wgsl: set.wgsl({ group: 1 }) + PROBE_FALLBACK_WGSL, layout: set.bindGroupLayout, bindGroup: set.bindGroup, storageBufferCount: 1, sampledTextureCount: set.atlasViews.length };
}
