// Code samples for the pixi page. See three.ts for how these are checked.
// pixi-3d is a closed beta the adapter never imports, so the parts of it the sample touches are typed here.
import { Application, type Texture, type WebGPURenderer } from 'pixi.js';
import type { SpecularInputs, TemporalDenoiser } from '@pmndrs/reflections/core';
import { PixiProbeSet, ReflectionsView, getDevice, requestReflectionsDevice, type Pixi3DCameraLike } from '@pmndrs/reflections/pixi';

interface View3DLike { camera: Pixi3DCameraLike; setSize(width: number, height: number): void }
interface OutputPass { texture: Texture }

// #region pixi-app
export async function createApp(): Promise<Application> {
  const app = new Application();
  await app.init({
    preference: 'webgpu',
    gpu: await requestReflectionsDevice(), // a device with the limits and features the library uses
    width: 960,
    height: 540,
    resolution: 1,
    antialias: false,
  });
  return app;
}
// #endregion

export function pixiSetup(
  app: Application,
  view3d: View3DLike,
  depthPass: OutputPass,
  motionPass: OutputPass,
  gbufferPass: OutputPass,
  denoiser: TemporalDenoiser<SpecularInputs> | null,
) {
  const renderer = app.renderer as WebGPURenderer;
  // #region pixi-view
  // Optional: probes for what the screen cannot see. The example's ProbeCapture then fills them from six pixi-3d renders.
  const probes = new PixiProbeSet(renderer, { capacity: 1, sourceSize: 128 });
  probes.setProbes([{ position: [0, 1.2, -1.6], influenceSize: [30, 10, 30], fade: 2 }]);

  const view = new ReflectionsView({ renderer, width: 960, height: 540, resolution: 1, probes, denoiser });
  view3d.setSize(view.pixelWidth, view.pixelHeight); // pixi-3d renders at the frame's size
  app.stage.addChild(view);

  // Each frame, before pixi renders the stage:
  const frame = () => {
    renderer.render({ container: view3d as never, target: view.colorTarget });
    view.render({ depth: depthPass.texture, motion: motionPass.texture, gbuffer: gbufferPass.texture }, view3d.camera);
  };
  // #endregion
  return { view, frame, device: getDevice(renderer) };
}
