// The ray-traced reflection pass on a bare GPUDevice (docs/SPEC.md section 4): rays for the pixels
// screen space failed. It runs after the SSSR tracer in the same command encoder, dispatches
// indirectly over the tracer's miss list (`missArgs`), traces each entry's stored direction
// through a TraceProvider, and overwrites the tracer's radiance / hit distance / confidence for the
// pixels it traced, so the denoise seam sees one signal whatever filled each pixel.
//
//   const rt = createTracedReflections(device, { width, height, provider });
//   ssr.dispatch(cmd, inputs, settings);           // created with { missList: true }
//   rt.dispatch(cmd, { tracer: ssr, inputs });     // same encoder, after the tracer
//
// Bind groups: 0 the pass, 1 the radiance fallback (misses), 2 the provider, 3 the hit shading.
import { constantRadianceFallback, mirrorBiasSplit, type RadianceFallback, type ScreenSpaceReflections, type ScreenSpaceReflectionsInputs } from '../sssr/sssr';
import { dedupeWgslChunks } from '../probes/layouts';
import { mat4Invert, mat4Mul } from '../sssr/math';
import { PassTimer } from '../sssr/timer';
import { checkStageLimits, countStageBindings } from '../limits';
import { DEFAULT_HIT_LOBE_FILTER, DEFAULT_HIT_MATERIAL_WGSL, DEFAULT_HIT_SPECULAR_WGSL, DEFAULT_SHADING_NORMAL_WGSL, DEFAULT_TRACE_ANY_WGSL, fallbackHitShading, type HitShading, type TraceProvider } from './provider';
import { RT_BEGIN_WGSL, RT_FILL_MARK_WGSL, RT_FILL_SCATTER_WGSL, RT_PARAMS_SIZE, RT_STATE, RT_STATE_HEADER, rtFillGatherWgsl, rtTraceWgsl } from './shaders';
import { BILATERAL_FILL_WGSL, bilateralFillWeightWords, resolveBilateralFillWeights } from '../bilateral/fill';

export interface TracedReflectionsOptions {
  width: number;
  height: number;
  provider: TraceProvider;
  /**
   * Radiance along the ray for traced misses (`sampleRadianceFallback`, group 1). Pass the same
   * fallback the SSSR tracer uses, so a traced miss and a screen-space miss agree. Default constant.
   */
  radianceFallback?: RadianceFallback;
  /** How hits are shaded. Default `fallbackHitShading()` (material x fallback at the hit). */
  hitShading?: HitShading;
  /** Per-pass GPU timestamps (needs 'timestamp-query'). Default false. */
  timestamps?: boolean;
}

export interface TracedReflectionsSettings {
  /** Rays per frame at most (D9). Entries past it keep intersect's fallback. Default unlimited. */
  maxTracedRaysPerFrame?: number;
  /**
   * Rays per 8x8 tile at most (1..64). Each frame every tile may trace min(this, floor(max rays per
   * frame / tiles with misses last frame)) rays, and a rotating fraction of the tiles one more (the
   * remainder of that division), so a capped frame spreads its budget over the screen and over time
   * (D9, D56, D1100). Default 64 (no tile cap beyond the frame budget's share).
   */
  maxRaysPerTile?: number;
  /** Ray length cap at roughness 0 (world units); the cap is this x exp(-falloff x alpha). Default 100 (FFX hybrid sample). */
  maxRayLength?: number;
  /** Default 5 (FFX hybrid sample). */
  rayLengthRoughnessFalloff?: number;
  /** Origin offset along the normal, as a fraction of the view distance. Default 3e-3 (FFX hybrid sample). */
  normalOffset?: number;
  /** A hit the camera sees this frame takes the scene colour there (D55). Default true. */
  reuseOnScreenHits?: boolean;
  /**
   * Where an on-screen hit takes its colour, as the SSSR tracer's `hitColor`: 'current' (default)
   * = `inputs.color`; 'history' = `inputs.history` reprojected through `inputs.motion` (D1002).
   * Pass the tracer's setting so both sources agree.
   */
  hitColor?: 'current' | 'history';
  /**
   * Roughness a traced miss takes its fallback at, as the SSSR tracer's `fallbackRoughness` (pass
   * the tracer's setting so both agree): 'surface' (default) = each pixel's own rough-pixel lookup
   * (mirror direction, its perceptual roughness), quad copies included; 'mirror' = the ray's
   * direction at roughness 0 (FFX). Mirror pixels and a constant fallback are the same either way.
   */
  fallbackRoughness?: 'mirror' | 'surface';
  /**
   * Hit shading may trace shadow rays (`traceLightVisible`, D903): `environmentHitShading` sends
   * one per directional light from each traced hit it shades (not from on-screen reused hits, whose
   * scene colour is already shadowed). Off: every light is unoccluded. Default true.
   */
  hitShadows?: boolean;
  /**
   * Shade the specular lobe and clear coat of traced hits whose provider has `traceHitSpecular`
   * (W41, D3510). Off: hits are diffuse + emissive only, as before (what an on-screen colour without
   * specular, hitColor 'current', compares against). Default true.
   */
  hitSpecular?: boolean;
  /**
   * As the SSSR tracer's `hitShading` (pass the tracer's, W44, D3540): with 'reshade' an on-screen hit takes this frame's scene colour (its diffuse) plus its specular lobe along the ray
   * (`hitShadeSurface`, without the visibility ray, D3542), not the screen colour as is. Default 'reshade'.
   */
  hitShading?: 'reshade' | 'off';
  /**
   * Filtered importance sampling at hits (W45, D3550), as the SSSR tracer's `hitLobeFilter` (pass the
   * tracer's): a hit's specular radiance is looked up wider by this many times the reflecting pixel's
   * alpha. Default {@link DEFAULT_HIT_LOBE_FILTER}; 0 = the hit's own roughness.
   */
  hitLobeFilter?: number;
  /**
   * Which re-shaded hits take D3513's visibility ray along R (W52, D3640): 'offscreen' (default) =
   * only hits shaded from the BVH's material (as before: on-screen re-shades take none, D3542, so a
   * surface shades the same whichever pass found it); 'all' = on-screen re-shades too, so a rim's
   * lobe into the wheel well or a mirror seen in a mirror (blocked by the facing mirror) goes dark
   * as the path tracer has it where the blocker is dark. Needs `hitShadows` (the ray is a shadow
   * query). Costs one any-hit ray per on-screen hit.
   */
  hitShadeVisibility?: 'offscreen' | 'all';
  /**
   * Re-shade occlusion without a BVH ray (W52, D3642), as the SSSR tracer's `hitShadeOcclusion`
   * (pass the tracer's): 'screen' = an on-screen re-shaded hit that takes no visibility ray (with
   * `hitShadeVisibility` 'offscreen') marches 8 depth-buffer samples along R instead. Default 'off'.
   */
  hitShadeOcclusion?: 'off' | 'screen';
  /**
   * The lobe filter where hits mix (W52, D3641), as the SSSR tracer's `hitLobeFilterMixed` (pass
   * the tracer's): a traced hit with a screen-space hit near it last frame (this pass's own `source`
   * 0 on a glossy pixel, among 3x3 samples 5 px apart) looks up with hitLobeFilter x this. Below 1,
   * the pass keeps a copy of last frame's `source` (r32float, render size). Default 1 (no change).
   */
  hitLobeFilterMixed?: number;
  /**
   * W71 (X1 #3, D5002), as the SSSR tracer's `hitLobeFilterGrazing` (pass the tracer's): the lobe
   * filter's spread at a traced hit shrinks at grazing angles of the reflecting pixel. 0..1, default 0.
   */
  hitLobeFilterGrazing?: number;
  /**
   * W72 (X2 #6, D5021): the SSSR tracer's `mirrorBias`, `mirrorBiasCompensate` and `hitColorFilter`.
   * With compensation the traced directions come from the narrowed lobe (alpha x sqrt(1 - mirrorBias)),
   * so the lobe filter here widens by hitLobeFilter x sqrt(mirrorBias) of the pixel's alpha
   * (`mirrorBiasSplit`). Default (W76): what the tracer's last dispatch ran (`outputs.settings`), so the
   * split always matches the rays; set them only to override.
   */
  mirrorBias?: number;
  mirrorBiasCompensate?: boolean;
  hitColorFilter?: 'off' | 'cone';
  /** W72 (D5024): the SSSR tracer's `hitColorConeScale`. Default (W76): the tracer's last dispatch's. */
  hitColorConeScale?: number;
  /** The SSSR tracer's `roughnessThreshold` (perceptual; pass the tracer's), read by `hitLobeFilterMixed` only. Default 0.447. */
  roughnessThreshold?: number;
  /** Relative view-distance tolerance for that test. Default 0.02. */
  onScreenDepthTolerance?: number;
  /**
   * W74 (plan X4, D5060): 'half' runs the bilateral fill over the SSSR tracer's fill list after the
   * trace: each of its pixels (glossy misses of the quads intersect didn't send to the miss list this
   * frame) takes its traced neighbours' radiance, hit distance, confidence and source
   * (core/bilateral, `fill*` below). No usable neighbour: it keeps intersect's fallback, source
   * 'capped'. Pass the tracer's `tracedMissRate` (the three adapter does). Default 'full' (no fill).
   */
  tracedMissRate?: 'full' | 'half';
  /** The SSSR tracer's `tracedHalfRateMinRoughness`, carried for adapters that pass one settings object to both (unused by this pass). */
  tracedHalfRateMinRoughness?: number;
  /** Fill weight: plane distance tolerance, relative to the view distance (`BilateralFillWeights.planeTolerance`). Default 0.01; 0 off. */
  fillPlaneTolerance?: number;
  /** Fill weight: pow(dot(n_p, n_q), this). Default 16; 0 off. */
  fillNormalPower?: number;
  /** Fill weight: perceptual roughness difference tolerance. Default 0.1; 0 off. */
  fillRoughnessTolerance?: number;
  /** Fill taps: RT_SOURCE codes accepted, one bit per code. Default 0b10110 (traced hit, traced miss, on-screen traced hit). */
  fillSourceMask?: number;
  /** Fill: below this weight sum the pixel keeps intersect's fallback. Default 0.01. */
  fillMinWeightSum?: number;
  /** Fill footprint in 2x2 quads across: 3 (default: the quad's 8 neighbours, of which the checkerboard traced the 4 edge ones), 2 or 4. */
  fillFootprint?: 2 | 3 | 4;
  /** The fallback's `P.iblFactor`. Default 1. */
  iblFactor?: number;
  /** The constant fallback's colour (`P.fallbackColor`). Default [0, 0, 0]. */
  fallbackColor?: readonly [number, number, number];
}

export interface TracedReflectionsDispatch {
  /** The SSSR tracer this frame ran (created with `missList: true`); its outputs are overwritten in place. */
  tracer: ScreenSpaceReflections;
  /** The tracer's inputs for this frame (normal, colour, camera; same object as its dispatch). */
  inputs: ScreenSpaceReflectionsInputs;
  /** Bind group for the radiance fallback's `@group(1)`, if it has one. */
  fallbackBindGroup?: GPUBindGroup;
  /** Bind group for the hit shading's `@group(3)`, if it has one. */
  hitShadingBindGroup?: GPUBindGroup;
}

/** Debug counts of the last frame read back with `readStats()`. */
export interface TracedReflectionsStats {
  /** Entries in the miss list. */
  misses: number;
  /** Rays traced (hits + traced misses). */
  traced: number;
  /** Entries past the tile cap or the frame budget (kept intersect's fallback). */
  capped: number;
  hits: number;
  /** Traced rays that left the scene (took the fallback along the ray). */
  tracedMisses: number;
  /** Hits that reused this frame's scene colour (D55). */
  onScreenHits: number;
  /** 8x8 tiles with at least one miss. */
  tilesWithMisses: number;
  /** Which dispatch these counts come from (1 = the first). */
  frame: number;
  /** The most rays a tile could trace this frame (the floor share, + 1 for the tiles that got the remainder). */
  tileCap: number;
  /** W74: entries on the fill list (glossy misses `tracedMissRate: 'half'` did not trace). */
  halfRateSkipped: number;
  /** W74: fill entries past the list's capacity (traced instead). */
  fillOverflow: number;
  /** W74: fill pixels that took their traced neighbours' result. */
  filled: number;
  /** W74: fill pixels with no usable neighbour (kept intersect's fallback). */
  fillFallbacks: number;
}

export interface TracedReflections {
  readonly device: GPUDevice;
  readonly width: number;
  readonly height: number;
  readonly provider: TraceProvider;
  /**
   * r32float per pixel: RT_SOURCE code (0 untouched, 1 traced hit, 2 traced miss, 3 capped,
   * 4 traced hit that reused the on-screen colour). Cleared each dispatch.
   */
  readonly source: GPUTexture;
  /** u32: RT_STATE header (16 words), then one counter per 8x8 tile (row-major): misses that tile asked for. */
  readonly state: GPUBuffer;
  readonly tilesX: number;
  readonly tilesY: number;
  dispatch(cmd: GPUCommandEncoder, frame: TracedReflectionsDispatch, settings?: TracedReflectionsSettings): void;
  /**
   * Counts of the last frame dispatched before this call (call after submitting it), also while an
   * earlier read is pending. `frame` says which dispatch they are from.
   */
  readStats(): Promise<TracedReflectionsStats>;
  /**
   * W74 (review fix 4): the half-rate fill's pipelines are compiled (asynchronously, on the first
   * `tracedMissRate: 'half'` dispatch or `prepareHalfRate()`). Until then a 'half' dispatch runs no
   * fill: give the SSSR tracer 'full' meanwhile (the three adapter does), or its fill entries keep
   * intersect's fallback for those frames.
   */
  readonly halfRateReady: boolean;
  /** Starts compiling the fill's pipelines; resolves when `halfRateReady`. */
  prepareHalfRate(): Promise<void>;
  /** With `timestamps`: ms per pass ('rt begin', 'rt trace', 'total') for the last frame. */
  readTimings(): Promise<ReadonlyMap<string, number>>;
  destroy(): void;
}

const C = 0x4; // GPUShaderStage.COMPUTE
const tex = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, texture: { sampleType: 'unfilterable-float' } });
const sto = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({ binding, visibility: C, storageTexture: { access: 'write-only', format } });
const buf = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: C, buffer: { type } });

/** The trace pass's own bindings in group 0 (binding 7 is read-write, 5 and 6 read-only; 8-11 write-only; 1-4, 12-14 sampled). */
const OWN_STORAGE_BUFFERS = 3, OWN_STORAGE_TEXTURES = 4, OWN_SAMPLED_TEXTURES = 7;

/**
 * Counts every group of the trace pipeline (0 the pass, 1 the radiance fallback, 2 the provider, 3
 * the hit shading) against the device's per-stage limits, so a combination that doesn't fit fails
 * here with what to change, not as a validation error at createPipelineLayout. Sampled textures
 * too (D4900): a probe set of several sizes binds one atlas per size in the fallback and again in
 * the hit shading.
 */
function checkTraceStageLimits(device: GPUDevice, provider: TraceProvider, fallback: RadianceFallback, shading: HitShading) {
  const fromProvider = countStageBindings(provider.entries as GPUBindGroupLayoutEntry[]);
  checkStageLimits(device, 'rt: the trace pipeline', [
    ['pass', { storageBuffers: OWN_STORAGE_BUFFERS, storageTextures: OWN_STORAGE_TEXTURES, sampledTextures: OWN_SAMPLED_TEXTURES }],
    ['radiance fallback', { storageBuffers: fallback.storageBufferCount, storageTextures: fallback.storageTextureCount, sampledTextures: fallback.sampledTextureCount }],
    [`provider '${provider.name}'`, { storageBuffers: provider.storageBufferCount, storageTextures: fromProvider.storageTextures, sampledTextures: fromProvider.sampledTextures }],
    ['hit shading', { storageBuffers: shading.storageBufferCount, storageTextures: shading.storageTextureCount, sampledTextures: shading.sampledTextureCount }],
  ], 'or use a provider / fallback that binds fewer');
}

export function createTracedReflections(device: GPUDevice, options: TracedReflectionsOptions): TracedReflections {
  const { width: W, height: H, provider } = options;
  const fallback = options.radianceFallback ?? constantRadianceFallback();
  const shading = options.hitShading ?? fallbackHitShading();
  const tilesX = Math.ceil(W / 8), tilesY = Math.ceil(H / 8);
  const timer = options.timestamps && PassTimer.supported(device) ? new PassTimer(device, 8) : undefined; // begin, trace, + the fill's three (W74)

  checkTraceStageLimits(device, provider, fallback, shading);

  const source = device.createTexture({
    label: 'rt source', size: [W, H], format: 'r32float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const stateBytes = (RT_STATE_HEADER + tilesX * tilesY) * 4;
  const state = device.createBuffer({ label: 'rt state', size: stateBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const params = device.createBuffer({ label: 'rt params', size: RT_PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  // Stats readback: each dispatch copies into a slot that isn't being mapped (a mapped buffer can't
  // be a copy target), so a read never returns an older frame because an earlier read was pending.
  interface StatsSlot { buffer: GPUBuffer; frame: number; reading: Promise<TracedReflectionsStats> | null }
  const statsSlots: StatsSlot[] = [];
  const MAX_STATS_SLOTS = 4;
  let latestStats: StatsSlot | null = null;
  let dispatches = 0;

  // ---- pipelines
  const beginBgl = device.createBindGroupLayout({ label: 'rt begin', entries: [buf(0, 'uniform'), buf(1, 'storage')] });
  const beginPipe = device.createComputePipeline({
    label: 'rt begin', layout: device.createPipelineLayout({ bindGroupLayouts: [beginBgl] }),
    compute: { module: device.createShaderModule({ label: 'rt begin', code: RT_BEGIN_WGSL }), entryPoint: 'main' },
  });
  const beginGroup = device.createBindGroup({ label: 'rt begin', layout: beginBgl, entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: state } }] });

  const traceBgl = device.createBindGroupLayout({
    label: 'rt trace',
    entries: [buf(0, 'uniform'), tex(1), tex(2), tex(3), tex(4),
      buf(5, 'read-only-storage'), buf(6, 'read-only-storage'), buf(7, 'storage'),
      sto(8, 'rgba16float'), sto(9, 'r32float'), sto(10, 'r32float'), sto(11, 'r32float'), tex(12), tex(13), tex(14)],
  });
  const noHistory = device.createTexture({ label: 'rt no history', size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
  // last frame's source for hitLobeFilterMixed (W52, D3641), made on first use
  let prevSource: GPUTexture | null = null;
  const noSource = device.createTexture({ label: 'rt no previous source', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const providerBgl = device.createBindGroupLayout({
    label: `rt provider ${provider.name}`,
    entries: provider.entries.map((e, i) => ({ ...e, binding: i } as GPUBindGroupLayoutEntry)),
  });
  const empty = device.createBindGroupLayout({ label: 'rt empty', entries: [] });
  const emptyGroup = device.createBindGroup({ layout: empty, entries: [] });
  // W71 (X1 #3): the grazing lobe-filter shrink lives in a second pipeline (with the branch present the default
  // shader's output moved, D5002). It is built with createComputePipelineAsync on first use
  // (hitLobeFilterGrazing > 0), and the default pipeline keeps tracing until it resolves, so no frame stalls
  // on the compile (D3D12 compiles slowly); the first few frames trace without the shrink.
  const traceDescriptor = (lobeGrazing: boolean): GPUComputePipelineDescriptor => {
    const code = rtTraceWgsl({
      fallbackWgsl: fallback.wgsl,
      providerWgsl: provider.code({ group: 2, firstBinding: 0 }),
      materialWgsl: (provider.capabilities.hitMaterial ? '' : DEFAULT_HIT_MATERIAL_WGSL) + (provider.capabilities.hitSpecular ? '' : DEFAULT_HIT_SPECULAR_WGSL),
      anyHitWgsl: provider.capabilities.anyHit ? '' : DEFAULT_TRACE_ANY_WGSL,
      shadingNormalWgsl: provider.capabilities.shadingNormal ? '' : DEFAULT_SHADING_NORMAL_WGSL,
      hitShadingWgsl: shading.wgsl,
      lobeGrazing,
    });
    // the fallback and the hit shading may both carry the probe lookup's includes (D4901): keep one copy
    const label = `rt trace (${provider.name}${lobeGrazing ? ', lobe grazing' : ''})`;
    return {
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [traceBgl, fallback.layout ?? empty, providerBgl, shading.layout ?? empty] }),
      compute: { module: device.createShaderModule({ label, code: dedupeWgslChunks(code) }), entryPoint: 'main' },
    };
  };
  const tracePipe = device.createComputePipeline(traceDescriptor(false));
  let grazingPipe: GPUComputePipeline | null = null;
  let grazingPending = false;
  const tracePipeFor = (lobeGrazing: boolean) => {
    if (!lobeGrazing) return tracePipe;
    if (grazingPipe) return grazingPipe;
    if (!grazingPending) {
      grazingPending = true;
      device.createComputePipelineAsync(traceDescriptor(true)).then((p) => { grazingPipe = p; })
        .catch((e) => { console.error('rt trace: the lobe-grazing pipeline failed to build; tracing without it', e); });
    }
    return tracePipe;
  };

  let providerGroup: GPUBindGroup | null = null, providerVersion = -1;
  const providerBindGroup = () => {
    if (!providerGroup || providerVersion !== provider.version) {
      providerGroup = device.createBindGroup({
        label: `rt provider ${provider.name}`, layout: providerBgl,
        entries: provider.resources().map((resource, binding) => ({ binding, resource })),
      });
      providerVersion = provider.version;
    }
    return providerGroup;
  };

  // W74 (X4): the half-rate fill's passes, compiled asynchronously on the first 'half' request
  // (review fix 4, as W71's second trace pipeline): until they resolve, dispatch runs no fill and
  // `halfRateReady` is false, so an adapter keeps the tracer at 'full' meanwhile. The scratch buffer
  // is made (or grown) at dispatch, a plain allocation.
  interface FillPipes { mark: GPUComputePipeline; gather: GPUComputePipeline; scatter: GPUComputePipeline; bgl: [GPUBindGroupLayout, GPUBindGroupLayout, GPUBindGroupLayout] }
  let fillPipes: FillPipes | null = null;
  let fillPending: Promise<void> | null = null;
  let fillScratch: GPUBuffer | null = null;
  const prepareHalfRate = (): Promise<void> => {
    if (fillPipes) return Promise.resolve();
    if (fillPending) return fillPending;
    const markBgl = device.createBindGroupLayout({ label: 'rt fill mark', entries: [buf(0, 'uniform'), buf(1, 'read-only-storage'), buf(2, 'read-only-storage'), sto(3, 'r32float')] });
    const gatherBgl = device.createBindGroupLayout({
      label: 'rt fill gather',
      entries: [buf(0, 'uniform'), tex(1), tex(2), tex(3), tex(4), tex(5), tex(6), tex(7), buf(8, 'read-only-storage'), buf(9, 'read-only-storage'), buf(10, 'storage'), buf(11, 'storage')],
    });
    const scatterBgl = device.createBindGroupLayout({
      label: 'rt fill scatter',
      entries: [buf(0, 'uniform'), buf(1, 'read-only-storage'), buf(2, 'read-only-storage'), buf(3, 'read-only-storage'),
        sto(4, 'rgba16float'), sto(5, 'r32float'), sto(6, 'r32float'), sto(7, 'r32float')],
    });
    checkStageLimits(device, 'rt: the fill gather pipeline', [['pass', { storageBuffers: 4, sampledTextures: 7 }]]);
    checkStageLimits(device, 'rt: the fill scatter pipeline', [['pass', { storageBuffers: 3, storageTextures: 4 }]]);
    const mk = (label: string, code: string, bgl: GPUBindGroupLayout) => device.createComputePipelineAsync({
      label, layout: device.createPipelineLayout({ label, bindGroupLayouts: [bgl] }),
      compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    });
    fillPending = Promise.all([
      mk('rt fill mark', RT_FILL_MARK_WGSL, markBgl),
      mk('rt fill gather', rtFillGatherWgsl(BILATERAL_FILL_WGSL), gatherBgl),
      mk('rt fill scatter', RT_FILL_SCATTER_WGSL, scatterBgl),
    ]).then(([mark, gather, scatter]) => { fillPipes = { mark, gather, scatter, bgl: [markBgl, gatherBgl, scatterBgl] }; });
    return fillPending;
  };
  const fillScratchFor = (capacity: number): GPUBuffer => {
    const bytes = Math.max(16, capacity * 64);
    if (fillScratch && fillScratch.size >= bytes) return fillScratch;
    fillScratch?.destroy();
    return (fillScratch = device.createBuffer({ label: 'rt fill scratch', size: bytes, usage: GPUBufferUsage.STORAGE }));
  };

  let afterSubmit: (() => void) | undefined;

  function writeParams(frame: TracedReflectionsDispatch, s0: TracedReflectionsSettings, cone: boolean) {
    // W72: the lobe split follows what the tracer ran this frame (its 'cone' runs as 'off' until built)
    const s = frame.tracer.outputs.hitColorFilterActive ? s0 : { ...s0, hitColorFilter: 'off' as const };
    const cam = frame.inputs.camera;
    const VP = mat4Mul(cam.projection, cam.view);
    const invView = mat4Invert(cam.view);
    const data = new ArrayBuffer(RT_PARAMS_SIZE);
    const f = new Float32Array(data), u = new Uint32Array(data);
    f.set(mat4Invert(VP), 0);
    f.set(VP, 16);
    f[32] = invView[12]; f[33] = invView[13]; f[34] = invView[14];
    u[35] = frame.tracer.depthInverted ? 1 : 0;
    u[36] = W; u[37] = H; f[38] = 1 / W; f[39] = 1 / H;
    f[40] = frame.inputs.normalUnpack?.mul ?? 1; f[41] = frame.inputs.normalUnpack?.add ?? 0;
    const budget = s.maxTracedRaysPerFrame;
    u[42] = budget === undefined || !Number.isFinite(budget) ? 0xffffffff : Math.max(0, Math.floor(budget));
    u[43] = Math.min(64, Math.max(1, Math.floor(s.maxRaysPerTile ?? 64)));
    f[44] = s.maxRayLength ?? 100;
    f[45] = s.rayLengthRoughnessFalloff ?? 5;
    f[46] = s.normalOffset ?? 3e-3;
    u[47] = s.reuseOnScreenHits ?? true ? 1 : 0;
    f[48] = s.onScreenDepthTolerance ?? 0.02;
    u[49] = tilesX;
    f[50] = s.iblFactor ?? 1;
    u[51] = s.hitShadows ?? true ? 1 : 0;
    const fc = s.fallbackColor ?? [0, 0, 0];
    f[52] = fc[0]; f[53] = fc[1]; f[54] = fc[2]; f[55] = 1;
    const mvs = frame.inputs.motionVectorScale ?? [1, 1];
    f[56] = mvs[0]; f[57] = mvs[1];
    u[58] = (s.hitColor ?? 'current') === 'history' ? 1 : 0;
    u[59] = (s.fallbackRoughness ?? 'surface') === 'surface' ? 1 : 0;
    u[60] = s.hitSpecular ?? true ? 1 : 0;
    u[61] = (s.hitShading ?? 'reshade') === 'off' ? 0 : 1;
    f[62] = Math.max(0, s.hitLobeFilter ?? DEFAULT_HIT_LOBE_FILTER);
    u[63] = (s.hitShadeVisibility ?? 'offscreen') === 'all' ? 1 : 0;
    u[64] = (s.hitShadeOcclusion ?? 'off') === 'screen' ? 1 : 0;
    f[65] = Math.min(1, Math.max(0, s.hitLobeFilterMixed ?? 1));
    f[66] = (s.roughnessThreshold ?? 0.447) ** 2;
    f[67] = Math.min(1, Math.max(0, s.hitLobeFilterGrazing ?? 0)); // W71 (X1 #3)
    // 68-75: W74 (X4) the half-rate fill
    bilateralFillWeightWords(resolveBilateralFillWeights({
      planeTolerance: s.fillPlaneTolerance, normalPower: s.fillNormalPower, roughnessTolerance: s.fillRoughnessTolerance,
      sourceMask: s.fillSourceMask, minWeightSum: s.fillMinWeightSum,
    }), f, u, 68);
    u[73] = frame.tracer.outputs.missCapacity ?? 0;
    u[74] = [2, 3, 4].includes(s.fillFootprint as number) ? s.fillFootprint! : 3;
    u[75] = dispatches; // the stochastic fill's frame (W74 review)
    // W72 (X2 #6, D5021): 76
    f[76] = mirrorBiasSplit(s).filter;
    // 77-78: W72 (D5024) the cone at on-screen reused hits, when the tracer built a pyramid of this frame's colour
    f[77] = cone ? Math.max(0, s.hitColorConeScale ?? 1) * mirrorBiasSplit(s).filter : 0;
    f[78] = 0.5 * H * frame.inputs.camera.projection[5];
    device.queue.writeBuffer(params, 0, data);
  }

  function dispatch(cmd: GPUCommandEncoder, frame: TracedReflectionsDispatch, settings0: TracedReflectionsSettings = {}) {
    const { tracer, inputs } = frame;
    const out = tracer.outputs;
    // W76: the lobe split (and the cone) follow what the tracer ran unless given here
    const ran = out.settings ?? {};
    const settings: TracedReflectionsSettings = {
      ...settings0,
      mirrorBias: settings0.mirrorBias ?? ran.mirrorBias, mirrorBiasCompensate: settings0.mirrorBiasCompensate ?? ran.mirrorBiasCompensate,
      hitColorFilter: settings0.hitColorFilter ?? ran.hitColorFilter, hitColorConeScale: settings0.hitColorConeScale ?? ran.hitColorConeScale,
    };
    if (tracer.width !== W || tracer.height !== H) throw new Error(`rt: tracer is ${tracer.width}x${tracer.height}, pass is ${W}x${H}`);
    if (!out.missList || !out.missCounter || !out.missArgs) throw new Error('rt: the SSSR tracer was created without `missList: true`');
    if (fallback.layout && !frame.fallbackBindGroup) throw new Error('rt: the radiance fallback needs fallbackBindGroup');
    if (shading.layout && !frame.hitShadingBindGroup) throw new Error('rt: the hit shading needs hitShadingBindGroup');
    // the same checks as the SSSR tracer's for hitColor 'history'
    const useHistory = (settings.hitColor ?? 'current') === 'history';
    if (useHistory && (!inputs.history || !inputs.motion)) throw new Error("rt: hitColor 'history' needs inputs.history and inputs.motion");
    if (useHistory && (inputs.history!.width !== W || inputs.history!.height !== H)) throw new Error(`rt: history is ${inputs.history!.width}x${inputs.history!.height}, expected ${W}x${H}`);
    // W72 (D5024): the tracer's hit-colour pyramid (of this frame's scene colour) replaces t_color for on-screen reused hits
    const coneTexture = out.hitColorFilterActive && settings.hitColorFilter === 'cone' ? out.hitColorPyramid : undefined;
    writeParams(frame, settings, !!coneTexture);
    const mixed = (settings.hitLobeFilterMixed ?? 1) < 1;
    if (mixed) prevSource ??= device.createTexture({ label: 'rt previous source', size: [W, H], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const traceGroup = device.createBindGroup({
      label: 'rt trace', layout: traceBgl,
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: out.depthHierarchy.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 2, resource: inputs.normal.createView() },
        { binding: 3, resource: out.extractedRoughness.createView() },
        { binding: 4, resource: (coneTexture ?? inputs.color).createView() },
        { binding: 5, resource: { buffer: out.missList } },
        { binding: 6, resource: { buffer: out.missCounter } },
        { binding: 7, resource: { buffer: state } },
        { binding: 8, resource: out.radiance.createView() },
        { binding: 9, resource: out.hitDistance.createView() },
        { binding: 10, resource: out.confidence.createView() },
        { binding: 11, resource: source.createView() },
        // last frame's colour with hitColor 'history' (D1002)
        { binding: 12, resource: (useHistory ? inputs.history! : noHistory).createView() },
        { binding: 13, resource: (useHistory ? inputs.motion! : noHistory).createView() },
        { binding: 14, resource: (mixed ? prevSource! : noSource).createView() },
      ],
    });
    timer?.begin();
    if (mixed) cmd.copyTextureToTexture({ texture: source }, { texture: prevSource! }, [W, H]);
    // source = 0 everywhere; the trace pass marks the pixels it touches
    cmd.beginRenderPass({ label: 'rt clear source', colorAttachments: [{ view: source.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
    cmd.clearBuffer(state, RT_STATE_HEADER * 4, tilesX * tilesY * 4);
    let p = cmd.beginComputePass({ label: 'rt begin', timestampWrites: timer?.pass('rt begin') });
    p.setPipeline(beginPipe); p.setBindGroup(0, beginGroup); p.dispatchWorkgroups(1); p.end();
    p = cmd.beginComputePass({ label: 'rt trace', timestampWrites: timer?.pass('rt trace') });
    p.setPipeline(tracePipeFor((settings.hitLobeFilterGrazing ?? 0) > 0));
    p.setBindGroup(0, traceGroup);
    p.setBindGroup(1, frame.fallbackBindGroup ?? emptyGroup);
    p.setBindGroup(2, providerBindGroup());
    p.setBindGroup(3, frame.hitShadingBindGroup ?? emptyGroup);
    p.dispatchWorkgroupsIndirect(out.missArgs, 0);
    p.end();
    const wantFill = (settings.tracedMissRate ?? 'full') === 'half' && !!out.missFillCapacity;
    if (wantFill && !fillPipes) prepareHalfRate().catch((e) => console.error('rt: the half-rate fill pipelines failed', e)); // no fill until compiled (halfRateReady)
    if (wantFill && fillPipes) {
      // W74 (X4): mark, gather, scatter over the fill list (indirect args at byte 12)
      const f = fillPipes, scratch = fillScratchFor(out.missFillCapacity!);
      const P0 = { binding: 0, resource: { buffer: params } };
      const list = [{ binding: 1, resource: { buffer: out.missList } }, { binding: 2, resource: { buffer: out.missCounter } }];
      const markGroup = device.createBindGroup({ label: 'rt fill mark', layout: f.bgl[0], entries: [P0, ...list, { binding: 3, resource: source.createView() }] });
      const gatherGroup = device.createBindGroup({
        label: 'rt fill gather', layout: f.bgl[1],
        entries: [P0,
          { binding: 1, resource: out.depthHierarchy.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
          { binding: 2, resource: inputs.normal.createView() },
          { binding: 3, resource: out.extractedRoughness.createView() },
          { binding: 4, resource: out.radiance.createView() },
          { binding: 5, resource: out.hitDistance.createView() },
          { binding: 6, resource: out.confidence.createView() },
          { binding: 7, resource: source.createView() },
          { binding: 8, resource: { buffer: out.missList } },
          { binding: 9, resource: { buffer: out.missCounter } },
          { binding: 10, resource: { buffer: scratch } },
          { binding: 11, resource: { buffer: state } }],
      });
      const scatterGroup = device.createBindGroup({
        label: 'rt fill scatter', layout: f.bgl[2],
        entries: [P0, ...list, { binding: 3, resource: { buffer: scratch } },
          { binding: 4, resource: out.radiance.createView() },
          { binding: 5, resource: out.hitDistance.createView() },
          { binding: 6, resource: out.confidence.createView() },
          { binding: 7, resource: source.createView() }],
      });
      // three passes: a pass boundary orders one's storage writes before the next one's reads
      p = cmd.beginComputePass({ label: 'rt fill mark', timestampWrites: timer?.pass('rt fill mark') });
      p.setPipeline(f.mark); p.setBindGroup(0, markGroup); p.dispatchWorkgroupsIndirect(out.missArgs, 12);
      p.end();
      p = cmd.beginComputePass({ label: 'rt fill gather', timestampWrites: timer?.pass('rt fill gather') });
      p.setPipeline(f.gather); p.setBindGroup(0, gatherGroup); p.dispatchWorkgroupsIndirect(out.missArgs, 12);
      p.end();
      p = cmd.beginComputePass({ label: 'rt fill scatter', timestampWrites: timer?.pass('rt fill scatter') });
      p.setPipeline(f.scatter); p.setBindGroup(0, scatterGroup); p.dispatchWorkgroupsIndirect(out.missArgs, 12);
      p.end();
    }
    dispatches++;
    let slot = statsSlots.find((x) => x.reading === null);
    if (!slot && statsSlots.length < MAX_STATS_SLOTS) {
      slot = { buffer: device.createBuffer({ label: 'rt stats readback', size: RT_STATE_HEADER * 4 + 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), frame: 0, reading: null };
      statsSlots.push(slot);
    }
    if (slot) { // all slots mapping (4 reads pending): this frame's counts are skipped
      cmd.copyBufferToBuffer(state, 0, slot.buffer, 0, RT_STATE_HEADER * 4);
      cmd.copyBufferToBuffer(out.missCounter, 0, slot.buffer, RT_STATE_HEADER * 4, Math.min(32, out.missCounter.size));
      slot.frame = dispatches;
      latestStats = slot;
    }
    afterSubmit = timer?.end(cmd);
  }

  return {
    device, width: W, height: H, provider, source, state, tilesX, tilesY, dispatch, prepareHalfRate,
    get halfRateReady() { return fillPipes !== null; },
    readStats() {
      const slot = latestStats;
      if (!slot) return Promise.resolve({ misses: 0, traced: 0, capped: 0, hits: 0, tracedMisses: 0, onScreenHits: 0, tilesWithMisses: 0, tileCap: 0, frame: 0, halfRateSkipped: 0, fillOverflow: 0, filled: 0, fillFallbacks: 0 });
      // one mapping per slot; a second caller for the same frame waits for the first
      slot.reading ??= slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
        const s = new Uint32Array(slot.buffer.getMappedRange().slice(0));
        slot.buffer.unmap();
        return {
          misses: s[RT_STATE_HEADER + 1], traced: s[RT_STATE.traced], capped: s[RT_STATE.capped], hits: s[RT_STATE.hits],
          tracedMisses: s[RT_STATE.misses], onScreenHits: s[RT_STATE.onScreen], tilesWithMisses: s[RT_STATE.tilesWithMisses], tileCap: s[RT_STATE.tileCap],
          halfRateSkipped: s[RT_STATE_HEADER + 5] ?? 0, fillOverflow: s[RT_STATE_HEADER + 7] ?? 0, filled: s[RT_STATE.filled], fillFallbacks: s[RT_STATE.fillFallbacks],
          frame: slot.frame,
        };
      }).finally(() => { slot.reading = null; });
      return slot.reading;
    },
    async readTimings() {
      if (!timer) return new Map();
      afterSubmit?.();
      afterSubmit = undefined;
      await timer.read();
      return timer.timings;
    },
    destroy() {
      source.destroy(); state.destroy(); params.destroy(); fillScratch?.destroy(); for (const x of statsSlots) x.buffer.destroy(); noHistory.destroy(); noSource.destroy(); prevSource?.destroy();
      timer?.destroy();
    },
  };
}
