// The explainer room: the furnished one-room scene of the denoiser repo's
// examples/three-temporal/src/reflections-hybrid.ts (buildScene, its probe and its scenarios),
// ported as a kit scene. Geometry, materials, probe box and camera poses are the original's.
//
// One change: the original lights the room with a rectangular area light whose direct term is
// added in screen space by its composite (with ray-traced shadows), and only uses a spot light at
// the panel as the probe capture's stand-in. A kit scene has to render lit with three's own
// lighting, so that stand-in is the light here: a shadowed SpotLight at the panel, intensity
// power * pi, cone pi/2 * 0.98, penumbra 1, decay 2 (the original's `fill`).
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TeapotGeometry } from 'three/addons/geometries/TeapotGeometry.js';
import { type KitScene, type SceneOptions, type Vec3, gradientEnvironment, makeCamera, toVec3 } from './kit';

const LIGHT_C = new THREE.Vector3(2.7, 2.5, -0.35);
const LIGHT_AIM = new THREE.Vector3(-0.8, 0.0, -0.6);
const LIGHT_N = LIGHT_AIM.clone().sub(LIGHT_C).normalize();
const LIGHT_ASPECT = 1.35;
const LIGHT_POWER = 30;
const LIGHT_HALF = 0.3;

export function explainer(opts: SceneOptions = {}): KitScene {
  const scene = new THREE.Scene();
  const win = LIGHT_C.clone().sub(LIGHT_AIM).normalize();
  scene.environment = gradientEnvironment(win);
  scene.environmentIntensity = 0.28;
  scene.background = new THREE.Color(0x101216);

  const room = new THREE.Group();
  scene.add(room);
  const std = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0, parent: THREE.Object3D = room) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // shell: glossy floor, two matte walls, skirting
  const floor = add(new THREE.PlaneGeometry(16, 16), std(0x3d2e24, 0.12), 0, 0, 0);
  floor.rotation.x = -Math.PI / 2;
  const wallMat = std(0xd9d4cc, 0.85);
  add(new THREE.PlaneGeometry(16, 4), wallMat, 0, 2, -2.1);
  const left = add(new THREE.PlaneGeometry(16, 4), wallMat, -3.0, 2, 0);
  left.rotation.y = Math.PI / 2;
  const skirt = std(0xece8e2, 0.6);
  add(new THREE.BoxGeometry(12, 0.09, 0.02), skirt, 0, 0.045, -2.09);
  add(new THREE.BoxGeometry(0.02, 0.09, 12), skirt, -2.99, 0.045, 0);
  add(new RoundedBoxGeometry(1.7, 0.012, 1.6, 2, 0.005), std(0x56677a, 1.0), -1.25, 0.006, -0.5);

  // table
  const topMat = std(0x2b1d15, 0.12);
  const legMat = std(0x1d1d1f, 0.35, 0.85);
  const table = new THREE.Group();
  table.position.set(0.05, 0, -0.65);
  room.add(table);
  add(new RoundedBoxGeometry(1.5, 0.045, 0.8, 3, 0.012), topMat, 0, 0.74, 0, 0, table);
  const legGeo = new THREE.CylinderGeometry(0.018, 0.014, 0.72, 16);
  for (const [lx, lz] of [[-0.66, -0.32], [0.66, -0.32], [-0.66, 0.32], [0.66, 0.32]]) add(legGeo, legMat, lx, 0.36, lz, 0, table);

  // chair
  const chair = new THREE.Group();
  chair.position.set(-1.05, 0, -0.5);
  chair.rotation.y = Math.PI / 2 + 0.25;
  room.add(chair);
  const oak = std(0xb88a5a, 0.55);
  add(new RoundedBoxGeometry(0.44, 0.035, 0.42, 3, 0.012), oak, 0, 0.45, 0, 0, chair);
  const back = add(new RoundedBoxGeometry(0.42, 0.24, 0.025, 3, 0.01), oak, 0, 0.74, -0.2, 0, chair);
  back.rotation.x = -0.12;
  const cLeg = new THREE.CylinderGeometry(0.014, 0.012, 0.45, 12);
  for (const [lx, lz] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) add(cLeg, legMat, lx, 0.225, lz, 0, chair);
  for (const lx of [-0.19, 0.19]) add(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 10), legMat, lx, 0.6, -0.195, 0, chair);

  // floor lamp (on: a glowing shade)
  const lamp = new THREE.Group();
  lamp.position.set(-2.35, 0, -1.25);
  room.add(lamp);
  const brass = std(0xb08d57, 0.3, 1.0);
  add(new THREE.CylinderGeometry(0.17, 0.18, 0.025, 32), legMat, 0, 0.0125, 0, 0, lamp);
  add(new THREE.CylinderGeometry(0.011, 0.011, 1.5, 12), brass, 0, 0.76, 0, 0, lamp);
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffd6a0, emissiveIntensity: 2.2, side: THREE.DoubleSide });
  add(new THREE.CylinderGeometry(0.13, 0.23, 0.28, 40, 1, true), shadeMat, 0, 1.58, 0, 0, lamp);

  // vase, pouf
  const vaseProfile = [[0, 0], [0.12, 0], [0.15, 0.08], [0.17, 0.3], [0.12, 0.62], [0.07, 0.76], [0.08, 0.84], [0.075, 0.85]].map(([r, y]) => new THREE.Vector2(r, y));
  add(new THREE.LatheGeometry(vaseProfile, 48), std(0x3f6a64, 0.35), -1.6, 0, -1.6);
  const poufProfile = [[0, 0], [0.24, 0], [0.28, 0.03], [0.3, 0.2], [0.28, 0.37], [0.24, 0.4], [0, 0.4]].map(([r, y]) => new THREE.Vector2(r, y));
  add(new THREE.LatheGeometry(poufProfile, 48), std(0xc56b4a, 0.8), 1.15, 0, 0.55);

  // on the table: teapot, chrome ball, small vase, books
  const tt = 0.7625;
  add(new TeapotGeometry(0.085, 10), std(0xe9e4dc, 0.25), -0.3, tt + 0.065, -0.6);
  add(new THREE.SphereGeometry(0.075, 48, 24), std(0xdddddd, 0.06, 1.0), 0.28, tt + 0.075, -0.48);
  const smallVase = [[0, 0], [0.05, 0], [0.065, 0.06], [0.04, 0.2], [0.03, 0.26], [0.035, 0.28]].map(([r, y]) => new THREE.Vector2(r, y));
  add(new THREE.LatheGeometry(smallVase, 32), std(0x9b4f3a, 0.4), 0.42, tt, -0.82);
  [0x2f4858, 0x8c6d46, 0xa9443a].forEach((c, i) => add(new RoundedBoxGeometry(0.26, 0.035, 0.19, 2, 0.004), std(c, 0.7), 0.55, tt + 0.0175 + i * 0.036, -0.05, 0.15 * i - 0.1, table));

  // sculpture on a plinth (turns: update())
  add(new RoundedBoxGeometry(0.34, 0.9, 0.34, 3, 0.01), std(0xeeeae4, 0.7), 0.95, 0.45, -1.65);
  const knot = add(new THREE.TorusKnotGeometry(0.15, 0.045, 160, 20), std(0xc9a46a, 0.25, 1.0), 0.95, 1.14, -1.65);

  // the mirror on the back wall
  add(new RoundedBoxGeometry(2.32, 1.62, 0.03, 2, 0.008), std(0x1d1d1f, 0.4, 0.8), 0.15, 1.6, -2.095);
  add(new THREE.PlaneGeometry(2.2, 1.5), std(0xe6e6e6, 0.02, 1.0), 0.15, 1.6, -2.078);

  // the front of the room, behind the default camera
  const front = std(0x5a7690, 0.85);
  add(new THREE.PlaneGeometry(16, 4), front, 0, 2, 4.6, Math.PI);
  add(new THREE.BoxGeometry(12, 0.09, 0.02), skirt, 0, 0.045, 4.59);
  const sofaMat = std(0xb5562f, 0.8);
  add(new RoundedBoxGeometry(2.3, 0.42, 0.9, 3, 0.06), sofaMat, 0.2, 0.21, 4.1);
  add(new RoundedBoxGeometry(2.3, 0.5, 0.22, 3, 0.06), sofaMat, 0.2, 0.62, 4.48);
  const glow = (c: number, k: number) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c, emissiveIntensity: k });
  ([[0xff3b5c, -0.75, 1.75, 0.9], [0x2ee6d6, 0.2, 1.95, 1.3], [0xffc93c, 1.15, 1.7, 0.8]] as const).forEach(([c, x, y, h]) =>
    add(new RoundedBoxGeometry(0.12, h, 0.03, 2, 0.01), glow(c, 3), x, y, 4.57));
  add(new THREE.CylinderGeometry(0.14, 0.16, 0.03, 32), legMat, -1.4, 0.015, 3.3);
  add(new THREE.CylinderGeometry(0.012, 0.012, 1.3, 12), brass, -1.4, 0.65, 3.3);
  add(new THREE.SphereGeometry(0.2, 32, 16), glow(0xfff0d0, 2.5), -1.4, 1.45, 3.3);
  add(new THREE.CylinderGeometry(0.2, 0.15, 0.4, 32), std(0xe9e4dc, 0.4), 1.7, 0.2, 3.2);
  const leaf = std(0x3f8f3a, 0.6);
  [[0, 0.75, 0, 0.32], [-0.18, 1.05, 0.05, 0.22], [0.15, 1.15, -0.05, 0.2], [0.02, 1.35, 0.02, 0.17]].forEach(([x, y, z, r]) =>
    add(new THREE.IcosahedronGeometry(r, 2), leaf, 1.7 + x, y, 3.2 + z));
  add(new THREE.TorusGeometry(0.32, 0.025, 12, 64), glow(0xff8a2a, 3.5), -2.96, 2.25, 0.4, Math.PI / 2);

  // the light panel (emissive, radiance consistent with the original's composite) + its spot light
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff4e6, side: THREE.DoubleSide });
  panelMat.emissiveIntensity = Math.PI * LIGHT_POWER / (4 * LIGHT_HALF * LIGHT_HALF * LIGHT_ASPECT);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), panelMat);
  panel.position.copy(LIGHT_C);
  panel.lookAt(LIGHT_C.clone().add(LIGHT_N));
  panel.scale.set(LIGHT_HALF * LIGHT_ASPECT, LIGHT_HALF, 1);
  scene.add(panel);
  const spot = new THREE.SpotLight(0xffffff, LIGHT_POWER * Math.PI, 0, Math.PI / 2 * 0.98, 1, 2);
  spot.position.copy(LIGHT_C);
  spot.target.position.copy(LIGHT_C.clone().add(LIGHT_N));
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.0005;
  spot.shadow.normalBias = 0.02;
  scene.add(spot, spot.target);

  // the probe: the original's box, capture point and influence
  const PROBE_POS = new THREE.Vector3(-0.3, 1.1, -0.5);
  const box = new THREE.Box3(new THREE.Vector3(-3.0, -0.01, -2.1), new THREE.Vector3(8.0, 4.0, 4.6));
  const centre = box.getCenter(new THREE.Vector3());

  // the original's scenarios (reflections-hybrid.ts SCENARIOS) plus its first orbit shot as default
  const views: Record<string, { pos: Vec3; target: Vec3; fov?: number }> = {
    default: { pos: [-0.35 + 4.1 * Math.sin(0.2), 1.65, -0.8 + 4.1 * Math.cos(0.2)], target: [-0.35, 0.5, -0.8], fov: 42 },
    mirror: { pos: [0.3, 1.45, 2.3], target: [0.15, 1.5, -2.08], fov: 42 },
    offscreen: { pos: [-1.0, 1.0, 2.4], target: [-1.75, 0, 0.9], fov: 42 },
    moving: { pos: [-0.9, 1.35, 1.4], target: [0.6, 1.15, -1.9], fov: 42 },
    contact: { pos: [0.4, 0.5, -1.75], target: [-1.6, 0.3, -1.55], fov: 42 },
    rough: { pos: [-0.2, 1.3, 1.4], target: [-1.2, 0, -0.4], fov: 42 },
  };
  const camera = makeCamera(views.default, opts.aspect, 0.05, 30);
  const update = (t: number) => { knot.rotation.set(0.4, t * 0.35, 0); };
  update(0);
  return {
    id: 'explainer', title: 'Explainer room (denoiser reflections-hybrid)', scene, camera,
    target: new THREE.Vector3(...views.default.target), views,
    probes: [{
      position: toVec3(centre),
      originOffset: toVec3(PROBE_POS.clone().sub(centre)),
      projectionSize: toVec3(box.getSize(new THREE.Vector3()).addScalar(0.02)),
      influenceSize: [21.2, 5.2, 19.6],
      blendDistance: 0.05,
    }],
    update,
  };
}
