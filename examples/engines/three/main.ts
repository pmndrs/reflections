// three.js: the engine page. Ben Houston's two rooms (examples/shared/rooms.ts) with every feature of the three.js
// adapter: one probe per room plus one in the doorway, screen-space reflections, the ray-traced fallback on a switch,
// and the denoiser, all through `Reflections.create`. The other engine pages (engines/r3f, engines/babylon,
// engines/core, engines/pixi) draw the same scene from the same camera views, so they can be put side by side.
//
// The compare switch turns screen space off (probes only): the one switch every engine page has.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflections, ReflectionProbe, ReflectionProbes, createReflectionsRenderer } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { rooms } from '../../shared';
import { mountShell } from '../../shell';

mountShell('engines/three');

const q = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const ssrBox = document.querySelector<HTMLInputElement>('#ssr')!;
const rtBox = document.querySelector<HTMLInputElement>('#rt')!;
const animateBox = document.querySelector<HTMLInputElement>('#animate')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  // 1. A WebGPURenderer with the device limits the passes need, three's shadows and tone mapping as usual.
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // 2. The scene: two rooms joined by a doorway, a point light in each, a polished floor, a mirror ball on a figure eight.
  const kit = rooms({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  // 3. The probes: one per room and one in the doorway (the kit's volumes), baked once. The mirror ball is kept out of
  //    the captures (userData.reflectionProbeExclude), so it does not paint itself into the rooms.
  const probes = new ReflectionProbes();
  for (const v of kit.probes) {
    const p = new ReflectionProbe(...v.influenceSize);
    p.position.set(...v.position);
    if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
    if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
    if (v.originOffset) p.originOffset.set(...v.originOffset);
    probes.add(p);
  }
  scene.add(probes);
  probes.bake(renderer, scene, { near: 0.05, far: 60 });

  // 4. Reflections: screen space over the probes, the denoiser, and (on the switch) rays for what the screen misses.
  const create = (rayTracing: boolean) => Reflections.create(renderer, scene, {
    probes,
    rayTracing,
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });
  let reflections = await create(q.get('rt') === '1');
  rtBox.checked = !!reflections.trace;

  // The compare switch: no screen-space march, so every reflection comes from the probes (or the rays, when on).
  let ssrOn = true;
  const applySSR = () => {
    if (ssrOn) delete reflections.ssr.settings.maxTraversalIntersections;
    else reflections.ssr.settings.maxTraversalIntersections = 0;
    reflections.hybrid.resetHistory();
  };
  const setSSR = (on: boolean) => { ssrOn = on; ssrBox.checked = on; applySSR(); };
  ssrBox.onchange = () => setSSR(ssrBox.checked);

  let building = false;
  rtBox.onchange = async () => {
    if (building) return;
    building = true;
    status.textContent = rtBox.checked ? 'building the BVH...' : 'rebuilding...';
    reflections.dispose(); // the probes are ours, so they stay baked
    reflections = await create(rtBox.checked);
    applySSR();
    building = false;
    showStatus();
  };

  for (const name of Object.keys(kit.views)) viewSelect.append(new Option(name, name));
  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    camera.fov = v.fov ?? 50;
    viewSelect.value = name;
    controls.update();
    reflections.hybrid.resetHistory();
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  // The rooms' animation (the knot turns, the ball flies its figure eight). Time only moves in the running loop.
  let time = 0;
  const setTime = (t: number) => {
    time = t;
    kit.update?.(t);
    reflections.trace?.refit(); // moving meshes: refit the BVH
  };

  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
  };
  let last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    if (animateBox.checked && !building) setTime(time + Math.min(0.05, (now - last) / 1000));
    last = now;
    if (!building) frame();
  });

  const showStatus = () => {
    status.textContent = `three.js: ${probes.bakedProbes.length} probes, screen space${reflections.trace ? ', ray-traced fallback' : ''}, FFX denoiser; drag to orbit`;
  };
  showStatus();

  // headless driver (scripts/run-headless.mjs, sections `catalog` and `engines`)
  (window as unknown as { __p: unknown }).__p = {
    /** Stops the loop (and the animation), then lets the denoiser's history settle on the still frame. */
    stop() { renderer.setAnimationLoop(null); for (let i = 0; i < 60; i++) frame(); },
    /** Render n frames, then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true turns screen space off (probes only); then lets the denoiser's history settle. */
    setCompare(on: boolean) { setSSR(!on); for (let i = 0; i < 60; i++) frame(); },
    setView,
    setTime,
    info: () => ({ probes: probes.bakedProbes.length, rt: !!reflections.trace, ssr: ssrOn }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
