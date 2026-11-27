// Two rooms, several probes: one probe per room plus a small one in the doorway, blended by their influence boxes.
//
// The scene is Ben Houston's two rooms from three.js #35046 (examples/shared/rooms.ts): a warm-lit room and a cool-lit room
// joined by a doorway, a polished floor, and a mirror ball rolling a figure eight through both. Each probe captures its own
// room and is box-projected onto that room's walls; where two influence boxes overlap, the lookup takes the smaller box first
// and fades it in over its `blendDistance`, so the doorway hands one room over to the other without a seam.
//
// The compare: one probe for both rooms (captured in the warm room, projected onto the whole building). It is right only near
// where it was captured: the cool room's floor and the mirror ball show the warm room's walls.
//
// Overlays: the volumes (`ReflectionProbesHelper`: influence boxes yellow, projection boxes cyan, a mirror sphere at each capture
// point) and the blend weights per pixel (each probe's colour times its weight; examples/shared/probeDebug.ts walks the
// volumes as the lookup does). Probes only: the loop is a plain `renderer.render()`.
import * as THREE from 'three/webgpu';
import { normalWorld, positionWorld, vec3 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, ReflectionProbesHelper, installCubeArraySupport, reflectionProbeVolumes, reflectionProbes } from '@pmndrs/reflections/three';
import { floorProbe, rooms, type ProbeVolume } from '../../../shared';
import { probeBlendColor, probePaletteColor } from '../../../shared/probeDebug';
import { mountShell } from '../../../shell';

mountShell('probes/two-rooms');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const perRoomBox = document.querySelector<HTMLInputElement>('#perRoom')!;
const volumesBox = document.querySelector<HTMLInputElement>('#volumes')!;
const weightsBox = document.querySelector<HTMLInputElement>('#weights')!;
const moveBox = document.querySelector<HTMLInputElement>('#move')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;
const legend = document.querySelector<HTMLElement>('#legend')!;

/** A probe set from volumes (position, influence box, projection box, capture point). */
function probeSet(volumes: ProbeVolume[]) {
  const set = new ReflectionProbes();
  for (const v of volumes) {
    const probe = new ReflectionProbe(...v.influenceSize);         // where it applies
    probe.position.set(...v.position);
    if (v.projectionSize) probe.projectionSize = new THREE.Vector3(...v.projectionSize); // the walls it projects onto
    if (v.projectionOffset) probe.projectionOffset.set(...v.projectionOffset);
    if (v.originOffset) probe.originOffset.set(...v.originOffset);  // where it captures from, relative to position
    set.add(probe);
  }
  return set;
}

async function main() {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // The scene: 16 x 5 x 8 m, a wall at x = 0 with a doorway, a warm light in the left room and a cool one in the right.
  const kit = rooms({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  // ---- the part to copy ------------------------------------------------------------------------
  await installCubeArraySupport(renderer);
  // One probe per room (influence: the room plus 0.2 m; projection: its walls) and a doorway probe. The doorway's box is the
  // smallest, so it wins where the boxes overlap and fades into the room probes over its blend distance (0.5 m).
  // (kit.probes holds the three; floorProbe() only extends each influence box under the floor, so the floor is fully inside.)
  const perRoom = probeSet(kit.probes);
  // The compare: one probe for both rooms, captured in the warm room (originOffset), projected onto the whole building.
  const single = probeSet([floorProbe({ position: [0, 2.5, 0], influenceSize: [16.8, 5.4, 8.4], projectionSize: [16, 5, 8], originOffset: [-4, 0, 0] })]);
  scene.add(perRoom, single);
  perRoom.bake(renderer, scene);   // the mirror ball has userData.reflectionProbeExclude: it moves, so it stays out
  single.bake(renderer, scene);
  const nodes = { perRoom: reflectionProbes(perRoom), single: reflectionProbes(single) };
  scene.environmentNode = nodes.perRoom as never;
  // ----------------------------------------------------------------------------------------------

  // Overlays (added after the bakes so the probes do not capture them).
  // The weights view: every surface coloured by the probes it blends (each probe's colour x its weight), lit by its normal.
  // One material per set and face side (the room shell is drawn from inside), swapped in for every mesh's own.
  const weightsMaterial = (set: ReflectionProbes) => [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide].map((side) => {
    const m = new THREE.MeshBasicNodeMaterial({ side });
    m.colorNode = probeBlendColor(set, positionWorld).mul(normalWorld.dot(vec3(0.35, 0.8, 0.5).normalize()).mul(0.25).add(0.75));
    return m;
  });
  const weights = { perRoom: weightsMaterial(perRoom), single: weightsMaterial(single) };
  const own = new Map<THREE.Mesh, THREE.Material>();
  scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) own.set(m, m.material as THREE.Material); });
  const showWeights = (on: boolean) => { for (const [m, mat] of own) m.material = on ? weights[which][mat.side] : mat; };
  const helpers = { perRoom: new ReflectionProbesHelper(perRoom, 0.15), single: new ReflectionProbesHelper(single, 0.15) };
  for (const h of Object.values(helpers)) { h.visible = false; scene.add(h); }

  let which: 'perRoom' | 'single' = 'perRoom';
  const names = (set: ReflectionProbes) => reflectionProbeVolumes(set).map((v) =>
    set === single ? 'both rooms' : v.center[0] < -1 ? 'warm room' : v.center[0] > 1 ? 'cool room' : 'doorway');
  const apply = () => {
    scene.environmentNode = nodes[which] as never;
    helpers.perRoom.visible = volumesBox.checked && which === 'perRoom';
    helpers.single.visible = volumesBox.checked && which === 'single';
    showWeights(weightsBox.checked);
    const set = which === 'perRoom' ? perRoom : single;
    legend.hidden = !weightsBox.checked;
    legend.innerHTML = names(set).map((n, i) => `<span style="background:#${probePaletteColor(i).getHexString()}"></span>${n}`).join('&nbsp; ')
      + '&nbsp; <span style="background:#1f1f1f"></span>none';
    status.textContent = `${set.bakedProbes.length} probe${set.bakedProbes.length > 1 ? 's' : ''} baked (${set.bakedLayout}, ${set.bakedResolutions[0]} px)`
      + `${which === 'single' ? ': one probe for both rooms, captured in the warm room' : ': warm room, cool room, doorway'}; drag to orbit`;
  };
  const setPerRoom = (on: boolean) => { which = on ? 'perRoom' : 'single'; perRoomBox.checked = on; apply(); };
  perRoomBox.onchange = () => setPerRoom(perRoomBox.checked);
  volumesBox.onchange = weightsBox.onchange = apply;
  apply();

  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    camera.fov = v.fov ?? 50;
    viewSelect.value = name;
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  // the knot turns and the mirror ball rolls its figure eight through both rooms (kit.update)
  let time = 0, last = performance.now();
  const frame = () => {
    const now = performance.now();
    if (moveBox.checked) { time += Math.min(0.1, (now - last) / 1000); kit.update?.(time); }
    last = now;
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
    /** The baseline of `brief.compare`: true shows it (one probe for both rooms). */
    setCompare(on: boolean) { setPerRoom(!on); },
    setView,
    setOverlays(v: { volumes?: boolean; weights?: boolean }) { volumesBox.checked = !!v.volumes; weightsBox.checked = !!v.weights; apply(); },
    info: () => ({ perRoom: perRoom.bakedProbes.length, single: single.bakedProbes.length, layout: perRoom.bakedLayout, showing: which }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
