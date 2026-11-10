// The frame contract (core FrameInputs) from the adapter's G-buffer (./gbuffer.ts). Because the
// adapter draws its own 3-D layer, it picks the contract's native conventions and nothing needs
// converting (compare the babylon adapter's D1800-D1803):
//
//   depth      depth32float, standard Z (0 near, 1 far)          depthInverted false, depthLinear false
//   normal     rgba16float world normal                           normalUnpack 1, 0
//   roughness  normal.w, perceptual                               roughnessIsPerceptual true
//   metalness  material.w, albedo material.rgb                    F0 = mix(0.04, albedo, metalness)
//   motion     motion.xy = uv(current) - uv(previous), y down     motionVectorScale [1, 1]
//   colour     lit without indirect specular                      sceneColorSpecular 'direct'
//   camera     right-handed, -Z forward, WebGPU clip z [0, 1]      matrices as built (./math.ts)
import { FrameCameraHistory, type FrameConventions, type FrameInputs } from '@pmndrs/reflections-core';
import type { GBufferTargets } from './gbuffer';
import type { Vec3 } from './math';

/** The conventions of the adapter's G-buffer: the contract's own. */
export const PIXI_FRAME_CONVENTIONS: FrameConventions = Object.freeze({
  depthInverted: false,
  depthLinear: false,
  normalUnpackMul: 1,
  normalUnpackAdd: 0,
  roughnessIsPerceptual: true,
  motionVectorScale: [1, 1] as const,
  sceneColorSpecular: 'direct' as const,
});

/** Builds FrameInputs from the G-buffer targets; keeps the previous camera for motion and the denoise seam. */
export class PixiFrame {
  readonly conventions = PIXI_FRAME_CONVENTIONS;
  private readonly history = new FrameCameraHistory();
  private frameIndex = 0;

  /** The next frame has no previous one (camera cut). */
  resetHistory() { this.history.reset(); }
  get hasPrevious() { return this.history.hasPrevious; }

  build(targets: GBufferTargets, camera: { view: ArrayLike<number>; projection: ArrayLike<number>; eye: Vec3; near: number; far: number }): FrameInputs {
    return {
      width: targets.width,
      height: targets.height,
      textures: {
        depth: targets.depth,
        normal: targets.normal.gpu,
        roughness: { texture: targets.normal.gpu, channel: 3 },
        metalness: { texture: targets.material.gpu, channel: 3 },
        albedo: targets.material.gpu,
        motion: targets.motion.gpu,
        sceneColor: targets.color.gpu,
      },
      conventions: this.conventions,
      camera: this.history.update({
        view: camera.view, projection: camera.projection, near: camera.near, far: camera.far,
        position: [camera.eye[0], camera.eye[1], camera.eye[2]], reversedDepth: false,
      }),
      frameIndex: this.frameIndex++,
    };
  }
}
