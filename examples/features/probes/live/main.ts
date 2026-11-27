// Live probes: the probes captured again while the scene changes, one probe per frame (time-sliced), so reflections follow.
//
// The scene is Ben Houston's two rooms (examples/shared/rooms.ts), a probe per room and one in the doorway. The torus knot turns
// and both ceiling lights drift through the hues, so the walls change colour, and with them everything the
// floor, the columns and the mirror ball reflect. A bake is a still: baked once, the probes keep the rooms as they were.
//
// Live capture here is `probes.bake(renderer, scene, { probes: [one], bounces: 1 })` each frame, round-robin over the three
// probes: each is at most three frames old, at a third of the cost of capturing all three. `bounces: 1` because a sliced bake
// covers only its slice (see `BakeOptions.bounces`), and one capture pass is half the cost. The moving mirror ball stays out of
// the captures (`userData.reflectionProbeExclude`): a mirror captured into the probes it reflects feeds back into itself.
//
// The compare: the same three probes baked once at load (a second set), while the scene keeps changing.
// The lab page examples/probes/ (the #35046 parity page, every storage and lookup option) is where this page came from.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, installCubeArraySupport, reflectionProbes } from '@pmndrs/reflections/three';
import { rooms, type ProbeVolume } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('probes/live');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const liveBox = document.querySelector<HTMLInputElement>('#live')!;
const perFrameSelect = document.querySelector<HTMLSelectElement>('#perFrame')!;
const animateBox = document.querySelector<HTMLInputElement>('#animate')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

/** A probe set from volumes (position, influence box, projection box). */
function probeSet(volumes: ProbeVolume[]) {
  const set = new ReflectionProbes();
  for (const v of volumes) {
    const probe = new ReflectionProbe(...v.influenceSize);
    probe.position.set(...v.position);
    if (v.projectionSize) probe.projectionSize = new THREE.Vector3(...v.projectionSize);
    if (v.projectionOffset) probe.projectionOffset.set(...v.projectionOffset);
    if (v.originOffset) probe.originOffset.set(...v.originOffset);
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

  const kit = rooms({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;
  // the two ceiling lights (warm left, cool right): their hues drift, each from its own
  const lights = scene.children.filter((o): o is THREE.PointLight => (o as THREE.PointLight).isPointLight);
  const hues = lights.map((l) => l.color.getHSL({ h: 0, s: 0, l: 0 }).h);
  let time = 0;
  const animate = (t: number) => {
    kit.update?.(t); // the knot turns, the mirror ball rolls
    lights.forEach((l, i) => l.color.setHSL((hues[i] + t * 0.06) % 1, 0.85, 0.6));
  };
  animate(0);

  // ---- the part to copy ------------------------------------------------------------------------
  await installCubeArraySupport(renderer);
  const live = probeSet(kit.probes);                 // re-captured while the scene runs
  const once = probeSet(kit.probes);                 // the compare: baked once, at load
  scene.add(live, once);
  const BAKE = { bounces: 1, near: 0.05, far: 30 };  // one capture pass: a sliced bake covers only its slice
  live.bake(renderer, scene, BAKE);                  // the first bake captures every probe (it lays out the atlas)
  once.bake(renderer, scene, BAKE);
  const nodes = { live: reflectionProbes(live), once: reflectionProbes(once) };
  scene.environmentNode = nodes.live as never;

  const liveProbes = live.children.filter((c): c is ReflectionProbe => (c as ReflectionProbe).isReflectionProbe);
  let next = 0;
  /** One slice: the next `n` probes, round-robin. A full re-capture is n = all of them. */
  const capture = (n: number) => {
    const slice = Array.from({ length: Math.min(n, liveProbes.length) }, () => liveProbes[next++ % liveProbes.length]);
    live.bake(renderer, scene, { ...BAKE, probes: slice });
  };
  // ----------------------------------------------------------------------------------------------

  const setLive = (on: boolean) => {
    liveBox.checked = on;
    scene.environmentNode = (on ? nodes.live : nodes.once) as never; // first: the captures are lit through it
    if (on) capture(liveProbes.length); // catch up at once: every probe, the scene as it is now
    showStatus();
  };
  liveBox.onchange = () => setLive(liveBox.checked);
  const showStatus = () => {
    status.textContent = liveBox.checked
      ? `live: ${perFrameSelect.value === '1' ? 'one probe re-captured per frame (each at most 3 frames old)' : 'all 3 probes re-captured every frame'}, `
        + `${live.bakedLayout}, ${live.bakedResolutions[0]} px; drag to orbit`
      : 'baked once at load: the reflections keep the light colours and the knot as they were';
  };
  perFrameSelect.onchange = showStatus;
  showStatus();

  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    camera.fov = v.fov ?? 50;
    viewSelect.value = name;
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    if (animateBox.checked) { time += Math.min(0.1, (now - last) / 1000); animate(time); }
    last = now;
    if (liveBox.checked) capture(Number(perFrameSelect.value));
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    /** Stops the loop and the animation where they are, and re-captures every live probe (so live is current). */
    stop() { renderer.setAnimationLoop(null); animateBox.checked = false; if (liveBox.checked) capture(liveProbes.length); },
    /** Render n frames, then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows it (baked once at load). */
    setCompare(on: boolean) { setLive(!on); },
    setView,
    /** Jump the animation to time t (seconds). */
    setTime(t: number) { time = t; animate(t); },
    info: () => ({ live: liveBox.checked, probes: live.bakedProbes.length, layout: live.bakedLayout, time }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
