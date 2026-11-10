// Reflection probes for pixi: core's ProbeSet (atlas, volume table, prefilter, WGSL lookup) on pixi's
// device. SPEC "Capture stays in the adapter", and with pixi-3d the capture is pixi-3d's: six
// renders of the scene from the probe (Camera3D with a renderTexture, examples/pixi3d/shared) hand
// six rgba16float face textures to `captureFaces()`, which stacks them into a cube and lets core
// prefilter it. The environment slot takes the view's Hemisphere, evaluated per texel exactly as
// pixi-3d's envSourceHemisphereBit does (`captureHemisphere()`), so misses see the same sky.
//
//   const probes = new PixiProbeSet(app.renderer, { capacity: 1 });
//   probes.setProbes([{ position: [0, 1.5, 0], influenceSize: [20, 6, 20], projectionSize: [20, 6, 20] }]);
//   probes.captureHemisphere({ sky, ground, up });
//   probes.captureFaces(0, faces);          // six camera renders, WebGPU cube face order +X -X +Y -Y +Z -Z
//
// A cube face is the mirror image of what a camera sees (cube texels run left-handed), so the faces
// come from ordinary right-handed 90-degree cameras looking down each axis, up +Y for the side faces,
// -Z for +Y and +Z for -Y, and `captureFaces()` mirrors x as it stacks them (D2104).
import type { Renderer, Texture } from 'pixi.js';
import { ProbeSet, type ProbeSetOptions, type ProbeVolume } from '@pmndrs/reflections-core';
import { getDevice, getGPUTexture } from './internal/pixiWebGPU';

type Vec3 = readonly [number, number, number];

/** One probe: capture point (and influence-box centre) and the box it lights, world units. */
export interface PixiProbe {
  position: Vec3;
  influenceSize: Vec3;
  /** Box-projection size (parallax). Default: no box projection. */
  projectionSize?: Vec3;
  /** Influence fade distance. Default 1. */
  fade?: number;
  priority?: number;
}

export interface PixiProbeSetOptions extends Partial<Pick<ProbeSetOptions, 'sourceSize' | 'format' | 'dominantDirection' | 'lodMapping'>> {
  /** Probe slots. Default 1. */
  capacity?: number;
  /** An environment slot (the sky for what no probe covers). Default true. */
  environment?: boolean;
}

/** A pixi-3d Hemisphere's linear colours (`writeHemisphere()` from @pixi/3d gives them). */
export interface HemisphereColors {
  sky: ArrayLike<number>;
  ground: ArrayLike<number>;
  /** Unit up axis. Default +Y. */
  up?: ArrayLike<number>;
}

const STACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var f0: texture_2d<f32>;
@group(0) @binding(1) var f1: texture_2d<f32>;
@group(0) @binding(2) var f2: texture_2d<f32>;
@group(0) @binding(3) var f3: texture_2d<f32>;
@group(0) @binding(4) var f4: texture_2d<f32>;
@group(0) @binding(5) var f5: texture_2d<f32>;
@group(0) @binding(6) var cube: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(cube);
  if (any(id.xy >= size)) { return; }
  let p = vec2i(i32(size.x - 1u - id.x), i32(id.y)); // mirror x: camera image -> cube face
  var c: vec4f;
  switch id.z {
    case 0u: { c = textureLoad(f0, p, 0); }
    case 1u: { c = textureLoad(f1, p, 0); }
    case 2u: { c = textureLoad(f2, p, 0); }
    case 3u: { c = textureLoad(f3, p, 0); }
    case 4u: { c = textureLoad(f4, p, 0); }
    default: { c = textureLoad(f5, p, 0); }
  }
  textureStore(cube, id.xy, id.z, vec4f(c.rgb, 1.0));
}
`;

const HEMISPHERE_WGSL = /* wgsl */ `
struct Params { sky: vec4f, ground: vec4f, up: vec4f };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var cube: texture_storage_2d_array<rgba16float, write>;

// WebGPU cube addressing (major axis, then sc / tc per face), inverted: texel centre to direction.
fn faceDir(face: u32, uv: vec2f) -> vec3f {
  let s = uv.x * 2.0 - 1.0;
  let t = uv.y * 2.0 - 1.0;
  switch face {
    case 0u: { return vec3f(1.0, -t, -s); }
    case 1u: { return vec3f(-1.0, -t, s); }
    case 2u: { return vec3f(s, 1.0, t); }
    case 3u: { return vec3f(s, -1.0, -t); }
    case 4u: { return vec3f(s, -t, 1.0); }
    default: { return vec3f(-s, -t, -1.0); }
  }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(cube);
  if (any(id.xy >= size)) { return; }
  let dir = normalize(faceDir(id.z, (vec2f(id.xy) + 0.5) / vec2f(size)));
  let t = dot(dir, params.up.xyz) * 0.5 + 0.5;
  textureStore(cube, id.xy, id.z, vec4f(mix(params.ground.rgb, params.sky.rgb, t), 1.0));
}
`;

export class PixiProbeSet {
  readonly renderer: Renderer;
  readonly device: GPUDevice;
  readonly set: ProbeSet;
  private probes: PixiProbe[] = [];
  private readonly cube: GPUTexture;
  private hemisphere: { pipeline: GPUComputePipeline; params: GPUBuffer; group: GPUBindGroup } | null = null;
  private stack: GPUComputePipeline | null = null;

  constructor(renderer: Renderer, options: PixiProbeSetOptions = {}) {
    this.renderer = renderer;
    this.device = getDevice(renderer);
    this.set = new ProbeSet(this.device, {
      capacity: options.capacity ?? 1,
      sourceSize: options.sourceSize ?? 128,
      format: options.format,
      dominantDirection: options.dominantDirection,
      lodMapping: options.lodMapping,
      environment: options.environment ?? true,
    });
    const n = this.set.sourceSize;
    this.cube = this.device.createTexture({
      label: 'pixi probe capture', size: [n, n, 6], format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
  }

  /** Face size in pixels: the size `captureFaces()` wants. */
  get faceSize() { return this.set.sourceSize; }

  /** Local probes contribute (off: the environment slot only). */
  get enabled() { return this.set.enabled; }
  set enabled(on: boolean) { this.set.enabled = on; this.set.update(); }

  setProbes(probes: readonly PixiProbe[]) {
    if (probes.length > this.set.capacity) throw new Error(`PixiProbeSet: ${probes.length} probes, capacity ${this.set.capacity}`);
    this.probes = [...probes];
    const volumes: ProbeVolume[] = this.probes.map((p, slot) => ({
      slot, center: p.position, halfSize: [p.influenceSize[0] / 2, p.influenceSize[1] / 2, p.influenceSize[2] / 2],
      fade: p.fade ?? 1, priority: p.priority,
      ...(p.projectionSize ? { boxProjection: true, projectionSize: p.projectionSize } : { boxProjection: false }),
    }));
    this.set.setVolumes(volumes);
    this.set.update();
  }

  getProbes(): readonly PixiProbe[] { return this.probes; }

  /**
   * Captures one probe slot from six face renders of `faceSize` pixels (pixi Textures, e.g. capture
   * cameras' RenderTextures; any float or unorm colour format), in WebGPU cube order (+X, -X, +Y,
   * -Y, +Z, -Z), each as a right-handed 90-degree camera sees it (see the header for the up
   * vectors). Stacks them mirrored into the capture cube, prefilters, uploads; submits.
   */
  captureFaces(slot: number, faces: readonly Texture[]) {
    if (faces.length !== 6) throw new Error(`PixiProbeSet: captureFaces wants 6 faces, got ${faces.length}`);
    const n = this.set.sourceSize;
    const device = this.device;
    const views = faces.map((face, layer) => {
      const src = getGPUTexture(this.renderer, face);
      if (src.width !== n || src.height !== n) throw new Error(`PixiProbeSet: face ${layer} is ${src.width}x${src.height}, expected ${n}x${n}`);
      return src.createView();
    });
    this.stack ??= device.createComputePipeline({
      label: 'pixi probe faces', layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'pixi probe faces', code: STACK_WGSL }), entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      label: 'pixi probe faces', layout: this.stack.getBindGroupLayout(0),
      entries: [...views.map((resource, binding) => ({ binding, resource })), { binding: 6, resource: this.cube.createView({ dimension: '2d-array' }) }],
    });
    const encoder = device.createCommandEncoder({ label: `pixi probe capture ${slot}` });
    const pass = encoder.beginComputePass({ label: 'pixi probe faces' });
    pass.setPipeline(this.stack);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), 6);
    pass.end();
    this.set.capture(encoder, slot, this.cube);
    device.queue.submit([encoder.finish()]);
  }

  /** Captures the environment slot from a Hemisphere's linear colours (the view's environment). */
  captureHemisphere(colors: HemisphereColors) {
    if (this.set.environmentSlot < 0) throw new Error('PixiProbeSet: created with environment: false');
    const device = this.device;
    if (!this.hemisphere) {
      const pipeline = device.createComputePipeline({
        label: 'pixi probe hemisphere', layout: 'auto',
        compute: { module: device.createShaderModule({ label: 'pixi probe hemisphere', code: HEMISPHERE_WGSL }), entryPoint: 'main' },
      });
      const params = device.createBuffer({ label: 'pixi probe hemisphere', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: this.cube.createView({ dimension: '2d-array' }) }],
      });
      this.hemisphere = { pipeline, params, group };
    }
    const up = colors.up ?? [0, 1, 0];
    device.queue.writeBuffer(this.hemisphere.params, 0, new Float32Array([
      colors.sky[0], colors.sky[1], colors.sky[2], 0, colors.ground[0], colors.ground[1], colors.ground[2], 0, up[0], up[1], up[2], 0,
    ]));
    const encoder = device.createCommandEncoder({ label: 'pixi probe hemisphere' });
    const pass = encoder.beginComputePass({ label: 'pixi probe hemisphere' });
    pass.setPipeline(this.hemisphere.pipeline);
    pass.setBindGroup(0, this.hemisphere.group);
    const n = this.set.sourceSize;
    pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), 6);
    pass.end();
    this.set.capture(encoder, this.set.environmentSlot, this.cube);
    device.queue.submit([encoder.finish()]);
  }

  /** @internal the capture cube (rgba16float, 6 layers): the last capture. */
  get captureTexture() { return this.cube; }

  dispose() {
    this.hemisphere?.params.destroy();
    this.cube.destroy();
    this.set.dispose();
  }
}
