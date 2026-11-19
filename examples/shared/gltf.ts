// glTF scenes from examples/assets/ (downloaded by `pnpm assets`, never committed).
//
// loadGLTF() loads a model; onMirrorFloor() puts any model on our own mirror / glossy floor with a
// light rig and a framing camera; ASSET_SCENES lists the scene factories by asset folder.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { type KitScene, type SceneOptions, type Vec3, floor, gradientEnvironment, makeCamera, mirror, newScene, std, studioLights, toVec3 } from './kit';

/**
 * The public site build serves the models from a CDN (tools/site-build.ts sets VITE_REMOTE_ASSETS to a JSON map
 * of asset folder -> base URL with a trailing slash); anything not in the map is under examples/assets/.
 */
const REMOTE: Record<string, string> = JSON.parse(import.meta.env.VITE_REMOTE_ASSETS || '{}');

/** URL of a file under examples/assets/ as served by the examples dev server (or by the CDN, see REMOTE). */
export const assetUrl = (dir: string, file: string) => `${REMOTE[dir] ?? `${import.meta.env.BASE_URL}assets/${dir ? dir + '/' : ''}`}${file}`;

export interface AssetEntry { dir: string; file: string; license: string; devOnly: boolean }

/** What `pnpm assets` downloaded (its manifest.json); empty when nothing is there. */
export async function availableAssets(): Promise<AssetEntry[]> {
  try {
    const res = await fetch(assetUrl('', 'manifest.json'));
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function loadGLTF(url: string): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return gltf.scene;
}

/**
 * World bounds of a model from its vertices. `Box3.setFromObject(model)` without `precise` boxes each
 * mesh's local bounding box after its transform, which over-reaches for rotated parts: CarConcept's
 * wheel nodes are rotated, their boxed corners reach 0.15 m below the tyres, and a car stood on that
 * box floats over the floor (W17).
 */
export function modelBounds(model: THREE.Object3D): THREE.Box3 {
  model.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(model, true);
}

/** Scales `model` so its longest side is `size` (if given), then centres it in x/z with its lowest vertex on y = 0. */
export function standOnFloor(model: THREE.Object3D, size?: number): THREE.Box3 {
  let box = modelBounds(model);
  if (size) {
    const s = box.getSize(new THREE.Vector3());
    model.scale.multiplyScalar(size / Math.max(s.x, s.y, s.z));
    box = modelBounds(model);
  }
  const c = box.getCenter(new THREE.Vector3());
  model.position.x -= c.x; model.position.z -= c.z; model.position.y -= box.min.y;
  return modelBounds(model);
}

export interface MirrorFloorOptions extends SceneOptions {
  /** Longest side of the model after scaling, in metres (default: keep the model's size). */
  size?: number;
  /** Floor roughness: 0 = mirror (default 0.02). */
  roughness?: number;
  /** Floor metalness (default 1: a mirror; 0 gives a glossy dielectric floor). */
  metalness?: number;
  /** Turn the model about Y (radians). */
  rotateY?: number;
  id?: string;
  title?: string;
}

/**
 * Puts `model` on a mirror (or glossy) floor at y = 0, centred, with a key light, an environment
 * and a camera that frames it. The probe volume suggestion is a box around the model.
 */
export function onMirrorFloor(model: THREE.Object3D, opts: MirrorFloorOptions = {}): KitScene {
  const scene = newScene(0x101216);
  scene.environment = gradientEnvironment(new THREE.Vector3(0.4, 0.7, 0.6));
  scene.environmentIntensity = 0.6;
  if (opts.rotateY) model.rotation.y = opts.rotateY;
  const s = standOnFloor(model, opts.size).getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z);
  scene.add(model);
  floor(scene, (opts.metalness ?? 1) > 0 ? mirror(opts.roughness ?? 0.02, 0xdddddd) : std(0x202022, opts.roughness ?? 0.05), r * 12);
  studioLights(scene, [r * 1.2, r * 2, r * 1.5], 2.5, r * 1.5);
  // frame the bounding sphere: distance so it fills ~80% of a 50 degree vertical fov
  const radius = s.length() / 2;
  const dist = (radius / Math.sin((25 * Math.PI) / 180)) * 0.8;
  const dir = new THREE.Vector3(0.55, 0.38, 0.75).normalize().multiplyScalar(dist);
  const target: Vec3 = [0, s.y * 0.4, 0];
  const views = {
    default: { pos: [dir.x, s.y * 0.4 + dir.y, dir.z] as Vec3, target },
    low: { pos: [dist * 0.6, Math.max(s.y * 0.15, r * 0.04), dist * 0.6] as Vec3, target: [0, s.y * 0.3, 0] as Vec3 },
  };
  return {
    id: opts.id ?? 'gltf', title: opts.title ?? 'glTF on a mirror floor', scene,
    camera: makeCamera(views.default, opts.aspect, r * 0.01, r * 40),
    target: new THREE.Vector3(...target), views,
    probes: [{ position: [0, s.y / 2, 0], influenceSize: [r * 6, s.y * 2, r * 6], projectionSize: toVec3(s.clone().multiplyScalar(3)) }],
  };
}

/** Sponza as it is (its own floor), lit by a sun through the courtyard. */
async function sponza(opts: SceneOptions = {}): Promise<KitScene> {
  const model = await loadGLTF(assetUrl('Sponza', 'Sponza.gltf'));
  const scene = newScene(0x8fb3e0);
  scene.add(model);
  scene.environment = gradientEnvironment(new THREE.Vector3(0.3, 1, 0.2));
  scene.environmentIntensity = 0.4;
  const sun = new THREE.DirectionalLight(0xfff1dc, 6);
  sun.position.set(6, 30, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(4096);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xbcd4ff, 0x4a3e30, 0.6));
  const views = {
    default: { pos: [-9, 2.2, -0.4] as Vec3, target: [3, 2.5, -0.2] as Vec3, fov: 60 },
    gallery: { pos: [8, 5.8, -3.4] as Vec3, target: [-6, 5.2, -3.6] as Vec3, fov: 60 },
  };
  return {
    id: 'sponza', title: 'Sponza (Khronos)', scene, camera: makeCamera(views.default, opts.aspect, 0.05, 80),
    target: new THREE.Vector3(...views.default.target), views,
    probes: [{ position: [0, 6, 0], influenceSize: [30, 14, 14], projectionSize: [28, 14, 12] }],
  };
}

const onFloor = (dir: string, file: string, o: MirrorFloorOptions) => async (opts: SceneOptions = {}) =>
  onMirrorFloor(await loadGLTF(assetUrl(dir, file)), { ...o, ...opts });

/** Scene factories for downloaded assets, by asset folder (see scripts/fetch-assets.mjs). */
export const ASSET_SCENES: Record<string, { id: string; title: string; factory: (opts?: SceneOptions) => Promise<KitScene> }> = {
  Sponza: { id: 'sponza', title: 'Sponza', factory: sponza },
  ToyCar: { id: 'toyCar', title: 'Toy car on a mirror floor', factory: onFloor('ToyCar', 'ToyCar.glb', { id: 'toyCar', title: 'Toy car on a mirror floor', size: 2, rotateY: 0.6 }) },
  CarConcept: { id: 'carConcept', title: 'Car concept on a mirror floor', factory: onFloor('CarConcept', 'CarConcept.glb', { id: 'carConcept', title: 'Car concept on a mirror floor', size: 4.5, rotateY: 0.6 }) },
  ABeautifulGame: { id: 'chess', title: 'Chess set on a mirror floor', factory: onFloor('ABeautifulGame', 'ABeautifulGame.glb', { id: 'chess', title: 'Chess set on a mirror floor', size: 1.2 }) },
  FlightHelmet: { id: 'helmet', title: 'Flight helmet on a glossy floor', factory: onFloor('FlightHelmet', 'FlightHelmet.gltf', { id: 'helmet', title: 'Flight helmet on a glossy floor', size: 0.8, metalness: 0, roughness: 0.05 }) },
  MetalRoughSpheres: { id: 'metalRough', title: 'MetalRoughSpheres', factory: onFloor('MetalRoughSpheres', 'MetalRoughSpheres.glb', { id: 'metalRough', title: 'MetalRoughSpheres', size: 3, metalness: 0, roughness: 0.3 }) },
  EnvironmentTest: { id: 'envTest', title: 'EnvironmentTest (dev only licence)', factory: onFloor('EnvironmentTest', 'EnvironmentTest.gltf', { id: 'envTest', title: 'EnvironmentTest (dev only)', size: 4, metalness: 0, roughness: 0.6 }) },
};
