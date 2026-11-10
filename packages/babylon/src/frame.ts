// The frame contract (core FrameInputs) from a Babylon geometry render: a FrameGraphGeometryRendererTask
// (or any MRT render) that writes linear HDR colour, depth32float, PREPASS_WORLD_NORMAL,
// PREPASS_REFLECTIVITY and PREPASS_VELOCITY_LINEAR. Conventions: ./conventions.ts.
//
// Everything binds as Babylon wrote it except roughness: PREPASS_REFLECTIVITY.a holds glossiness
// (1 - perceptual roughness), which no contract flag can express, so one compute dispatch writes a
// contract-shaped material texture (rgba16float: r = perceptual roughness, g = metalness 1, D1802/D1803).
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';
import { FrameCameraHistory, type FrameConventions, type FrameInputs } from '@pmndrs/reflections-core';
import { babylonFrameCamera, babylonFrameConventions } from './conventions';
import { getDevice, getGPUTexture } from './internal/babylonWebGPU';

/** The Babylon textures of one frame (all the same size). */
export interface BabylonGBuffer {
  /** Linear HDR scene colour (rgba16float): what screen-space hits return. See `sceneColorSpecular`. */
  color: InternalTexture;
  /** depth32float (or depth24plus) from the same render. */
  depth: InternalTexture;
  /** PREPASS_WORLD_NORMAL_TEXTURE_TYPE (n * 0.5 + 0.5), a float or unorm RGBA texture. */
  worldNormal: InternalTexture;
  /** PREPASS_REFLECTIVITY_TEXTURE_TYPE: rgb F0, a glossiness (`microSurface`). */
  reflectivity: InternalTexture;
  /** PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE. */
  velocity: InternalTexture;
}

export interface BabylonFrameOptions {
  /**
   * What `color` holds (FrameConventions.sceneColorSpecular). 'direct' (default): Babylon's lit
   * colour with its specular IBL removed by `stripSpecularIBL` (./material.ts); punctual-light
   * specular stays. 'none': the app rendered without any specular.
   */
  sceneColorSpecular?: FrameConventions['sceneColorSpecular'];
}

const MATERIAL_WGSL = /* wgsl */ `
@group(0) @binding(0) var reflectivity: texture_2d<f32>;
@group(0) @binding(1) var material: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(material);
  if (any(id.xy >= size)) { return; }
  let gloss = textureLoad(reflectivity, vec2i(id.xy), 0).a;
  // r: perceptual roughness; g: metalness 1, so the contract's F0 = mix(0.04, albedo, 1) = Babylon's F0
  textureStore(material, vec2i(id.xy), vec4f(clamp(1.0 - gloss, 0.0, 1.0), 1.0, 0.0, 1.0));
}
`;

/**
 * Builds core `FrameInputs` from Babylon G-buffer textures on Babylon's device. One instance per
 * view: it keeps the previous frame's camera for motion and the denoise seam.
 */
export class BabylonFrame {
  readonly engine: AbstractEngine;
  readonly device: GPUDevice;
  readonly conventions: FrameConventions;
  /** rgba16float: r perceptual roughness, g metalness (1). Reallocated when the size changes. */
  material: GPUTexture | null = null;
  private readonly history = new FrameCameraHistory();
  private readonly pipeline: GPUComputePipeline;
  private frameIndex = 0;

  constructor(engine: AbstractEngine, options: BabylonFrameOptions = {}) {
    this.engine = engine;
    this.device = getDevice(engine);
    this.conventions = babylonFrameConventions(engine.useReverseDepthBuffer, options.sceneColorSpecular ?? 'direct');
    this.pipeline = this.device.createComputePipeline({
      label: 'babylon frame: material',
      layout: 'auto',
      compute: { module: this.device.createShaderModule({ label: 'babylon frame: material', code: MATERIAL_WGSL }), entryPoint: 'main' },
    });
  }

  /** The next `build()` has no previous frame (camera cut). */
  resetHistory() { this.history.reset(); }

  /**
   * Records the material conversion into `encoder` and returns the frame. Call once per rendered
   * frame, after Babylon rendered `gbuffer` with `camera`.
   */
  build(encoder: GPUCommandEncoder, gbuffer: BabylonGBuffer, camera: Camera): FrameInputs {
    const color = getGPUTexture(gbuffer.color);
    const reflectivity = getGPUTexture(gbuffer.reflectivity);
    const { width, height } = color;
    if (!this.material || this.material.width !== width || this.material.height !== height) {
      this.material?.destroy();
      this.material = this.device.createTexture({
        label: 'babylon frame: material (roughness, metalness)', size: [width, height], format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    }
    const pass = encoder.beginComputePass({ label: 'babylon frame: material' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: reflectivity.createView() }, { binding: 1, resource: this.material.createView() }],
    }));
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    return {
      width, height,
      textures: {
        depth: getGPUTexture(gbuffer.depth),
        normal: getGPUTexture(gbuffer.worldNormal),
        roughness: { texture: this.material, channel: 0 },
        metalness: { texture: this.material, channel: 1 },
        albedo: reflectivity,
        motion: getGPUTexture(gbuffer.velocity),
        sceneColor: color,
      },
      conventions: this.conventions,
      camera: babylonFrameCamera(camera, this.conventions.depthInverted, this.history),
      frameIndex: this.frameIndex++,
    };
  }

  dispose() {
    this.material?.destroy();
    this.material = null;
  }
}
