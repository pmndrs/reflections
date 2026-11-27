// Keep a moving mirror out of its own probe: `probes.bake(renderer, scene, { exclude: [mirror] })`.
//
// The scene is the kit's `moving` (examples/shared/scenes.ts): a mirror floor facing a patterned wall, a knot sliding and
// turning in front of it, a ball bouncing. Here the knot is a polished gold mirror, and the room's probe is re-captured every
// frame so that the reflections follow the scene (a live probe, as on the probes/live page). The probe captures from 3 m in
// front of the wall, so the knot passes between the capture point and the wall.
//
// A probe captures the room from one point, and box projection paints what it saw onto the room's box: right for the walls and
// the floor, wrong for anything standing inside. Captured live, the moving mirror is in every capture: its image is painted onto
// the wall and the floor of the box, so the mirror floor shows a second, smeared knot sliding where no knot is, and the knot
// reflects a copy of itself. `exclude` hides objects for the capture only (Unity's culling mask, UE's "visible in reflection
// captures"); `userData.reflectionProbeExclude = true` on an object does the same for every bake. The kit marks its moving
// objects that way; this page clears the knot's flag so that the compare switch alone decides.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, ReflectionProbesHelper, installCubeArraySupport, reflectionProbes } from '@pmndrs/reflections/three';
import { moving } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('probes/exclude');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const excludeBox = document.querySelector<HTMLInputElement>('#exclude')!;
const moveBox = document.querySelector<HTMLInputElement>('#move')!;
const volumesBox = document.querySelector<HTMLInputElement>('#volumes')!;

async function main() {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const kit = moving({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  // The moving mirror: the kit's knot, polished to a gold mirror, its "never capture me" flag cleared.
  let knot!: THREE.Mesh;
  scene.traverse((o) => { if ((o as THREE.Mesh).geometry?.type === 'TorusKnotGeometry') knot = o as THREE.Mesh; });
  const gold = knot.material as THREE.MeshStandardMaterial;
  gold.roughness = 0.04;
  delete knot.userData.reflectionProbeExclude;

  // ---- the part to copy ------------------------------------------------------------------------
  await installCubeArraySupport(renderer);
  const probes = new ReflectionProbes();
  const v = kit.probes[0];                          // the room: influence box, projection box on the wall and the floor
  const probe = new ReflectionProbe(...v.influenceSize);
  probe.position.set(...v.position);
  probe.projectionSize = new THREE.Vector3(...v.projectionSize!);
  probe.projectionOffset.set(...v.projectionOffset!);
  probe.originOffset.set(0, 1.5 - v.position[1], 3 - v.position[2]); // captured at (0, 1.5, 3): in front of the knot's path
  probes.add(probe);
  scene.add(probes);
  let exclude = true;
  // re-captured every frame (one probe, one pass); the mirror kept out of its own capture
  const capture = () => probes.bake(renderer, scene, { bounces: 1, exclude: exclude ? [knot] : [] });
  capture();
  scene.environmentNode = reflectionProbes(probes) as never;
  // ----------------------------------------------------------------------------------------------

  const helper = new ReflectionProbesHelper(probes);
  helper.visible = false;
  scene.add(helper);
  volumesBox.onchange = () => { helper.visible = volumesBox.checked; };

  const setExclude = (on: boolean) => {
    exclude = on;
    excludeBox.checked = on;
    status.textContent = on
      ? `bake({ exclude: [knot] }) every frame: the probe holds the room without the knot (${probes.bakedLayout}, ${probes.bakedResolutions[0]} px); drag to orbit`
      : 'bake() every frame with the knot in it: box projection paints it onto the wall and the floor, and the floor shows a second, smeared knot';
  };
  excludeBox.onchange = () => setExclude(excludeBox.checked);
  setExclude(true);

  let time = 0, last = performance.now();
  const frame = () => {
    const now = performance.now();
    if (moveBox.checked) { time += Math.min(0.1, (now - last) / 1000); kit.update?.(time); }
    last = now;
    capture();
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    stop() { renderer.setAnimationLoop(null); moveBox.checked = false; },
    /** Render n frames, then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows it (the knot captured into the probe). */
    setCompare(on: boolean) { setExclude(!on); },
    setTime(t: number) { time = t; kit.update?.(t); },
    info: () => ({ exclude, layout: probes.bakedLayout, time }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
