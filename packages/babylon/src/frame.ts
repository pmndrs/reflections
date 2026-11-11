// The frame contract (core FrameInputs) from a Babylon geometry render: a FrameGraphGeometryRendererTask
// (or any MRT render) that writes linear HDR colour, depth32float, PREPASS_WORLD_NORMAL,
// PREPASS_REFLECTIVITY and PREPASS_VELOCITY_LINEAR. Conventions: ./conventions.ts.
//
// Everything binds as Babylon wrote it. Roughness is PREPASS_REFLECTIVITY.a, which holds glossiness
// (1 - perceptual roughness): the contract's `roughnessUnpack` { mul: -1, add: 1 } turns it into
// roughness where core reads it (D1802). Metalness is a constant 1 (albedo = F0, D1803): a
// one-channel texture cleared to 1 when the size changes, no per-frame pass.
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

/**
 * Builds core `FrameInputs` from Babylon G-buffer textures on Babylon's device. One instance per
 * view: it keeps the previous frame's camera for motion and the denoise seam.
 */
export class BabylonFrame {
  readonly engine: AbstractEngine;
  readonly device: GPUDevice;
  readonly conventions: FrameConventions;
  /** r8unorm, all 1: the contract's metalness (albedo = F0, D1803). Reallocated when the size changes. */
  metalness: GPUTexture | null = null;
  private readonly history = new FrameCameraHistory();
  private frameIndex = 0;

  constructor(engine: AbstractEngine, options: BabylonFrameOptions = {}) {
    this.engine = engine;
    this.device = getDevice(engine);
    this.conventions = babylonFrameConventions(engine.useReverseDepthBuffer, options.sceneColorSpecular ?? 'direct');
  }

  /** The next `build()` has no previous frame (camera cut). */
  resetHistory() { this.history.reset(); }

  /**
   * Returns the frame. Call once per rendered frame, after Babylon rendered `gbuffer` with `camera`;
   * records into `encoder` only when the size changed (clearing the metalness texture).
   */
  build(encoder: GPUCommandEncoder, gbuffer: BabylonGBuffer, camera: Camera): FrameInputs {
    const color = getGPUTexture(gbuffer.color);
    const reflectivity = getGPUTexture(gbuffer.reflectivity);
    const { width, height } = color;
    if (!this.metalness || this.metalness.width !== width || this.metalness.height !== height) {
      this.metalness?.destroy();
      this.metalness = this.device.createTexture({
        label: 'babylon frame: metalness (1)', size: [width, height], format: 'r8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      encoder.beginRenderPass({
        label: 'babylon frame: metalness clear',
        colorAttachments: [{ view: this.metalness.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }],
      }).end();
    }
    return {
      width, height,
      textures: {
        depth: getGPUTexture(gbuffer.depth),
        normal: getGPUTexture(gbuffer.worldNormal),
        roughness: { texture: reflectivity, channel: 3 },
        metalness: { texture: this.metalness, channel: 0 },
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
    this.metalness?.destroy();
    this.metalness = null;
  }
}
