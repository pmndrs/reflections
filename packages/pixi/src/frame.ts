// The frame contract (core FrameInputs) from a pixi-3d View3D (./pixi3d.ts has what it provides).
// One compute pass unpacks pixi-3d's outputs into the textures core and the composite read:
//
//   in   gbuffer    rgba32float  REFLECTIONS_GBUFFER: oct normal, roughness + metallic, base colour
//        depth      DepthOutputPass, depth24plus-stencil8 (depth-only view), standard Z
//        motion     MotionVectorPass, rg16float, currentNdc - previousNdc, y up
//   out  depth      r32float     device depth, copied (core's pyramid and the denoise seam read r32float
//                                 device depth; a combined depth-stencil can't be bound whole)
//        normal     rgba16float  world normal xyz, perceptual roughness w   normalUnpack 1, 0
//        material   rgba8unorm   linear base colour rgb, metalness a         F0 = mix(0.04, albedo, metalness)
//        motion     rgba16float  uv motion xy (y down), N.V z, geometry w    motionVectorScale [1, 1]
//
// sceneColor is the View3D's own render (rgba16float, `toneMapping: 'custom'`, with
// REFLECTIONS_SCENE_COLOR_BIT on its materials: sceneColorSpecular 'direct'). Camera: pixi-3d is
// right-handed with -Z forward like the contract; its projection is GL clip z, remapped to WebGPU's
// [0, 1] here. Rendered into a RenderTexture, pixi-3d's rows run top-down like the contract's uv
// (checked on the GPU: `pnpm check -- --only pixi3d`, the motion and orientation checks).
import { FrameCameraHistory, type FrameConventions, type FrameInputs } from '@pmndrs/reflections-core';
import type { Renderer, Texture } from 'pixi.js';
import { createPixiTarget, getDevice, getGPUTexture } from './internal/pixiWebGPU';
import type { Pixi3DCameraLike } from './pixi3d';

/** The conventions of the unpacked frame. */
export const PIXI3D_FRAME_CONVENTIONS: FrameConventions = Object.freeze({
  depthInverted: false,
  depthLinear: false,
  normalUnpackMul: 1,
  normalUnpackAdd: 0,
  roughnessIsPerceptual: true,
  motionVectorScale: [1, 1] as const,
  sceneColorSpecular: 'direct' as const,
});

/** pixi-3d's outputs for one frame, all the view's size (pixi Textures, e.g. `depthPass.texture`). */
export interface Pixi3DFrameSources {
  /** The view rendered into an rgba16float RenderTexture: `renderer.render({ container: view3d, target })`. */
  color: Texture;
  /** `DepthOutputPass.texture`. */
  depth: Texture;
  /** `MotionVectorPass.texture`. */
  motion: Texture;
  /** The REFLECTIONS_GBUFFER pass's texture (examples/pixi3d/shared). */
  gbuffer: Texture;
}

const UNPACK_WGSL = /* wgsl */ `
struct Params { invViewProj: mat4x4f, eye: vec4f };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var gbuffer: texture_2d<f32>;
@group(0) @binding(2) var depthIn: texture_depth_2d;
@group(0) @binding(3) var motionIn: texture_2d<f32>;
@group(0) @binding(4) var depthOut: texture_storage_2d<r32float, write>;
@group(0) @binding(5) var normalOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var materialOut: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(7) var motionOut: texture_storage_2d<rgba16float, write>;

fn octDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthOut);
  if (any(id.xy >= size)) { return; }
  let p = vec2i(id.xy);
  let d = textureLoad(depthIn, p, 0);
  textureStore(depthOut, p, vec4f(d, 0.0, 0.0, 1.0));
  let mv = textureLoad(motionIn, p, 0).xy * vec2f(0.5, -0.5);
  if (d >= 1.0) {
    textureStore(normalOut, p, vec4f(0.0, 0.0, 0.0, 1.0));
    textureStore(materialOut, p, vec4f(0.0));
    textureStore(motionOut, p, vec4f(mv, 0.0, 0.0));
    return;
  }
  let g = textureLoad(gbuffer, p, 0);
  let n = octDecode(g.xy);
  let rm = u32(g.z + 0.5);
  let roughness = f32(rm & 1023u) / 1023.0;
  let metalness = f32(rm >> 10u) / 255.0;
  let c = u32(g.w + 0.5);
  let albedo = vec3f(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u)) / 255.0;
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let clip = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  let w = params.invViewProj * clip;
  let viewDir = normalize(params.eye.xyz - w.xyz / w.w);
  textureStore(normalOut, p, vec4f(n, roughness));
  textureStore(materialOut, p, vec4f(albedo, metalness));
  textureStore(motionOut, p, vec4f(mv, max(dot(n, viewDir), 0.0), 1.0));
}
`;

type Target = ReturnType<typeof createPixiTarget>;

/** The unpacked frame's pixi textures (+ raw handles). */
export class Pixi3DFrameTargets {
  readonly width: number;
  readonly height: number;
  readonly depth: Target;
  readonly normal: Target;
  readonly material: Target;
  readonly motion: Target;
  constructor(renderer: Renderer, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.depth = createPixiTarget(renderer, 'reflections: device depth', width, height, 'r32float', true);
    this.normal = createPixiTarget(renderer, 'reflections: normal + roughness', width, height, 'rgba16float', true);
    this.material = createPixiTarget(renderer, 'reflections: albedo + metalness', width, height, 'rgba8unorm', true);
    this.motion = createPixiTarget(renderer, 'reflections: uv motion, N.V, mask', width, height, 'rgba16float', true);
  }
  destroy() {
    this.depth.destroy();
    this.normal.destroy();
    this.material.destroy();
    this.motion.destroy();
  }
}

/** Column-major a · b. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
    r[c * 4 + row] = s;
  }
  return r;
}

/** General 4x4 inverse (column-major). */
export function mat4Invert(m: ArrayLike<number>): Float32Array {
  const a = Array.from(m);
  const inv = new Float32Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  const s = det === 0 ? 0 : 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= s;
  return inv;
}

/** A GL-convention projection (clip z in [-w, w]) with clip z remapped to WebGPU's [0, w]. */
export function projectionToZeroOne(glProjection: ArrayLike<number>): Float32Array {
  const p = Float32Array.from(glProjection);
  for (let c = 0; c < 4; c++) p[c * 4 + 2] = 0.5 * p[c * 4 + 2] + 0.5 * p[c * 4 + 3];
  return p;
}

/** The world-space eye of a rigid world-to-camera matrix: -Rᵀ t. */
export function eyeFromView(view: ArrayLike<number>): [number, number, number] {
  const t = [view[12], view[13], view[14]];
  return [0, 1, 2].map((i) => -(view[i * 4] * t[0] + view[i * 4 + 1] * t[1] + view[i * 4 + 2] * t[2])) as [number, number, number];
}

/** The pixi-3d camera as the contract wants it (view, WebGPU-clip projections, eye). */
export function cameraFromPixi3D(camera: Pixi3DCameraLike) {
  const view = Float32Array.from(camera.view.elements);
  return {
    view,
    projection: projectionToZeroOne(camera.unjitteredProjection.elements),
    projectionJittered: projectionToZeroOne(camera.projection.elements),
    eye: eyeFromView(view),
    near: camera.near,
    far: camera.far,
    jitter: [camera.jitter?.x ?? 0, camera.jitter?.y ?? 0] as const,
  };
}

/**
 * Builds core's FrameInputs from a pixi-3d View3D's outputs: unpacks them (one compute pass, recorded
 * into the caller's encoder) and keeps the previous camera for motion and the denoise seam.
 */
export class Pixi3DFrame {
  readonly conventions = PIXI3D_FRAME_CONVENTIONS;
  readonly renderer: Renderer;
  readonly device: GPUDevice;
  private readonly history = new FrameCameraHistory();
  private frameIndex = 0;
  private readonly pipeline: GPUComputePipeline;
  private readonly params: GPUBuffer;
  private group: { key: GPUTexture[]; group: GPUBindGroup } | null = null;
  private targetsOf: Pixi3DFrameTargets | null = null;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.device = getDevice(renderer);
    const C = GPUShaderStage.COMPUTE;
    const layout = this.device.createBindGroupLayout({
      label: 'pixi3d frame: unpack',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: C, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: C, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 5, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 6, visibility: C, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 7, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      ],
    });
    this.pipeline = this.device.createComputePipeline({
      label: 'pixi3d frame: unpack',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: this.device.createShaderModule({ label: 'pixi3d frame: unpack', code: UNPACK_WGSL }), entryPoint: 'main' },
    });
    this.params = this.device.createBuffer({ label: 'pixi3d frame: params', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** The next frame has no previous one (camera cut). */
  resetHistory() { this.history.reset(); }
  get hasPrevious() { return this.history.hasPrevious; }

  /**
   * Records the unpack into `encoder` and returns the frame. Call after pixi rendered the view this
   * frame (the camera's matrices are rebuilt by that render).
   */
  build(encoder: GPUCommandEncoder, sources: Pixi3DFrameSources, camera: Pixi3DCameraLike, targets: Pixi3DFrameTargets): FrameInputs {
    const { width, height } = targets;
    const tex = {
      color: getGPUTexture(this.renderer, sources.color),
      depth: getGPUTexture(this.renderer, sources.depth),
      motion: getGPUTexture(this.renderer, sources.motion),
      gbuffer: getGPUTexture(this.renderer, sources.gbuffer),
    };
    for (const [k, t] of Object.entries(tex)) {
      if (t.width !== width || t.height !== height) throw new Error(`Pixi3DFrame: ${k} is ${t.width}x${t.height}, expected ${width}x${height} (render the view at the frame's size)`);
    }
    const cam = cameraFromPixi3D(camera);
    const data = new Float32Array(20);
    data.set(mat4Invert(mul(cam.projectionJittered, cam.view)), 0);
    data.set(cam.eye, 16);
    this.device.queue.writeBuffer(this.params, 0, data);

    const key = [tex.gbuffer, tex.depth, tex.motion, targets.depth.gpu];
    if (!this.group || this.targetsOf !== targets || this.group.key.some((t, i) => t !== key[i])) {
      const depthView = tex.depth.createView({ aspect: tex.depth.format.includes('stencil') ? 'depth-only' : 'all' });
      this.group = {
        key,
        group: this.device.createBindGroup({
          label: 'pixi3d frame: unpack',
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.params } },
            { binding: 1, resource: tex.gbuffer.createView() },
            { binding: 2, resource: depthView },
            { binding: 3, resource: tex.motion.createView() },
            { binding: 4, resource: targets.depth.gpu.createView() },
            { binding: 5, resource: targets.normal.gpu.createView() },
            { binding: 6, resource: targets.material.gpu.createView() },
            { binding: 7, resource: targets.motion.gpu.createView() },
          ],
        }),
      };
      this.targetsOf = targets;
    }
    const pass = encoder.beginComputePass({ label: 'pixi3d frame: unpack' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group.group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();

    return {
      width,
      height,
      textures: {
        depth: targets.depth.gpu,
        normal: targets.normal.gpu,
        roughness: { texture: targets.normal.gpu, channel: 3 },
        metalness: { texture: targets.material.gpu, channel: 3 },
        albedo: targets.material.gpu,
        motion: targets.motion.gpu,
        sceneColor: tex.color,
      },
      conventions: this.conventions,
      camera: this.history.update({
        view: cam.view, projection: cam.projection, projectionJittered: cam.projectionJittered,
        near: cam.near, far: cam.far, position: cam.eye, jitter: cam.jitter, reversedDepth: false,
      }),
      frameIndex: this.frameIndex++,
    };
  }

  dispose() {
    this.params.destroy();
  }
}
