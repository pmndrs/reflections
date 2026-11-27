// Quick start: reflections on an existing three.js WebGPURenderer scene.
//
// The scene (./scene.ts) is plain three. What this file adds is `Reflections`: it renders your
// scene through a G-buffer, traces screen-space reflections, fills what the screen cannot see from
// a baked probe (and, optionally, from rays against a BVH), denoises the result and composites it
// into the final image. You call `reflections.render(camera)` where you called `renderer.render()`.
//
// Needs: three >= 0.187 and a browser with WebGPU. `?rt=1` adds the ray-traced fallback (`@pmndrs/raytracer`),
// `?denoise=0` turns the denoiser off, `?preset=performance`.
// Checks only (W89, D5451; W91, D5480): `?limits=default` builds a plain `new WebGPURenderer()` instead of `createReflectionsRenderer`,
// with WebGPU's default limits (8 storage buffers per stage, 32 colour attachment bytes per sample: the G-buffer renders three's lit
// image in a second pass, with one warning); `&rtPacking=split` attaches a provider that binds one storage buffer more than 8 with
// probe hit shading, so ray tracing turns itself off with one warning.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflections, createRaytracerTraceProviderFromObjects, createReflectionsRenderer } from '@pmndrs/reflections/three';
// The denoiser is a separate library (`denoiser/ffx`: AMD's reflection denoiser in WGSL). It is
// optional, but glossy reflections are noisy and shimmer without it. In your project:
//   import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { createScene } from './scene';
import { mountShell } from '../../shell'; // the examples' nav and info panel (not part of the quick start)

mountShell('start/hello', { placement: 'inline' });
const q = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;

async function main() {
  // 1. A WebGPURenderer with the device limits the passes need (plain three would not ask for them).
  const defaultLimits = q.get('limits') === 'default';
  const renderer = defaultLimits
    ? new THREE.WebGPURenderer({ canvas, antialias: false })
    : await createReflectionsRenderer({ canvas, antialias: false });
  if (defaultLimits) await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // the usual renderer settings still apply
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // 2. Your scene and camera, as always.
  const { scene, camera } = createScene(renderer);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.6, 0.3);
  controls.enableDamping = true;

  const Ffx = q.get('denoise') !== '0' ? FfxReflectionDenoiser : null;
  // 3. Reflections: one object. Everything but the renderer and the scene is optional.
  const reflections = await Reflections.create(renderer, scene, {
    preset: q.get('preset') === 'performance' ? 'performance' : 'default',
    rayTracing: q.get('rt') === '1', // rays for what neither the screen nor the probe has (needs @pmndrs/raytracer)
    denoiser: Ffx && ((device, { roughnessThreshold }) => new Ffx(device, { roughnessThreshold: roughnessThreshold ** 2 })),
  });

  // (checks only) a provider whose scene copy is bound split: 9 storage buffers with probe hit shading
  if (q.get('rt') === '1' && q.get('rtPacking') === 'split') {
    reflections.trace?.provider.destroy();
    const built = await createRaytracerTraceProviderFromObjects(reflections.ssr.device, scene, { packing: 'split' });
    reflections.ssr.setTraceProvider(built.provider);
  }

  // 4. The loop: reflections.render(camera) instead of renderer.render(scene, camera).
  let on = true;
  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    if (on) reflections.render(camera);
    else renderer.render(scene, camera); // the baseline: three's own pass (with the probes as its environment)
  };
  renderer.setAnimationLoop(frame);

  // the one toggle
  const toggle = document.querySelector<HTMLInputElement>('#on')!;
  toggle.onchange = () => { on = toggle.checked; };
  status.textContent = `screen space${reflections.probes ? ' + probes' : ''}${reflections.trace ? ' + ray tracing' : ''}${reflections.hybrid.denoiser ? ' + denoiser' : ' (no denoiser: glossy reflections are noisy)'}; drag to orbit`;

  // headless driver (scripts/run-headless.mjs, section `quickstart`)
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    stop() { renderer.setAnimationLoop(null); },
    setOn(v: boolean) { on = v; toggle.checked = v; },
    /** Render n frames (denoiser history), then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    info: () => ({
      denoiser: !!reflections.hybrid.denoiser, probes: !!reflections.probes, rt: !!reflections.trace, baked: reflections.probes?.bakedProbes.length ?? 0,
      storageBuffersPerStage: reflections.ssr.device.limits.maxStorageBuffersPerShaderStage, traced: !!reflections.ssr.traced, traceError: reflections.ssr.traceError,
      colorBytesPerSample: reflections.ssr.device.limits.maxColorAttachmentBytesPerSample, litPass: reflections.ssr.gbuffer.litPass, exactSpecular: reflections.ssr.gbuffer.specular,
    }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
