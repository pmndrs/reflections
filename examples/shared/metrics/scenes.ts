// X0 (W70): the experiment plan's two measurement scenes, as tuning-bench scenes (examples/showcase/bench.html
// `?scene=lineSpread` / `?scene=grazing`), so every method, the path-traced reference and Measure work on them.
// Procedural (no asset download); they use the studio HDRI file only so the bench's environment plumbing holds
// (lineSpread turns it to black).
//
// - lineSpread: a thin emissive strip (8 m long, 1.5 cm square, 30 cm above the floor, 4 m ahead) over a large
//   metal floor (white, `floorRoughness`), black environment and background, no lights. Poses e5 / e15 / e30 /
//   e60: the camera sees the strip's reflection point at that elevation (the double-blur gate runs at e15).
//   The reflected strip is a horizontal line; its vertical FWHM is the line spread (metrics.lineSpread).
// - grazing: a metal floor (roughness 0.15 by default) in front of an emissive checker wall (25 cm squares,
//   12 x 4 m, 1.5 m behind the target point), studio HDRI at intensity 1 around it. Poses e5 / e15 / e30 / e60:
//   4 m from the target point at that elevation. The floor reflects the checker at every elevation.
import * as THREE from 'three/webgpu';
import type { CameraView, Vec3 } from '..';
import { STUDIO_HDRI, type ShowcaseEntry, type ShowcaseFloor, type ShowcaseScene } from '../../showcase/src/scenes';

export const ELEVATIONS = [5, 15, 30, 60] as const;
const rad = (d: number) => (d * Math.PI) / 180;

function floorOf(roughness: number, color = 0xf0f0f0) {
  const mat = new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'floor';
  const floor: ShowcaseFloor = { kinds: null, roughness, polishable: false, setRoughness(v) { mat.roughness = v; this.roughness = v; } };
  return { mesh, floor };
}

function cameraFor(view: CameraView, aspect: number) {
  const c = new THREE.PerspectiveCamera(view.fov ?? 40, aspect, 0.05, 120);
  c.position.set(...view.pos);
  c.lookAt(new THREE.Vector3(...view.target));
  c.updateMatrixWorld();
  return c;
}

/** The strip's geometry (exported for the metric's window). */
export const STRIP = { distance: 4, height: 0.3, size: 0.015, length: 8, emissive: 0.65 } as const;

/** Camera for line spread at elevation `e`: the strip's mirror point seen `e` degrees below the horizon. */
export function lineSpreadView(e: number): CameraView {
  const { distance: d, height: h } = STRIP;
  const c = Math.max(0.05, d * Math.tan(rad(e)) - h);
  const zr = d * c / (c + h); // the mirror point's horizontal distance
  return { pos: [0, c, d], target: [0, 0, d - zr], fov: 40 };
}

async function lineSpread(aspect: number): Promise<ShowcaseScene> {
  const scene = new THREE.Scene();
  scene.environmentIntensity = 0; // black: the strip is the only light (freshEnvironment() sets the HDRI texture)
  scene.backgroundIntensity = 0;
  const { mesh, floor } = floorOf(0.15);
  scene.add(mesh);
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(STRIP.length, STRIP.size, STRIP.size),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, emissive: 0xffffff, emissiveIntensity: STRIP.emissive }),
  );
  strip.position.set(0, STRIP.height, 0);
  strip.name = 'strip';
  scene.add(strip);
  const views = Object.fromEntries(ELEVATIONS.map((e) => [`e${e}`, lineSpreadView(e)]));
  return {
    id: 'lineSpread', title: 'Line spread (X0)', credit: 'procedural (W70)', scene, views, floor,
    camera: cameraFor(views.e15, aspect), exposure: 1,
    probes: [{ position: [0, 1.5, 2], influenceSize: [60, 6, 60] as Vec3, originOffset: [0, -0.9, 0] as Vec3, blendDistance: 0.5 }],
    bake: { near: 0.02, far: 100 },
  };
}

function checkerTexture(n = 2) {
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = (x + y) & 1 ? 255 : 18;
    data.set([v, v, v, 255], (y * n + x) * 4);
  }
  const t = new THREE.DataTexture(data, n, n);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

export const WALL = { behind: 1.5, width: 12, height: 4, square: 0.25, emissive: 1.2 } as const;
export function grazingView(e: number, dist = 4): CameraView {
  return { pos: [0, dist * Math.sin(rad(e)), dist * Math.cos(rad(e))], target: [0, 0, 0], fov: 40 };
}

async function grazing(aspect: number): Promise<ShowcaseScene> {
  const scene = new THREE.Scene();
  scene.environmentIntensity = 1;
  scene.backgroundIntensity = 0.35;
  const { mesh, floor } = floorOf(0.15, 0xd8d8d8);
  scene.add(mesh);
  const map = checkerTexture();
  map.repeat.set(WALL.width / WALL.square / 2, WALL.height / WALL.square / 2);
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(WALL.width, WALL.height),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: WALL.emissive }),
  );
  wall.position.set(0, WALL.height / 2, -WALL.behind);
  wall.name = 'checkerWall';
  scene.add(wall);
  const views = Object.fromEntries(ELEVATIONS.map((e) => [`e${e}`, grazingView(e)]));
  return {
    id: 'grazing', title: 'Grazing sweep (X0)', credit: 'procedural (W70); studio: Poly Haven (CC0)', scene, views, floor,
    camera: cameraFor(views.e15, aspect), exposure: 1,
    probes: [{ position: [0, 2, 1], influenceSize: [30, 8, 30] as Vec3, originOffset: [0, -1, 0] as Vec3, blendDistance: 0.5 }],
    bake: { near: 0.02, far: 100 },
  };
}

/** The bench's procedural scenes (no asset download; they need the studio HDRI file only). */
export const METRIC_SCENES: ShowcaseEntry[] = [
  { id: 'lineSpread', title: 'Line spread (X0)', asset: '', hdri: STUDIO_HDRI, build: lineSpread },
  { id: 'grazing', title: 'Grazing sweep (X0)', asset: '', hdri: STUDIO_HDRI, build: grazing },
];
