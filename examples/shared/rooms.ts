// Ben Houston's two rooms (three.js #35046, webgpu_reflection_probes.html), in the version of the
// denoiser repo's examples/three-temporal/src/reflections-rooms.ts: a polished floor added, and the
// mirror ball on Ben's figure eight lowered to 1.2 m so its reflection lands next to it. The probe
// setup (one per room plus a doorway probe) and the scenario poses are that page's.
import * as THREE from 'three/webgpu';
import { type KitScene, type SceneOptions, type Vec3, floorProbe, makeCamera } from './kit';

export function rooms(opts: SceneOptions = {}): KitScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  const room = new THREE.Group();
  scene.add(room);
  const add = (mesh: THREE.Mesh, cast = true, receive = true) => { mesh.castShadow = cast; mesh.receiveShadow = receive; room.add(mesh); return mesh; };
  const std = (color: number, roughness = 1, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

  // shell: x = -8 to 8, z = -4 to 4, y = 0 to 5
  add(new THREE.Mesh(new THREE.BoxGeometry(16, 5, 8), new THREE.MeshStandardMaterial({ color: 0xcccccc, side: THREE.BackSide })), false).position.set(0, 2.5, 0);
  const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(16, 8), std(0x5c5650, 0.12)), false);
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.002;
  const redWall = add(new THREE.Mesh(new THREE.PlaneGeometry(8, 5), std(0xdd2200)), false, false);
  redWall.rotation.y = Math.PI / 2; redWall.position.set(-7.99, 2.5, 0);
  const blueWall = add(new THREE.Mesh(new THREE.PlaneGeometry(8, 5), std(0x0044ff)), false, false);
  blueWall.rotation.y = -Math.PI / 2; blueWall.position.set(7.99, 2.5, 0);

  // dividing wall with a doorway
  const dividerMat = std(0xcccccc);
  const gap = 1.25;
  add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 5, 4 - gap), dividerMat)).position.set(0, 2.5, -(gap + (4 - gap) / 2));
  add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 5, 4 - gap), dividerMat)).position.set(0, 2.5, gap + (4 - gap) / 2);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, gap * 2), dividerMat)).position.set(0, 4.4, 0);

  // left room
  const whiteMat = std(0xeeeeee);
  const columnGeom = new THREE.CylinderGeometry(0.3, 0.3, 4, 16);
  for (const x of [-6, -2, 2, 6]) for (const z of [-2.5, 2.5]) add(new THREE.Mesh(columnGeom, whiteMat)).position.set(x, 2, z);
  const tableMat = std(0x886644);
  add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 1.4), tableMat)).position.set(-4, 1.0, 0);
  const legGeom = new THREE.BoxGeometry(0.1, 1, 0.1);
  for (const x of [-5.05, -2.95]) for (const z of [-0.55, 0.55]) add(new THREE.Mesh(legGeom, tableMat), true, false).position.set(x, 0.5, z);
  add(new THREE.Mesh(new THREE.SphereGeometry(0.35, 32, 32), std(0xffd700, 0.4, 0.3))).position.set(-4, 1.41, 0);
  add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1), whiteMat)).position.set(-7, 0.25, 0);
  add(new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 1), whiteMat)).position.set(-7, 0.5, 0);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 1), whiteMat)).position.set(-7, 0.75, 0);

  // right room
  add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.8), whiteMat)).position.set(4, 0.6, 0);
  const knot = add(new THREE.Mesh(new THREE.TorusKnotGeometry(0.3, 0.1, 64, 16), std(0xff44aa, 0.5, 0.2)));
  knot.position.set(4, 1.65, 0);
  add(new THREE.Mesh(new THREE.ConeGeometry(0.4, 2.5, 5), whiteMat)).position.set(6.5, 1.25, -1.5);

  for (const [color, x] of [[0xffaa44, -4], [0x88bbff, 4]]) {
    const light = new THREE.PointLight(color, 30);
    light.position.set(x, 4.5, 0);
    light.castShadow = true;
    light.shadow.mapSize.setScalar(256);
    light.shadow.radius = 12;
    light.shadow.bias = -0.002;
    scene.add(light);
  }

  // the mirror ball (kept out of probe captures in the original)
  const ball = add(new THREE.Mesh(new THREE.SphereGeometry(4.5 * 0.12, 48, 32), std(0xffffff, 0, 1)));
  ball.name = 'mirrorBall';

  const views: Record<string, { pos: Vec3; target: Vec3 }> = {
    default: { pos: [0, 2.3, 8.5], target: [0, 2.05, 0] },
    ball: { pos: [-3.0, 1.6, 3.85], target: [-4.6, 0.3, 0.8] },
    table: { pos: [-1.3, 0.55, 2.3], target: [-4.2, 0.45, -0.2] },
    stale: { pos: [-2.9, 2.2, 3.7], target: [-4.8, 0.4, -1.5] },
    doorway: { pos: [6.6, 1.5, 1.9], target: [-4.0, 0.9, -0.4] },
    explore: { pos: [-6.2, 2.1, 3.1], target: [1.0, 1.0, -0.8] },
  };
  // the room's animation (Ben's updateRoom knot turn) and the ball's figure eight
  const update = (t: number) => {
    knot.rotation.y = t * 0.5;
    const phase = (t + 2.2) * 0.35;
    ball.position.set(5.6 * Math.sin(phase), 1.2, 1.4 * Math.sin(2 * phase));
  };
  update(0);
  return {
    id: 'rooms', title: 'Two rooms (the scene of three.js #35046)', scene, camera: makeCamera(views.default, opts.aspect, 0.05, 60),
    target: new THREE.Vector3(...views.default.target), views,
    probes: [
      floorProbe({ position: [-4, 2.5, 0], influenceSize: [8.4, 5.4, 8.4], projectionSize: [8, 5, 8] }),
      floorProbe({ position: [4, 2.5, 0], influenceSize: [8.4, 5.4, 8.4], projectionSize: [8, 5, 8] }),
      floorProbe({ position: [0, 1.9, 0], influenceSize: [2.4, 3.8, 2.5], projectionSize: [16, 3.8, 8] }),
    ],
    update,
  };
}
