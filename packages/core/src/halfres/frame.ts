// Half-resolution reflections (W75, plan X5; docs/research/ssr-external-sources.md #9): a half-size
// copy of the frame contract, point-sampled from one pixel per 2x2 quad (the top-left one), so the
// tracer, the ray-traced pass and the denoise seam run on it unchanged at (ceil(w/2), ceil(h/2)).
//
// Point sampling keeps every half-res texel a real full-res surface (no averaged depth or normal that
// belongs to neither side of a silhouette). The half frame's camera carries a sub-pixel affine on its
// projection (`halfResolutionCamera`) so that half texel (x, y)'s centre reconstructs exactly the
// full-res pixel (2x, 2y)'s centre: positions, rays and on-screen reprojection of the half-res passes
// agree with the full-res G-buffer they were sampled from, and the upsample (./upsample.ts) can read
// the sample's surface from the full-res G-buffer at (2x, 2y).
import { mat4Multiply, type FrameCamera, type FrameInputs, type FrameTextures, type Mat4 } from '../frame/contract';

/** The half-resolution size of a `width` x `height` frame: ceil(w / 2) x ceil(h / 2). */
export function halfResolutionSize(width: number, height: number): [number, number] {
  return [Math.ceil(width / 2), Math.ceil(height / 2)];
}

/**
 * The clip-space affine (column-major 4x4) that maps the full-res projection to the half-res
 * frame's: half texel x's centre ((x + 0.5) / ceil(w/2) in uv) lands on full-res pixel 2x's centre
 * ((2x + 0.5) / w). For an even width it is a shift by half a full-res pixel; for an odd one a
 * scale by w / (2 ceil(w/2)) too.
 */
export function halfResolutionClipTransform(width: number, height: number): Float32Array {
  const [hw, hh] = halfResolutionSize(width, height);
  // uv_h = a uv_f + b, a = w / (2 hw), b = 0.25 / hw (x); ndc x = 2u - 1, ndc y = 1 - 2v
  const ax = width / (2 * hw), bx = 0.25 / hw;
  const ay = height / (2 * hh), by = 0.25 / hh;
  const m = new Float32Array(16);
  m[0] = ax; m[5] = ay; m[10] = 1; m[15] = 1;
  m[12] = ax + 2 * bx - 1;
  m[13] = 1 - ay - 2 * by;
  return m;
}

/** `camera` as the half-res frame of a `width` x `height` frame sees it (see `halfResolutionClipTransform`). */
export function halfResolutionCamera(camera: FrameCamera, width: number, height: number): FrameCamera {
  const m = halfResolutionClipTransform(width, height);
  const [hw, hh] = halfResolutionSize(width, height);
  const mul = (p: Mat4) => mat4Multiply(m, p);
  return {
    ...camera,
    projection: mul(camera.projection),
    projectionJittered: camera.projectionJittered ? mul(camera.projectionJittered) : undefined,
    prevProjection: mul(camera.prevProjection),
    prevViewProjection: mul(camera.prevViewProjection),
    jitter: [camera.jitter[0] * hw / width, camera.jitter[1] * hh / height],
  };
}

/** Point-samples a frame (and any other full-res texture) into half-size copies it owns. */
export interface HalfResolutionFrame {
  /**
   * Record the point sampling of every texture of `frame` into `cmd` and return the half frame:
   * same conventions (motion scale adjusted for odd sizes), camera from `halfResolutionCamera`,
   * depth as r32float device depth, two-channel targets widened to rgba16float.
   */
  build(cmd: GPUCommandEncoder, frame: FrameInputs): FrameInputs;
  /** Point-sample one more full-res texture (e.g. an app's history image) the same way. */
  sample(cmd: GPUCommandEncoder, texture: GPUTexture): GPUTexture;
  /** The last `build()`'s half frame (null before the first). */
  readonly frame: FrameInputs | null;
  destroy(): void;
}

const POINT_SAMPLE_WGSL = (src: string, load: string, fmt: GPUTextureFormat) => /* wgsl */ `
@group(0) @binding(0) var src: ${src};
@group(0) @binding(1) var dst: texture_storage_2d<${fmt}, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(dst))) { return; }
  let p = min(id.xy * 2u, textureDimensions(src) - 1u);
  textureStore(dst, id.xy, ${load});
}
`;

/** Storage format a half copy of `format` is written in. */
function halfFormat(format: GPUTextureFormat): GPUTextureFormat {
  if (format.startsWith('depth')) return 'r32float';
  switch (format) {
    case 'rgba8unorm': case 'bgra8unorm': case 'rgba8unorm-srgb': case 'bgra8unorm-srgb': return 'rgba8unorm';
    case 'r32float': case 'rgba32float': case 'rgba16float': return format;
    case 'rg32float': return 'rgba32float';
    default: return 'rgba16float';
  }
}

export interface HalfResolutionFrameOptions {
  /** Pass timestamp writes for the sampling (one compute pass per build). */
  timestampWrites?: () => GPUComputePassTimestampWrites | undefined;
}

export function createHalfResolutionFrame(device: GPUDevice, options: HalfResolutionFrameOptions = {}): HalfResolutionFrame {
  const C = 0x4;
  const pipelines = new Map<string, { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }>();
  const pipelineFor = (depth: boolean, fmt: GPUTextureFormat) => {
    const key = `${depth ? 'depth' : 'float'}:${fmt}`;
    let p = pipelines.get(key);
    if (p) return p;
    const layout = device.createBindGroupLayout({
      label: `half-res sample ${key}`,
      entries: [
        { binding: 0, visibility: C, texture: { sampleType: depth ? 'depth' : 'unfilterable-float' } },
        { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: fmt } },
      ],
    });
    const code = depth
      ? POINT_SAMPLE_WGSL('texture_depth_2d', 'vec4f(textureLoad(src, p, 0), 0.0, 0.0, 0.0)', fmt)
      : POINT_SAMPLE_WGSL('texture_2d<f32>', 'textureLoad(src, p, 0)', fmt);
    p = {
      layout,
      pipeline: device.createComputePipeline({
        label: `half-res sample ${key}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: device.createShaderModule({ label: `half-res sample ${key}`, code }), entryPoint: 'main' },
      }),
    };
    pipelines.set(key, p);
    return p;
  };
  // half copies by source texture; dropped when a build no longer uses their source (resize, swap)
  const copies = new Map<GPUTexture, { tex: GPUTexture; used: number }>();
  let generation = 0;
  let last: FrameInputs | null = null;
  const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;

  const copyOf = (src: GPUTexture) => {
    const [hw, hh] = halfResolutionSize(src.width, src.height);
    let c = copies.get(src);
    if (!c || c.tex.width !== hw || c.tex.height !== hh) {
      c?.tex.destroy();
      c = { tex: device.createTexture({ label: `half-res ${src.label || src.format}`, size: [hw, hh], format: halfFormat(src.format), usage }), used: generation };
      copies.set(src, c);
    }
    c.used = generation;
    return c.tex;
  };
  const record = (pass: GPUComputePassEncoder, src: GPUTexture, dst: GPUTexture) => {
    const depth = src.format.startsWith('depth');
    const { pipeline, layout } = pipelineFor(depth, dst.format);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: src.createView(depth ? { aspect: 'depth-only' } : {}) },
        { binding: 1, resource: dst.createView() },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(dst.width / 8), Math.ceil(dst.height / 8));
  };

  return {
    get frame() { return last; },
    build(cmd, frame) {
      generation++;
      const t = frame.textures;
      const sources: GPUTexture[] = [];
      const add = (x: GPUTexture | undefined) => { if (x && !sources.includes(x)) sources.push(x); };
      for (const x of [t.depth, t.normal, t.roughness.texture, t.metalness.texture, t.albedo, t.motion, t.sceneColor, t.lit, t.clearcoat]) add(x);
      const pass = cmd.beginComputePass({ label: 'half-res sample', timestampWrites: options.timestampWrites?.() });
      for (const s of sources) record(pass, s, copyOf(s));
      pass.end();
      for (const [src, c] of copies) if (generation - c.used > 2) { c.tex.destroy(); copies.delete(src); }
      const h = (x: GPUTexture) => copies.get(x)!.tex;
      const textures: FrameTextures = {
        depth: h(t.depth),
        normal: h(t.normal),
        roughness: { texture: h(t.roughness.texture), channel: t.roughness.channel },
        metalness: { texture: h(t.metalness.texture), channel: t.metalness.channel },
        albedo: h(t.albedo),
        motion: h(t.motion),
        sceneColor: h(t.sceneColor),
        lit: t.lit ? h(t.lit) : undefined,
        clearcoat: t.clearcoat ? h(t.clearcoat) : undefined,
      };
      const [hw, hh] = halfResolutionSize(frame.width, frame.height);
      const mvs = frame.conventions.motionVectorScale;
      last = {
        width: hw, height: hh, textures,
        conventions: { ...frame.conventions, motionVectorScale: [mvs[0] * frame.width / (2 * hw), mvs[1] * frame.height / (2 * hh)] },
        camera: halfResolutionCamera(frame.camera, frame.width, frame.height),
        frameIndex: frame.frameIndex,
      };
      return last;
    },
    sample(cmd, texture) {
      const dst = copyOf(texture);
      const pass = cmd.beginComputePass({ label: 'half-res sample (extra)' });
      record(pass, texture, dst);
      pass.end();
      return dst;
    },
    destroy() {
      for (const c of copies.values()) c.tex.destroy();
      copies.clear();
      last = null;
    },
  };
}
