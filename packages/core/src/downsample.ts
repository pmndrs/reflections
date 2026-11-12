// Mip chains and reduction pyramids come from the maintainer's `downsampler` package (WebGPU,
// SPD-style: up to six levels per dispatch from a 64x64 tile in workgroup memory). One instance per
// device, so pipelines are shared by every pass that builds a chain (depth pyramid, probe prefilter).

import { Downsampler } from 'downsampler/webgpu';

const perDevice = new WeakMap<GPUDevice, Downsampler>();

/** The device's shared Downsampler. Uses up to min(6, maxStorageTexturesPerShaderStage) levels per dispatch. */
export function downsamplerFor(device: GPUDevice): Downsampler {
  let d = perDevice.get(device);
  if (!d) perDevice.set(device, (d = new Downsampler(device)));
  return d;
}

/** Color-attachment bytes per sample the reflections G-buffer can use (three's base 28 + lit 8 + specular 10 + clear coat 4 = 50, rounded up to the next common limit). */
export const REFLECTIONS_COLOR_BYTES_PER_SAMPLE = 64;

/** Sampled textures per shader stage {@link reflectionsRequiredLimits} asks for, when the adapter has them (D4900). */
export const REFLECTIONS_SAMPLED_TEXTURES_PER_STAGE = 32;

/**
 * Limits to request when creating the device (merge into `requestDevice({ requiredLimits })`, or
 * three's `new WebGPURenderer({ requiredLimits })`), each capped at what `adapter` supports, so the
 * request never fails:
 * - six storage textures per stage, so mip chains run six levels per dispatch (default 4 still
 *   works, with more dispatches);
 * - up to 64 color-attachment bytes per sample (WebGPU's default is 32), so a G-buffer can add the
 *   lit image, three's exact specular weights (46 B, D603) and the clear coat target (50 B, D3541). On an adapter that can't, the
 *   G-buffer's `'auto'` targets stay off and the composite falls back to its estimate (D4600);
 * - up to 32 sampled textures per stage (WebGPU's default is 16), so probe sets of several sizes
 *   (one atlas binding per size, D4700) leave room for the material's own maps and the passes'
 *   G-buffer inputs (D4900). At the default 16 a four-size set still fits three's composite; the
 *   core passes check their count at build and say what to request.
 */
export function reflectionsRequiredLimits(adapter: GPUAdapter): Record<string, number> {
  const limits: Record<string, number> = { ...Downsampler.requiredLimits(adapter) };
  const maxBytes = adapter.limits.maxColorAttachmentBytesPerSample;
  if (typeof maxBytes === 'number' && maxBytes > 32) limits.maxColorAttachmentBytesPerSample = Math.min(maxBytes, REFLECTIONS_COLOR_BYTES_PER_SAMPLE);
  const maxSampled = adapter.limits.maxSampledTexturesPerShaderStage;
  if (typeof maxSampled === 'number' && maxSampled > 16) limits.maxSampledTexturesPerShaderStage = Math.min(maxSampled, REFLECTIONS_SAMPLED_TEXTURES_PER_STAGE);
  return limits;
}
