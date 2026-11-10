// Scene kit: shared types and building blocks for the reflection test scenes (./scenes.ts,
// ./explainer.ts, ./rooms.ts, ./gltf.ts). Everything is procedural (no downloads) except the glTF
// scenes, so a fresh clone renders every procedural scene.
import * as THREE from 'three/webgpu';

export type Vec3 = [number, number, number];

/** A suggested reflection-probe volume, in the terms of `ReflectionProbe` (three.js #35046). */
export interface ProbeVolume {
  /** Volume centre (world). */
  position: Vec3;
  /** Where the probe applies (box size). */
  influenceSize: Vec3;
  /** The box the lookup is projected onto (box projection); usually the room's walls. */
  projectionSize?: Vec3;
  /** Capture point relative to `position` (our extension over #35046). */
  originOffset?: Vec3;
  blendDistance?: number;
}

export interface CameraView { pos: Vec3; target: Vec3; fov?: number }

export interface KitScene {
  id: string;
  title: string;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Orbit target for the default view. */
  target: THREE.Vector3;
  /** Named camera views (scenarios). `default` is where the camera starts. */
  views: Record<string, CameraView>;
  /** Suggested probe volumes. */
  probes: ProbeVolume[];
  /** Animate to `time` (seconds). Absent for static scenes. */
  update?(time: number): void;
  dispose?(): void;
}

export interface SceneOptions { aspect?: number }
export type SceneFactory = (opts?: SceneOptions) => KitScene | Promise<KitScene>;

// ---- building blocks ------------------------------------------------------------------------

export const std = (color: THREE.ColorRepresentation, roughness = 0.8, metalness = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

export const glow = (color: THREE.ColorRepresentation, intensity = 3) =>
  new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity });

/** A mirror: metal, roughness `roughness` (0 = perfect). */
export const mirror = (roughness = 0, color: THREE.ColorRepresentation = 0xeeeeee) => std(color, roughness, 1);

export function makeCamera(view: CameraView, aspect = 16 / 9, near = 0.05, far = 100) {
  const camera = new THREE.PerspectiveCamera(view.fov ?? 50, aspect, near, far);
  camera.position.set(...view.pos);
  camera.lookAt(new THREE.Vector3(...view.target));
  camera.updateMatrixWorld();
  return camera;
}

/** Adds a mesh with shadows on, returns it. */
export function add<T extends THREE.Object3D>(parent: THREE.Object3D, obj: T, pos?: Vec3, rotY = 0): T {
  if (pos) obj.position.set(...pos);
  if (rotY) obj.rotation.y = rotY;
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  parent.add(obj);
  return obj;
}

/** A horizontal floor plane at y = 0. */
export function floor(parent: THREE.Object3D, material: THREE.Material, size = 20) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/**
 * A patterned canvas texture: a checker of two greys with coloured bands and big numbered cells,
 * so position and orientation in a reflection are easy to read.
 */
export function patternTexture(opts: { cells?: [number, number]; size?: [number, number]; bands?: string[] } = {}) {
  const [cx, cy] = opts.cells ?? [10, 4];
  const [w, h] = opts.size ?? [1024, 410];
  const bands = opts.bands ?? ['#e63946', '#f4a261', '#2a9d8f', '#457b9d', '#8d5fd3'];
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d')!;
  const cw = w / cx, ch = h / cy;
  for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) {
    g.fillStyle = (x + y) % 2 ? '#d8d8d8' : '#9a9a9a';
    g.fillRect(x * cw, y * ch, cw, ch);
  }
  // a coloured band along every second row, and a big index per cell
  for (let y = 0; y < cy; y += 2) {
    g.fillStyle = bands[(y / 2) % bands.length];
    g.fillRect(0, y * ch + ch * 0.4, w, ch * 0.2);
  }
  g.fillStyle = '#202020';
  g.font = `bold ${Math.floor(ch * 0.32)}px sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) g.fillText(String.fromCharCode(65 + y) + (x + 1), (x + 0.5) * cw, (y + 0.22) * ch);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A soft gradient environment (ceiling warm white, horizon beige, floor dark), CPU float data,
 * after the explainer's makeEnvironment(). `sun` adds a bright patch in that direction.
 */
export function gradientEnvironment(sun?: THREE.Vector3, sunStrength = 6) {
  const w = 256, h = 128;
  const data = new Float32Array(w * h * 4);
  const dir = new THREE.Vector3();
  const s = sun?.clone().normalize();
  for (let y = 0; y < h; y++) {
    const phi = (y / (h - 1)) * Math.PI;
    for (let x = 0; x < w; x++) {
      const theta = (x / (w - 1)) * Math.PI * 2;
      dir.set(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
      const up = dir.y;
      let r: number, gg: number, b: number;
      if (up > 0) { const k = Math.min(1, up * 1.6); r = 0.46 + 0.22 * k; gg = 0.44 + 0.21 * k; b = 0.41 + 0.19 * k; }
      else { const k = Math.min(1, -up * 2.5); r = 0.46 - 0.30 * k; gg = 0.44 - 0.29 * k; b = 0.41 - 0.28 * k; }
      let add = 0;
      if (s) { const d = dir.dot(s); add = Math.max(0, (d - 0.93) / 0.07) ** 2 * sunStrength; }
      const i = (y * w + x) * 4;
      data[i] = r + add; data[i + 1] = gg + add * 0.97; data[i + 2] = b + add * 0.92; data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Key + fill: a shadowed directional light and a dim hemisphere. Returns the key light. */
export function studioLights(scene: THREE.Scene, key: Vec3 = [4, 6, 5], intensity = 2.5, shadowExtent = 8) {
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x302820, 0.5));
  const sun = new THREE.DirectionalLight(0xfff2e0, intensity);
  sun.position.set(...key);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  const c = sun.shadow.camera;
  c.left = c.bottom = -shadowExtent; c.right = c.top = shadowExtent; c.near = 0.5; c.far = 40;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  return sun;
}

export function newScene(background: THREE.ColorRepresentation = 0x0d0f12) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  return scene;
}

export const toVec3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
