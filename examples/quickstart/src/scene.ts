// "Your scene": a glossy floor, a few PBR objects and a room environment. Nothing in here knows
// about reflections; main.ts / probes.ts are the part to copy into a project.
import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function createScene(renderer: THREE.WebGPURenderer) {
  const scene = new THREE.Scene();
  // image-based light: three's own studio room, prefiltered once. Probes and screen-space
  // reflections take over the specular part of it where they have something better to show.
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  // the room is also the backdrop, so a probe captured from the scene sees what the lighting sees
  scene.background = scene.environment;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(3.4, 2.2, 4.6);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 6, 2);
  scene.add(key);

  // glossy floor: roughness 0.08 is polished stone, the band where reflections show most
  const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x20242b, roughness: 0.08, metalness: 0 }));
  scene.add(floor);

  const gold = new THREE.Mesh(new THREE.SphereGeometry(0.7, 64, 32), new THREE.MeshStandardMaterial({ color: 0xffc766, roughness: 0.18, metalness: 1 }));
  gold.position.set(-1.3, 0.7, 0);
  const red = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd22c2c, roughness: 0.4, metalness: 0 }));
  red.position.set(0.5, 0.5, -0.8);
  red.rotation.y = 0.5;
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.45, 0.15, 160, 24), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 1 }));
  knot.position.set(1.9, 0.75, 0.9);
  const teal = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.7, 8, 24), new THREE.MeshStandardMaterial({ color: 0x1fb7a6, roughness: 0.25, metalness: 0.1 }));
  teal.position.set(-0.2, 0.63, 1.6);
  scene.add(gold, red, knot, teal);

  return { scene, camera, floor, objects: [gold, red, knot, teal] };
}
