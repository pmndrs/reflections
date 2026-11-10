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
import { mat4Invert, mat4Mul, type Mat4Like } from './math';
import {
  BLUE_NOISE_WGSL, classifyWgsl, CONSTANT_FALLBACK_WGSL, downsampleWgsl, ENVIRONMENT_FALLBACK_WGSL,
  INDIRECT_ARGS_WGSL, intersectWgsl, MISS_ARGS_WGSL, PARAMS_SIZE, type Variant,
} from './shaders';
import { PassTimer } from './timer';

export type ScreenSpaceVariant = Variant;

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
  /** Linear roughness (alpha = perceptual^2) below which a pixel traces. Default 0.2 (~0.447 perceptual). */
  roughnessThreshold?: number;
  /** Minimum rays per 2x2 quad for glossy (non-mirror) pixels: 1, 2 or 4. Default 1. */
  samplesPerQuad?: 1 | 2 | 4;
  /** Default 128. */
  maxTraversalIntersections?: number;
  /** Glossy rays stop once this few invocations of their subgroup (workgroup in the fallback) still march. Mirrors ignore it. Default 4. */
  minTraversalOccupancy?: number;
  /** Hit acceptance thickness (view-space units). Default 0.015. */
  depthBufferThickness?: number;
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
  /** Miss list: only rays with linear roughness <= this. Default 1 (all traced rays). The hybrid sample uses 0.22. */
  missRoughnessThreshold?: number;
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
  normalUnpack?: { mul: number; add: number };
  /** A material texture holding roughness in `roughnessChannel`. */
  roughness: GPUTexture;
  roughnessChannel?: number;
  /** Roughness is perceptual and gets squared (three: true). Default true. */
  roughnessIsPerceptual?: boolean;
  /** Lit scene colour without specular (the radiance a hit returns). */
  color: GPUTexture;
  /** Motion vectors: unused by the tracer, carried for the denoise seam. */
  motion?: GPUTexture;
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
  /** Indirect args: intersect at byte 0, denoiser (one group per tile) at byte 12. */
  indirectArgs: GPUBuffer;
  /** vec2u per miss: packed ray coords (as rayList), oct-encoded world direction (2 x snorm16). */
  missList?: GPUBuffer;
  /** [0] append counter (reset after intersect), [1] misses this frame, [2] dropped past capacity. */
  missCounter?: GPUBuffer;
  /** Indirect args for a ray-traced pass over the miss list (64 per group). */
  missArgs?: GPUBuffer;
}

export interface ScreenSpaceReflections {
  readonly device: GPUDevice;
  readonly variant: ScreenSpaceVariant;
  readonly width: number;
  readonly height: number;
  readonly mipCount: number;
  readonly outputs: ScreenSpaceReflectionsOutputs;
  /** Record every pass into `cmd`. Writes the uniform block through `device.queue` immediately, so
   *  one instance dispatches at most once per submit. */
  dispatch(cmd: GPUCommandEncoder, inputs: ScreenSpaceReflectionsInputs, settings?: ScreenSpaceReflectionsSettings): ScreenSpaceReflectionsOutputs;
  /** With `timestamps`: call after submitting the encoder; resolves to ms per pass (+ 'total'). */
  readTimings(): Promise<ReadonlyMap<string, number>>;
  destroy(): void;
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
  const mipCount = Math.min(7, Math.ceil(Math.log2(Math.max(W, H))));
  const tilesX = Math.ceil(W / 8), tilesY = Math.ceil(H / 8);

  // ---- resources
  const STex = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
  const tex = (label: string, format: GPUTextureFormat, w = W, h = H, mips = 1) =>
    device.createTexture({ label: `ssr ${label}`, size: [w, h], format, mipLevelCount: mips, usage: STex });
  const buf = (label: string, size: number, extra = 0) =>
    device.createBuffer({ label: `ssr ${label}`, size: Math.max(16, Math.ceil(size / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra });
  const depthHierarchy = tex('depth hierarchy', 'r32float', W, H, mipCount);
  const radiance = tex('radiance', 'rgba16float');
  const hitDistance = tex('hit distance', 'r32float');
  const extractedRoughness = tex('extracted roughness', 'r32float');
  const blueNoise = tex('blue noise', 'rgba8unorm', 128, 128);
  const rayList = buf('ray list', W * H * 4);
  const denoiserTileList = buf('denoiser tile list', tilesX * tilesY * 4);
  const tileFlags = buf('tile flags', tilesX * tilesY * 4);
  const rayCounter = buf('ray counter', 16);
  const indirectArgs = buf('indirect args', 24, GPUBufferUsage.INDIRECT);
  const missCapacity = W * H;
  const missList = useMissList ? buf('miss list', missCapacity * 8) : undefined;
  const missCounter = useMissList ? buf('miss counter', 16) : undefined;
  const missArgs = useMissList ? buf('miss args', 12, GPUBufferUsage.INDIRECT) : undefined;
  const params = device.createBuffer({ label: 'ssr params', size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const noiseTable = device.createBuffer({ label: 'ssr blue-noise table', size: 128 * 128 * 2, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(noiseTable, 0, blueNoiseBytes());
  const dummyVariance = device.createTexture({ label: 'ssr no variance', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const mipView = (m: number) => depthHierarchy.createView({ baseMipLevel: m, mipLevelCount: 1 });
  const mipViews = Array.from({ length: mipCount }, (_, m) => mipView(m));
  const hierarchyView = depthHierarchy.createView();

  // ---- pipelines
  const pipe = (label: string, code: string, layouts: GPUBindGroupLayout[]) => device.createComputePipeline({
    label: `ssr ${label}`,
    layout: device.createPipelineLayout({ label: `ssr ${label}`, bindGroupLayouts: layouts }),
    compute: { module: device.createShaderModule({ label: `ssr ${label}`, code }), entryPoint: 'main' },
  });
  const withFallback = (bgl: GPUBindGroupLayout) => (fallback.layout ? [bgl, fallback.layout] : [bgl]);

  // depth downsample: pass A (copy + mips 1..3) per input kind, pass B (mips 4..6)
  const levelsA = Math.min(3, mipCount - 1);
  const levelsB = Math.max(0, mipCount - 4);
  const downA: Partial<Record<'depth' | 'float', { pipe: GPUComputePipeline; bgl: GPUBindGroupLayout }>> = {};
  const getDownA = (kind: 'depth' | 'float') => {
    if (downA[kind]) return downA[kind]!;
    const bgl = device.createBindGroupLayout({
      label: `ssr downsample A (${kind})`,
      entries: [texEntry(0, kind === 'depth' ? 'depth' : 'unfilterable-float'),
        ...Array.from({ length: levelsA + 1 }, (_, i) => storageTexEntry(i + 1, 'r32float'))],
    });
    return (downA[kind] = { bgl, pipe: pipe(`downsample A (${kind})`, downsampleWgsl({ source: kind, copy: true, levels: levelsA, inverted }), [bgl]) });
  };
  let downB: { pipe: GPUComputePipeline; group: GPUBindGroup } | undefined;
  if (levelsB > 0) {
    const bgl = device.createBindGroupLayout({
      label: 'ssr downsample B',
      entries: [texEntry(0), ...Array.from({ length: levelsB }, (_, i) => storageTexEntry(i + 1, 'r32float'))],
    });
    downB = {
      pipe: pipe('downsample B', downsampleWgsl({ source: 'float', copy: false, levels: levelsB, inverted }), [bgl]),
      group: device.createBindGroup({
        label: 'ssr downsample B', layout: bgl,
        entries: [{ binding: 0, resource: mipViews[3] }, ...Array.from({ length: levelsB }, (_, i) => ({ binding: i + 1, resource: mipViews[4 + i] }))],
      }),
    };
  }

  const classifyBgl = device.createBindGroupLayout({
    label: 'ssr classify',
    entries: [uniformEntry(0), texEntry(1), texEntry(2), texEntry(3), texEntry(4),
      bufEntry(5), bufEntry(6), bufEntry(7), bufEntry(8),
      storageTexEntry(9, 'rgba16float'), storageTexEntry(10, 'r32float'), storageTexEntry(11, 'r32float')],
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
      storageTexEntry(8, 'rgba16float'), storageTexEntry(9, 'r32float'),
      ...(useMissList ? [bufEntry(10), bufEntry(11)] : [])],
  });
  const intersectPipe = pipe(`intersect (${variant})`, intersectWgsl(variant, inverted, fallback.wgsl, useMissList), withFallback(intersectBgl));

  let missArgsPipe: GPUComputePipeline | undefined, missArgsGroup: GPUBindGroup | undefined;
  if (useMissList) {
    const bgl = device.createBindGroupLayout({ label: 'ssr miss args', entries: [bufEntry(0), bufEntry(1)] });
    missArgsPipe = pipe('miss args', MISS_ARGS_WGSL, [bgl]);
    missArgsGroup = device.createBindGroup({
      label: 'ssr miss args', layout: bgl,
      entries: [{ binding: 0, resource: { buffer: missCounter! } }, { binding: 1, resource: { buffer: missArgs! } }],
    });
  }

  const outputs: ScreenSpaceReflectionsOutputs = {
    radiance, hitDistance, extractedRoughness, depthHierarchy, blueNoise, rayList, denoiserTileList, tileFlags,
    rayCounter, indirectArgs, missList, missCounter, missArgs,
  };

  let frameIndex = 0;
  let afterSubmit: (() => void) | undefined;
  const P = (b: number) => ({ binding: b, resource: { buffer: params } });

  function writeParams(inputs: ScreenSpaceReflectionsInputs, s: ScreenSpaceReflectionsSettings) {
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
    f[106] = s.depthBufferThickness ?? 0.015;
    f[107] = s.roughnessThreshold ?? 0.2;
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
    f[122] = s.missRoughnessThreshold ?? 1;
    device.queue.writeBuffer(params, 0, data);
  }

  function dispatch(cmd: GPUCommandEncoder, inputs: ScreenSpaceReflectionsInputs, settings: ScreenSpaceReflectionsSettings = {}) {
    for (const [k, t] of [['depth', inputs.depth], ['normal', inputs.normal], ['roughness', inputs.roughness], ['color', inputs.color]] as const) {
      if (t.width !== W || t.height !== H) throw new Error(`ssr: ${k} is ${t.width}x${t.height}, expected ${W}x${H}`);
    }
    if (fallback.layout && !inputs.fallbackBindGroup) throw new Error('ssr: the radiance fallback needs inputs.fallbackBindGroup');
    writeParams(inputs, settings);
    const kind = inputs.depth.format.startsWith('depth') ? 'depth' : 'float';
    const dA = getDownA(kind);
    const depthView = kind === 'depth' ? inputs.depth.createView({ aspect: 'depth-only' }) : inputs.depth.createView();
    const groupA = device.createBindGroup({
      label: 'ssr downsample A', layout: dA.bgl,
      entries: [{ binding: 0, resource: depthView }, ...Array.from({ length: levelsA + 1 }, (_, i) => ({ binding: i + 1, resource: mipViews[i] }))],
    });
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
        { binding: 11, resource: extractedRoughness.createView() }],
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
        ...(useMissList ? [{ binding: 10, resource: { buffer: missList! } }, { binding: 11, resource: { buffer: missCounter! } }] : [])],
    });

    timer?.begin();
    const pass = (name: string, fn: (p: GPUComputePassEncoder) => void) => {
      const p = cmd.beginComputePass({ label: `ssr ${name}`, timestampWrites: timer?.pass(name) });
      fn(p);
      p.end();
    };
    pass('depth downsample', (p) => {
      p.setPipeline(dA.pipe); p.setBindGroup(0, groupA);
      p.dispatchWorkgroups(Math.ceil(W / 64), Math.ceil(H / 64));
      if (downB) {
        const w3 = Math.max(1, W >> 3), h3 = Math.max(1, H >> 3);
        p.setPipeline(downB.pipe); p.setBindGroup(0, downB.group);
        p.dispatchWorkgroups(Math.ceil(w3 / 64), Math.ceil(h3 / 64));
      }
    });
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
    device, variant, width: W, height: H, mipCount, outputs, dispatch,
    async readTimings() {
      if (!timer) return new Map();
      afterSubmit?.();
      afterSubmit = undefined;
      await timer.read();
      return timer.timings;
    },
    destroy() {
      for (const t of [depthHierarchy, radiance, hitDistance, extractedRoughness, blueNoise, dummyVariance]) t.destroy();
      for (const b of [rayList, denoiserTileList, tileFlags, rayCounter, indirectArgs, missList, missCounter, missArgs, params, noiseTable]) b?.destroy();
      timer?.destroy();
    },
  };
}
