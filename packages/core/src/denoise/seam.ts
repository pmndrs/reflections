// The denoise seam (docs/SPEC.md, "Frame contract" > "Denoise seam").
//
// The hybrid resolve hands its noisy specular signal to any object shaped like denoiser-core's
// `TemporalDenoiser<SpecularInputs>` (the `denoiser` repo; `FfxReflectionDenoiser` from
// `denoiser/ffx` fits as is). The types below are structural copies of denoiser-core's, so this
// repo never depends on it: `denoiser` stays an optional peer.
//
// What the seam adapts between our frame contract and that interface (DIVERGES D1400-D1403):
//  - motion: our contract stores uv-space motion with `motionVectorScale`; denoiser-core's
//    `FrameGuides.motion` is an NDC delta (current - previous, y up), which FFX hard-codes. The seam
//    converts per frame (one compute pass) into an rgba16float target (rg16float is not a storage
//    format in core WebGPU).
//  - roughness: denoiser-core wants a texture with roughness in .r; ours is a channel of a material
//    target. The same pass extracts it into r32float, in the space the denoiser asks for
//    (`roughness: 'perceptual'` by default, FFX's `roughnessIsPerceptual: true` default), after the
//    contract's `roughnessUnpack` (so a glossiness channel reaches the denoiser as roughness).
//  - normal: unpacked with the contract's mul/add when that is not the identity (three's is).
//  - hit distance: our tracer writes r32float; denoiser-core's docs say r16float. Both bind as
//    `unfilterable-float` and are read with textureLoad, so it is passed as is.
//  - tile lists / indirect args: the denoisers in the denoiser repo dispatch full screen and take no
//    lists, so the seam passes textures only (our 2-D tile args, D601, stay for a later consumer).
//  - camera: our `FrameCamera` is a superset of denoiser-core's and is passed unchanged.
import type { FrameInputs } from '../frame/contract';

/** denoiser-core `SpecularInputs`: noisy reflected radiance (rgba16float) and hit distance (0 = miss). */
export interface SpecularInputs {
  radiance: GPUTexture;
  hitDistance: GPUTexture;
}

/** denoiser-core `FrameGuides`. */
export interface DenoiseGuides {
  /** Hardware depth or r32float device depth. */
  depth: GPUTexture;
  /** World-space unit normals in [-1, 1]. */
  normal: GPUTexture;
  /** Screen motion, NDC delta current - previous (y up). */
  motion: GPUTexture;
  /** Roughness in .r. */
  roughness?: GPUTexture;
  albedo?: GPUTexture;
}

/** denoiser-core `FrameCamera` (ours, `FrameInputs.camera`, is a superset). */
export interface DenoiseCamera {
  view: ArrayLike<number>;
  projection: ArrayLike<number>;
  prevView: ArrayLike<number>;
  prevProjection: ArrayLike<number>;
  jitter?: readonly [number, number];
  near: number;
  far: number;
  position?: readonly [number, number, number];
  reversedDepth?: boolean;
}

/** denoiser-core `TemporalDenoiser<Inputs>`, structurally. */
export interface TemporalDenoiser<Inputs extends object = SpecularInputs> {
  readonly name: string;
  readonly device: GPUDevice;
  configure(config: { width: number; height: number }): void;
  dispatch(inputs: Inputs, guides: DenoiseGuides, camera: DenoiseCamera): GPUTexture;
  resetHistory(): void;
  readonly gpuTimings?: ReadonlyMap<string, number>;
  dispose(): void;
}

export interface ReflectionDenoiseSeamOptions {
  denoiser: TemporalDenoiser<SpecularInputs>;
  /**
   * The motion convention the denoiser reads. 'ndc' (default): denoiser-core's NDC delta, what
   * `FfxReflectionDenoiser` hard-codes. 'uv': our contract's uv-space delta (scale applied).
   */
  motion?: 'ndc' | 'uv';
  /** The roughness space the denoiser expects in `guides.roughness`. Default 'perceptual' (FFX's default). */
  roughness?: 'perceptual' | 'alpha';
  /** Also time the guides pass (needs 'timestamp-query'); see `readTimings()`. Default false. */
  timestamps?: boolean;
}

/**
 * Maps one frame of the contract onto the denoiser's guides and runs it. Call `dispatch` after the
 * frame's signal has been submitted; it submits its own guides pass, then the denoiser's work.
 */
export interface ReflectionDenoiseSeam {
  readonly denoiser: TemporalDenoiser<SpecularInputs>;
  /** The guides of the last dispatch (for debug views). */
  readonly guides: DenoiseGuides | null;
  /** Denoise. Returns the denoiser's output texture (owned by it, valid until its next dispatch). */
  dispatch(frame: FrameInputs, signal: SpecularInputs): GPUTexture;
  resetHistory(): void;
  destroy(): void;
}

const GUIDES_WGSL = /* wgsl */ `
struct U { size: vec2u, roughChannel: u32, flags: u32, motionScale: vec2f, normalMul: f32, normalAdd: f32, roughMul: f32, roughAdd: f32 };
// flags: bit 0 = motion out as NDC delta; bit 1 = square roughness (perceptual -> alpha);
//        bit 2 = sqrt roughness (alpha -> perceptual); bit 3 = write the unpacked normal
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tMotion: texture_2d<f32>;
@group(0) @binding(2) var tRough: texture_2d<f32>;
@group(0) @binding(3) var tNormal: texture_2d<f32>;
@group(0) @binding(4) var oMotion: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var oRough: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var oNormal: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= u.size)) { return; }
  // contract: uvPrevious = uv - motion * scale (uv y down); NDC delta = (2 du, -2 dv)
  let duv = textureLoad(tMotion, id.xy, 0).xy * u.motionScale;
  let m = select(duv, vec2f(2.0, -2.0) * duv, (u.flags & 1u) != 0u);
  textureStore(oMotion, id.xy, vec4f(m, 0.0, 0.0));
  var r = textureLoad(tRough, id.xy, 0)[u.roughChannel] * u.roughMul + u.roughAdd;
  if ((u.flags & 2u) != 0u) { r = r * r; }
  if ((u.flags & 4u) != 0u) { r = sqrt(max(r, 0.0)); }
  textureStore(oRough, id.xy, vec4f(r, 0.0, 0.0, 0.0));
  if ((u.flags & 8u) != 0u) {
    let n = textureLoad(tNormal, id.xy, 0).xyz * u.normalMul + u.normalAdd;
    textureStore(oNormal, id.xy, vec4f(normalize(n), 0.0));
  }
}
`;

export function createReflectionDenoiseSeam(device: GPUDevice, options: ReflectionDenoiseSeamOptions): ReflectionDenoiseSeam {
  const { denoiser } = options;
  const motionOut = options.motion ?? 'ndc';
  const roughOut = options.roughness ?? 'perceptual';
  const C = GPUShaderStage.COMPUTE;
  const layout = device.createBindGroupLayout({
    label: 'denoise seam guides',
    entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      { binding: 5, visibility: C, storageTexture: { access: 'write-only', format: 'r32float' } },
      { binding: 6, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });
  const pipeline = device.createComputePipeline({
    label: 'denoise seam guides',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ label: 'denoise seam guides', code: GUIDES_WGSL }), entryPoint: 'main' },
  });
  const uniforms = device.createBuffer({ label: 'denoise seam guides', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let width = 0, height = 0;
  let motion: GPUTexture | null = null, roughness: GPUTexture | null = null, normal: GPUTexture | null = null;
  let guides: DenoiseGuides | null = null;
  const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

  const ensure = (w: number, h: number) => {
    if (w === width && h === height && motion) return;
    for (const t of [motion, roughness, normal]) t?.destroy();
    width = w; height = h;
    motion = device.createTexture({ label: 'denoise seam motion', size: [w, h], format: 'rgba16float', usage });
    roughness = device.createTexture({ label: 'denoise seam roughness', size: [w, h], format: 'r32float', usage });
    normal = device.createTexture({ label: 'denoise seam normal', size: [w, h], format: 'rgba16float', usage });
    denoiser.configure({ width: w, height: h });
  };

  return {
    denoiser,
    get guides() { return guides; },
    dispatch(frame, signal) {
      const c = frame.conventions;
      if (c.depthLinear) throw new Error('denoise seam: the denoiser reads device depth; linear depth (depthLinear) is not supported');
      ensure(frame.width, frame.height);
      const unpackNormal = c.normalUnpackMul !== 1 || c.normalUnpackAdd !== 0;
      let flags = motionOut === 'ndc' ? 1 : 0;
      if (c.roughnessIsPerceptual && roughOut === 'alpha') flags |= 2;
      if (!c.roughnessIsPerceptual && roughOut === 'perceptual') flags |= 4;
      if (unpackNormal) flags |= 8;
      const buf = new ArrayBuffer(48);
      const u32 = new Uint32Array(buf), f32 = new Float32Array(buf);
      u32[0] = width; u32[1] = height; u32[2] = frame.textures.roughness.channel; u32[3] = flags;
      f32[4] = c.motionVectorScale[0]; f32[5] = c.motionVectorScale[1]; f32[6] = c.normalUnpackMul; f32[7] = c.normalUnpackAdd;
      f32[8] = c.roughnessUnpack?.mul ?? 1; f32[9] = c.roughnessUnpack?.add ?? 0;
      device.queue.writeBuffer(uniforms, 0, buf);
      const enc = device.createCommandEncoder({ label: 'denoise seam guides' });
      const pass = enc.beginComputePass({ label: 'denoise seam guides' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: frame.textures.motion.createView() },
          { binding: 2, resource: frame.textures.roughness.texture.createView() },
          { binding: 3, resource: frame.textures.normal.createView() },
          { binding: 4, resource: motion!.createView() },
          { binding: 5, resource: roughness!.createView() },
          { binding: 6, resource: normal!.createView() },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      device.queue.submit([enc.finish()]);
      guides = {
        depth: frame.textures.depth,
        normal: unpackNormal ? normal! : frame.textures.normal,
        motion: motion!,
        roughness: roughness!,
        albedo: frame.textures.albedo,
      };
      return denoiser.dispatch(signal, guides, frame.camera);
    },
    resetHistory() { denoiser.resetHistory(); },
    destroy() {
      for (const t of [motion, roughness, normal]) t?.destroy();
      motion = roughness = normal = null;
      uniforms.destroy();
    },
  };
}
