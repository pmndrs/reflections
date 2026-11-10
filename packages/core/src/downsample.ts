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

/**
 * Limits to request when creating the device (merge into `requestDevice({ requiredLimits })`, or
 * three's `new WebGPURenderer({ requiredLimits })`): six storage textures per stage, so mip chains
 * run six levels per dispatch. Without it the default (4) still works, with more dispatches.
 */
export function reflectionsRequiredLimits(adapter: GPUAdapter): Record<string, number> {
  return Downsampler.requiredLimits(adapter);
}
