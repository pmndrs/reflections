// Code samples for docs/site/**/*.mdx. `pnpm docs:check` type-checks this file (tsconfig.snippets.json) and
// checks that each `#region` here is the code block of the same name in the MDX, character for character.
// Edit the region here, then run `pnpm docs:snippets` to copy it into the pages.
import * as THREE from 'three/webgpu';
import { renderOutput } from 'three/tsl';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import {
  HybridReflections,
  Reflections,
  ReflectionProbe,
  ReflectionProbes,
  ScreenSpaceReflectionsPass,
  applyReflectionsPreset,
  createRaytracerTraceProviderFromObjects,
  createReflectionsRenderer,
  installCubeArraySupport,
  getDevice,
  reflectionProbes,
  reflectionsRequiredLimits,
} from '@pmndrs/reflections';
import type { SpecularInputs, TemporalDenoiser } from '@pmndrs/reflections/core';

// #region renderer-limits
export async function createRenderer(canvas: HTMLCanvasElement): Promise<THREE.WebGPURenderer> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU is not available');
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,
    // Asks for the most the adapter allows, up to what the library uses.
    requiredLimits: reflectionsRequiredLimits(adapter),
  });
  await renderer.init();
  return renderer;
}
// #endregion

export async function oneCall(canvas: HTMLCanvasElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  // #region reflections-create
  // A WebGPURenderer with the device limits the passes need, already initialised.
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });

  const reflections = await Reflections.create(renderer, scene, {
    preset: 'default', // or 'performance'
    rayTracing: false, // true needs @pmndrs/raytracer and @pmndrs/bvh
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });

  // Where you called renderer.render(scene, camera):
  renderer.setAnimationLoop(() => reflections.render(camera));
  // #endregion
  return reflections;
}

export async function firstFrame(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, denoiser: TemporalDenoiser<SpecularInputs> | null) {
  // #region first-frame
  // G-buffer + screen-space trace, on the renderer's own device.
  const ssr = new ScreenSpaceReflectionsPass(renderer);

  // The hybrid resolve: the denoiser is optional (see "Denoising and upscaling").
  const hybrid = new HybridReflections(ssr, { denoiser, environment: scene.environment });

  // One full-screen pass puts the result in the frame.
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = renderOutput(hybrid.composite().final, THREE.AgXToneMapping, THREE.SRGBColorSpace);

  function frame() {
    ssr.render(scene, camera); // G-buffer and trace
    hybrid.update(); // resolve and denoise
    pipeline.render(); // composite on screen
    requestAnimationFrame(frame);
  }
  frame();
  // #endregion
}

export async function bakeProbes(renderer: THREE.WebGPURenderer, scene: THREE.Scene) {
  // #region probes
  // Optional: lets the probes live in a real cube array on three r187.
  await installCubeArraySupport(renderer);

  const probes = new ReflectionProbes();
  const room = new ReflectionProbe(6, 3, 6); // influence box: width, height, depth
  room.position.set(0, 1.5, 0);
  probes.add(room);
  scene.add(probes);

  probes.bake(renderer, scene, { resolution: 128 });
  scene.environmentNode = reflectionProbes(probes) as never; // every physical material uses them (`as never`: three's typings are narrower than the node)
  // #endregion
  return probes;
}

export function orientedProbe(probes: ReflectionProbes) {
  // #region probes-oriented
  const room = new ReflectionProbe(6, 3, 4); // in the room's frame: width, height, depth
  room.oriented = true;                      // the boxes follow the probe's world rotation
  room.position.set(2, 1.5, -3);
  room.rotation.y = Math.PI / 6;             // this room's walls run at 30 degrees
  probes.add(room);
  // #endregion
  return room;
}

export async function rayTracedFallback(renderer: THREE.WebGPURenderer, scene: THREE.Scene, meshes: THREE.Mesh[]) {
  // #region ray-traced
  // needs `npm install @pmndrs/raytracer @pmndrs/bvh`
  const { provider } = await createRaytracerTraceProviderFromObjects(getDevice(renderer), meshes);
  const ssr = new ScreenSpaceReflectionsPass(renderer, { trace: { provider } });
  // #endregion
  return ssr;
}

export function usePreset(ssr: ScreenSpaceReflectionsPass, hybrid: HybridReflections) {
  // #region preset
  const { resolutionChanged } = applyReflectionsPreset({ ssr, hybrid }, 'performance');
  if (resolutionChanged) {
    hybrid.rebuild(); // the resolution changed: build the composite again
    // ...and call hybrid.composite() again for your own output node
  }
  // #endregion
}

export function tuneSettings(ssr: ScreenSpaceReflectionsPass) {
  // #region settings
  ssr.settings.roughnessThreshold = 0.5; // trace rougher surfaces (more rays, more noise)
  ssr.settings.samplesPerQuad = 2; // two rays per 2x2 quad on glossy pixels
  ssr.settings.maxCandidates = 4; // look past thin objects in front of a wall
  // #endregion
}
