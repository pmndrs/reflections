// The frame contract: what every screen-space and hybrid pass reads (docs/SPEC.md, "Frame contract").
//
// Adapters fill it from their engine; core never guesses a convention, so each one is a flag here.
// Engine-free: GPUTexture handles, plain arrays and numbers only.
//
// The camera struct is a superset of denoiser-core's `FrameCamera`, so one object can be passed
// through the denoise seam unchanged.

/** Column-major 4x4 matrix (three.js `Matrix4.elements`, gl-matrix, WGSL `mat4x4f`). */
export type Mat4 = Float32Array | ArrayLike<number>;

/** One channel of a texture, e.g. roughness in the alpha of the normal target. */
export interface TextureChannel {
  texture: GPUTexture;
  /** 0 = r, 1 = g, 2 = b, 3 = a. */
  channel: 0 | 1 | 2 | 3;
}

/** The G-buffer and colour targets of one frame. All are `width` x `height`. */
export interface FrameTextures {
  /**
   * Depth. Hardware depth (`depth32float` / `depth24plus`) unless `conventions.depthLinear`, in
   * which case an r32float of positive view-space distance along -Z.
   */
  depth: GPUTexture;
  /** Unit world-space normal in xyz, after `normalUnpackMul` / `normalUnpackAdd`. */
  normal: GPUTexture;
  /** Roughness, perceptual or alpha per `conventions.roughnessIsPerceptual`. */
  roughness: TextureChannel;
  /** Metalness in [0, 1]. F0 = mix(0.04, albedo, metalness). */
  metalness: TextureChannel;
  /** Base colour (linear, not premultiplied by 1 - metalness) in rgb. */
  albedo: GPUTexture;
  /** Screen motion in xy; see `conventions.motionVectorScale`. 0 where nothing was drawn. */
  motion: GPUTexture;
  /**
   * HDR scene radiance without specular reflections, the hit radiance for screen-space rays.
   * `conventions.sceneColorSpecular` says what it holds exactly.
   */
  sceneColor: GPUTexture;
  /** Optional: the engine's full lit frame (with its own specular), for debug and comparison. */
  lit?: GPUTexture;
}

export interface FrameConventions {
  /** Reverse-Z: 1 at the near plane, 0 at far. */
  depthInverted: boolean;
  /** `depth` holds linear view distance (r32float) instead of hardware depth. */
  depthLinear: boolean;
  /** normal = texel.xyz * normalUnpackMul + normalUnpackAdd (FFX's `normalUnPackMul/Add`). Raw float: 1, 0. Unorm-packed: 2, -1. */
  normalUnpackMul: number;
  normalUnpackAdd: number;
  /** Roughness is perceptual (artist) roughness; alpha = roughness². three: true. */
  roughnessIsPerceptual: boolean;
  /**
   * Maps the stored motion to a uv-space offset: `uvPrevious = uv - motion.xy * motionVectorScale`
   * (uv: x right, y down, [0, 1]). A uv-space target uses [1, 1]; three's NDC velocity (current -
   * previous, y up) uses [0.5, -0.5].
   */
  motionVectorScale: readonly [number, number];
  /**
   * What `sceneColor` holds:
   *  - 'none': emissive + direct diffuse + indirect diffuse. No specular lobe at all.
   *  - 'direct': as 'none' plus direct (punctual-light) specular; only indirect specular is left out.
   */
  sceneColorSpecular: 'none' | 'direct';
}

/** Camera state of the current and previous frame. A superset of denoiser-core's `FrameCamera`. */
export interface FrameCamera {
  /** World to view. */
  view: Mat4;
  /** View to clip, WITHOUT jitter. */
  projection: Mat4;
  prevView: Mat4;
  prevProjection: Mat4;
  /** prevProjection · prevView: last frame's world to clip, unjittered. */
  prevViewProjection: Mat4;
  /** Sub-pixel jitter applied to this frame's render, in pixels. */
  jitter: readonly [number, number];
  near: number;
  far: number;
  /** World-space camera position. */
  position: readonly [number, number, number];
  /** Same as `FrameConventions.depthInverted`; kept for denoiser-core compatibility. */
  reversedDepth: boolean;
}

/** Everything a pass needs for one frame. */
export interface FrameInputs {
  width: number;
  height: number;
  textures: FrameTextures;
  conventions: FrameConventions;
  camera: FrameCamera;
  /** Monotonic frame index (blue-noise and sample sequences key on it). */
  frameIndex: number;
}

/** out = a · b for column-major 4x4 matrices. */
export function mat4Multiply(a: Mat4, b: Mat4, out = new Float32Array(16)): Float32Array {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  }
  out.set(r);
  return out;
}

/**
 * Keeps the previous frame's matrices and builds a `FrameCamera` each frame. Engine-free: adapters
 * pass in their matrices. Call `update()` once per rendered frame, `reset()` on camera cuts.
 */
export class FrameCameraHistory {
  private prevView = new Float32Array(16);
  private prevProjection = new Float32Array(16);
  private hasPrev = false;

  update(frame: {
    view: Mat4; projection: Mat4; near: number; far: number;
    position: readonly [number, number, number]; jitter?: readonly [number, number]; reversedDepth?: boolean;
  }): FrameCamera {
    const view = Float32Array.from(frame.view as ArrayLike<number>);
    const projection = Float32Array.from(frame.projection as ArrayLike<number>);
    const prevView = this.hasPrev ? this.prevView.slice() : view.slice();
    const prevProjection = this.hasPrev ? this.prevProjection.slice() : projection.slice();
    this.prevView.set(view);
    this.prevProjection.set(projection);
    this.hasPrev = true;
    return {
      view, projection, prevView, prevProjection,
      prevViewProjection: mat4Multiply(prevProjection, prevView),
      jitter: frame.jitter ?? [0, 0],
      near: frame.near, far: frame.far,
      position: frame.position,
      reversedDepth: frame.reversedDepth ?? false,
    };
  }

  reset() { this.hasPrev = false; }
}
