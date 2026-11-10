// Babylon's conventions, mapped onto the core frame contract (packages/core/src/frame/contract.ts).
//
// What Babylon does differently from three (the contract's first engine), and where each goes:
//
//   matrices     Babylon multiplies row vectors (v * M) and stores the translation in m[12..14], so
//                `Matrix.m` read as column-major is the same transform as three's `elements`: passed as is.
//   handedness   Babylon's default world is left-handed: the camera looks down +Z in view space. The
//                tracer's view space is three's (right-handed, -Z forward), so the adapter hands it
//                V' = Sz V and P' = P Sz (Sz = diag(1, 1, -1, 1)): P' V' = P V, clip space unchanged,
//                world space untouched (normals, positions, reflection directions, probe volumes stay
//                Babylon's). No contract flag says this; D1800.
//   y flip       Babylon's WebGPU engine draws every render target Y-flipped (row 0 holds NDC y = -1)
//                so a sampled render target matches WebGL's texture convention. The tracer maps texel
//                rows to NDC y with y down (row 0 = top). Rather than flipping every input, the adapter
//                flips the projection it hands the tracer: P'' = Fy P' (Fy = diag(1, -1, 1, 1)), so
//                the tracer's "row 0 = top of the clip space" is Babylon's row 0. Every output then has
//                Babylon's render-target orientation and Babylon samples it upright. No flag; D1801.
//   depth        WebGPU depth is already the contract's [0, 1] (`isNDCHalfZRange`), 0 at minZ; reverse
//                Z under `engine.useReverseDepthBuffer` -> `depthInverted`.
//   motion       PREPASS_VELOCITY_LINEAR stores 0.5 (previousNDC - currentNDC); on a flipped target
//                texel-uv `current - previous` is exactly -velocity on both axes: motionVectorScale
//                [-1, -1] (the same value @pmndrs/upscaler verified with its jitter-sign test).
//   normal       PREPASS_WORLD_NORMAL stores n * 0.5 + 0.5: normalUnpackMul 2, add -1.
//   roughness    PREPASS_REFLECTIVITY.a is `microSurface` = glossiness = 1 - perceptual roughness. The
//                contract reads roughness from a channel with no remap, so the adapter converts it in
//                a one-dispatch pass (./frame.ts). D1802.
//   F0           PREPASS_REFLECTIVITY.rgb is F0 (Babylon's specularEnvironmentR0, metalness already
//                applied). The contract wants albedo + metalness; the adapter passes albedo = F0 and
//                metalness = 1, which gives F0 = mix(0.04, albedo, 1) exactly. D1803.
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import { FrameCameraHistory, type FrameCamera, type FrameConventions } from '@pmndrs/reflections-core';

/** motionVectorScale for PREPASS_VELOCITY_LINEAR on Babylon's Y-flipped render targets. */
export const BABYLON_MOTION_SCALE: readonly [number, number] = [-1, -1];

/** The contract conventions of the adapter's G-buffer (./frame.ts), given the engine's depth mode. */
export function babylonFrameConventions(depthInverted: boolean, sceneColorSpecular: FrameConventions['sceneColorSpecular'] = 'direct'): FrameConventions {
  return {
    depthInverted,
    depthLinear: false,
    normalUnpackMul: 2,
    normalUnpackAdd: -1,
    roughnessIsPerceptual: true,
    motionVectorScale: BABYLON_MOTION_SCALE,
    sceneColorSpecular,
  };
}

/** V' = Sz V (negate row 2): Babylon's left-handed view space as a right-handed, -Z-forward one. */
export function tracerView(view: ArrayLike<number>, out = new Float32Array(16)): Float32Array {
  out.set(view as ArrayLike<number>);
  for (const i of [2, 6, 10, 14]) out[i] = -out[i];
  return out;
}

/** P'' = Fy P Sz (negate row 1, then column 2): Babylon's projection for the tracer's view space and texel rows. */
export function tracerProjection(projection: ArrayLike<number>, out = new Float32Array(16)): Float32Array {
  out.set(projection as ArrayLike<number>);
  for (const i of [1, 5, 9, 13]) out[i] = -out[i];
  for (const i of [8, 9, 10, 11]) out[i] = -out[i];
  return out;
}

/**
 * Builds the contract's camera from a Babylon camera, in the tracer's frame (see the header): view
 * and projection converted, world position as is, previous frame from `history`. Call once per
 * rendered frame, after the render that filled the G-buffer.
 */
export function babylonFrameCamera(camera: Camera, depthInverted: boolean, history: FrameCameraHistory): FrameCamera {
  if (!(camera.maxZ > 0)) throw new Error('@pmndrs/reflections/babylon: the camera needs a finite far plane (maxZ > 0).');
  const p = camera.globalPosition;
  return history.update({
    view: tracerView(camera.getViewMatrix().m),
    projection: tracerProjection(camera.getProjectionMatrix().m),
    near: camera.minZ,
    far: camera.maxZ,
    position: [p.x, p.y, p.z],
    reversedDepth: depthInverted,
  });
}
