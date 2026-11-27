// The probes in your own TSL material: a pool of water whose rippled surface reflects the baked room.
//
// What it shows: `reflectionProbes(probes)` as `scene.environmentNode` serves three's physical materials. A material with its own
// shading (unlit, a custom fresnel, normals from a function) calls the same lookup itself:
//
//   sampleReflectionProbes(probes, positionWorld, reflectedDirection, roughness)   // vec3 radiance, box-projected, blended
//
// The water is a `MeshBasicNodeMaterial` (no lighting model): its normal comes from a sum of travelling waves, its reflection from
// the probe along the reflected ray, mixed with a dark water tint by Schlick's fresnel. The compare puts a stock
// `MeshStandardMaterial` (glossy, flat, tinted) in its place: three's lighting reflects the same probe, but the surface is a mirror
// of the room with no waves. Unlit custom materials get no screen-space reflections from `Reflections` (they have no physical
// specular term for it to replace, D2802): the probe sample is their reflection. This page is probes only, `renderer.render()`.
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, cos, float, mix, normalize, positionWorld, reflect, uniform, vec3 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, installCubeArraySupport, reflectionProbes, sampleReflectionProbes } from '@pmndrs/reflections/three';
import { boxRoom } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('custom/tsl');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const stockBox = document.querySelector<HTMLInputElement>('#stock')!;
const ripplesBox = document.querySelector<HTMLInputElement>('#ripples')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  const kit = boxRoom({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  // The room's probe (as on probes/box-projection), baked before the pool is added: the pool is not in its own capture.
  await installCubeArraySupport(renderer);
  const probes = new ReflectionProbes();
  const probe = new ReflectionProbe(9.2, 4.2, 7.2);
  probe.position.set(0, 1.5, 0);
  probe.projectionSize = new THREE.Vector3(8, 3, 6);
  probes.add(probe);
  scene.add(probes);
  probes.bake(renderer, scene);
  scene.environmentNode = reflectionProbes(probes) as never;
  scene.environmentIntensity = 1; // the kit dims its outdoor environment for the closed room; the probe holds the room as lit

  // A shallow stone basin on the floor, between the sofa and the sphere.
  const W = 2.6, D = 1.5, cx = -1.2, cz = -0.55, rim = 0.12, h = 0.1;
  const stone = new THREE.MeshStandardMaterial({ color: 0x8c8780, roughness: 0.8 });
  for (const [sx, sz, x, z] of [[W + 2 * rim, rim, cx, cz - D / 2 - rim / 2], [W + 2 * rim, rim, cx, cz + D / 2 + rim / 2], [rim, D, cx - W / 2 - rim / 2, cz], [rim, D, cx + W / 2 + rim / 2, cz]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), stone);
    m.position.set(x, h / 2, z); m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial());
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(cx, h * 0.7, cz);
  scene.add(pool);

  // ---- the part to copy: the water material ------------------------------------------------------
  const uTime = uniform(0), uWaves = uniform(1);
  const water = new THREE.MeshBasicNodeMaterial();
  water.colorNode = Fn(() => {
    const p: N = positionWorld, t: N = uTime;
    // the slope of three travelling waves (d height / dx, d height / dz)
    const a: N = cos(p.x.mul(7).add(t.mul(1.7))).mul(0.05);
    const b: N = cos(p.z.mul(9).sub(t.mul(1.3))).mul(0.04);
    const c: N = cos(p.x.mul(3.1).add(p.z.mul(4.3)).add(t.mul(0.9))).mul(0.06);
    const n: N = normalize(vec3(a.add(c.mul(0.6)).mul(uWaves).negate(), 1, b.add(c.mul(0.8)).mul(uWaves).negate()));
    const v: N = normalize(cameraPosition.sub(p));
    const r: N = reflect(v.negate(), n);
    const reflection: N = sampleReflectionProbes(probes, p, r, float(0.04)); // nearly a mirror, prefiltered a little
    const fresnel: N = float(0.02).add(float(0.98).mul(float(1).sub(n.dot(v).clamp(0, 1)).pow(5))); // Schlick, water F0 0.02
    return mix(vec3(0.015, 0.05, 0.055), reflection, fresnel);
  })();
  // ----------------------------------------------------------------------------------------------
  const stock = new THREE.MeshStandardMaterial({ color: 0x0b2226, roughness: 0.04, metalness: 0 });

  const setStock = (on: boolean) => { pool.material = on ? stock : water; stockBox.checked = on; };
  stockBox.onchange = () => setStock(stockBox.checked);
  ripplesBox.onchange = () => { uWaves.value = ripplesBox.checked ? 1 : 0; };
  setStock(false);

  const views: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
    pool: { pos: [-3.3, 1.25, 1.6], target: [-0.6, 0.05, -1.0] },
    default: { pos: kit.views.default.pos, target: kit.views.default.target },
  };
  const setView = (name: string) => {
    const v = views[name] ?? views.pool;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    camera.fov = 60;
    viewSelect.value = name;
  };
  viewSelect.onchange = () => setView(viewSelect.value);
  setView('pool');

  let running = true;
  const frame = () => {
    if (running) uTime.value = performance.now() / 1000;
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);
  status.textContent = 'the water: MeshBasicNodeMaterial + sampleReflectionProbes() along its rippled reflected ray; drag to orbit';

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    /** Stops the loop and the waves (shots repeat exactly). */
    stop() { renderer.setAnimationLoop(null); running = false; },
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true = the stock MeshStandardMaterial on the water. */
    setCompare(on: boolean) { setStock(on); },
    setView,
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
