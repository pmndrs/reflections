// Raw WebGPU: the engine page with no engine. `@pmndrs/reflections/core` on a bare GPUDevice: the probe set and the
// screen-space tracer, fed by the frame contract, denoised through the denoise seam, on the two rooms of engines/three.
//
// What an adapter does for an engine, written out once:
//   ./scene.ts     the rooms as triangle meshes and materials (three's generators, so they match engines/three)
//   ./renderer.ts  the smallest renderer that fills the frame contract: a forward pass into depth, normal + roughness,
//                  base colour + metalness, motion and the scene colour (direct light, shadows, the probes' bounce
//                  light); the point lights' cube shadow maps; the probes' 90-degree captures; the composite
//   this file      the core part: ProbeSet (captured from the renderer, prefiltered by core), the tracer with the
//                  probes as its radiance fallback, the denoise seam (FFX from `denoiser/ffx`), the loop
// Not on this page: the ray-traced fallback (core has it, `RaytracerTraceProvider` over plain geometry and the trace
// seam; left out to keep to the probes and the tracer) and the hybrid resolve (a three.js object): screen space with the
// probes behind it, as on Babylon and pixi.
import {
  FrameCameraHistory, ProbeSet, createReflectionDenoiseSeam, createScreenSpaceReflections, mat4Multiply, probeRadianceFallback,
  reflectionsRequiredLimits, screenSpaceInputsFromFrame, type FrameInputs, type ScreenSpaceReflections, type ScreenSpaceReflectionsSettings,
} from '@pmndrs/reflections/core';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { CUBE_FACES, buildRooms, lookAt, perspective, viewMatrix, type V3 } from './scene';
import { RoomsRenderer } from './renderer';
import { mountShell } from '../../shell';

mountShell('engines/core');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const ssrBox = document.querySelector<HTMLInputElement>('#ssr')!;
const animateBox = document.querySelector<HTMLInputElement>('#animate')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;
const debugSelect = document.querySelector<HTMLSelectElement>('#debugView')!;
const FOV = (50 * Math.PI) / 180, NEAR = 0.05, FAR = 60;

async function main() {
  // 1. A device with the limits the passes need, and subgroups for the tracer's faster variant when there are any.
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU is not available in this browser');
  const device = await adapter.requestDevice({
    requiredFeatures: (['subgroups'] as GPUFeatureName[]).filter((f) => adapter.features.has(f)),
    requiredLimits: reflectionsRequiredLimits(adapter),
  });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU validation:', (e as GPUUncapturedErrorEvent).error.message));
  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  // 2. The rooms, and the probe set: one probe per room and one in the doorway, no environment slot (the rooms are closed).
  const rooms = buildRooms();
  const probes = new ProbeSet(device, { capacity: 3, sourceSize: 256, environment: false, distanceRoughness: true });
  probes.setVolumes(rooms.probes.map((p, slot) => ({
    slot, center: p.center, halfSize: [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2] as V3, fade: 0.5,
    boxProjection: true, projectionSize: p.projectionSize, projectionOffset: p.offset, origin: [p.center[0] + p.offset[0], p.center[1] + p.offset[1], p.center[2] + p.offset[2]] as V3,
  })));
  probes.update();
  const renderer = new RoomsRenderer(device, rooms.meshes, rooms.lights, probes, format);

  // 3. Bake: the renderer draws six faces per probe, core prefilters them into the atlas. Two passes, as three's default:
  //    the first sees direct light only (the set switched off), the second sees the first's probes (bounce light and
  //    glossy reflections in the captures). Every cube is rendered before any is captured, so the order does not matter.
  const cubes = rooms.probes.map(() => device.createTexture({ size: [256, 256, 6], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }));
  const cubeDepth = device.createTexture({ size: [256, 256], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  rooms.probes.forEach((p, i) => {
    const eye: V3 = [p.center[0] + p.offset[0], p.center[1] + p.offset[1], p.center[2] + p.offset[2]];
    CUBE_FACES.forEach((f, k) => renderer.writeView(1 + i * 6 + k, mat4Multiply(perspective(Math.PI / 2, 1, NEAR, FAR), viewMatrix(eye, ...f)), eye));
  });
  renderer.updateMeshes();
  for (const bounce of [1, 2]) {
    probes.enabled = bounce > 1;
    probes.update();
    const encoder = device.createCommandEncoder();
    renderer.shadows(encoder);
    cubes.forEach((cube, i) => renderer.capture(encoder, cube, cubeDepth, 1 + i * 6));
    cubes.forEach((cube, slot) => probes.capture(encoder, slot, cube));
    device.queue.submit([encoder.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  for (const t of [...cubes, cubeDepth]) t.destroy();

  // 4. The tracer, with the probes as its radiance fallback, and the denoise seam.
  const fallback = probeRadianceFallback(probes);
  const seam = createReflectionDenoiseSeam(device, { denoiser: new FfxReflectionDenoiser(device, { roughnessThreshold: 0.447 ** 2 }) });
  const history = new FrameCameraHistory();
  const settings: ScreenSpaceReflectionsSettings = {};
  let tracer: ScreenSpaceReflections | null = null;
  let size: [number, number] = [0, 0];
  const resize = () => {
    const w = Math.max(16, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)));
    const h = Math.max(16, Math.round(canvas.clientHeight * Math.min(devicePixelRatio, 2)));
    if (w === size[0] && h === size[1]) return;
    size = [w, h];
    canvas.width = w; canvas.height = h;
    renderer.resize(w, h);
    tracer?.destroy();
    tracer = createScreenSpaceReflections(device, { width: w, height: h, depthInverted: false, radianceFallback: fallback });
    history.reset();
    seam.resetHistory();
  };

  // The camera: orbit around a target (drag, wheel), and the rooms' views.
  const cam = { pos: [0, 0, 0] as V3, target: [0, 0, 0] as V3 };
  for (const name of Object.keys(rooms.views)) viewSelect.append(new Option(name, name));
  const setView = (name: string) => {
    const v = rooms.views[name] ?? rooms.views.default;
    cam.pos = [...v.pos]; cam.target = [...v.target];
    viewSelect.value = name;
    history.reset(); seam.resetHistory();
  };
  viewSelect.onchange = () => setView(viewSelect.value);
  setView('default');
  canvas.addEventListener('pointermove', (e) => {
    if (!e.buttons) return;
    const d = cam.pos.map((x, i) => x - cam.target[i]) as V3, r = Math.hypot(...d);
    const yaw = Math.atan2(d[0], d[2]) - e.movementX * 0.005;
    const pitch = Math.min(1.5, Math.max(-1.5, Math.asin(d[1] / r) + e.movementY * 0.005));
    cam.pos = [cam.target[0] + r * Math.cos(pitch) * Math.sin(yaw), cam.target[1] + r * Math.sin(pitch), cam.target[2] + r * Math.cos(pitch) * Math.cos(yaw)];
  });
  canvas.addEventListener('wheel', (e) => { const k = Math.exp(e.deltaY * 0.001); cam.pos = cam.pos.map((x, i) => cam.target[i] + (x - cam.target[i]) * k) as V3; e.preventDefault(); }, { passive: false });

  // The compare switch: nothing traced, every reflective pixel takes the probes at its roughness (what adapters do).
  let ssrOn = true;
  const setSSR = (on: boolean) => { ssrOn = on; ssrBox.checked = on; seam.resetHistory(); };
  ssrBox.onchange = () => setSSR(ssrBox.checked);
  for (const v of ['final', 'lit', 'reflection']) debugSelect.append(new Option(v, v));
  debugSelect.value = new URLSearchParams(location.search).get('show') ?? 'final';

  let time = 0;
  const setTime = (t: number) => { time = t; rooms.update(t); };
  let prevViewProj: Float32Array | null = null;
  let frameIndex = 0;
  const frame = () => {
    resize();
    const [w, h] = size;
    const view = lookAt(cam.pos, cam.target), projection = perspective(FOV, w / h, NEAR, FAR);
    const viewProj = mat4Multiply(projection, view);
    renderer.writeView(0, viewProj, cam.pos, prevViewProj ?? viewProj);
    prevViewProj = viewProj;
    renderer.updateMeshes();
    // the G-buffer, then the frame contract over it
    const encoder = device.createCommandEncoder();
    renderer.shadows(encoder);
    renderer.gbuffer(encoder);
    const t = renderer.targets!;
    const frameInputs: FrameInputs = {
      width: w, height: h, frameIndex: frameIndex++,
      textures: {
        depth: t.depth, normal: t.normal, roughness: { texture: t.normal, channel: 3 }, metalness: { texture: t.albedo, channel: 3 },
        albedo: t.albedo, motion: t.motion, sceneColor: t.color,
      },
      conventions: { depthInverted: false, depthLinear: false, normalUnpackMul: 1, normalUnpackAdd: 0, roughnessIsPerceptual: true, motionVectorScale: [1, 1], sceneColorSpecular: 'direct' },
      camera: history.update({ view, projection, near: NEAR, far: FAR, position: cam.pos }),
    };
    // ---- the part to copy: trace, denoise ------------------------------------------------------------------------
    const s: ScreenSpaceReflectionsSettings = ssrOn ? settings : { ...settings, roughnessThreshold: 0, hitColorFilter: 'off' };
    tracer!.dispatch(encoder, screenSpaceInputsFromFrame(frameInputs, tracer!, { fallbackBindGroup: probes.bindGroup }), s);
    device.queue.submit([encoder.finish()]);
    const radiance = seam.dispatch(frameInputs, { radiance: tracer!.outputs.radiance, hitDistance: tracer!.outputs.hitDistance });
    // ---------------------------------------------------------------------------------------------------------------
    const present = device.createCommandEncoder();
    renderer.composite(present, radiance, context.getCurrentTexture().createView(), debugSelect.selectedIndex);
    device.queue.submit([present.finish()]);
  };
  let running = true, last = performance.now();
  const loop = (now: number) => {
    if (!running) return;
    if (animateBox.checked) setTime(time + Math.min(0.05, (now - last) / 1000));
    last = now;
    frame();
    requestAnimationFrame(loop);
  };
  resize();
  requestAnimationFrame(loop);
  status.textContent = `raw WebGPU: ${rooms.meshes.length} meshes, 3 probes (core ProbeSet, 2 bounces) + screen space (${(tracer as ScreenSpaceReflections | null)?.variant} tracer) + FFX denoiser; drag to orbit`;

  // headless driver (scripts/run-headless.mjs, sections `catalog` and `engines`)
  (window as unknown as { __p: unknown }).__p = {
    /** Stops the loop (and the animation), then lets the denoiser's history settle on the still frame. */
    stop() { running = false; for (let i = 0; i < 60; i++) frame(); },
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); const url = canvas.toDataURL('image/png'); await device.queue.onSubmittedWorkDone(); return url; },
    /** The baseline of `brief.compare`: true turns screen space off (probes only); then the denoiser settles. */
    setCompare(on: boolean) { setSSR(!on); for (let i = 0; i < 60; i++) frame(); },
    setView,
    setTime,
    info: () => ({ variant: tracer?.variant, ssr: ssrOn, size }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
