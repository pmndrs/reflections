// Screen-space reflections on a bare GPUDevice: a WGSL port of the stochastic screen-space
// reflection tracer in the AMD FidelityFX SDK v1.1.4 (Copyright (C) 2024 Advanced Micro Devices,
// Inc., MIT; see NOTICE and shaders.ts). Pass order follows sssrDispatch() in
// sdk/src/components/sssr/ffx_sssr.cpp:
//
//   depth downsample   depth -> min (max if inverted) depth pyramid, r32float, <= 7 mips
//   classify tiles     roughness -> ray list, denoiser tile list, ray counter, extracted roughness;
//                      rough pixels take the radiance fallback right here
//   blue noise         128x128 rg noise for this frame
//   indirect args      ray counter -> dispatchWorkgroupsIndirect args (intersect, denoiser)
//   intersect          Hi-Z march per listed ray -> radiance (rgb + ray length) and hit distance;
//                      optional miss list (hybrid sample) + its own indirect args
//
// The denoiser is not here (it lives in the denoiser repo); the outputs are what its seam takes.
import { blueNoiseBytes } from './blueNoiseData';
import { createDepthPyramidBuilder, createDepthPyramidTexture, depthPyramidMipCount } from './depthPyramid';
import { mat4Invert, mat4Mul, type Mat4Like } from './math';
import {
  BLUE_NOISE_WGSL, classifyWgsl, CONSTANT_FALLBACK_WGSL, ENVIRONMENT_FALLBACK_WGSL,
  INDIRECT_ARGS_WGSL, intersectWgsl, missArgsWgsl, PARAMS_SIZE, type Variant,
} from './shaders';
import { PassTimer } from './timer';
import type { FrameInputs } from '../frame/contract';

export type ScreenSpaceVariant = Variant;

/**
 * The hybrid-reflections sample's thickness (FFX SDK v1.1.4): 0.2 + 10 alpha + 0.01 x ray length.
 * The default (DIVERGES D42, D1001): on mirrorWall it fills reflections of curved objects that
 * the constant leaves partly rejected, for a small rise in hits accepted behind objects.
 */
export const THICKNESS_HYBRID = Object.freeze({ depthBufferThickness: 0.2, thicknessRoughnessFactor: 10, thicknessLengthFactor: 0.01 });
/** FFX SSSR's constant 0.015 thickness (view-space units), no roughness or length terms. */
export const THICKNESS_CONSTANT = Object.freeze({ depthBufferThickness: 0.015, thicknessRoughnessFactor: 0, thicknessLengthFactor: 0 });

/** Default `roughnessThreshold`, perceptual: sqrt of FFX's 0.2 alpha, rounded. */
export const DEFAULT_ROUGHNESS_THRESHOLD = 0.447;

/**
 * The radiance-fallback seam (docs/HANDOFF.md): WGSL defining
 * `fn sampleRadianceFallback(P: vec3f, dir: vec3f, roughness: f32) -> vec3f`
 * (world-space position and direction, perceptual roughness), with its bindings in `@group(1)`.
 * It is called for rays that miss (lerped by hit confidence, roughness 0 as in FFX) and for
 * reflective pixels rougher than the threshold (mirror direction, sqrt of the extracted roughness).
 * The snippet may read the tracer's uniform block `P` (e.g. `P.iblFactor`, `P.fallbackColor`).
 */
export interface RadianceFallback {
  wgsl: string;
  /** Layout of `@group(1)`; omit when the snippet has no bindings. */
  layout?: GPUBindGroupLayout;
  /** Storage buffers in `layout`, counted against the device's per-stage limit by passes that check it. Default 0. */
  storageBufferCount?: number;
  /** Storage textures in `layout`, likewise. Default 0. */
  storageTextureCount?: number;
}

/** Default fallback: `settings.fallbackColor * settings.iblFactor`, no bindings. */
export function constantRadianceFallback(): RadianceFallback {
  return { wgsl: CONSTANT_FALLBACK_WGSL };
}

/** One `texture_cube<f32>` environment at `@group(1)`, sampled at mip `roughness * log2(width)`, times `iblFactor`. */
export function environmentRadianceFallback(device: GPUDevice): RadianceFallback & {
  createBindGroup(cube: GPUTextureView, sampler?: GPUSampler): GPUBindGroup;
} {
  const layout = device.createBindGroupLayout({
    label: 'ssr fallback environment',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    ],
  });
  let defaultSampler: GPUSampler | undefined;
  return {
    wgsl: ENVIRONMENT_FALLBACK_WGSL,
    layout,
    createBindGroup(cube, sampler) {
      sampler ??= defaultSampler ??= device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
      return device.createBindGroup({ layout, entries: [{ binding: 0, resource: cube }, { binding: 1, resource: sampler }] });
    },
  };
}

export interface ScreenSpaceReflectionsOptions {
  width: number;
  height: number;
  /** Reverse-Z depth (1 = near). Picks max instead of min for the pyramid and flips the far plane. Default false. */
  depthInverted?: boolean;
  /** 'auto' (default) uses 'subgroups' when the device has the feature, else 'workgroup'. */
  variant?: 'auto' | ScreenSpaceVariant;
  /** Radiance for misses and rough pixels. Default: constantRadianceFallback(). */
  radianceFallback?: RadianceFallback;
  /** Allocate the miss list (pixels for a ray-traced pass, see docs/SPEC.md "Work lists"). Default false. */
  missList?: boolean;
  /** Per-pass GPU timestamps (needs 'timestamp-query'). Default false. */
  timestamps?: boolean;
}

export interface ScreenSpaceReflectionsSettings {
  /**
   * Perceptual roughness below which a pixel traces; squared to alpha at the pass boundary (FFX
   * compares alpha, DIVERGES D43). Default 0.447 (alpha 0.1998, FFX's 0.2).
   */
  roughnessThreshold?: number;
  /** Minimum rays per 2x2 quad for glossy (non-mirror) pixels: 1, 2 or 4. Default 1. */
  samplesPerQuad?: 1 | 2 | 4;
  /** Default 128. */
  maxTraversalIntersections?: number;
  /** Glossy rays stop once this few invocations of their subgroup (workgroup in the fallback) still march. Mirrors ignore it. Default 4. */
  minTraversalOccupancy?: number;
  /**
   * Hit acceptance thickness (view-space units, = world units when the view matrix has no scale).
   * The full thickness is
   * `depthBufferThickness + thicknessRoughnessFactor * alpha + thicknessLengthFactor * worldRayLength`.
   * Defaults: {@link THICKNESS_HYBRID} (0.2, 10, 0.01); {@link THICKNESS_CONSTANT} is FFX SSSR's 0.015.
   */
  depthBufferThickness?: number;
  /** Thickness added per unit of alpha (linear roughness) of the reflecting pixel. Default 10. */
  thicknessRoughnessFactor?: number;
  /** Thickness added per world unit of ray length. Default 0.01. */
  thicknessLengthFactor?: number;
  /** Pyramid mip glossy rays start on (mirrors always use 0). Default 0. */
  mostDetailedMip?: number;
  /** Trace extra quad pixels where last frame's variance > varianceThreshold. Needs `inputs.variance`. Default true. */
  temporalVarianceGuidedTracing?: boolean;
  /** Default 0. */
  varianceThreshold?: number;
  /** Scales the radiance fallback. Default 1. */
  iblFactor?: number;
  /** Carried in the uniform block for the denoiser seam; unused by these passes. Default 0.7. */
  temporalStabilityFactor?: number;
  /** Colour of the constant fallback. Default [0, 0, 0]. */
  fallbackColor?: readonly [number, number, number];
  /** Miss list: a ray goes there when its confidence is below this. Default 0.9 (hybrid sample). */
  missConfidenceThreshold?: number;
  /** Miss list: only rays with perceptual roughness <= this (squared like `roughnessThreshold`). Default 1 (all traced rays). The hybrid sample's 0.22 alpha is 0.469. */
  missRoughnessThreshold?: number;
  /**
   * Where a screen-space hit takes its colour: 'current' (default) = `inputs.color`, this frame's
   * scene colour without specular (FFX); 'history' = `inputs.history`, last frame's lit colour
   * reprojected through `inputs.motion` (FFX's hybrid sample, PICA, SSSR 2015; D69).
   */
  hitColor?: 'current' | 'history';
  /** Override the frame index (blue-noise rotation). Default: increments per dispatch. */
  frameIndex?: number;
}

export interface ScreenSpaceCamera {
  /** Column-major view matrix (world -> view). */
  view: Mat4Like;
  /** Column-major projection, WebGPU clip space (z in [0, 1]), without jitter. */
  projection: Mat4Like;
  prevView?: Mat4Like;
  prevProjection?: Mat4Like;
}

/** This tracer's frame inputs (W4 defines the general frame contract; the lead reconciles them). */
export interface ScreenSpaceReflectionsInputs {
  /** Device depth: a depth texture, or r32float. Same size as the tracer. */
  depth: GPUTexture;
  /** World-space normal, decoded as normalize(mul * texel.xyz + add). */
  normal: GPUTexture;
  /** Default { mul: 1, add: 0 } (raw float normals, e.g. rgba16float); unorm-packed normals use { mul: 2, add: -1 }. */
  normalUnpack?: { mul: number; add: number };
  /** A material texture holding roughness in `roughnessChannel`. */
  roughness: GPUTexture;
  roughnessChannel?: number;
  /** Roughness is perceptual and gets squared (three: true). Default true. */
  roughnessIsPerceptual?: boolean;
  /** Lit scene colour without specular (the radiance a hit returns). */
  color: GPUTexture;
  /** Motion vectors (uv-space current - previous, times `motionVectorScale`): read only with `hitColor: 'history'`; carried for the denoise seam. */
  motion?: GPUTexture;
  /** Scale that turns a `motion` texel into uv-space current - previous. Default [1, 1]. */
  motionVectorScale?: readonly [number, number];
  /**
   * Last frame's lit colour (any float format, render size), for `hitColor: 'history'`: hits load it
   * at the hit reprojected through `motion`, so a mirror seen in a mirror shows its reflection
   * instead of the specular-free scene colour (D69).
   */
  history?: GPUTexture;
  /** Last frame's reflection variance (denoiser output), for variance-guided tracing. */
  variance?: GPUTexture;
  camera: ScreenSpaceCamera;
  /** Bind group for the radiance fallback's `@group(1)`, if it has one. */
  fallbackBindGroup?: GPUBindGroup;
}

export interface ScreenSpaceReflectionsOutputs {
  /** rgba16float: reflected radiance rgb, world ray length in w (FFX layout). */
  radiance: GPUTexture;
  /** r32float: world hit distance, 0 where the ray found no screen-space hit (the denoiser's convention). */
  hitDistance: GPUTexture;
  /**
   * r32float: hit confidence in [0, 1] (FFX's vignette x thickness falloff; 0 for rejected rays, rough
   * pixels and the background). Radiance is `mix(fallback, hit, confidence)`; a resolve that blends
   * its own fallback reads this. Port addition: FFX only uses it inside intersect.
   */
  confidence: GPUTexture;
  /** r32float: linear roughness (alpha). */
  extractedRoughness: GPUTexture;
  depthHierarchy: GPUTexture;
  blueNoise: GPUTexture;
  /** u32 per ray: x (15 bits) | y (14 bits) << 15 | copy horizontal / vertical / diagonal << 29 / 30 / 31. */
  rayList: GPUBuffer;
  /** u32 per 8x8 tile with a glossy reflective pixel: tile origin x | y << 16. */
  denoiserTileList: GPUBuffer;
  /** u32 per 8x8 tile (row-major): bit 0 listed, bit 1 has a non-mirror glossy pixel. */
  tileFlags: GPUBuffer;
  /** [0] next frame's ray counter, [1] rays this frame, [2] next frame's tile counter, [3] tiles this frame. */
  rayCounter: GPUBuffer;
  /**
   * Indirect args: intersect at byte 0, denoiser (one group per tile) at byte 12. 2-D groups
   * (x = min(n, 65535), y = ceil(n / x)): index a group as wg.y * nwg.x + wg.x and bounds-check
   * against rayCounter[1] / [3] (D601; FFX writes 1-D, which overflows at 4K).
   */
  indirectArgs: GPUBuffer;
  /** vec2u per miss: packed ray coords (as rayList), oct-encoded world direction (2 x snorm16). */
  missList?: GPUBuffer;
  /** [0] append counter (reset after intersect), [1] misses listed this frame, [2] overflow append counter (reset), [3] dropped past capacity this frame. */
  missCounter?: GPUBuffer;
  /** Indirect args for a ray-traced pass over the miss list: 64 per group, 2-D groups (index (wg.y * nwg.x + wg.x) * 64 + local, bounds-check against missCounter[1]). */
  missArgs?: GPUBuffer;
}

export interface ScreenSpaceReflections {
  readonly device: GPUDevice;
  readonly variant: ScreenSpaceVariant;
  readonly width: number;
  readonly height: number;
  readonly mipCount: number;
  readonly depthInverted: boolean;
  readonly outputs: ScreenSpaceReflectionsOutputs;
  /** Record every pass into `cmd`. Writes the uniform block through `device.queue` immediately, so
   *  one instance dispatches at most once per submit. */
  dispatch(cmd: GPUCommandEncoder, inputs: ScreenSpaceReflectionsInputs, settings?: ScreenSpaceReflectionsSettings): ScreenSpaceReflectionsOutputs;
  /** With `timestamps`: call after submitting the encoder; resolves to ms per pass (+ 'total'). */
  readTimings(): Promise<ReadonlyMap<string, number>>;
  destroy(): void;
}

/**
 * Map the general frame contract (`frame/contract.ts`, W4) onto this tracer's inputs. Throws for
 * what the tracer can't take: linear depth (it marches device depth), or a depth convention that
 * differs from the one the tracer was created with. Pass `frame.frameIndex` as `settings.frameIndex`.
 * The three G-buffer's targets bind as they are: depth32float depth, rgba16float raw normal
 * (unpack 1, 0) with perceptual roughness in alpha, rgba16float scene colour.
 */
export function screenSpaceInputsFromFrame(
  frame: FrameInputs, tracer: Pick<ScreenSpaceReflections, 'depthInverted'>,
  extra: Pick<ScreenSpaceReflectionsInputs, 'variance' | 'fallbackBindGroup' | 'history'> = {},
): ScreenSpaceReflectionsInputs {
  const { textures: t, conventions: c } = frame;
  if (c.depthLinear) throw new Error('ssr: linear depth is not supported; pass hardware (device) depth');
  if (c.depthInverted !== tracer.depthInverted) throw new Error(`ssr: frame depthInverted=${c.depthInverted}, tracer created with ${tracer.depthInverted}`);
  return {
    depth: t.depth,
    normal: t.normal,
    normalUnpack: { mul: c.normalUnpackMul, add: c.normalUnpackAdd },
    roughness: t.roughness.texture,
    roughnessChannel: t.roughness.channel,
    roughnessIsPerceptual: c.roughnessIsPerceptual,
    color: t.sceneColor,
    motion: t.motion,
    motionVectorScale: c.motionVectorScale,
    camera: frame.camera,
    ...extra,
  };
}

const C = 0x4; // GPUShaderStage.COMPUTE (a literal, so importing core never touches WebGPU globals)
const uniformEntry = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, buffer: { type: 'uniform' } });
const texEntry = (binding: number, sampleType: GPUTextureSampleType = 'unfilterable-float'): GPUBindGroupLayoutEntry =>
  ({ binding, visibility: C, texture: { sampleType } });
const storageTexEntry = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry =>
  ({ binding, visibility: C, storageTexture: { access: 'write-only', format } });
const bufEntry = (binding: number, type: GPUBufferBindingType = 'storage'): GPUBindGroupLayoutEntry => ({ binding, visibility: C, buffer: { type } });

export function createScreenSpaceReflections(device: GPUDevice, options: ScreenSpaceReflectionsOptions): ScreenSpaceReflections {
  const { width: W, height: H } = options;
  if (W < 16 || H < 16 || W > 32767 || H > 16383) throw new Error(`ssr: size ${W}x${H} out of range (16..32767 x 16..16383)`);
  const hasSubgroups = device.features.has('subgroups' as GPUFeatureName);
  const variant: Variant = options.variant && options.variant !== 'auto' ? options.variant : hasSubgroups ? 'subgroups' : 'workgroup';
  if (variant === 'subgroups' && !hasSubgroups) throw new Error("ssr: variant 'subgroups' needs the device feature 'subgroups'");
  const inverted = options.depthInverted ?? false;
  const fallback = options.radianceFallback ?? constantRadianceFallback();
  const useMissList = options.missList ?? false;
  const timer = options.timestamps && PassTimer.supported(device) ? new PassTimer(device) : undefined;
  // FFX: min(7, ceil(log2(max(w, h)))) -- a copy at mip 0 plus six reduced mips.
  const mipCount = depthPyramidMipCount(W, H);
  const tilesX = Math.ceil(W / 8), tilesY = Math.ceil(H / 8);

  // ---- resources
  const STex = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
  const tex = (label: string, format: GPUTextureFormat, w = W, h = H, mips = 1) =>
    device.createTexture({ label: `ssr ${label}`, size: [w, h], format, mipLevelCount: mips, usage: STex });
  const buf = (label: string, size: number, extra = 0) =>
    device.createBuffer({ label: `ssr ${label}`, size: Math.max(16, Math.ceil(size / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra });
  const depthHierarchy = createDepthPyramidTexture(device, W, H, 'ssr depth hierarchy');
  const pyramid = createDepthPyramidBuilder(device, { inverted });
  const radiance = tex('radiance', 'rgba16float');
  const hitDistance = tex('hit distance', 'r32float');
  const confidence = tex('confidence', 'r32float');
  const extractedRoughness = tex('extracted roughness', 'r32float');
  const blueNoise = tex('blue noise', 'rgba8unorm', 128, 128);
  const rayList = buf('ray list', W * H * 4);
  const denoiserTileList = buf('denoiser tile list', tilesX * tilesY * 4);
  const tileFlags = buf('tile flags', tilesX * tilesY * 4);
  const rayCounter = buf('ray counter', 16);
  const indirectArgs = buf('indirect args', 24, GPUBufferUsage.INDIRECT);
  // Buffers must fit one storage binding (default limit 128 MiB): the ray list is W*H*4 bytes, so
  // above ~33.5 Mpx (8K) the tracer can't run; the miss list (8 B per entry) is capped instead and
  // counts what it drops (missCounter[3]). The per-tile cap (D9) will bound it further.
  const maxBinding = device.limits.maxStorageBufferBindingSize;
  if (W * H * 4 > maxBinding) throw new Error(`ssr: ${W}x${H} needs a ${W * H * 4} B ray list; the device's maxStorageBufferBindingSize is ${maxBinding}`);
  const missCapacity = Math.min(W * H, Math.floor(maxBinding / 8));
  const missList = useMissList ? buf('miss list', missCapacity * 8) : undefined;
  const missCounter = useMissList ? buf('miss counter', 16) : undefined;
  const missArgs = useMissList ? buf('miss args', 12, GPUBufferUsage.INDIRECT) : undefined;
  const params = device.createBuffer({ label: 'ssr params', size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const noiseTable = device.createBuffer({ label: 'ssr blue-noise table', size: 128 * 128 * 2, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(noiseTable, 0, blueNoiseBytes());
  const dummyVariance = device.createTexture({ label: 'ssr no variance', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const dummyHistory = device.createTexture({ label: 'ssr no history', size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const hierarchyView = depthHierarchy.createView();

  // ---- pipelines
  const pipe = (label: string, code: string, layouts: GPUBindGroupLayout[]) => device.createComputePipeline({
    label: `ssr ${label}`,
    layout: device.createPipelineLayout({ label: `ssr ${label}`, bindGroupLayouts: layouts }),
    compute: { module: device.createShaderModule({ label: `ssr ${label}`, code }), entryPoint: 'main' },
  });
  const withFallback = (bgl: GPUBindGroupLayout) => (fallback.layout ? [bgl, fallback.layout] : [bgl]);

  const classifyBgl = device.createBindGroupLayout({
    label: 'ssr classify',
    entries: [uniformEntry(0), texEntry(1), texEntry(2), texEntry(3), texEntry(4),
      bufEntry(5), bufEntry(6), bufEntry(7), bufEntry(8),
      storageTexEntry(9, 'rgba16float'), storageTexEntry(10, 'r32float'), storageTexEntry(11, 'r32float'), storageTexEntry(12, 'r32float')],
  });
  const classifyPipe = pipe(`classify (${variant})`, classifyWgsl(variant, inverted, fallback.wgsl), withFallback(classifyBgl));

  const noiseBgl = device.createBindGroupLayout({
    label: 'ssr blue noise', entries: [uniformEntry(0), bufEntry(1, 'read-only-storage'), storageTexEntry(2, 'rgba8unorm')],
  });
  const noisePipe = pipe('blue noise', BLUE_NOISE_WGSL, [noiseBgl]);
  const noiseGroup = device.createBindGroup({
    label: 'ssr blue noise', layout: noiseBgl,
    entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: noiseTable } }, { binding: 2, resource: blueNoise.createView() }],
  });

  const argsBgl = device.createBindGroupLayout({ label: 'ssr indirect args', entries: [bufEntry(0), bufEntry(1)] });
  const argsPipe = pipe('indirect args', INDIRECT_ARGS_WGSL, [argsBgl]);
  const argsGroup = device.createBindGroup({
    label: 'ssr indirect args', layout: argsBgl,
    entries: [{ binding: 0, resource: { buffer: rayCounter } }, { binding: 1, resource: { buffer: indirectArgs } }],
  });

  const intersectBgl = device.createBindGroupLayout({
    label: 'ssr intersect',
    entries: [uniformEntry(0), texEntry(1), texEntry(2), texEntry(3), texEntry(4), texEntry(5),
      bufEntry(6, 'read-only-storage'), bufEntry(7, 'read-only-storage'),
      storageTexEntry(8, 'rgba16float'), storageTexEntry(9, 'r32float'), storageTexEntry(10, 'r32float'),
      ...(useMissList ? [bufEntry(11), bufEntry(12)] : []), texEntry(13), texEntry(14)],
  });
  const intersectPipe = pipe(`intersect (${variant})`, intersectWgsl(variant, inverted, fallback.wgsl, useMissList), withFallback(intersectBgl));

  let missArgsPipe: GPUComputePipeline | undefined, missArgsGroup: GPUBindGroup | undefined;
  if (useMissList) {
    const bgl = device.createBindGroupLayout({ label: 'ssr miss args', entries: [bufEntry(0), bufEntry(1)] });
    missArgsPipe = pipe('miss args', missArgsWgsl(missCapacity), [bgl]);
    missArgsGroup = device.createBindGroup({
      label: 'ssr miss args', layout: bgl,
      entries: [{ binding: 0, resource: { buffer: missCounter! } }, { binding: 1, resource: { buffer: missArgs! } }],
    });
  }

  const outputs: ScreenSpaceReflectionsOutputs = {
    radiance, hitDistance, confidence, extractedRoughness, depthHierarchy, blueNoise, rayList, denoiserTileList, tileFlags,
    rayCounter, indirectArgs, missList, missCounter, missArgs,
  };

  let frameIndex = 0;
  let afterSubmit: (() => void) | undefined;
  const P = (b: number) => ({ binding: b, resource: { buffer: params } });

  function writeParams(inputs: ScreenSpaceReflectionsInputs, s: ScreenSpaceReflectionsSettings, useHistory: boolean) {
    const cam = inputs.camera;
    const V = cam.view, Pm = cam.projection;
    const VP = mat4Mul(Pm, V);
    const prevVP = mat4Mul(cam.prevProjection ?? Pm, cam.prevView ?? V);
    const data = new ArrayBuffer(PARAMS_SIZE);
    const f = new Float32Array(data), u = new Uint32Array(data);
    f.set(mat4Invert(VP), 0);
    f.set(Array.from(Pm), 16);
    f.set(mat4Invert(Pm), 32);
    f.set(Array.from(V), 48);
    f.set(mat4Invert(V), 64);
    f.set(prevVP, 80);
    u[96] = W; u[97] = H; f[98] = 1 / W; f[99] = 1 / H;
    f[100] = inputs.normalUnpack?.mul ?? 1; f[101] = inputs.normalUnpack?.add ?? 0;
    u[102] = inputs.roughnessChannel ?? 0;
    u[103] = inputs.roughnessIsPerceptual ?? true ? 1 : 0;
    f[104] = s.iblFactor ?? 1;
    f[105] = s.temporalStabilityFactor ?? 0.7;
    f[106] = s.depthBufferThickness ?? THICKNESS_HYBRID.depthBufferThickness;
    f[107] = (s.roughnessThreshold ?? DEFAULT_ROUGHNESS_THRESHOLD) ** 2; // perceptual -> alpha (D43)
    f[108] = s.varianceThreshold ?? 0;
    u[109] = s.frameIndex ?? frameIndex;
    u[110] = s.maxTraversalIntersections ?? 128;
    u[111] = s.minTraversalOccupancy ?? 4;
    u[112] = s.mostDetailedMip ?? 0;
    u[113] = s.samplesPerQuad ?? 1;
    u[114] = inputs.variance && (s.temporalVarianceGuidedTracing ?? true) ? 1 : 0;
    u[115] = mipCount - 1;
    const fc = s.fallbackColor ?? [0, 0, 0];
    f[116] = fc[0]; f[117] = fc[1]; f[118] = fc[2]; f[119] = 1;
    u[120] = missCapacity;
    f[121] = s.missConfidenceThreshold ?? 0.9;
    f[122] = (s.missRoughnessThreshold ?? 1) ** 2;
    f[123] = s.thicknessRoughnessFactor ?? THICKNESS_HYBRID.thicknessRoughnessFactor;
    f[124] = s.thicknessLengthFactor ?? THICKNESS_HYBRID.thicknessLengthFactor;
    u[125] = useHistory ? 1 : 0;
    const mvs = inputs.motionVectorScale ?? [1, 1];
    f[128] = mvs[0]; f[129] = mvs[1];
    device.queue.writeBuffer(params, 0, data);
  }

  function dispatch(cmd: GPUCommandEncoder, inputs: ScreenSpaceReflectionsInputs, settings: ScreenSpaceReflectionsSettings = {}) {
    for (const [k, t] of [['depth', inputs.depth], ['normal', inputs.normal], ['roughness', inputs.roughness], ['color', inputs.color]] as const) {
      if (t.width !== W || t.height !== H) throw new Error(`ssr: ${k} is ${t.width}x${t.height}, expected ${W}x${H}`);
    }
    if (fallback.layout && !inputs.fallbackBindGroup) throw new Error('ssr: the radiance fallback needs inputs.fallbackBindGroup');
    const useHistory = (settings.hitColor ?? 'current') === 'history';
    if (useHistory && (!inputs.history || !inputs.motion)) throw new Error("ssr: hitColor 'history' needs inputs.history and inputs.motion");
    if (inputs.history && (inputs.history.width !== W || inputs.history.height !== H)) throw new Error(`ssr: history is ${inputs.history.width}x${inputs.history.height}, expected ${W}x${H}`);
    writeParams(inputs, settings, useHistory);
    const classifyGroup = device.createBindGroup({
      label: 'ssr classify', layout: classifyBgl,
      entries: [P(0),
        { binding: 1, resource: hierarchyView },
        { binding: 2, resource: inputs.normal.createView() },
        { binding: 3, resource: inputs.roughness.createView() },
        { binding: 4, resource: (inputs.variance ?? dummyVariance).createView() },
        { binding: 5, resource: { buffer: rayList } },
        { binding: 6, resource: { buffer: denoiserTileList } },
        { binding: 7, resource: { buffer: rayCounter } },
        { binding: 8, resource: { buffer: tileFlags } },
        { binding: 9, resource: radiance.createView() },
        { binding: 10, resource: hitDistance.createView() },
        { binding: 11, resource: extractedRoughness.createView() },
        { binding: 12, resource: confidence.createView() }],
    });
    const intersectGroup = device.createBindGroup({
      label: 'ssr intersect', layout: intersectBgl,
      entries: [P(0),
        { binding: 1, resource: inputs.color.createView() },
        { binding: 2, resource: inputs.normal.createView() },
        { binding: 3, resource: hierarchyView },
        { binding: 4, resource: extractedRoughness.createView() },
        { binding: 5, resource: blueNoise.createView() },
        { binding: 6, resource: { buffer: rayList } },
        { binding: 7, resource: { buffer: rayCounter } },
        { binding: 8, resource: radiance.createView() },
        { binding: 9, resource: hitDistance.createView() },
        { binding: 10, resource: confidence.createView() },
        ...(useMissList ? [{ binding: 11, resource: { buffer: missList! } }, { binding: 12, resource: { buffer: missCounter! } }] : []),
        { binding: 13, resource: (useHistory ? inputs.history! : dummyHistory).createView() },
        { binding: 14, resource: (useHistory ? inputs.motion! : dummyHistory).createView() }],
    });

    timer?.begin();
    const pass = (name: string, fn: (p: GPUComputePassEncoder) => void) => {
      const p = cmd.beginComputePass({ label: `ssr ${name}`, timestampWrites: timer?.pass(name) });
      fn(p);
      p.end();
    };
    pyramid.build(cmd, inputs.depth, depthHierarchy, timer?.pass('depth downsample'));
    pass('classify', (p) => {
      p.setPipeline(classifyPipe); p.setBindGroup(0, classifyGroup);
      if (fallback.layout) p.setBindGroup(1, inputs.fallbackBindGroup!);
      p.dispatchWorkgroups(tilesX, tilesY);
    });
    pass('blue noise', (p) => { p.setPipeline(noisePipe); p.setBindGroup(0, noiseGroup); p.dispatchWorkgroups(16, 16); });
    pass('indirect args', (p) => { p.setPipeline(argsPipe); p.setBindGroup(0, argsGroup); p.dispatchWorkgroups(1); });
    pass('intersect', (p) => {
      p.setPipeline(intersectPipe); p.setBindGroup(0, intersectGroup);
      if (fallback.layout) p.setBindGroup(1, inputs.fallbackBindGroup!);
      p.dispatchWorkgroupsIndirect(indirectArgs, 0);
    });
    if (missArgsPipe) pass('miss args', (p) => { p.setPipeline(missArgsPipe!); p.setBindGroup(0, missArgsGroup!); p.dispatchWorkgroups(1); });
    afterSubmit = timer?.end(cmd);
    frameIndex++;
    return outputs;
  }

  return {
    device, variant, width: W, height: H, mipCount, depthInverted: inverted, outputs, dispatch,
    async readTimings() {
      if (!timer) return new Map();
      afterSubmit?.();
      afterSubmit = undefined;
      await timer.read();
      return timer.timings;
    },
    destroy() {
      for (const t of [depthHierarchy, radiance, hitDistance, confidence, extractedRoughness, blueNoise, dummyVariance, dummyHistory]) t.destroy();
      for (const b of [rayList, denoiserTileList, tileFlags, rayCounter, indirectArgs, missList, missCounter, missArgs, params, noiseTable]) b?.destroy();
      timer?.destroy();
    },
  };
}
