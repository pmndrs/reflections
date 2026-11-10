// The pixi.js surface this adapter relies on, all public WebGPURenderer API (pixi.js 8.22, the same
// two calls @pmndrs/upscaler's pixi adapter uses): `renderer.gpu.device`, and
// `renderer.texture.getGpuSource()` for the GPUTexture behind a texture source.
import { reflectionsRequiredLimits } from '@pmndrs/reflections-core';
import { Texture, TextureSource, type Renderer, type TextureSourceOptions, type WebGPURenderer } from 'pixi.js';

// RendererType.WEBGPU, inlined so this module needs no runtime enum.
const WEBGPU = 2;

/** Narrows a pixi renderer to a WebGPU one (throws for WebGL). */
export function asWebGPURenderer(renderer: Renderer): WebGPURenderer {
  if (renderer.type !== WEBGPU) {
    throw new Error("@pmndrs/reflections/pixi: requires pixi's WebGPURenderer (got WebGL; pass preference: 'webgpu').");
  }
  return renderer as WebGPURenderer;
}

/** The renderer's GPUDevice, so every pass shares pixi's queue. */
export function getDevice(renderer: Renderer): GPUDevice {
  const device = asWebGPURenderer(renderer).gpu?.device;
  if (!device) throw new Error('@pmndrs/reflections/pixi: the renderer has no GPU device yet; await app.init() first.');
  return device;
}

/** The GPUTexture behind a pixi texture (a RenderTexture, a loaded image, ...), created if pixi hasn't yet. */
export function getGPUTexture(renderer: Renderer, texture: Texture | TextureSource): GPUTexture {
  return asWebGPURenderer(renderer).texture.getGpuSource(texture.source);
}

/**
 * A pixi texture whose GPUTexture the adapter's passes render or write into: pixi samples it like
 * any texture (Sprites, Filters), the passes bind the raw handle. pixi creates every non-compressed
 * source with TEXTURE_BINDING | COPY_DST | COPY_SRC | RENDER_ATTACHMENT (+ STORAGE_BINDING with
 * `storage`). One allocation, two views.
 */
export function createPixiTarget(
  renderer: Renderer, label: string, width: number, height: number, format: TextureSourceOptions['format'], storage = false,
): { texture: Texture; source: TextureSource; gpu: GPUTexture; destroy(): void } {
  const source = new TextureSource({
    label, width, height, resolution: 1, format, storage,
    autoGenerateMipmaps: false,
    scaleMode: 'linear',
    alphaMode: 'no-premultiply-alpha',
    // pixi's GC unloads sources it hasn't drawn lately; the passes bind these through the raw handle every frame
    autoGarbageCollect: false,
  });
  const texture = new Texture({ source, label });
  return {
    texture, source, gpu: getGPUTexture(renderer, source),
    // unload(), not destroy(): pixi keeps batch bind groups around and warns when a source they
    // reference is destroyed (the upscaler adapter's note)
    destroy() { source.unload(); texture.destroy(false); },
  };
}

/**
 * Creates a GPUAdapter + GPUDevice for `app.init({ gpu })` with what the reflections need on top of
 * pixi's own request: the 'subgroups' feature (the tracer's subgroup variant; pixi doesn't request
 * it, D2003) and core's `requiredLimits` (six storage textures per stage for the mip chains). Keeps
 * pixi's optional features (texture compression, indirect-first-instance, storage formats).
 */
export async function requestReflectionsDevice(
  options: { powerPreference?: GPUPowerPreference; requiredLimits?: Record<string, number> } = {},
): Promise<{ adapter: GPUAdapter; device: GPUDevice }> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: options.powerPreference });
  if (!adapter) throw new Error('@pmndrs/reflections/pixi: WebGPU is not available (no adapter).');
  const wanted = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2', 'indirect-first-instance',
    'bgra8unorm-storage', 'texture-formats-tier1', 'subgroups', 'timestamp-query', 'float32-filterable'];
  const requiredFeatures = wanted.filter((f) => adapter.features.has(f as GPUFeatureName)) as GPUFeatureName[];
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxSampledTexturesPerShaderStage: L.maxSampledTexturesPerShaderStage,
      maxSamplersPerShaderStage: L.maxSamplersPerShaderStage,
      ...reflectionsRequiredLimits(adapter),
      ...options.requiredLimits,
    },
  });
  return { adapter, device };
}
