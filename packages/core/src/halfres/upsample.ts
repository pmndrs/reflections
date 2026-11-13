// The half-res reflection upsample (W75, plan X5 step 4): a joint bilateral upsample (Kopf et al.
// 2007) of a half-res reflection signal to full res, with core `bilateralFill` (W74) as the kernel.
//
// The half-res samples are full-res pixels: texel c of the half-res signal was traced from full-res
// pixel (2 c.x, 2 c.y) (./frame.ts point-samples one pixel per quad, top-left). So a tap's surface is
// read from the full-res G-buffer at 2c, and a full-res pixel p sits at p / 2 in sample space: the
// spatial weight is bilinear there (an even pixel is its own sample, weight 1; an odd one sits
// halfway between two or four). Range weights: plane distance, normal power, roughness difference,
// source mask (bilateralFill). Where no bilinear tap fits (a thin silhouette, the sample's quad on
// another surface), a wider 4x4 tent gather; where that finds nothing either, the pixel gets zero
// radiance and confidence (the caller's fallback: in the three composite, a zero residual is three's
// own environment term).
//
// What it upsamples is the caller's business; X5 passes the residual `denoised - probeEnv` at half res
// (D1401: the denoised signal already holds the probe term, which is then added back at full res),
// plus the confidence and hit distance with the same weights (D2400 and the composite read them).
import { BILATERAL_FILL_WGSL, DEFAULT_BILATERAL_FILL_WEIGHTS, bilateralFillWeightWords, resolveBilateralFillWeights, type BilateralFillWeights } from '../bilateral/fill';
import { mat4Invert, mat4Mul } from '../sssr/math';
import { checkStageLimits } from '../limits';
import type { FrameInputs } from '../frame/contract';

export interface ReflectionUpsampleSettings extends Partial<BilateralFillWeights> {
  /** Where no bilinear tap fits, gather a 4x4 tent of samples around the pixel before giving up. Default true. */
  wideFallback?: boolean;
  /**
   * Samples below this perceptual roughness never tap (X5 step 2: those pixels were traced by the
   * full-res mirror path, their half-res texels hold no reflection). Default 0.
   */
  minRoughness?: number;
}

/** The upsample's default weights: bilateralFill's, with every source accepted (codes 0-7). */
export const DEFAULT_REFLECTION_UPSAMPLE_WEIGHTS: Readonly<BilateralFillWeights> = Object.freeze({ ...DEFAULT_BILATERAL_FILL_WEIGHTS, sourceMask: 0xff });

export interface ReflectionUpsampleInputs {
  /** The full-res frame the half-res signal was point-sampled from: its depth, normal and roughness guide the weights. */
  frame: FrameInputs;
  /** Half-res rgba16float (or any float): what to upsample, all four channels. */
  radiance: GPUTexture;
  /** Half-res r32float hit distance. */
  hitDistance: GPUTexture;
  /** Half-res r32float confidence. */
  confidence: GPUTexture;
  /** Half-res source codes in .r (RT_SOURCE), for `sourceMask`; none: every sample is code 0. */
  source?: GPUTexture | null;
  /**
   * `radiance.a` is a blend weight (X5: the composite's ssrWeight), not FFX's ray length: it is upsampled
   * in the confidence's place (bilateralFill's plain weighted mean; the ray length is confidence-weighted
   * since W74's review), written to both the output's alpha and `confidence`, and `confidence` above is
   * not read. Default false.
   */
  weightInAlpha?: boolean;
  /**
   * Write into these full-res textures (formats as `ReflectionUpsampleOutputs`, STORAGE_BINDING) instead
   * of the upsample's own, e.g. an engine's textures its shaders sample. All four, or none.
   */
  targets?: ReflectionUpsampleOutputs;
}

export interface ReflectionUpsampleOutputs {
  /** rgba16float, full res. */
  radiance: GPUTexture;
  /** r32float. */
  hitDistance: GPUTexture;
  /** r32float. */
  confidence: GPUTexture;
  /** r32float: the dominant source code of the taps (0 where nothing fit). */
  source: GPUTexture;
}

export interface ReflectionUpsample {
  readonly width: number;
  readonly height: number;
  /** The upsample's own targets (allocated on the first dispatch without `targets`). */
  readonly outputs: ReflectionUpsampleOutputs;
  dispatch(cmd: GPUCommandEncoder, inputs: ReflectionUpsampleInputs, settings?: ReflectionUpsampleSettings, timestampWrites?: GPUComputePassTimestampWrites): ReflectionUpsampleOutputs;
  destroy(): void;
}

const UPSAMPLE_WGSL = (depthType: string, depthLoad: string) => /* wgsl */ `
${BILATERAL_FILL_WGSL}
struct U {
  invViewProjection: mat4x4f,
  cameraPosition: vec3f, inverted: u32,
  fullSize: vec2u, halfSize: vec2u,
  normalMul: f32, normalAdd: f32, roughChannel: u32, roughPerceptual: u32,
  roughMul: f32, roughAdd: f32, hasSource: u32, wideFallback: u32,
  // BilateralWeights flattened (words 32-36): a struct member of a uniform struct must be followed by a
  // 16-byte-rounded gap in core WGSL (without uniform_buffer_standard_layout), so no struct here
  wPlaneTolerance: f32, wNormalPower: f32, wRoughnessTolerance: f32, wSourceMask: u32,
  wMinWeightSum: f32, tapMinRoughness: f32, weightInAlpha: u32,
};
fn upsampleWeights() -> BilateralWeights {
  return BilateralWeights(u.wPlaneTolerance, u.wNormalPower, u.wRoughnessTolerance, u.wSourceMask, u.wMinWeightSum);
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tDepth: ${depthType};
@group(0) @binding(2) var tNormal: texture_2d<f32>;
@group(0) @binding(3) var tRough: texture_2d<f32>;
@group(0) @binding(4) var tRadiance: texture_2d<f32>;
@group(0) @binding(5) var tHit: texture_2d<f32>;
@group(0) @binding(6) var tConfidence: texture_2d<f32>;
@group(0) @binding(7) var tSource: texture_2d<f32>;
@group(0) @binding(8) var oRadiance: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var oHit: texture_storage_2d<r32float, write>;
@group(0) @binding(10) var oConfidence: texture_storage_2d<r32float, write>;
@group(0) @binding(11) var oSource: texture_storage_2d<r32float, write>;

fn surfaceAt(p: vec2i) -> BilateralSurface {
  var s: BilateralSurface;
  let d = ${depthLoad};
  s.valid = select((d < 1.0), (d > 0.0), u.inverted != 0u);
  if (!s.valid) { return s; }
  let uv = (vec2f(p) + 0.5) / vec2f(u.fullSize);
  let h = u.invViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  s.position = h.xyz / h.w;
  s.normal = normalize(textureLoad(tNormal, p, 0).xyz * u.normalMul + u.normalAdd);
  var r = textureLoad(tRough, p, 0)[u.roughChannel] * u.roughMul + u.roughAdd;
  if (u.roughPerceptual == 0u) { r = sqrt(max(r, 0.0)); }
  s.roughness = r;
  return s;
}

// the filled pixel in sample space (sample c sits at full-res pixel 2c), and the gather's mode
var<private> gS: vec2f;
var<private> gWide: bool;
fn bilateralTap(cell: vec2i, pixel: vec2i) -> BilateralTap {
  var t: BilateralTap;
  if (any(cell < vec2i(0)) || any(cell >= vec2i(u.halfSize))) { return t; }
  let d = abs(vec2f(cell) - gS);
  let k = select(max(vec2f(0.0), 1.0 - d), max(vec2f(0.0), 1.0 - 0.5 * d), gWide);
  t.spatial = k.x * k.y;
  if (t.spatial <= 0.0) { return t; }
  t.surface = surfaceAt(min(cell * 2, vec2i(u.fullSize) - 1));
  if (t.surface.roughness < u.tapMinRoughness) { t.spatial = 0.0; return t; }
  t.radiance = textureLoad(tRadiance, cell, 0);
  if (u.weightInAlpha != 0u) { t.confidence = t.radiance.a; t.radiance.a = 0.0; }
  t.hitDistance = textureLoad(tHit, cell, 0).x;
  if (u.weightInAlpha == 0u) { t.confidence = textureLoad(tConfidence, cell, 0).x; }
  t.source = select(0u, u32(textureLoad(tSource, cell, 0).x + 0.5), u.hasSource != 0u);
  return t;
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= u.fullSize)) { return; }
  let p = vec2i(id.xy);
  let s = surfaceAt(p);
  var r: BilateralResult;
  if (s.valid) {
    gS = vec2f(p) * 0.5;
    let origin = p / 2;
    gWide = false;
    let w = upsampleWeights();
    r = bilateralFill(s, u.cameraPosition, p, origin, 2u, w);
    if (r.weightSum < w.minWeightSum && u.wideFallback != 0u) {
      gWide = true;
      r = bilateralFill(s, u.cameraPosition, p, origin, 4u, w);
    }
    if (r.weightSum < w.minWeightSum) { r = BilateralResult(); }
  }
  textureStore(oRadiance, p, select(r.radiance, vec4f(r.radiance.rgb, r.confidence), u.weightInAlpha != 0u));
  textureStore(oHit, p, vec4f(r.hitDistance, 0.0, 0.0, 0.0));
  textureStore(oConfidence, p, vec4f(r.confidence, 0.0, 0.0, 0.0));
  textureStore(oSource, p, vec4f(f32(r.source), 0.0, 0.0, 0.0));
}
`;

const UNIFORM_BYTES = 160;

export function createReflectionUpsample(device: GPUDevice, options: { width: number; height: number }): ReflectionUpsample {
  const { width: W, height: H } = options;
  const C = 0x4;
  const tex = (b: number, sampleType: GPUTextureSampleType = 'unfilterable-float'): GPUBindGroupLayoutEntry => ({ binding: b, visibility: C, texture: { sampleType } });
  const sto = (b: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({ binding: b, visibility: C, storageTexture: { access: 'write-only', format } });
  checkStageLimits(device, 'reflection upsample', [['pass', { storageTextures: 4, sampledTextures: 7 }]], 'or raise maxStorageTexturesPerShaderStage');
  const variants = new Map<'depth' | 'float', { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }>();
  const variant = (kind: 'depth' | 'float') => {
    let v = variants.get(kind);
    if (v) return v;
    const layout = device.createBindGroupLayout({
      label: `reflection upsample (${kind} depth)`,
      entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } }, tex(1, kind === 'depth' ? 'depth' : 'unfilterable-float'),
        tex(2), tex(3), tex(4), tex(5), tex(6), tex(7), sto(8, 'rgba16float'), sto(9, 'r32float'), sto(10, 'r32float'), sto(11, 'r32float')],
    });
    const code = kind === 'depth'
      ? UPSAMPLE_WGSL('texture_depth_2d', 'textureLoad(tDepth, p, 0)')
      : UPSAMPLE_WGSL('texture_2d<f32>', 'textureLoad(tDepth, p, 0).x');
    v = {
      layout,
      pipeline: device.createComputePipeline({
        label: `reflection upsample (${kind} depth)`, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: device.createShaderModule({ label: 'reflection upsample', code }), entryPoint: 'main' },
      }),
    };
    variants.set(kind, v);
    return v;
  };
  const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
  const out = (label: string, format: GPUTextureFormat) => device.createTexture({ label: `reflection upsample ${label}`, size: [W, H], format, usage });
  let own: ReflectionUpsampleOutputs | null = null;
  const ownOutputs = () => own ??= {
    radiance: out('radiance', 'rgba16float'), hitDistance: out('hit distance', 'r32float'),
    confidence: out('confidence', 'r32float'), source: out('source', 'r32float'),
  };
  const uniforms = device.createBuffer({ label: 'reflection upsample', size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const noSource = device.createTexture({ label: 'reflection upsample no source', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING });

  return {
    width: W, height: H,
    get outputs() { return ownOutputs(); },
    dispatch(cmd, inputs, settings = {}, timestampWrites) {
      const { frame } = inputs;
      const outputs = inputs.targets ?? ownOutputs();
      for (const [k, t] of Object.entries(outputs)) if (t.width !== W || t.height !== H) throw new Error(`reflection upsample: target ${k} is ${t.width}x${t.height}, expected ${W}x${H}`);
      if (frame.width !== W || frame.height !== H) throw new Error(`reflection upsample: frame is ${frame.width}x${frame.height}, created for ${W}x${H}`);
      if (frame.conventions.depthLinear) throw new Error('reflection upsample: linear depth is not supported; pass device depth');
      const hw = inputs.radiance.width, hh = inputs.radiance.height;
      for (const [k, t] of [['hitDistance', inputs.hitDistance], ['confidence', inputs.confidence], ['source', inputs.source]] as const) {
        if (t && (t.width !== hw || t.height !== hh)) throw new Error(`reflection upsample: ${k} is ${t.width}x${t.height}, radiance ${hw}x${hh}`);
      }
      const w = resolveBilateralFillWeights({ ...DEFAULT_REFLECTION_UPSAMPLE_WEIGHTS, ...settings });
      const c = frame.conventions, cam = frame.camera;
      const data = new ArrayBuffer(UNIFORM_BYTES);
      const f = new Float32Array(data), u = new Uint32Array(data);
      f.set(mat4Invert(mat4Mul(cam.projection, cam.view)), 0);
      f[16] = cam.position[0]; f[17] = cam.position[1]; f[18] = cam.position[2];
      u[19] = c.depthInverted ? 1 : 0;
      u[20] = W; u[21] = H; u[22] = hw; u[23] = hh;
      f[24] = c.normalUnpackMul; f[25] = c.normalUnpackAdd;
      u[26] = frame.textures.roughness.channel; u[27] = c.roughnessIsPerceptual ? 1 : 0;
      f[28] = c.roughnessUnpack?.mul ?? 1; f[29] = c.roughnessUnpack?.add ?? 0;
      u[30] = inputs.source ? 1 : 0; u[31] = settings.wideFallback ?? true ? 1 : 0;
      bilateralFillWeightWords(w, f, u, 32);
      f[37] = Math.max(0, settings.minRoughness ?? 0);
      u[38] = inputs.weightInAlpha ? 1 : 0;
      device.queue.writeBuffer(uniforms, 0, data);
      const depth = frame.textures.depth;
      const isDepth = depth.format.startsWith('depth');
      const { pipeline, layout } = variant(isDepth ? 'depth' : 'float');
      const pass = cmd.beginComputePass({ label: 'reflection upsample', timestampWrites });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: depth.createView(isDepth ? { aspect: 'depth-only' } : {}) },
          { binding: 2, resource: frame.textures.normal.createView() },
          { binding: 3, resource: frame.textures.roughness.texture.createView() },
          { binding: 4, resource: inputs.radiance.createView() },
          { binding: 5, resource: inputs.hitDistance.createView() },
          { binding: 6, resource: inputs.confidence.createView() },
          { binding: 7, resource: (inputs.source ?? noSource).createView() },
          { binding: 8, resource: outputs.radiance.createView() },
          { binding: 9, resource: outputs.hitDistance.createView() },
          { binding: 10, resource: outputs.confidence.createView() },
          { binding: 11, resource: outputs.source.createView() },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
      pass.end();
      return outputs;
    },
    destroy() {
      if (own) for (const t of Object.values(own)) t.destroy();
      own = null;
      noSource.destroy();
      uniforms.destroy();
    },
  };
}
