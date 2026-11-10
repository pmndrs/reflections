// Showcase scenes: real assets (examples/assets/, fetched by `pnpm assets`) lit by an HDR
// environment plus a sun or point lights, each with suggested probe volumes and camera presets.
//
// - toyCar, carConcept, chess: the model on our own floor (mirror or black lacquer) in a studio HDRI.
// - sponza: Sponza with a sky HDRI, a sun through the courtyard and the four torches lit; its own
//   floor is rough stone, so `floor.setPolished(true)` swaps in a polished copy of that material.
import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { assetUrl, loadGLTF, standOnFloor, type CameraView, type ProbeVolume, type Vec3 } from '../../shared';

export type FloorKind = 'mirror' | 'lacquer';

export interface ShowcaseFloor {
  /** The floor's look; `kinds` lists what this scene offers. */
  kinds: FloorKind[] | null;
  roughness: number;
  /** Scenes with an asset floor (Sponza): polished override on or off. */
  polishable: boolean;
  setRoughness(r: number): void;
  setKind?(k: FloorKind): void;
  setPolished?(on: boolean): void;
}

export interface ShowcaseScene {
  id: string;
  title: string;
  credit: string;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  views: Record<string, CameraView>;
  probes: (ProbeVolume & { projectionOffset?: Vec3 })[];
  floor: ShowcaseFloor;
  exposure: number;
  /** Bake settings for the probes (far plane in scene units). */
  bake: { near: number; far: number };
  /**
   * Screen-space hit thickness for this scene's scale. The tracer's defaults (0.2 + 10 alpha +
   * 0.01 x ray length, in metres) suit rooms; on a 1 m chess board or a car they accept hits far
   * behind thin parts. (The pieces seen over the board's edge in the floor are correct: the board is
   * 2.6 cm thick. The black specks on raw car paint are hits on the dark sill, W17.)
   */
  thickness?: { depthBufferThickness: number; thicknessRoughnessFactor: number };
}

export interface ShowcaseEntry { id: string; title: string; asset: string; hdri: string; build(aspect: number): Promise<ShowcaseScene> }

const hdrCache = new Map<string, Promise<THREE.DataTexture>>();
function loadHDR(file: string) {
  let p = hdrCache.get(file);
  if (!p) {
    p = new HDRLoader().loadAsync(assetUrl('hdri', file)).then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; return t; });
    hdrCache.set(file, p);
  }
  return p;
}

export const STUDIO_HDRI = 'studio_small_09_1k.hdr';
export const SKY_HDRI = 'kloofendal_48d_partly_cloudy_puresky_1k.hdr';

function camera(view: CameraView, aspect: number, near: number, far: number) {
  const c = new THREE.PerspectiveCamera(view.fov ?? 40, aspect, near, far);
  c.position.set(...view.pos);
  c.lookAt(new THREE.Vector3(...view.target));
  c.updateMatrixWorld();
  return c;
}

const noTrace = (o: THREE.Object3D) => { o.userData.noTrace = true; return o; };

interface StageOptions { id: string; title: string; credit: string; size: number; rotateY?: number; exposure?: number; floor?: FloorKind; roughness?: number }

/** A model on a floor disc in the studio HDRI with a shadowed key light. */
async function stage(asset: string, file: string, o: StageOptions, aspect: number): Promise<ShowcaseScene> {
  const [model, hdr] = await Promise.all([loadGLTF(assetUrl(asset, file)), loadHDR(STUDIO_HDRI)]);
  const scene = new THREE.Scene();
  scene.environment = hdr;
  scene.environmentIntensity = 1;
  scene.background = hdr;
  scene.backgroundBlurriness = 0.35;
  scene.backgroundIntensity = 0.35;

  if (o.rotateY) model.rotation.y = o.rotateY;
  // vertex bounds: the loose per-mesh boxes stand CarConcept 0.15 m above the floor (rotated wheels)
  const s = standOnFloor(model, o.size).getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z);
  scene.add(model);

  // floor: a disc, so the HDRI background shows past its edge
  const floorMat = new THREE.MeshPhysicalMaterial({ color: 0xc8c8c8, metalness: 1, roughness: o.roughness ?? 0.03 });
  const floorMesh = new THREE.Mesh(new THREE.CircleGeometry(r * 7, 96), floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);
  const setKind = (k: FloorKind) => {
    if (k === 'mirror') { floorMat.color.set(0xc8c8c8); floorMat.metalness = 1; }
    else { floorMat.color.set(0x050506); floorMat.metalness = 0; }
    floorMat.needsUpdate = true;
  };
  setKind(o.floor ?? 'mirror');

  const key = new THREE.DirectionalLight(0xfff4e8, 2.2);
  key.position.set(r * 1.4, r * 2.4, r * 1.1);
  key.castShadow = true;
  key.shadow.mapSize.setScalar(2048);
  Object.assign(key.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: r * 0.2, far: r * 8 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = r * 0.004;
  scene.add(key, key.target);

  const radius = s.length() / 2;
  const dist = (radius / Math.sin((20 * Math.PI) / 180)) * 0.85;
  const t: Vec3 = [0, s.y * 0.38, 0];
  const views: Record<string, CameraView> = {
    hero: { pos: [dist * 0.62, s.y * 0.38 + dist * 0.22, dist * 0.78], target: t, fov: 40 },
    low: { pos: [dist * 0.75, Math.max(s.y * 0.08, r * 0.03), dist * 0.55], target: [0, s.y * 0.3, 0], fov: 40 },
    front: { pos: [0, s.y * 0.45, dist * 0.95], target: t, fov: 40 },
    close: { pos: [dist * 0.3, s.y * 0.95, dist * 0.38], target: [0, s.y * 0.7, 0], fov: 40 },
    top: { pos: [dist * 0.25, dist * 0.85, dist * 0.45], target: [0, 0, 0], fov: 40 },
  };
  const floor: ShowcaseFloor = {
    kinds: ['mirror', 'lacquer'], roughness: floorMat.roughness, polishable: false,
    setRoughness(v) { floorMat.roughness = v; this.roughness = v; },
    setKind,
  };
  return {
    id: o.id, title: o.title, credit: o.credit, scene, views, floor,
    camera: camera(views.hero, aspect, r * 0.01, r * 60),
    exposure: o.exposure ?? 1,
    // One probe over the whole floor disc, captured just above the model and projected onto a far
    // box (close to infinity): it gives the model's paint and chrome the mirror floor and the rest
    // of the model, and gives the floor the environment as seen from the model. A box projection with
    // a near capture point smears the model across the floor (pieces under the board, the toy car
    // under its cloth); the floor's reflection of the model is screen-space / ray-traced work.
    // The box reaches r/4 below the floor, so the floor isn't in its blend fade, and covers the disc,
    // so three's lit image and the composite read the same term everywhere (outside every probe
    // they don't quite: HANDOFF fine-tune backlog, W11).
    probes: [(() => {
      const y0 = -r * 0.25, y1 = s.y * 1.1 + r * 0.1, cy = (y0 + y1) / 2;
      return {
        position: [0, cy, 0] as Vec3, influenceSize: [r * 14.2, y1 - y0, r * 14.2] as Vec3, projectionSize: [r * 30, r * 30, r * 30] as Vec3,
        originOffset: [0, s.y + r * 0.08 - cy, 0] as Vec3, blendDistance: r * 0.06,
      };
    })()],
    bake: { near: r * 0.01, far: r * 40 },
    thickness: { depthBufferThickness: r * 0.01, thicknessRoughnessFactor: r * 0.5 },
  };
}

/**
 * Sponza: courtyard along x (about -11 .. 10), open roof, ground-floor aisles on both sides (z about
 * -5.2 .. -2.5 and 1.9 .. 4.6) under a gallery. One probe per region: the courtyard, both aisles
 * split into halves (they're 21 m long and 2.7 m wide, so one box projects poorly at the ends), and
 * the two galleries.
 */
async function sponza(aspect: number): Promise<ShowcaseScene> {
  const [model, hdr] = await Promise.all([loadGLTF(assetUrl('Sponza', 'Sponza.gltf')), loadHDR(SKY_HDRI)]);
  const scene = new THREE.Scene();
  scene.environment = hdr;
  scene.environmentIntensity = 1;
  scene.background = hdr;
  scene.add(model);

  // the asset's own floor material and a polished override (same albedo and normal map, smooth, flatter)
  // (the 'Floors' node: a Mesh itself for one primitive, a Group of them otherwise)
  let floorMesh: THREE.Mesh | null = null;
  model.getObjectByName('Floors')?.traverse((o) => { if ((o as THREE.Mesh).isMesh) floorMesh ??= o as THREE.Mesh; });
  const original = floorMesh ? (floorMesh as THREE.Mesh).material as THREE.MeshStandardMaterial : null;
  const polished = original ? original.clone() : null;
  if (polished) {
    polished.roughnessMap = null;
    polished.metalnessMap = null;
    polished.metalness = 0;
    polished.roughness = 0.06;
    polished.normalScale = new THREE.Vector2(0.15, 0.15);
    polished.color.multiplyScalar(0.8);
  }

  const sun = new THREE.DirectionalLight(0xfff0d8, 7);
  sun.position.set(5, 30, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(4096);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  for (const [x, z] of [[3.9, 1.15], [-4.95, 1.15], [3.9, -1.75], [-4.95, -1.75]]) {
    const torch = new THREE.PointLight(0xff8a3a, 6, 9, 2);
    torch.position.set(x, 1.85, z);
    scene.add(noTrace(torch));
  }

  const views: Record<string, CameraView> = {
    courtyard: { pos: [-9.5, 1.5, -0.3], target: [3, 1.6, -0.3], fov: 60 },
    low: { pos: [-6.5, 0.35, 0.4], target: [4, 1.0, -0.4], fov: 60 },
    aisle: { pos: [-9, 1.6, -3.8], target: [6, 1.3, -3.6], fov: 60 },
    gallery: { pos: [8, 5.8, -3.6], target: [-6, 5.2, -3.6], fov: 60 },
    overview: { pos: [-8.5, 9.6, -0.3], target: [5, 0.2, -0.3], fov: 55 },
  };
  const floor: ShowcaseFloor = {
    kinds: null, roughness: polished?.roughness ?? 0.06, polishable: !!polished,
    setRoughness(v) { if (polished) polished.roughness = v; this.roughness = v; },
    setPolished(on) { if (floorMesh && polished && original) floorMesh.material = on ? polished : original; },
  };
  floor.setPolished!(true);

  // Influence boxes reach `below` under their floor (a floor on the box face sits in the blend fade,
  // at coverage ~0); the projection box stays on the walls and floor (projectionOffset).
  const box = (x0: number, x1: number, z: number, depth: number, y0: number, y1: number, blendDistance: number, below = 0.8) => ({
    position: [(x0 + x1) / 2, (y0 - below + y1) / 2, z] as Vec3, influenceSize: [x1 - x0, y1 - y0 + below, depth] as Vec3,
    projectionSize: [x1 - x0, y1 - y0, depth] as Vec3, projectionOffset: [0, below / 2, 0] as Vec3, blendDistance,
  });
  const probes = [
    box(-11.4, 10.4, -0.3, 4.4, 0, 10.4, 0.8), // courtyard, up to the roof line
    box(-11.4, -0.5, -3.85, 2.7, 0, 3.6, 0.6), box(-0.5, 10.4, -3.85, 2.7, 0, 3.6, 0.6), // south aisle, two halves
    box(-11.4, -0.5, 3.25, 2.7, 0, 3.6, 0.6), box(-0.5, 10.4, 3.25, 2.7, 0, 3.6, 0.6), // north aisle
    box(-11.4, 10.4, -3.85, 2.7, 3.6, 8.2, 0.6, 0.3), box(-11.4, 10.4, 3.25, 2.7, 3.6, 8.2, 0.6, 0.3), // galleries
  ];
  return {
    id: 'sponza', title: 'Sponza', credit: 'Sponza: Crytek (CryENGINE limited licence), Khronos glTF; sky: Poly Haven (CC0)',
    scene, views, floor, probes, exposure: 0.7,
    camera: camera(views.courtyard, aspect, 0.05, 80),
    bake: { near: 0.05, far: 60 },
  };
}

export const SHOWCASE: ShowcaseEntry[] = [
  {
    id: 'carConcept', title: 'Car concept', asset: 'CarConcept', hdri: STUDIO_HDRI,
    build: (aspect) => stage('CarConcept', 'CarConcept.glb', { id: 'carConcept', title: 'Car concept', credit: 'CarConcept: Khronos glTF sample (CC-BY 4.0); studio: Poly Haven (CC0)', size: 4.6, rotateY: -1.0 }, aspect),
  },
  {
    id: 'toyCar', title: 'Toy car', asset: 'ToyCar', hdri: STUDIO_HDRI,
    build: (aspect) => stage('ToyCar', 'ToyCar.glb', { id: 'toyCar', title: 'Toy car', credit: 'ToyCar: Khronos glTF sample (CC0); studio: Poly Haven (CC0)', size: 2, rotateY: 0.6 }, aspect),
  },
  {
    id: 'chess', title: 'Chess set', asset: 'ABeautifulGame', hdri: STUDIO_HDRI,
    build: (aspect) => stage('ABeautifulGame', 'ABeautifulGame.glb', { id: 'chess', title: 'Chess set', credit: 'A Beautiful Game: ASWF / Khronos glTF sample (CC-BY 4.0); studio: Poly Haven (CC0)', size: 1, rotateY: 0.35 }, aspect),
  },
  { id: 'sponza', title: 'Sponza (polished floor)', asset: 'Sponza', hdri: SKY_HDRI, build: sponza },
];
