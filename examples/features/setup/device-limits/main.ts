// What changes on a renderer with WebGPU's default limits, and how the package degrades instead of failing.
//
// What it shows: a plain `new WebGPURenderer()` asks the GPU for WebGPU's default limits only. Two of them matter here:
//   - maxColorAttachmentBytesPerSample (default 32): the G-buffer plus three's lit image needs 36. On 32 the G-buffer renders the lit
//     image in a second plain pass (one more scene draw per frame, shadow maps included) and three's specular weights are estimated
//     instead of read from the material (no `specular` target). One console warning says so (docs/DIVERGES.md D5480).
//   - maxStorageBuffersPerShaderStage (default 8): the ray-traced pass binds 8 with the packed scene copy, so it runs. A configuration
//     that needs more (here: the split scene copy, 9 with probe hit shading) turns ray tracing off with one warning and sets
//     `pass.traceError`; screen space and probes go on (D5451).
// `createReflectionsRenderer()` (or `requiredLimits: reflectionsRequiredLimits(adapter)`) asks for what the passes need, up to what the
// adapter has. The two images are by nature nearly the same (quick start: 0.44 / 255 mean, from the estimated specular weights): the
// difference is the cost (the extra draw) and what is shown below, not the picture. Switching renderers needs a reload: the page
// reads `?renderer=plain|reflections` and `?rt=1|split|0`.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflections, createRaytracerTraceProviderFromObjects, createReflectionsRenderer } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { mirrorWall } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('setup/device-limits');

const q = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const limitsEl = document.querySelector<HTMLElement>('#limits')!;
const rendererSelect = document.querySelector<HTMLSelectElement>('#renderer')!;
const rtSelect = document.querySelector<HTMLSelectElement>('#rt')!;

async function main() {
  const plain = q.get('renderer') !== 'reflections';
  const rt = q.get('rt') ?? '1';
  rendererSelect.value = plain ? 'plain' : 'reflections';
  rtSelect.value = rt;
  const reload = () => { const u = new URL(location.href); u.searchParams.set('renderer', rendererSelect.value); u.searchParams.set('rt', rtSelect.value); location.href = u.href; };
  rendererSelect.onchange = reload;
  rtSelect.onchange = reload;

  // ---- the part to compare ---------------------------------------------------------------------
  const renderer = plain
    ? new THREE.WebGPURenderer({ canvas, antialias: false })        // WebGPU's default limits
    : await createReflectionsRenderer({ canvas, antialias: false }); // the limits the passes need, initialised
  if (plain) await renderer.init();
  // ----------------------------------------------------------------------------------------------
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const kit = mirrorWall({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  const reflections = await Reflections.create(renderer, scene, {
    rayTracing: rt !== '0',
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });
  if (rt === 'split') {
    // the same meshes, bound as a split scene copy: one storage buffer more than the packed one (9 with probe hit shading)
    reflections.trace?.provider.destroy();
    const built = await createRaytracerTraceProviderFromObjects(reflections.ssr.device, scene, { packing: 'split' });
    reflections.ssr.setTraceProvider(built.provider);
  }

  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
  };
  renderer.setAnimationLoop(frame);

  const info = () => {
    const { device, gbuffer } = reflections.ssr;
    return {
      renderer: plain ? 'new WebGPURenderer()' : 'createReflectionsRenderer()',
      colorBytesPerSample: device.limits.maxColorAttachmentBytesPerSample,
      storageBuffersPerStage: device.limits.maxStorageBuffersPerShaderStage,
      litPass: gbuffer.litPass, exactSpecular: !!gbuffer.specular,
      rayTracing: rt, traced: !!reflections.ssr.traced, traceError: reflections.ssr.traceError ?? null,
    };
  };
  const show = () => {
    const i = info();
    limitsEl.textContent = [
      `colour bytes per sample  ${i.colorBytesPerSample}  (need 36)`,
      `storage buffers / stage  ${i.storageBuffersPerStage}`,
      `lit image   ${i.litPass ? 'second scene draw' : 'in the G-buffer'}`,
      `specular    ${i.exactSpecular ? 'from the material' : 'estimated'}`,
      `ray tracing ${rt === '0' ? 'off (not asked for)' : i.traced ? 'on' : i.traceError ? 'off: see the status line' : 'starting...'}`,
    ].join('\n');
    status.textContent = `${i.renderer}: ` +
      (i.litPass ? 'the scene is drawn twice per frame (G-buffer + lit image), with one console warning. ' : 'one scene draw per frame. ') +
      (i.traceError ? `pass.traceError: ${i.traceError}` : 'Drag to orbit.');
  };
  setInterval(show, 500);
  show();

  // headless driver (scripts/run-headless.mjs, section `catalog`). No setCompare: the compare is a reload (`?renderer=reflections`).
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    /** Stops the loop and pins the tracer's noise (frame index 0), so shots repeat exactly. */
    stop() { renderer.setAnimationLoop(null); reflections.ssr.settings.frameIndex = 0; },
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    info,
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
