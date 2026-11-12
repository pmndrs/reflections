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
import { constantRadianceFallback, type RadianceFallback, type ScreenSpaceReflections, type ScreenSpaceReflectionsInputs } from '../sssr/sssr';
import { mat4Invert, mat4Mul } from '../sssr/math';
import { PassTimer } from '../sssr/timer';
import { checkStageLimits, countStageBindings } from '../limits';
import { DEFAULT_HIT_LOBE_FILTER, DEFAULT_HIT_MATERIAL_WGSL, DEFAULT_HIT_SPECULAR_WGSL, DEFAULT_SHADING_NORMAL_WGSL, DEFAULT_TRACE_ANY_WGSL, fallbackHitShading, type HitShading, type TraceProvider } from './provider';
import { RT_BEGIN_WGSL, RT_PARAMS_SIZE, RT_STATE, RT_STATE_HEADER, rtTraceWgsl } from './shaders';

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
  /** The SSSR tracer's `roughnessThreshold` (perceptual; pass the tracer's), read by `hitLobeFilterMixed` only. Default 0.447. */
  roughnessThreshold?: number;
  /** Relative view-distance tolerance for that test. Default 0.02. */
  onScreenDepthTolerance?: number;
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
  const timer = options.timestamps && PassTimer.supported(device) ? new PassTimer(device, 4) : undefined;

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
  const code = rtTraceWgsl({
    fallbackWgsl: fallback.wgsl,
    providerWgsl: provider.code({ group: 2, firstBinding: 0 }),
    materialWgsl: (provider.capabilities.hitMaterial ? '' : DEFAULT_HIT_MATERIAL_WGSL) + (provider.capabilities.hitSpecular ? '' : DEFAULT_HIT_SPECULAR_WGSL),
    anyHitWgsl: provider.capabilities.anyHit ? '' : DEFAULT_TRACE_ANY_WGSL,
    shadingNormalWgsl: provider.capabilities.shadingNormal ? '' : DEFAULT_SHADING_NORMAL_WGSL,
    hitShadingWgsl: shading.wgsl,
  });
  const traceModule = device.createShaderModule({ label: `rt trace (${provider.name})`, code });
  const tracePipe = device.createComputePipeline({
    label: `rt trace (${provider.name})`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [traceBgl, fallback.layout ?? empty, providerBgl, shading.layout ?? empty] }),
    compute: { module: traceModule, entryPoint: 'main' },
  });

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

  let afterSubmit: (() => void) | undefined;

  function writeParams(frame: TracedReflectionsDispatch, s: TracedReflectionsSettings) {
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
    device.queue.writeBuffer(params, 0, data);
  }

  function dispatch(cmd: GPUCommandEncoder, frame: TracedReflectionsDispatch, settings: TracedReflectionsSettings = {}) {
    const { tracer, inputs } = frame;
    const out = tracer.outputs;
    if (tracer.width !== W || tracer.height !== H) throw new Error(`rt: tracer is ${tracer.width}x${tracer.height}, pass is ${W}x${H}`);
    if (!out.missList || !out.missCounter || !out.missArgs) throw new Error('rt: the SSSR tracer was created without `missList: true`');
    if (fallback.layout && !frame.fallbackBindGroup) throw new Error('rt: the radiance fallback needs fallbackBindGroup');
    if (shading.layout && !frame.hitShadingBindGroup) throw new Error('rt: the hit shading needs hitShadingBindGroup');
    // the same checks as the SSSR tracer's for hitColor 'history'
    const useHistory = (settings.hitColor ?? 'current') === 'history';
    if (useHistory && (!inputs.history || !inputs.motion)) throw new Error("rt: hitColor 'history' needs inputs.history and inputs.motion");
    if (useHistory && (inputs.history!.width !== W || inputs.history!.height !== H)) throw new Error(`rt: history is ${inputs.history!.width}x${inputs.history!.height}, expected ${W}x${H}`);
    writeParams(frame, settings);
    const mixed = (settings.hitLobeFilterMixed ?? 1) < 1;
    if (mixed) prevSource ??= device.createTexture({ label: 'rt previous source', size: [W, H], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const traceGroup = device.createBindGroup({
      label: 'rt trace', layout: traceBgl,
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: out.depthHierarchy.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 2, resource: inputs.normal.createView() },
        { binding: 3, resource: out.extractedRoughness.createView() },
        { binding: 4, resource: inputs.color.createView() },
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
    p.setPipeline(tracePipe);
    p.setBindGroup(0, traceGroup);
    p.setBindGroup(1, frame.fallbackBindGroup ?? emptyGroup);
    p.setBindGroup(2, providerBindGroup());
    p.setBindGroup(3, frame.hitShadingBindGroup ?? emptyGroup);
    p.dispatchWorkgroupsIndirect(out.missArgs, 0);
    p.end();
    dispatches++;
    let slot = statsSlots.find((x) => x.reading === null);
    if (!slot && statsSlots.length < MAX_STATS_SLOTS) {
      slot = { buffer: device.createBuffer({ label: 'rt stats readback', size: RT_STATE_HEADER * 4 + 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), frame: 0, reading: null };
      statsSlots.push(slot);
    }
    if (slot) { // all slots mapping (4 reads pending): this frame's counts are skipped
      cmd.copyBufferToBuffer(state, 0, slot.buffer, 0, RT_STATE_HEADER * 4);
      cmd.copyBufferToBuffer(out.missCounter, 0, slot.buffer, RT_STATE_HEADER * 4, 16);
      slot.frame = dispatches;
      latestStats = slot;
    }
    afterSubmit = timer?.end(cmd);
  }

  return {
    device, width: W, height: H, provider, source, state, tilesX, tilesY, dispatch,
    readStats() {
      const slot = latestStats;
      if (!slot) return Promise.resolve({ misses: 0, traced: 0, capped: 0, hits: 0, tracedMisses: 0, onScreenHits: 0, tilesWithMisses: 0, tileCap: 0, frame: 0 });
      // one mapping per slot; a second caller for the same frame waits for the first
      slot.reading ??= slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
        const s = new Uint32Array(slot.buffer.getMappedRange().slice(0));
        slot.buffer.unmap();
        return {
          misses: s[RT_STATE_HEADER + 1], traced: s[RT_STATE.traced], capped: s[RT_STATE.capped], hits: s[RT_STATE.hits],
          tracedMisses: s[RT_STATE.misses], onScreenHits: s[RT_STATE.onScreen], tilesWithMisses: s[RT_STATE.tilesWithMisses], tileCap: s[RT_STATE.tileCap],
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
      source.destroy(); state.destroy(); params.destroy(); for (const x of statsSlots) x.buffer.destroy(); noHistory.destroy(); noSource.destroy(); prevSource?.destroy();
      timer?.destroy();
    },
  };
}
