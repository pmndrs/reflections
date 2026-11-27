// Box-projected reflection probe: one probe baked in a room, every material sampling it, the loop a plain renderer.render().
//
// THE REFERENCE PAGE. Every feature page (docs/EXAMPLES.md) copies this one's shape:
//   - index.html: a full-window canvas, a small panel whose first control is the compare switch, a status line.
//   - main.ts (this file, under 300 lines): mountShell('<slug>') first, a scene from examples/shared, the feature set up with the
//     public API (`@pmndrs/reflections/three`) the way an app would, the compare switch, the loop, and `window.__p` for the check.
//   - an entry in examples/catalog.ts with the brief; `brief.compare` names the switch.
// To add a page: copy this folder to examples/<category>/<name>/, add (or un-plan) its catalog entry, change the slug below, then
// `REFLECTIONS_PORT=<port> pnpm check -- --only catalog` (with `--thumbs` for its card image). The catalog check loads every
// page and, where `__p.setCompare` exists, checks that the compare switch changes the image.
//
// What it shows: a probe captures the room from one point. Looked up by direction alone (box projection off), it behaves as if
// the room were infinitely far away, so the windows and walls reflected in the glossy floor sit in the wrong place and slide as
// the camera moves. Box projection intersects each reflected ray with the room's box first.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, ReflectionProbesHelper, installCubeArraySupport, reflectionProbes } from '@pmndrs/reflections/three';
import { boxRoom } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('probes/box-projection');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const boxProjectionBox = document.querySelector<HTMLInputElement>('#boxProjection')!;
const volumesBox = document.querySelector<HTMLInputElement>('#volumes')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // The scene: an 8 x 3 x 6 m room with windows, a glossy wood floor, the sun shining in (examples/shared/scenes.ts).
  const kit = boxRoom({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  // ---- the part to copy ------------------------------------------------------------------------
  await installCubeArraySupport(renderer);                // three r187 cannot bind cube arrays yet; this adds it
  const probes = new ReflectionProbes();
  const probe = new ReflectionProbe(9.2, 4.2, 7.2);       // influence box: the room plus 0.6 m past every wall, floor and ceiling
  probe.position.set(0, 1.5, 0);                          // the room's centre, which is also where it captures from
  probe.projectionSize = new THREE.Vector3(8, 3, 6);      // the walls: reflections are projected onto this box
  probes.add(probe);
  scene.add(probes);
  probes.bake(renderer, scene);                           // once (objects marked userData.reflectionProbeExclude stay out)
  scene.environmentNode = reflectionProbes(probes) as never; // every physical material now reflects the probe
  // ----------------------------------------------------------------------------------------------
  // The kit dims the outdoor environment (0.15) for the closed room; that factor also scales the probe lookup, and the probe
  // holds the room as lit, so it goes back to 1 after the bake.
  scene.environmentIntensity = 1;

  // The compare switch: the same probe looked up by direction only (reflections at infinity). It is read every frame.
  const setBoxProjection = (on: boolean) => { probes.boxProjection = on; boxProjectionBox.checked = on; };
  boxProjectionBox.onchange = () => setBoxProjection(boxProjectionBox.checked);

  // The influence box (yellow) and the projection box (cyan); added after the bake so the probe does not capture them.
  const helper = new ReflectionProbesHelper(probes);
  helper.visible = false;
  scene.add(helper);
  volumesBox.onchange = () => { helper.visible = volumesBox.checked; };

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
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);
  status.textContent = `1 probe baked (${probes.bakedLayout}, ${probes.bakedResolutions[0]} px); drag to orbit`;

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    stop() { renderer.setAnimationLoop(null); },
    /** Render n frames, then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows it (box projection off). */
    setCompare(on: boolean) { setBoxProjection(!on); },
    setView,
    info: () => ({ baked: probes.bakedProbes.length, layout: probes.bakedLayout, boxProjection: probes.boxProjection }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
