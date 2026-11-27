// Screen-space reflections on a polished floor, over a probe.
//
// The scene is the kit's mirrorWall (examples/shared/scenes.ts): a polished floor facing a patterned wall, two posts, a sphere
// and a box standing on the floor, the sky behind. A box-projected probe gets the wall right (it is the probe's box), but the
// sphere and the box stand inside the room: the probe leaves them out, so with probes alone their reflections are missing and
// nothing touches the floor. Screen-space reflections trace each pixel's reflected ray through the depth buffer and take the
// colour of what it hits on screen: exact, sharp at the contact, and moving with the objects. Where a ray finds nothing on screen
// the probe fills in.
//
// `Reflections.create(renderer, scene, { probes, denoiser })` wires it: a G-buffer render of the scene, the tracer, the probe
// fill, the denoiser (`denoiser/ffx`, for the noise of glossy rays) and the composite. The loop calls `reflections.render(camera)`.
// The compare shows three's own lit image from the same frame, the probe as its environment: probes only.
import * as THREE from 'three/webgpu';
import { uniform, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, Reflections, createReflectionsRenderer, installCubeArraySupport } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { mirrorWall } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('ssr/mirror-floor');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const ssrBox = document.querySelector<HTMLInputElement>('#ssr')!;
const roughnessSlider = document.querySelector<HTMLInputElement>('#roughness')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  // the device limits the passes need (a plain WebGPURenderer works too, with a second lit pass: docs, guides/three)
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const kit = mirrorWall({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;
  // the floor: the kit's mirror, polished a little (glossy rays are noisy: that is the denoiser's job)
  let floor!: THREE.Mesh;
  scene.traverse((o) => { if ((o as THREE.Mesh).geometry?.type === 'PlaneGeometry' && o.rotation.x !== 0) floor = o as THREE.Mesh; });
  const floorMaterial = floor.material as THREE.MeshStandardMaterial;
  floorMaterial.roughness = Number(roughnessSlider.value);
  roughnessSlider.oninput = () => { floorMaterial.roughness = Number(roughnessSlider.value); };

  // ---- the part to copy ------------------------------------------------------------------------
  // The probe: the room's box (its back face on the wall), baked once; it fills what the screen cannot see.
  const probes = new ReflectionProbes();
  const v = kit.probes[0];
  const probe = new ReflectionProbe(...v.influenceSize);
  probe.position.set(...v.position);
  probe.projectionSize = new THREE.Vector3(...v.projectionSize!);
  probe.projectionOffset.set(...v.projectionOffset!);
  probe.originOffset.set(...v.originOffset!);
  probes.add(probe);
  scene.add(probes);
  await installCubeArraySupport(renderer);     // three r187 cannot bind cube arrays yet; this adds it
  probes.bake(renderer, scene);
  const reflections = await Reflections.create(renderer, scene, {
    probes,                                    // a baked set of your own (default: one automatic probe over the scene's bounds)
    // FFX compares alpha (perceptual roughness squared)
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });
  // ----------------------------------------------------------------------------------------------

  // The compare, in the same frame: three's lit image (the G-buffer's, with the probe as the environment) instead of the composite.
  const composite = reflections.hybrid.composite();
  const probesOnly = uniform(0);
  reflections.pipeline.outputNode = probesOnly.greaterThan(0.5).select(vec4(composite.lit, 1), composite.final);
  reflections.pipeline.needsUpdate = true;
  const setSsr = (on: boolean) => {
    probesOnly.value = on ? 0 : 1;
    ssrBox.checked = on;
    status.textContent = on
      ? `screen space + probe + denoiser${reflections.hybrid.denoiser ? '' : ' (none)'}: the sphere, the box and the posts stand on their reflections; drag to orbit`
      : 'probes only: the wall is right (it is the probe\'s box), the objects in the room are missing from the floor';
  };
  ssrBox.onchange = () => setSsr(ssrBox.checked);
  setSsr(true);

  const setView = (name: string) => {
    const view = kit.views[name] ?? kit.views.default;
    camera.position.set(...view.pos);
    controls.target.set(...view.target);
    camera.fov = view.fov ?? 50;
    viewSelect.value = name;
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);                // instead of renderer.render(scene, camera)
  };
  renderer.setAnimationLoop(frame);

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    /** Stops the loop and pins the tracer's noise pattern (`settings.frameIndex`), then lets the denoiser settle on it: a stopped page shows one image. */
    stop() { renderer.setAnimationLoop(null); reflections.ssr.settings.frameIndex = 0; for (let i = 0; i < 30; i++) frame(); },
    /** Render n frames (denoiser history), then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows it (probes only). */
    setCompare(on: boolean) { setSsr(!on); },
    setView,
    setRoughness(r: number) { floorMaterial.roughness = r; roughnessSlider.value = String(r); },
    info: () => ({ denoiser: !!reflections.hybrid.denoiser, probes: probes.bakedProbes.length, roughness: floorMaterial.roughness }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
