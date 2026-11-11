// How an engine's cube captures relate to the WebGPU cube convention the probe core works in
// (D1805, D2104). Two parts, either or both:
//
//   axes   a direction transform, applied by the lookup and the irradiance pass to every world
//          direction before it reaches the layout: texture-space component i is the signed world
//          component axes[i]. Free at run time; any of the cube's 48 symmetries (axis mirrors and
//          axis swaps). three's CubeCamera: ['-x', 'y', 'z'] (what `mirrorX` means); a Babylon
//          ReflectionProbe cube on WebGPU: ['x', '-y', 'z'].
//   faces  a face remap, applied by ProbeSet.capture() as it reads the capture in (one compute
//          pass in place of the copy): destination face f of the WebGPU cube takes texel (x, y) of
//          source layer faces[f].layer, flipped in x and / or y. Covers captures that aren't a
//          mirror of the world: pixi-3d's camera images (every face flipped in x, D2104), or
//          Babylon's cube rewritten to WebGPU's convention (±Y swapped, rows flipped, D1805).
//
// The prefilter works in texture space, so for the GGX lobe an axis transform and the equivalent
// face remap are the same capture, up to the prefilter's sample pattern (W35, examples/probe-core:
// three's mirror bit-identical, Babylon's float max 3.9e-3, 0 / 255; D1805).

/** A signed world axis. */
export type ProbeAxis = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';

/** Where destination face `f` (WebGPU order +X -X +Y -Y +Z -Z) of the capture comes from. */
export interface ProbeCaptureFace {
  /** Array layer of the source capture. */
  layer: number;
  /** Read the source row right to left. */
  flipX?: boolean;
  /** Read the source bottom row first. */
  flipY?: boolean;
}

export interface ProbeCaptureTransform {
  /** Texture-space direction = (world[axes[0]], world[axes[1]], world[axes[2]]), signed. Default ['x', 'y', 'z']. */
  axes?: readonly [ProbeAxis, ProbeAxis, ProbeAxis];
  /** Six entries, one per destination face (ProbeSet.capture only). Default: layer f, no flips. */
  faces?: readonly ProbeCaptureFace[];
}

/** three's CubeCamera: the world mirrored in x (`mirrorX: true`). */
export const CAPTURE_MIRROR_X: ProbeCaptureTransform = Object.freeze({ axes: Object.freeze(['-x', 'y', 'z'] as const) });
/** A Babylon ReflectionProbe cube on WebGPU, read as it is: the world mirrored in y (D1805). */
export const CAPTURE_MIRROR_Y: ProbeCaptureTransform = Object.freeze({ axes: Object.freeze(['x', '-y', 'z'] as const) });
/** A Babylon ReflectionProbe cube on WebGPU, rewritten into WebGPU's convention at capture: ±Y swapped, rows flipped (D1805's compute pass). */
export const CAPTURE_BABYLON_FACES: ProbeCaptureTransform = Object.freeze({ faces: Object.freeze([0, 1, 3, 2, 4, 5].map((layer) => Object.freeze({ layer, flipY: true }))) });
/** Six camera images in WebGPU face order, each the mirror image of its cube face (pixi-3d's captures, D2104). */
export const CAPTURE_CAMERA_FACES: ProbeCaptureTransform = Object.freeze({ faces: Object.freeze([0, 1, 2, 3, 4, 5].map((layer) => Object.freeze({ layer, flipX: true }))) });

/** The options that name a transform: `mirrorX` is an alias of {@link CAPTURE_MIRROR_X}. */
export interface ProbeCaptureTransformOptions {
  /** The captures are x-mirrored (three's CubeCamera): `captureTransform: CAPTURE_MIRROR_X`. Default false. */
  mirrorX?: boolean;
  /** See {@link ProbeCaptureTransform}. Default: none (WebGPU's convention). */
  captureTransform?: ProbeCaptureTransform;
}

/** The transform `options` name (validated); throws if both `mirrorX` and `captureTransform` are given. */
export function resolveCaptureTransform(options: ProbeCaptureTransformOptions): ProbeCaptureTransform {
  if (options.mirrorX === true && options.captureTransform !== undefined) {
    throw new Error('probe capture: pass either mirrorX (an alias of CAPTURE_MIRROR_X) or captureTransform, not both');
  }
  const t = options.mirrorX === true ? CAPTURE_MIRROR_X : (options.captureTransform ?? {});
  if (t.axes !== undefined) {
    const used = t.axes.map((a) => a.replace('-', ''));
    if (t.axes.length !== 3 || new Set(used).size !== 3 || used.some((a) => !'xyz'.includes(a) || a.length !== 1)) throw new Error(`probe capture: axes must be a signed permutation of x, y, z, got [${t.axes.join(', ')}]`);
  }
  if (t.faces !== undefined) {
    if (t.faces.length !== 6 || t.faces.some((f) => !Number.isInteger(f.layer) || f.layer < 0 || f.layer > 5)) throw new Error('probe capture: faces needs 6 entries with layer 0 ... 5');
  }
  return t;
}

/** True when the transform changes directions. */
export function hasCaptureAxes(t: ProbeCaptureTransform) {
  return t.axes !== undefined && t.axes.join() !== 'x,y,z';
}

/** True when the transform remaps faces. */
export function hasCaptureFaces(t: ProbeCaptureTransform) {
  return t.faces !== undefined && t.faces.some((f, i) => f.layer !== i || f.flipX === true || f.flipY === true);
}

/** WGSL expression: the world direction `d` (a vec3f expression) in the capture's texture space. */
export function captureAxesWgsl(t: ProbeCaptureTransform, d: string): string {
  if (!hasCaptureAxes(t)) return d;
  return `vec3f(${t.axes!.map((a) => (a.startsWith('-') ? `-(${d}).${a[1]}` : `(${d}).${a}`)).join(', ')})`;
}

const REMAP_WGSL = /* wgsl */ `
struct Face { layer: u32, flipX: u32, flipY: u32, pad: u32 }
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> faces: array<Face, 6>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = textureDimensions(dst).x;
  if (id.x >= n || id.y >= n) { return; }
  let f = faces[id.z];
  let x = select(id.x, n - 1u - id.x, f.flipX != 0u);
  let y = select(id.y, n - 1u - id.y, f.flipY != 0u);
  textureStore(dst, id.xy, id.z, textureLoad(src, vec2u(x, y), f.layer, 0));
}`;

/**
 * The capture-time face remap of a {@link ProbeCaptureTransform}: writes mip 0 of a WebGPU cube
 * (rgba16float, 6 layers, STORAGE_BINDING) from a capture (6 layers, TEXTURE_BINDING, read through
 * a '2d-array' view, mip 0).
 */
export class ProbeCaptureRemap {
  private readonly device: GPUDevice;
  private readonly pipe: GPUComputePipeline;
  private readonly faces: GPUBuffer;

  constructor(device: GPUDevice, transform: ProbeCaptureTransform) {
    this.device = device;
    const faces: readonly ProbeCaptureFace[] = transform.faces ?? [0, 1, 2, 3, 4, 5].map((layer) => ({ layer }));
    this.faces = device.createBuffer({ label: 'ProbeCaptureRemap.faces', size: 96, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    new Uint32Array(this.faces.getMappedRange()).set(faces.flatMap((f) => [f.layer, f.flipX === true ? 1 : 0, f.flipY === true ? 1 : 0, 0]));
    this.faces.unmap();
    this.pipe = device.createComputePipeline({
      label: 'ProbeCaptureRemap', layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'ProbeCaptureRemap', code: REMAP_WGSL }), entryPoint: 'main' },
    });
  }

  /** Records `dst` mip 0 = remapped `source` mip 0 (same face size). */
  encode(encoder: GPUCommandEncoder, source: GPUTexture, dst: GPUTexture) {
    const n = dst.width;
    if (source.width !== n || source.height !== n) throw new Error(`ProbeCaptureRemap: the capture is ${source.width}x${source.height}, expected ${n}x${n}`);
    const pass = encoder.beginComputePass({ label: 'ProbeCaptureRemap' });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 6 }) },
        { binding: 1, resource: dst.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 2, resource: { buffer: this.faces } },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), 6);
    pass.end();
  }

  dispose() {
    this.faces.destroy();
  }
}
