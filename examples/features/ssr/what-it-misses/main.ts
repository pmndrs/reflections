// What screen space cannot see: a reflected ray can only find what is on screen.
//
// The scene is the kit's offscreen (examples/shared/scenes.ts): a polished floor, a dark back wall with a mirror panel, a glowing
// ring and a lamp bar above the top of the frame, three glowing bars on the wall behind the camera, a cylinder and a box on the
// floor. Screen-space reflections march each reflected ray through the depth buffer, so they miss
//   - what is off screen: the floor reflects the ring and the lamp bar, which are above the frame (view "Above the frame");
//   - what is behind the camera: the wall mirror reflects the bars behind you (view "Behind the camera");
//   - what is hidden behind something on screen: the back of an object, its underside (ssr/mirror-floor, view "At the sphere").
// The composite fills every miss from the probes (box-projected cubes captured from inside the room), so the image stays whole;
// the compare shows screen space alone, black where it missed. Rays fill the same misses with the real geometry: rt/fallback.
//
// Screen space alone, as drawn here: three's lit image with its probe reflection taken out and the tracer's hits put in
// (`lit + weight x (ssr - probeSpecular)`, the terms of `hybrid.composite()`). Rough pixels, which the tracer skips, lose their
// reflection too. "Tint the misses" colours each smooth pixel by how much of it the probes filled.
import * as THREE from 'three/webgpu';
import { float, mix, uniform, vec3, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, Reflections, createReflectionsRenderer, installCubeArraySupport } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { offscreen } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('ssr/what-it-misses');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any; // TSL's node typings are too strict for hand-written shader maths
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const fillBox = document.querySelector<HTMLInputElement>('#fill')!;
const tintBox = document.querySelector<HTMLInputElement>('#tint')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const kit = offscreen({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  // ---- the part to copy ------------------------------------------------------------------------
  // The kit's three probes: the room, the floor (its box lidded at the ring's height) and the wall mirror (examples/shared/scenes.ts).
  const probes = new ReflectionProbes();
  for (const v of kit.probes) {
    const probe = new ReflectionProbe(...v.influenceSize);
    probe.position.set(...v.position);
    if (v.projectionSize) probe.projectionSize = new THREE.Vector3(...v.projectionSize);
    if (v.projectionOffset) probe.projectionOffset.set(...v.projectionOffset);
    if (v.originOffset) probe.originOffset.set(...v.originOffset);
    if (v.blendDistance !== undefined) probe.blendDistance = v.blendDistance;
    if (v.resolution !== undefined) probe.resolution = v.resolution;
    probes.add(probe);
  }
  scene.add(probes);
  await installCubeArraySupport(renderer);
  probes.bake(renderer, scene);
  const reflections = await Reflections.create(renderer, scene, {
    probes,
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });
  // ----------------------------------------------------------------------------------------------

  // The page's own output: the composite, or screen space alone; optionally the misses tinted.
  const c = reflections.hybrid.composite();
  const fill = uniform(1), tint = uniform(0);
  const ssrAlone: N = c.geometry.select(c.lit.add(c.weight.mul(c.ssr.sub(c.probeSpecular))).max(0), c.lit);
  const color: N = mix(ssrAlone, c.final.rgb, fill);
  // how much of a smooth pixel's reflection the probes filled (the tracer skips rough ones: they are the probes' anyway)
  const smooth: N = c.geometry.and(c.roughness.lessThan(reflections.hybrid.roughnessThreshold));
  const missed: N = smooth.select(float(1).sub(c.ssrWeight).clamp(0, 1), float(0));
  reflections.pipeline.outputNode = vec4(mix(color, vec3(1.2, 0.05, 0.8), missed.mul(tint).mul(0.7)), 1);
  reflections.pipeline.needsUpdate = true;

  const showStatus = () => {
    status.textContent = fill.value
      ? 'screen space + probes + denoiser: every miss filled from the probes; drag to orbit'
      : 'screen space alone (raw tracer hits, no fill): black where the reflected ray found nothing on screen';
  };
  const setFill = (on: boolean) => { fill.value = on ? 1 : 0; fillBox.checked = on; showStatus(); };
  fillBox.onchange = () => setFill(fillBox.checked);
  tintBox.onchange = () => { tint.value = tintBox.checked ? 1 : 0; };
  showStatus();

  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    camera.fov = v.fov ?? 50;
    viewSelect.value = name;
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
  };
  renderer.setAnimationLoop(frame);

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    /** Stops the loop and pins the tracer's noise pattern (`settings.frameIndex`), then lets the denoiser settle on it: a stopped page shows one image. */
    stop() { renderer.setAnimationLoop(null); reflections.ssr.settings.frameIndex = 0; for (let i = 0; i < 30; i++) frame(); },
    /** Render n frames (denoiser history), then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows it (screen space alone, black misses). */
    setCompare(on: boolean) { setFill(!on); },
    setView,
    setTint(on: boolean) { tint.value = on ? 1 : 0; tintBox.checked = on; },
    info: () => ({ denoiser: !!reflections.hybrid.denoiser, probes: probes.bakedProbes.length, fill: fill.value }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
