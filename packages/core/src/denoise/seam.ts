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
//  - hit source (W53, optional, D3660): denoiser-core's `SpecularInputs.hitSource` (HIT_SOURCE codes
//    in an r32float) is built here from the tracer's confidence and the ray-traced pass's RT_SOURCE
//    codes, when `dispatch` is given them. Denoisers that know it keep screen-space hits, traced hits
//    and misses apart (FFX: `separateHitSources`).
import type { FrameInputs } from '../frame/contract';
import { RT_SOURCE } from '../trace/shaders';

/**
 * denoiser-core `SpecularInputs`: noisy reflected radiance (rgba16float), hit distance (0 = miss)
 * and, optionally, which pass produced each sample (`HIT_SOURCE` codes in .r).
 */
export interface SpecularInputs {
  radiance: GPUTexture;
  hitDistance: GPUTexture;
  hitSource?: GPUTexture;
}

/** denoiser-core `HIT_SOURCE`: the codes of `SpecularInputs.hitSource`. */
export const HIT_SOURCE = { miss: 0, screen: 1, traced: 2 } as const;

/**
 * What the seam builds `SpecularInputs.hitSource` from (W53). `confidence`: the tracer's (r32float,
 * after the ray-traced pass). `traceSource`: the ray-traced pass's RT_SOURCE codes (r32float), or
 * null without it.
 */
export interface DenoiseHitSources {
  confidence: GPUTexture;
  traceSource?: GPUTexture | null;
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
  /** The hit source of the last dispatch that was given `sources` (r32float, HIT_SOURCE codes), else null. */
  readonly hitSource: GPUTexture | null;
  /**
   * Denoise. Returns the denoiser's output texture (owned by it, valid until its next dispatch).
   * With `sources` (W53), the seam also hands the denoiser `hitSource`, built from them: a traced
   * hit off screen is `traced`; a screen-space hit (confidence > 0, W52's reading) or a traced hit shaded from
   * the on-screen colour is `screen`; anything else is `miss`. A `signal.hitSource` given by the
   * caller is passed as is.
   */
  dispatch(frame: FrameInputs, signal: SpecularInputs, sources?: DenoiseHitSources | null): GPUTexture;
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

// W53 (D3660): HIT_SOURCE per pixel from the confidence and the ray-traced pass's RT_SOURCE codes.
// A traced hit shaded from the on-screen colour (onScreenHit) counts as a screen-space hit: its
// radiance is the screen's, re-shaded as the screen-space hits are (D3540).
const HIT_SOURCE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> size: vec4u; // xy size, z = 1 with a trace source
@group(0) @binding(1) var tConfidence: texture_2d<f32>;
@group(0) @binding(2) var tTrace: texture_2d<f32>;
@group(0) @binding(3) var oSource: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= size.xy)) { return; }
  let rt = select(0u, u32(textureLoad(tTrace, id.xy, 0).x + 0.5), size.z != 0u);
  var s = select(${HIT_SOURCE.miss}.0, ${HIT_SOURCE.screen}.0, textureLoad(tConfidence, id.xy, 0).x > 0.0);
  if (rt == ${RT_SOURCE.tracedHit}u) { s = ${HIT_SOURCE.traced}.0; }
  if (rt == ${RT_SOURCE.onScreenHit}u) { s = ${HIT_SOURCE.screen}.0; }
  if (rt == ${RT_SOURCE.tracedMiss}u) { s = ${HIT_SOURCE.miss}.0; }
  textureStore(oSource, id.xy, vec4f(s, 0.0, 0.0, 0.0));
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
  // W53: the hit-source pass, made on first use
  let source: { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout; uniforms: GPUBuffer; none: GPUTexture; out: GPUTexture | null } | null = null;
  let lastSource: GPUTexture | null = null;
  const buildHitSource = (enc: GPUCommandEncoder, s: DenoiseHitSources): GPUTexture => {
    if (!source) {
      const l = device.createBindGroupLayout({
        label: 'denoise seam hit source',
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'uniform' } },
          { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 2, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 3, visibility: C, storageTexture: { access: 'write-only', format: 'r32float' } },
        ],
      });
      source = {
        layout: l,
        pipeline: device.createComputePipeline({
          label: 'denoise seam hit source', layout: device.createPipelineLayout({ bindGroupLayouts: [l] }),
          compute: { module: device.createShaderModule({ label: 'denoise seam hit source', code: HIT_SOURCE_WGSL }), entryPoint: 'main' },
        }),
        uniforms: device.createBuffer({ label: 'denoise seam hit source', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        none: device.createTexture({ label: 'denoise seam no trace source', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING }),
        out: null,
      };
    }
    if (!source.out || source.out.width !== width || source.out.height !== height) {
      source.out?.destroy();
      source.out = device.createTexture({ label: 'denoise seam hit source', size: [width, height], format: 'r32float', usage });
    }
    device.queue.writeBuffer(source.uniforms, 0, new Uint32Array([width, height, s.traceSource ? 1 : 0, 0]));
    const pass = enc.beginComputePass({ label: 'denoise seam hit source' });
    pass.setPipeline(source.pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: source.layout,
      entries: [
        { binding: 0, resource: { buffer: source.uniforms } },
        { binding: 1, resource: s.confidence.createView() },
        { binding: 2, resource: (s.traceSource ?? source.none).createView() },
        { binding: 3, resource: source.out.createView() },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    return source.out;
  };
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
    get hitSource() { return lastSource; },
    dispatch(frame, signal, sources) {
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
      lastSource = sources && !signal.hitSource ? buildHitSource(enc, sources) : null;
      device.queue.submit([enc.finish()]);
      guides = {
        depth: frame.textures.depth,
        normal: unpackNormal ? normal! : frame.textures.normal,
        motion: motion!,
        roughness: roughness!,
        albedo: frame.textures.albedo,
      };
      return denoiser.dispatch(lastSource ? { ...signal, hitSource: lastSource } : signal, guides, frame.camera);
    },
    resetHistory() { denoiser.resetHistory(); },
    destroy() {
      for (const t of [motion, roughness, normal]) t?.destroy();
      motion = roughness = normal = null;
      uniforms.destroy();
      if (source) { source.out?.destroy(); source.none.destroy(); source.uniforms.destroy(); source = null; }
      lastSource = null;
    },
  };
}
