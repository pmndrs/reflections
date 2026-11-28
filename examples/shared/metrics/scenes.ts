// X0 (W70): the experiment plan's two measurement scenes, as tuning-bench scenes (examples/showcase/bench.html
// `?scene=lineSpread` / `?scene=grazing`), so every method, the path-traced reference and Measure work on them.
// Procedural (no asset download); they use the studio HDRI file only so the bench's environment plumbing holds
// (lineSpread turns it to black).
//
// - lineSpread: a thin emissive strip (8 m long, 1.5 cm tall, 30 cm above the floor, 4 m ahead) over a large
//   metal floor (white, `floorRoughness`), black environment and background, no lights. Poses e5 / e15 / e30 /
//   e60: the camera sees the strip's reflection point at that elevation (the double-blur gate runs at e15).
//   The reflected strip is a horizontal line; its vertical FWHM is the line spread (metrics.lineSpread).
//   The strip is painted on a black wall (10 m x 3 m, standing on the floor), 1 mm in front of it, so a
//   screen-space ray that passes above or below the strip meets the wall in the depth buffer as it does in the
//   PT: the scene measures blur, not thickness.
// - lineSpreadThin: the same strip floating free (no wall). W70's baseline: SSR's depth thickness (0.2 m +
//   10 alpha) accepts hits behind it, so it reflects as a slab (r 0.05: 14 px vs the PT's 3.6; r 0.3: ~70x the
//   PT's peak); ours + RT matches the PT. The thin-geometry / thickness case (X1 #2), not the blur gate.
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
export const STRIP = { distance: 4, height: 0.3, size: 0.015, length: 8, emissive: 0.65, wallWidth: 10, wallHeight: 3 } as const;

/** Camera for line spread at elevation `e`: the strip's mirror point seen `e` degrees below the horizon. */
export function lineSpreadView(e: number): CameraView {
  const { distance: d, height: h } = STRIP;
  const c = Math.max(0.05, d * Math.tan(rad(e)) - h);
  const zr = d * c / (c + h); // the mirror point's horizontal distance
  return { pos: [0, c, d], target: [0, 0, d - zr], fov: 40 };
}

async function lineSpread(aspect: number, thin = false): Promise<ShowcaseScene> {
  const scene = new THREE.Scene();
  scene.environmentIntensity = 0; // black: the strip is the only light (freshEnvironment() sets the HDRI texture)
  scene.backgroundIntensity = 0;
  const { mesh, floor } = floorOf(0.15);
  scene.add(mesh);
  const glow = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, emissive: 0xffffff, emissiveIntensity: STRIP.emissive });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(STRIP.length, STRIP.size, STRIP.size), glow);
  strip.position.set(0, STRIP.height, 0);
  strip.name = 'strip';
  scene.add(strip);
  if (!thin) {
    // the black wall the strip is painted on (just behind it)
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(STRIP.wallWidth, STRIP.wallHeight), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
    wall.position.set(0, STRIP.wallHeight / 2, -STRIP.size / 2 - 1e-3);
    wall.name = 'stripWall';
    scene.add(wall);
  }
  const views = Object.fromEntries(ELEVATIONS.map((e) => [`e${e}`, lineSpreadView(e)]));
  return {
    id: thin ? 'lineSpreadThin' : 'lineSpread', title: thin ? 'Line spread, thin strip (X0)' : 'Line spread (X0)', credit: 'procedural (W70)', scene, views, floor,
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

// ---- T53 (W85): simple flicker scenes ---------------------------------------------------------------------
// A glossy floor (roughness 0.08, bright metal) in the studio HDRI with a key light, and one object each, so the
// flicker metrics have a reflection whose truth is obvious (named regions in bench/regions.ts, pose `hero`):
// - cubeFloor: a 0.6 m orange cube turned 25 degrees (diagonal, stair-stepping edges) and a low slab on the floor:
//   the contact line, the silhouette and the reflected faces (the contact-rest-drift family).
// - edgesFloor: a high-contrast checker panel (sharp black / white edges) standing 0.25 m above the floor: the
//   reflected edges (quad copy, edge pan, orbit shimmer).
// - plateFloor: a 2 cm plate floating 0.25 m above the floor, bright top: SSR thickness (rays behind it), the
//   plate's reflected edge and the dark gap under it.
function simpleScene(id: string, title: string, fill: (scene: THREE.Scene) => void, aspect: number): ShowcaseScene {
  const scene = new THREE.Scene();
  scene.environmentIntensity = 1;
  scene.backgroundIntensity = 0.35;
  const { mesh, floor } = floorOf(0.08, 0xe8e8e8);
  scene.add(mesh);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2.5, 4, 2);
  scene.add(key);
  fill(scene);
  const views: Record<string, CameraView> = { hero: { pos: [0, 1.15, 3.3], target: [0, 0.2, 0], fov: 40 }, low: { pos: [0, 0.45, 3.3], target: [0, 0.2, 0], fov: 40 } };
  return {
    id, title, credit: 'procedural (W85, T53); studio: Poly Haven (CC0)', scene, views, floor,
    camera: cameraFor(views.hero, aspect), exposure: 1,
    probes: [{ position: [0, 1.5, 1], influenceSize: [30, 6, 30] as Vec3, originOffset: [0, -0.9, 0] as Vec3, blendDistance: 0.5 }],
    bake: { near: 0.02, far: 100 },
    thickness: { depthBufferThickness: 0.05, thicknessRoughnessFactor: 0.1 },
  };
}

const diffuse = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.7 });

async function cubeFloor(aspect: number): Promise<ShowcaseScene> {
  return simpleScene('cubeFloor', 'Cube and slab on a glossy floor (T53)', (scene) => {
    const cube = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), diffuse(0xe0701c));
    cube.position.set(-0.35, 0.3, 0);
    cube.rotation.y = rad(25);
    cube.name = 'cube';
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.4), diffuse(0x2c8fe0));
    slab.position.set(0.55, 0.06, 0.25);
    slab.rotation.y = rad(-12);
    slab.name = 'slab';
    scene.add(cube, slab);
  }, aspect);
}

async function edgesFloor(aspect: number): Promise<ShowcaseScene> {
  return simpleScene('edgesFloor', 'Sharp-edged panel above a glossy floor (T53)', (scene) => {
    const map = checkerTexture();
    map.repeat.set(6, 3);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.02), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 1.0 }));
    panel.position.set(0, 0.55, -0.2);
    panel.name = 'panel';
    scene.add(panel);
  }, aspect);
}

async function plateFloor(aspect: number): Promise<ShowcaseScene> {
  return simpleScene('plateFloor', 'Thin plate over a glossy floor (T53)', (scene) => {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.02, 0.8), diffuse(0xd8d020));
    plate.position.set(0, 0.25, 0);
    plate.rotation.y = rad(15);
    plate.name = 'plate';
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), diffuse(0x30a050));
    post.position.set(0.9, 0.25, -0.4);
    post.name = 'post';
    scene.add(plate, post);
  }, aspect);
}

/**
 * W110 (T18): an alpha-tested slatted card (`alphaTest` 0.5, half its width cut out) 1.2 m above the glossy floor, an orange
 * wall behind it. At pose `down` the camera looks 49 degrees down: card and wall are above the frame, so their floor
 * reflection is all traced rays (SSR has nothing on screen to hit), and a solid card would block the wall in it.
 */
async function fenceFloor(aspect: number): Promise<ShowcaseScene> {
  const s = simpleScene('fenceFloor', 'Alpha-tested slats above a glossy floor (W110)', (scene) => {
    const n = 64, data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data.set([60, 150, 70, (x >> 3) & 1 ? 0 : 255], (y * n + x) * 4);
    const map = new THREE.DataTexture(data, n, n);
    map.colorSpace = THREE.SRGBColorSpace;
    map.needsUpdate = true;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8), new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7 }));
    card.position.set(0, 1.2, 0);
    card.name = 'card';
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2, 0.1), diffuse(0xe0701c));
    wall.position.set(0, 1, -0.6);
    wall.name = 'wall';
    scene.add(card, wall);
  }, aspect);
  s.views.down = { pos: [0, 1.15, 1.6], target: [0, 0, 0.6], fov: 40 };
  return s;
}

/** The bench's procedural scenes (no asset download; they need the studio HDRI file only). */
export const METRIC_SCENES: ShowcaseEntry[] = [
  { id: 'lineSpread', title: 'Line spread (X0)', asset: '', hdri: STUDIO_HDRI, build: (a) => lineSpread(a) },
  { id: 'lineSpreadThin', title: 'Line spread, thin strip (X0)', asset: '', hdri: STUDIO_HDRI, build: (a) => lineSpread(a, true) },
  { id: 'grazing', title: 'Grazing sweep (X0)', asset: '', hdri: STUDIO_HDRI, build: grazing },
  { id: 'cubeFloor', title: 'Cube and slab on a glossy floor (T53)', asset: '', hdri: STUDIO_HDRI, build: cubeFloor },
  { id: 'edgesFloor', title: 'Sharp-edged panel above a glossy floor (T53)', asset: '', hdri: STUDIO_HDRI, build: edgesFloor },
  { id: 'plateFloor', title: 'Thin plate over a glossy floor (T53)', asset: '', hdri: STUDIO_HDRI, build: plateFloor },
  { id: 'fenceFloor', title: 'Alpha-tested slats above a glossy floor (W110)', asset: '', hdri: STUDIO_HDRI, build: fenceFloor },
];
