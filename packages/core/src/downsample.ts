// Mip chains and reduction pyramids come from the maintainer's `downsampler` package (WebGPU,
// SPD-style: up to six levels per dispatch from a 64x64 tile in workgroup memory). One instance per
// device, so pipelines are shared by every pass that builds a chain (depth pyramid, probe prefilter).

import { planBatches } from 'downsampler';
import { Downsampler, createKernel, kernelLayoutEntries } from 'downsampler/webgpu';

const perDevice = new WeakMap<GPUDevice, Downsampler>();

/** The device's shared Downsampler. Uses up to min(6, maxStorageTexturesPerShaderStage) levels per dispatch. */
export function downsamplerFor(device: GPUDevice): Downsampler {
  let d = perDevice.get(device);
  if (!d) perDevice.set(device, (d = new Downsampler(device)));
  return d;
}

/**
 * W72: compile, with createComputePipelineAsync, the kernels the shared Downsampler will use for an
 * 'average' chain into a `format` texture of `width` x `height` x `levels` read from a `sourceFormat`
 * source (`encodePass(..., { source, reduction: 'average' })`). The Downsampler builds its pipelines
 * synchronously on first use; WebGPU implementations cache pipelines by content (Dawn does), so the
 * same descriptors compiled here first make that later call a cache hit instead of a stall. Same
 * plan, kernel source and layout as Downsampler.prepare (2-D, filterable formats read by 'sample').
 */
export function warmDownsampler(device: GPUDevice, format: 'rgba16float', width: number, height: number, levels: number, sourceFormat: GPUTextureFormat): Promise<unknown> {
  const d = downsamplerFor(device);
  const filterable = (f: string) => !f.startsWith('depth') && !f.endsWith('32float') && !/16[us]norm$/.test(f);
  const jobs = planBatches(width, height, { baseMipLevel: 0, mipLevelCount: levels, levelsPerDispatch: d.levelsPerDispatch, fromSource: true }).map((batch) => {
    const src = batch.sourceMipLevel === null ? sourceFormat : format;
    const access = filterable(src) ? (d.averageAccess ?? 'sample') : 'load';
    const label = `downsampler ${format}:2d:${batch.count}:${access}:${src}:average`;
    const module = device.createShaderModule({ label, code: createKernel({ format, dimension: '2d', count: batch.count, reduction: 'average', access, sourceFormat: src }) });
    const bgl = device.createBindGroupLayout({ label: `downsampler ${format}:2d:${batch.count}:${access}`, entries: kernelLayoutEntries({ format, dimension: '2d', count: batch.count, access }) });
    return device.createComputePipelineAsync({ label, layout: device.createPipelineLayout({ label, bindGroupLayouts: [bgl] }), compute: { module, entryPoint: 'main' } });
  });
  return Promise.all(jobs);
}

/** Color-attachment bytes per sample the reflections G-buffer can use (three's base 28 + lit 8 + specular 10 + clear coat 4 = 50, rounded up to the next common limit). */
export const REFLECTIONS_COLOR_BYTES_PER_SAMPLE = 64;

/** Sampled textures per shader stage {@link reflectionsRequiredLimits} asks for, when the adapter has them (D4900). */
export const REFLECTIONS_SAMPLED_TEXTURES_PER_STAGE = 32;

/**
 * Storage buffers per shader stage {@link reflectionsRequiredLimits} asks for, when the adapter has them (P1.5, D5200):
 * the traced pass (3) + a probe radiance fallback (1) + the @pmndrs/raytracer provider (5: walk 3, scene copy 2) +
 * probe hit shading (1). WebGPU's default is 8.
 */
export const REFLECTIONS_STORAGE_BUFFERS_PER_STAGE = 10;

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
 *   core passes check their count at build and say what to request;
 * - up to 10 storage buffers per stage (default 8), so the @pmndrs/raytracer trace provider (5) fits next to probe
 *   fallbacks and probe hit shading (P1.5, D5200).
 */
export function reflectionsRequiredLimits(adapter: GPUAdapter): Record<string, number> {
  const limits: Record<string, number> = { ...Downsampler.requiredLimits(adapter) };
  const maxBytes = adapter.limits.maxColorAttachmentBytesPerSample;
  if (typeof maxBytes === 'number' && maxBytes > 32) limits.maxColorAttachmentBytesPerSample = Math.min(maxBytes, REFLECTIONS_COLOR_BYTES_PER_SAMPLE);
  const maxSampled = adapter.limits.maxSampledTexturesPerShaderStage;
  if (typeof maxSampled === 'number' && maxSampled > 16) limits.maxSampledTexturesPerShaderStage = Math.min(maxSampled, REFLECTIONS_SAMPLED_TEXTURES_PER_STAGE);
  const maxStorage = adapter.limits.maxStorageBuffersPerShaderStage;
  if (typeof maxStorage === 'number' && maxStorage > 8) limits.maxStorageBuffersPerShaderStage = Math.max(limits.maxStorageBuffersPerShaderStage ?? 0, Math.min(maxStorage, REFLECTIONS_STORAGE_BUFFERS_PER_STAGE));
  return limits;
}
