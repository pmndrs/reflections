// Probes only: the cheapest way to get reflections into an existing scene. No G-buffer, no extra
// passes: the probe is baked once into a cube map and your materials sample it as their
// environment (box-projected, prefiltered by roughness). It shows whatever was in the scene at bake
// time and does not follow moving objects (bake again when they change).
//
// Needs: three >= 0.187 and a browser with WebGPU. The loop is `renderer.render()` as usual.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ReflectionProbe, ReflectionProbes, installCubeArraySupport, reflectionProbes } from '@pmndrs/reflections/three';
import { createScene } from './scene';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;

async function main() {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const { scene, camera } = createScene(renderer);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.6, 0.3);
  controls.enableDamping = true;

  // ---- the part to copy ------------------------------------------------------------------------
  await installCubeArraySupport(renderer);                   // three r187 cannot bind cube arrays yet; this adds it
  const probes = new ReflectionProbes();
  const room = new ReflectionProbe(12, 6, 12);               // influence box: width, height, depth
  room.position.set(0, 2.5, 0);                              // the capture point: inside the space the probe serves
  probes.add(room);
  scene.add(probes);
  probes.bake(renderer, scene);                              // once, and again when the scene changes
  scene.environmentNode = reflectionProbes(probes) as never; // every physical material now reflects the probe
  // ----------------------------------------------------------------------------------------------

  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(frame);
  status.textContent = `${probes.bakedProbes.length} probe baked (${probes.bakedLayout}); drag to orbit`;
  (window as unknown as { __p: unknown }).__p = {
    stop() { renderer.setAnimationLoop(null); },
    /** The baseline for the headless check: the plain environment instead of the probe. */
    setProbes(on: boolean) {
      scene.environmentNode = on ? (reflectionProbes(probes) as never) : null;
      scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; });
    },
    async shot(n = 1) { for (let i = 0; i < n; i++) frame(); return canvas.toDataURL('image/png'); },
    info: () => ({ baked: probes.bakedProbes.length, layout: probes.bakedLayout }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
