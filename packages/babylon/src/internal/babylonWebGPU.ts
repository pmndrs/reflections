// Every Babylon internal the adapter touches lives here, verified against @babylonjs/core 9.35 (the
// same two private fields @pmndrs/upscaler's babylon adapter uses, verified there on 9.31):
//   - `engine._device`                                   -> the GPUDevice
//   - `internalTexture._hardwareTexture.underlyingResource` -> the raw GPUTexture
// Both throw loudly when their shape changes; re-verify them first on a Babylon upgrade. The rest is
// public WebGPUEngine API: `flushFramebuffer()` (orders our submit after Babylon's recorded work) and
// `wrapWebGPUTexture()` / `updateWrappedWebGPUTexture()` (core-owned textures as Babylon textures).
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';

// Constants values inlined, so this module pulls in no Babylon runtime code.
const TEXTURETYPE_UNSIGNED_BYTE = 0;
const TEXTURETYPE_FLOAT = 1;
const TEXTURETYPE_HALF_FLOAT = 2;
const TEXTUREFORMAT_RGBA = 5;
const TEXTUREFORMAT_R = 6;
const NEAREST_SAMPLINGMODE = 1;

/** Narrows an engine to an initialized WebGPUEngine. */
export function asWebGPUEngine(engine: AbstractEngine): WebGPUEngine {
  if (!engine.isWebGPU) throw new Error('@pmndrs/reflections/babylon: requires a WebGPUEngine (got a WebGL engine).');
  return engine as WebGPUEngine;
}

/** The engine's GPUDevice, so the core passes share Babylon's queue. */
export function getDevice(engine: AbstractEngine): GPUDevice {
  const device = (asWebGPUEngine(engine) as unknown as { _device?: GPUDevice })._device;
  if (!device || typeof device.createCommandEncoder !== 'function') {
    throw new Error('@pmndrs/reflections/babylon: engine._device is missing. Await engine.initAsync() first, or this Babylon version changed its internals (verified against 9.35).');
  }
  return device;
}

/** The raw GPUTexture behind a Babylon InternalTexture (a render-target attachment, a frame-graph texture, a cube RTT). */
export function getGPUTexture(texture: InternalTexture): GPUTexture {
  const hardware = texture._hardwareTexture as { underlyingResource?: GPUTexture | null } | null;
  const gpu = hardware?.underlyingResource;
  if (!gpu || typeof gpu.createView !== 'function') {
    throw new Error('@pmndrs/reflections/babylon: texture has no WebGPU allocation yet (render to it first), or this Babylon version changed _hardwareTexture.underlyingResource (verified against 9.35).');
  }
  return gpu;
}

/**
 * A core-owned GPUTexture as a Babylon InternalTexture sharing the allocation (no copy). Babylon picks
 * its bind-group sample type from `type` (32-bit float textures it can't filter bind as
 * 'unfilterable-float'), so the wrapper's type and format are set from the GPU format.
 */
export function wrapGPUTexture(engine: AbstractEngine, texture: GPUTexture): InternalTexture {
  const webgpu = asWebGPUEngine(engine);
  const handle = webgpu.wrapWebGPUTexture(texture);
  handle.generateMipMaps = false;
  // wrapWebGPUTexture creates no sampling view (it serves render targets); re-pointing at the same
  // allocation builds one through the public API.
  webgpu.updateWrappedWebGPUTexture(handle, texture);
  switch (texture.format) {
    case 'r32float': handle.type = TEXTURETYPE_FLOAT; handle.format = TEXTUREFORMAT_R; handle.samplingMode = NEAREST_SAMPLINGMODE; break;
    case 'rgba32float': handle.type = TEXTURETYPE_FLOAT; handle.format = TEXTUREFORMAT_RGBA; handle.samplingMode = NEAREST_SAMPLINGMODE; break;
    case 'rgba16float': handle.type = TEXTURETYPE_HALF_FLOAT; handle.format = TEXTUREFORMAT_RGBA; break;
    default: handle.type = TEXTURETYPE_UNSIGNED_BYTE; break;
  }
  return handle;
}
