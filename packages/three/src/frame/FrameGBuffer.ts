// The frame contract (packages/core/src/frame/contract.ts) filled from a three.js scene.
//
// One render of the scene with WebGPURenderer MRT, the pattern the denoiser repo's three-temporal
// pages use (`setMRT(mrt({ output, diffuseColor, normal, velocity }))`), but into our own render
// target instead of a PassNode so it works with or without a RenderPipeline. The GPUTextures come
// from the renderer's backend (`backend.get(texture).texture`), as in ./probes and denoiser/three.
//
// Targets (WebGPU's default `maxColorAttachmentBytesPerSample` is 32; the default set uses 28):
//
//   name             format        contents
//   output           rgba16float   scene colour WITHOUT specular (emissive + direct + indirect diffuse), a = alpha
//   normalRoughness  rgba16float   world normal (raw, unit) in xyz, perceptual roughness in w
//   albedoMetalness  rgba8unorm    linear base colour in rgb, metalness in a
//   velocity         rg16float     uv-space motion, current - previous (or three's NDC velocity, option);
//                                  `textures.motion`. The MRT slot must be named 'velocity': three only
//                                  moves `positionPrevious` by last frame's instance / bone / batch
//                                  matrices when `builder.needsPreviousData()`, i.e. `mrt.has('velocity')`.
//   lit (optional)   rgba16float   three's full lit output (+8 bytes: needs a raised limit, see `lit`);
//                                  attachment 0 when written, since three's transmission refracts
//                                  attachment 0 (D3520). The rest follow in the order listed.
//   specular (opt.)  rgba16float   three's environment-specular weights (with `lit`, +8 bytes, D603):
//                                  rgb = single scattering (specularColorBlended x DFG.x + specularF90 x DFG.y)
//                                        x the clear coat's base scale (1 - cc Fcc, D3512),
//                                  a = specular occlusion x material env intensity (./nodes.ts `gbufferSpecular`)
//   shadingRoughness r16float      three's shading roughness (geometry-adjusted, >= 0.045; with `specular`, +2 bytes, D403)
//   depth            depth32float  hardware depth (reverse-Z if the renderer uses it)
import * as THREE from 'three/webgpu';
import { diffuseColor, mrt, nodeObject, normalWorld, output, uniform, vec2, vec4 } from 'three/tsl';
import {
  FrameCameraHistory, type FrameCamera, type FrameConventions, type FrameInputs, type FrameTextures,
} from '@pmndrs/reflections-core';
import { gbufferMetalness, gbufferRoughness, gbufferShadingRoughness, gbufferSpecular, sceneColorNoSpecular } from './nodes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

interface BackendLike { device?: GPUDevice; isWebGPUBackend?: boolean; get(o: object): { texture?: GPUTexture } | undefined }
const backendOf = (r: THREE.WebGPURenderer) => (r as unknown as { backend: BackendLike }).backend;

/** The GPUDevice behind an initialized WebGPURenderer. */
export function getDevice(renderer: THREE.WebGPURenderer): GPUDevice {
  const device = backendOf(renderer)?.device;
  if (!device || backendOf(renderer).isWebGPUBackend !== true) throw new Error('reflections/three: renderer is not initialized or not on the WebGPU backend');
  return device;
}

/** The GPUTexture behind a three texture; it must already be allocated (rendered to or initialized). */
export function getGPUTexture(renderer: THREE.WebGPURenderer, texture: THREE.Texture): GPUTexture {
  const gpu = backendOf(renderer).get(texture)?.texture;
  if (!gpu) throw new Error(`reflections/three: texture "${texture.name || texture.uuid}" has no GPU allocation yet`);
  return gpu;
}

export type FrameTargetName = 'output' | 'normalRoughness' | 'albedoMetalness' | 'motion' | 'lit' | 'specular' | 'shadingRoughness';

export interface FrameGBufferOptions {
  /** Render size in pixels. Default: the renderer's drawing-buffer size, followed on each render(). */
  width?: number;
  height?: number;
  /**
   * Also write three's full lit image (8 more bytes per sample, 36 in all). `'auto'` (default)
   * enables it when the device allows it (`maxColorAttachmentBytesPerSample >= 36`; request it with
   * `new WebGPURenderer({ requiredLimits: { maxColorAttachmentBytesPerSample: 64 } })`).
   */
  lit?: boolean | 'auto';
  /**
   * Also write three's own environment-specular weights (`specular`, rgba16float) and shading
   * roughness (`shadingRoughness`, r16float): 10 more bytes per sample on top of `lit` (46 in all).
   * The hybrid composite then removes exactly the term three added (specularIntensity / Color, ior,
   * AO-map occlusion, envMapIntensity, geometry roughness) instead of estimating it (D603).
   * `'auto'` (default): on when `lit` is on and the device allows 46 bytes. Needs `lit`.
   */
  specular?: boolean | 'auto';
  /** 'uv' (default): uv-space motion, scale [1, 1]. 'ndc': three's velocity as is, scale [0.5, -0.5] (what denoiser/three expects). */
  motion?: 'uv' | 'ndc';
}

const BYTES = { base: 8 + 8 + 8 + 4, lit: 8, specular: 8 + 2 };

/**
 * three's VelocityNode with the camera half of its history taken from our FrameCamera instead of
 * three's per-animation-frame camera record, so motion and `FrameInputs.camera` advance together,
 * once per `FrameGBuffer.render()`, however many renders an animation frame holds. The object
 * half (previous model, instance and batch matrices) stays three's: it advances per draw in a
 * velocity MRT pass, which is once per render() here. Skinned meshes' previous bones advance per
 * animation frame in three (r187 Skinning.js), not per draw.
 */
class HistoryVelocityNode extends (THREE as N).VelocityNode {
  readonly prevView = new THREE.Matrix4();
  readonly prevProjection = new THREE.Matrix4();
  readonly projection = new THREE.Matrix4();
  update(frame: N) {
    super.update(frame); // previous model matrix (per object); three's camera record is overridden below
    const s = this as N;
    s.previousCameraViewMatrix.value.copy(this.prevView);
    s.previousProjectionMatrix.value.copy(this.prevProjection);
    s.currentProjectionMatrix.value.copy(this.projection);
  }
}

/**
 * Renders a scene into the frame-contract G-buffer and hands out the GPU textures.
 *
 * ```ts
 * const gbuffer = new FrameGBuffer(renderer);
 * const frame = gbuffer.render(scene, camera); // FrameInputs: GPUTextures + conventions + camera
 * ```
 *
 * Each `render()` is one frame of history: the camera struct and the motion target both take the
 * previous render as "last frame" (two renders in one animation frame are fine). Objects keep their
 * history in three, per draw in a velocity MRT pass: render an object in one such pass per frame
 * (this one), or its motion goes to zero. Skinned meshes' previous bones advance once per
 * animation frame (three). The first render and the one after `resetHistory()` write zero motion.
 * Transparent objects blend into `output` (scene colour) only; the guide targets take whatever was
 * drawn last. Not supported: `logarithmicDepthBuffer` (the constructor throws).
 */
export class FrameGBuffer {
  readonly renderer: THREE.WebGPURenderer;
  readonly renderTarget: THREE.RenderTarget;
  readonly mrt: N;
  readonly lit: boolean;
  /** The `specular` and `shadingRoughness` targets are written (see the option). */
  readonly specular: boolean;
  readonly motionMode: 'uv' | 'ndc';
  /** three textures by target name (plus `depth`), for TSL sampling (debug views, composites). */
  readonly textures: Record<FrameTargetName, THREE.Texture | undefined> & { depth: THREE.DepthTexture };
  private readonly history = new FrameCameraHistory();
  private readonly fixedSize: boolean;
  private frameIndex = 0;
  private last: FrameInputs | null = null;
  private readonly velocityNode: HistoryVelocityNode;
  /** 0 when there is no previous frame (first render, after resetHistory()), else 1. */
  private readonly historyValid = uniform(0);

  constructor(renderer: THREE.WebGPURenderer, options: FrameGBufferOptions = {}) {
    this.renderer = renderer;
    const device = getDevice(renderer);
    if ((renderer as N).logarithmicDepthBuffer === true && renderer.reversedDepthBuffer !== true) {
      throw new Error('FrameGBuffer: logarithmicDepthBuffer is not supported (the contract has no log-depth convention; depth would not invert with the projection). Use reversedDepthBuffer for precision instead.');
    }
    const limit = device.limits.maxColorAttachmentBytesPerSample;
    const wantLit = options.lit ?? 'auto';
    this.lit = wantLit === 'auto' ? limit >= BYTES.base + BYTES.lit : wantLit;
    if (this.lit && limit < BYTES.base + BYTES.lit) {
      throw new Error(`FrameGBuffer: lit needs maxColorAttachmentBytesPerSample >= ${BYTES.base + BYTES.lit}, device has ${limit}`);
    }
    const withSpecular = BYTES.base + BYTES.lit + BYTES.specular;
    const wantSpecular = options.specular ?? 'auto';
    this.specular = wantSpecular === 'auto' ? this.lit && limit >= withSpecular : wantSpecular;
    if (this.specular && !this.lit) throw new Error('FrameGBuffer: specular needs the lit target');
    if (this.specular && limit < withSpecular) {
      throw new Error(`FrameGBuffer: specular needs maxColorAttachmentBytesPerSample >= ${withSpecular}, device has ${limit}`);
    }
    this.motionMode = options.motion ?? 'uv';
    this.fixedSize = options.width !== undefined && options.height !== undefined;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = options.width ?? size.x, h = options.height ?? size.y;

    // `lit` goes first when written: three's transmission (KHR_materials_transmission, r187
    // `viewportOpaqueMipTexture`) copies the render target's attachment 0 as the refracted backdrop
    // (WebGPUBackend.copyFramebufferToTexture: `renderContext.textures[0]`). With `output` (scene
    // colour without specular) there, glass refracted every metal (gold trim, a mirror floor) as
    // black (W42, D3520). Without `lit` the backdrop stays specular-free.
    const names: FrameTargetName[] = this.lit ? ['lit', 'output'] : ['output'];
    names.push('normalRoughness', 'albedoMetalness', 'motion');
    if (this.specular) names.push('specular', 'shadingRoughness');
    const depth = new THREE.DepthTexture(w, h, THREE.FloatType);
    depth.name = 'depth';
    const rt = new THREE.RenderTarget(w, h, { count: names.length, type: THREE.HalfFloatType, depthTexture: depth, depthBuffer: true });
    rt.textures.forEach((t, i) => {
      t.name = names[i] === 'motion' ? 'velocity' : names[i]; // MRT outputs bind by texture name
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
    });
    const albedo = rt.textures[names.indexOf('albedoMetalness')];
    albedo.type = THREE.UnsignedByteType; // rgba8unorm
    const motion = rt.textures[names.indexOf('motion')];
    motion.format = THREE.RGFormat; // rg16float
    if (this.specular) rt.textures[names.indexOf('shadingRoughness')].format = THREE.RedFormat; // r16float
    this.renderTarget = rt;
    this.textures = Object.fromEntries([...names.map((n, i) => [n, rt.textures[i]]), ['depth', depth]]) as never;

    this.velocityNode = new HistoryVelocityNode();
    const velocity = (nodeObject(this.velocityNode as N) as N).mul(this.historyValid);
    const motionNode = this.motionMode === 'uv' ? velocity.mul(vec2(0.5, -0.5)) : velocity;
    const outputs: Record<string, N> = {
      output: vec4(sceneColorNoSpecular, (diffuseColor as N).a),
      normalRoughness: vec4(normalWorld, gbufferRoughness),
      albedoMetalness: vec4((diffuseColor as N).rgb, gbufferMetalness),
      velocity: motionNode, // must be 'velocity', see the header
    };
    if (this.lit) outputs.lit = output;
    if (this.specular) { outputs.specular = gbufferSpecular; outputs.shadingRoughness = gbufferShadingRoughness; }
    this.mrt = mrt(outputs);
    // guides clear to zero (no surface); scene colour keeps the renderer's clear / background
    for (const n of ['normalRoughness', 'albedoMetalness', 'velocity', 'lit', 'specular', 'shadingRoughness']) this.mrt.setClearColor(n, 0x000000, 0);
  }

  /** The contract's convention flags for this G-buffer. */
  get conventions(): FrameConventions {
    return {
      depthInverted: this.renderer.reversedDepthBuffer === true,
      depthLinear: false,
      normalUnpackMul: 1,
      normalUnpackAdd: 0,
      roughnessIsPerceptual: true,
      motionVectorScale: this.motionMode === 'uv' ? [1, 1] : [0.5, -0.5],
      sceneColorSpecular: 'none',
    };
  }

  get width() { return this.renderTarget.width; }
  get height() { return this.renderTarget.height; }

  setSize(width: number, height: number) {
    if (width === this.renderTarget.width && height === this.renderTarget.height) return;
    this.renderTarget.setSize(width, height);
  }

  /** Drop the previous frame (camera cut, scene switch): the next render has prev = current and zero motion. */
  resetHistory() { this.history.reset(); }

  /**
   * Render `scene` from `camera` into the G-buffer and return the frame's inputs.
   * `jitter`: the sub-pixel offset (pixels) already applied to `camera` this frame, if any.
   * `projection`: the unjittered projection when `camera.projectionMatrix` carries jitter (e.g.
   * `setViewOffset`). It becomes `camera.projection` in the contract and drives motion, so motion
   * is unjittered; `camera.projectionJittered` keeps the rasterised one.
   */
  render(scene: THREE.Scene, camera: THREE.Camera, opts: { jitter?: readonly [number, number]; projection?: ArrayLike<number> } = {}): FrameInputs {
    const r = this.renderer;
    if (!this.fixedSize) {
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      this.setSize(size.x, size.y);
    }
    // three moves a camera to its clip space (WebGPU z in [0, 1]) and to reversed depth inside
    // render(), then updates the projection; do it first, or the first frame of a camera three
    // hasn't rendered yet carries WebGL's projection (F2)
    const c = camera as THREE.Camera & { reversedDepth?: boolean; updateProjectionMatrix?: () => void };
    if (c.coordinateSystem !== r.coordinateSystem || (r.reversedDepthBuffer === true && c.reversedDepth !== true)) {
      const sync = (r as N)._updateCamera;
      if (typeof sync === 'function') sync.call(r, camera, false);
      else { c.coordinateSystem = r.coordinateSystem; c.updateProjectionMatrix?.(); }
    }
    camera.updateMatrixWorld();
    const p = camera.matrixWorld.elements;
    const cam = camera as THREE.PerspectiveCamera;
    const projection = opts.projection ?? camera.projectionMatrix.elements;
    this.historyValid.value = this.history.hasPrevious ? 1 : 0;
    const frameCamera: FrameCamera = this.history.update({
      view: camera.matrixWorldInverse.elements,
      projection,
      projectionJittered: camera.projectionMatrix.elements,
      near: cam.near ?? 0.1, far: cam.far ?? 1000,
      position: [p[12], p[13], p[14]],
      jitter: opts.jitter,
      reversedDepth: r.reversedDepthBuffer === true,
    });
    const v = this.velocityNode;
    v.prevView.fromArray(frameCamera.prevView as ArrayLike<number> as number[]);
    v.prevProjection.fromArray(frameCamera.prevProjection as ArrayLike<number> as number[]);
    v.projection.fromArray(projection as number[]);

    const prevTarget = r.getRenderTarget();
    const prevMRT = r.getMRT();
    r.setRenderTarget(this.renderTarget);
    r.setMRT(this.mrt);
    r.render(scene, camera);
    r.setRenderTarget(prevTarget);
    r.setMRT(prevMRT);

    this.last = { width: this.width, height: this.height, textures: this.gpuTextures(), conventions: this.conventions, camera: frameCamera, frameIndex: this.frameIndex++ };
    return this.last;
  }

  /** The last render's inputs (null before the first render). */
  get frame(): FrameInputs | null { return this.last; }

  /** The GPU handles behind the targets (valid after the first render; reallocated on resize). */
  gpuTextures(): FrameTextures {
    const g = (t: THREE.Texture) => getGPUTexture(this.renderer, t);
    const nr = g(this.textures.normalRoughness!);
    const am = g(this.textures.albedoMetalness!);
    return {
      depth: g(this.textures.depth),
      normal: nr,
      roughness: { texture: nr, channel: 3 },
      metalness: { texture: am, channel: 3 },
      albedo: am,
      motion: g(this.textures.motion!),
      sceneColor: g(this.textures.output!),
      lit: this.textures.lit ? g(this.textures.lit) : undefined,
    };
  }

  dispose() {
    this.renderTarget.dispose();
    this.textures.depth.dispose();
  }
}
