// Procedural reflection test scenes. Each one isolates a case a reflection source wins or loses:
//
//   mirrorWall     mirror floor facing a lit, patterned wall: screen space sees everything it reflects
//   offscreen      what the floor reflects is above the frame (and a wall mirror shows what's behind
//                  the camera): screen space can't see it, rays and probes have to
//   contact        objects resting on a mirror floor: the reflection must start where they touch
//   roughnessRamp  spheres and floor strips from roughness 0 to 1, metal and dielectric rows
//   boxRoom        a closed room with windows: box-projected probe parallax
//   moving         mirrorWall with animated objects: camera and object motion vectors
import * as THREE from 'three/webgpu';
import {
  type KitScene, type SceneOptions, type Vec3, add, floor, glow, gradientEnvironment, makeCamera, mirror, newScene,
  patternTexture, std, studioLights,
} from './kit';

/** Mirror floor facing a lit, patterned wall. */
export function mirrorWall(opts: SceneOptions = {}): KitScene {
  const scene = newScene();
  scene.environment = gradientEnvironment();
  scene.environmentIntensity = 0.3;
  floor(scene, mirror(0), 16);
  const wall = add(scene, new THREE.Mesh(new THREE.PlaneGeometry(10, 4), std(0xffffff, 0.75, 0, { map: patternTexture() })), [0, 2, -3]);
  wall.castShadow = false;
  // coloured posts at the wall's ends and a few objects in between, for depth
  const post = new THREE.BoxGeometry(0.4, 3, 0.4);
  add(scene, new THREE.Mesh(post, std(0xd1495b, 0.5)), [-4.2, 1.5, -2.4]);
  add(scene, new THREE.Mesh(post, std(0x00798c, 0.5)), [4.2, 1.5, -2.4]);
  add(scene, new THREE.Mesh(new THREE.SphereGeometry(0.45, 48, 24), std(0xedae49, 0.35)), [-1.6, 0.45, -1.2]);
  add(scene, new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), std(0x66a182, 0.6)), [1.5, 0.4, -1.5], 0.5);
  // an emissive strip along the wall's top: a bright, sharp feature to reflect
  add(scene, new THREE.Mesh(new THREE.BoxGeometry(9, 0.08, 0.05), glow(0xfff0d8, 4)), [0, 3.85, -2.95]);
  studioLights(scene, [3, 6, 6], 2.2);
  const views = { default: { pos: [0, 1.5, 5.5] as Vec3, target: [0, 1.0, -3] as Vec3 } };
  return {
    id: 'mirrorWall', title: 'Mirror floor facing a patterned wall', scene, camera: makeCamera(views.default, opts.aspect),
    target: new THREE.Vector3(...views.default.target), views,
    probes: [{ position: [0, 2, 0], influenceSize: [16, 4.2, 16], projectionSize: [16, 4.2, 12] }],
  };
}

/**
 * The floor reflects things above the top of the frame, and a mirror on the far wall reflects
 * things behind the camera. Note a flat floor can only show what is in front of the camera (the
 * reflected ray keeps the view ray's horizontal direction), so "off screen" for the floor is above
 * the frame, as in the explainer's scenario; behind-the-camera is the wall mirror's case.
 */
export function offscreen(opts: SceneOptions = {}): KitScene {
  const scene = newScene();
  scene.environment = gradientEnvironment();
  scene.environmentIntensity = 0.25;
  floor(scene, mirror(0.02), 24);
  // dark back wall with a mirror panel facing the camera
  add(scene, new THREE.Mesh(new THREE.PlaneGeometry(14, 5), std(0x3b3f46, 0.9)), [0, 2.5, -4]);
  add(scene, new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.8, 0.04), std(0x1d1d1f, 0.4, 0.8)), [0, 1.2, -3.98]);
  add(scene, new THREE.Mesh(new THREE.PlaneGeometry(3, 1.6), mirror(0)), [0, 1.2, -3.95]);
  // on screen: a few matte objects
  add(scene, new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.7, 40), std(0x8899aa, 0.6)), [-1.8, 0.35, -1.2]);
  add(scene, new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), std(0xb5562f, 0.7)), [1.8, 0.25, -0.6], 0.4);
  // above the frame: a glowing ring and a lamp bar (the floor shows them, the screen doesn't)
  const ring = add(scene, new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.07, 16, 80), glow(0xff8a2a, 5)), [0, 3.4, -2.5]);
  ring.rotation.x = Math.PI / 2;
  add(scene, new THREE.Mesh(new THREE.BoxGeometry(3, 0.1, 0.1), glow(0x7fe7ff, 5)), [-2.2, 3.1, 0.2]);
  // behind the camera: three bright bars on a blue wall (only the wall mirror shows them)
  add(scene, new THREE.Mesh(new THREE.PlaneGeometry(14, 5), std(0x5a7690, 0.85)), [0, 2.5, 8], Math.PI);
  [[0xff3b5c, -1.2], [0x2ee6d6, 0], [0xffc93c, 1.2]].forEach(([c, x]) =>
    add(scene, new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.4, 0.05), glow(c, 4)), [x, 1.3, 7.9]));
  add(scene, new THREE.Mesh(new THREE.SphereGeometry(0.35, 32, 16), glow(0xfff0d0, 3)), [1.8, 1.4, 6.5]);
  studioLights(scene, [-3, 7, 3], 1.6);
  const views = {
    default: { pos: [0, 1.6, 4] as Vec3, target: [0, 0.25, -0.5] as Vec3 },
    mirror: { pos: [0.2, 1.2, 2.5] as Vec3, target: [0, 1.2, -4] as Vec3 },
  };
  return {
    id: 'offscreen', title: 'Off screen: above the frame and behind the camera', scene, camera: makeCamera(views.default, opts.aspect),
    target: new THREE.Vector3(...views.default.target), views,
    probes: [{ position: [0, 2.5, 2], influenceSize: [14, 5, 12], projectionSize: [14, 5, 12] }],
  };
}

/** Objects resting on a mirror floor: reflections must start exactly at the contact. */
export function contact(opts: SceneOptions = {}): KitScene {
  const scene = newScene();
  scene.environment = gradientEnvironment();
  scene.environmentIntensity = 0.3;
  floor(scene, mirror(0.02, 0xd8d8d8), 20);
  add(scene, new THREE.Mesh(new THREE.PlaneGeometry(14, 5), std(0xffffff, 0.8, 0, { map: patternTexture({ cells: [14, 5], size: [1400, 500] }) })), [0, 2.5, -5]);
  add(scene, new THREE.Mesh(new THREE.SphereGeometry(0.5, 64, 32), std(0xe63946, 0.4)), [-2.2, 0.5, 0]);
  add(scene, new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), std(0xf1faee, 0.6)), [-0.8, 0.45, -0.6], 0.6);
  add(scene, new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.4, 48), std(0x457b9d, 0.3)), [0.5, 0.7, 0.2]);
  const torus = add(scene, new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.15, 24, 64), std(0xf4a261, 0.35, 1)), [1.8, 0.15, -0.4]);
  torus.rotation.x = Math.PI / 2;
  add(scene, new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.0, 6), std(0x2a9d8f, 0.5)), [3.0, 0.5, 0.4]);
  // a thin plate leaning on the box: a contact along an edge
  const plate = add(scene, new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.8, 0.6), std(0x8d5fd3, 0.4)), [-1.4, 0.38, 0.1]);
  plate.rotation.z = 0.25;
  studioLights(scene, [3, 6, 4], 2.4);
  const views = {
    default: { pos: [0, 0.75, 4.2] as Vec3, target: [0, 0.35, 0] as Vec3 },
    low: { pos: [0.4, 0.2, 3.0] as Vec3, target: [-0.6, 0.3, 0] as Vec3 },
  };
  return {
    id: 'contact', title: 'Contact: objects resting on a mirror floor', scene, camera: makeCamera(views.default, opts.aspect),
    target: new THREE.Vector3(...views.default.target), views,
    probes: [{ position: [0, 2.5, 0], influenceSize: [20, 5, 20], projectionSize: [20, 5, 10] }],
  };
}

/** Spheres and floor strips from roughness 0 to 1; a metal row and a dielectric row. */
export function roughnessRamp(opts: SceneOptions = {}): KitScene {
  const scene = newScene();
  scene.environment = gradientEnvironment(new THREE.Vector3(0.3, 0.6, 0.7));
  scene.environmentIntensity = 0.5;
  floor(scene, std(0x1b1b1d, 0.9), 24);
  const n = 11, dx = 0.75, x0 = -((n - 1) / 2) * dx;
  const sphere = new THREE.SphereGeometry(0.3, 64, 32);
  for (let i = 0; i < n; i++) {
    const r = i / (n - 1);
    add(scene, new THREE.Mesh(sphere, std(0xffc36b, r, 1)), [x0 + i * dx, 0.3, -0.9]);  // metal (gold)
    add(scene, new THREE.Mesh(sphere, std(0x2f6fd0, r, 0)), [x0 + i * dx, 0.3, 0.1]);   // dielectric (blue plastic)
    // floor strips in front: chrome-like, same ramp (sit 1 mm up so they don't fight the floor)
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(dx * 0.92, 2.2), std(0xdddddd, r, 1));
    strip.rotation.x = -Math.PI / 2;
    add(scene, strip, [x0 + i * dx, 0.001, 1.8]);
  }
  // what the ramp reflects: a patterned wall behind, and bright bars above
  add(scene, new THREE.Mesh(new THREE.PlaneGeometry(12, 4), std(0xffffff, 0.8, 0, { map: patternTexture({ cells: [12, 4], size: [1200, 400] }) })), [0, 2, -2.6]);
  for (const [c, x] of [[0xffffff, -2.5], [0xffb070, 0], [0x90c8ff, 2.5]] as [number, number][]) {
    const bar = add(scene, new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.3), glow(c, 6)), [x, 3.2, 0.5]);
    bar.castShadow = false;
  }
  studioLights(scene, [2, 6, 6], 1.8);
  const views = {
    default: { pos: [0, 1.5, 6.2] as Vec3, target: [0, 0.3, 0] as Vec3 },
    strips: { pos: [0, 1.0, 4.2] as Vec3, target: [0, 0.2, 1.4] as Vec3 },
  };
  return {
    id: 'roughnessRamp', title: 'Roughness ramp 0 to 1 (metal and dielectric)', scene, camera: makeCamera(views.default, opts.aspect),
    target: new THREE.Vector3(...views.default.target), views,
    probes: [{ position: [0, 2, 0], influenceSize: [24, 4.2, 24], projectionSize: [12, 4.2, 10] }],
  };
}

/**
 * A closed room (8 x 3 x 6 m) with three windows and a sun shining in. The walls are coloured
 * differently, so a box-projected probe's parallax error shows as the wrong colour in the wrong place.
 */
export function boxRoom(opts: SceneOptions = {}): KitScene {
  const scene = newScene();
  const sky = new THREE.Color().setRGB(0.55, 0.72, 1.0).multiplyScalar(2.2);
  scene.background = sky;
  scene.environment = gradientEnvironment();
  scene.environmentIntensity = 0.15;
  const W = 8, H = 3, D = 6, T = 0.2; // inner size, wall thickness
  const room = new THREE.Group();
  scene.add(room);
  const box = (sx: number, sy: number, sz: number, mat: THREE.Material, p: Vec3) => add(room, new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat), p);
  const wallX = std(0xf0e6d8, 0.85), wallZ = std(0x9fc5a8, 0.85), ceiling = std(0xf4f4f4, 0.9);
  // floor (glossy wood) and ceiling
  box(W + 2 * T, T, D + 2 * T, std(0x6b4f3a, 0.12), [0, -T / 2, 0]);
  box(W + 2 * T, T, D + 2 * T, ceiling, [0, H + T / 2, 0]);
  // -x wall (solid), +z wall (solid, behind the default camera)
  box(T, H, D, wallX, [-W / 2 - T / 2, H / 2, 0]);
  box(W + 2 * T, H, T, std(0xd8a7a0, 0.85), [0, H / 2, D / 2 + T / 2]);
  // +x wall with two windows (1.2 wide, 1.4 high, sill at 0.8): built from pieces
  const sill = 0.8, wh = 1.4, ww = 1.2, wz = [-1.3, 1.3];
  box(T, sill, D, wallX, [W / 2 + T / 2, sill / 2, 0]);
  box(T, H - sill - wh, D, wallX, [W / 2 + T / 2, sill + wh + (H - sill - wh) / 2, 0]);
  const zEdges = [-D / 2, wz[0] - ww / 2, wz[0] + ww / 2, wz[1] - ww / 2, wz[1] + ww / 2, D / 2];
  for (let i = 0; i < zEdges.length; i += 2) {
    const z0 = zEdges[i], z1 = zEdges[i + 1];
    box(T, wh, z1 - z0, wallX, [W / 2 + T / 2, sill + wh / 2, (z0 + z1) / 2]);
  }
  // -z wall (accent green) with one wide window
  const bw = 2.4;
  box(W, sill, T, wallZ, [0, sill / 2, -D / 2 - T / 2]);
  box(W, H - sill - wh, T, wallZ, [0, sill + wh + (H - sill - wh) / 2, -D / 2 - T / 2]);
  box((W - bw) / 2, wh, T, wallZ, [-(bw / 2 + (W - bw) / 4), sill + wh / 2, -D / 2 - T / 2]);
  box((W - bw) / 2, wh, T, wallZ, [bw / 2 + (W - bw) / 4, sill + wh / 2, -D / 2 - T / 2]);
  // furniture: a sofa block, a pillar, a sphere, a low table
  box(2.2, 0.45, 0.9, std(0x3d5a80, 0.8), [-2.6, 0.225, -1.8]);
  box(2.2, 0.5, 0.2, std(0x3d5a80, 0.8), [-2.6, 0.65, -2.2]);
  add(room, new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, H, 32), std(0xffffff, 0.6)), [1.2, H / 2, -0.6]);
  add(room, new THREE.Mesh(new THREE.SphereGeometry(0.35, 48, 24), std(0xe0e0e0, 0.05, 1)), [-0.6, 0.35, 0.8]);
  box(1.2, 0.06, 0.7, std(0x222222, 0.2), [2.2, 0.45, 1.2]);
  // outside: a ground plane and the sun through the windows
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), std(0x8a9a6a, 0.95));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -T - 0.01;
  scene.add(ground);
  const sun = new THREE.DirectionalLight(0xfff1dc, 5);
  sun.position.set(14, 7, -6);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 40 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const lamp = new THREE.PointLight(0xffd8a8, 3, 0, 2);
  lamp.position.set(0, H - 0.3, 0.5);
  scene.add(lamp);
  scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x3a2e24, 0.25));
  const views = {
    default: { pos: [-3.2, 1.6, 2.5] as Vec3, target: [1.2, 0.9, -1.2] as Vec3, fov: 60 },
    floor: { pos: [-1.0, 1.1, 2.6] as Vec3, target: [1.6, 0, -0.6] as Vec3, fov: 60 },
  };
  return {
    id: 'boxRoom', title: 'Box room with windows (probe parallax)', scene, camera: makeCamera(views.default, opts.aspect),
    target: new THREE.Vector3(...views.default.target), views,
    probes: [{ position: [0, H / 2, 0], influenceSize: [W + 0.1, H + 0.1, D + 0.1], projectionSize: [W, H, D], originOffset: [0, 0.1, 0] }],
  };
}

/**
 * Two wall mirrors facing each other across a small stage. Each reflects the other, so with hit
 * colour from the current frame's scene colour (no specular) the mirror seen in the mirror is
 * black; with last frame's lit colour (D69) it shows a reflection, one bounce deeper per frame.
 */
export function facingMirrors(opts: SceneOptions = {}): KitScene {
  const scene = newScene();
  scene.environment = gradientEnvironment();
  scene.environmentIntensity = 0.3;
  floor(scene, std(0x6b6660, 0.85), 16);
  add(scene, new THREE.Mesh(new THREE.PlaneGeometry(8, 4), std(0xffffff, 0.8, 0, { map: patternTexture({ cells: [8, 4], size: [800, 400] }) })), [0, 2, -4]);
  for (const side of [-1, 1]) {
    // dark frame behind, mirror in front, both facing the other side
    add(scene, new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.6, 7.7), std(0x222226, 0.5)), [side * 1.83, 1.45, -0.25]);
    add(scene, new THREE.Mesh(new THREE.PlaneGeometry(7.5, 2.4), mirror(0)), [side * 1.79, 1.45, -0.25], -side * Math.PI / 2);
  }
  add(scene, new THREE.Mesh(new THREE.SphereGeometry(0.4, 48, 24), std(0xe63946, 0.35)), [-0.7, 0.4, -1.6]);
  add(scene, new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), std(0x2a9d8f, 0.6)), [0.8, 0.35, -2.2], 0.4);
  add(scene, new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.2, 40), std(0xf4a261, 0.4)), [0.2, 0.6, -0.4]);
  add(scene, new THREE.Mesh(new THREE.BoxGeometry(3, 0.08, 0.08), glow(0x9fd8ff, 5)), [0, 2.9, -2.5]).castShadow = false;
  studioLights(scene, [1, 6, 5], 2.0);
  const views = {
    // down the corridor: each mirror, seen at a grazing angle, reflects the other's far end, on screen
    default: { pos: [0.3, 1.5, 6.5] as Vec3, target: [0, 1.3, -2] as Vec3 },
    left: { pos: [0.6, 1.5, 3.6] as Vec3, target: [-1.6, 1.2, -1.6] as Vec3 },
  };
  return {
    id: 'facingMirrors', title: 'Two facing mirrors (mirror seen in a mirror)', scene, camera: makeCamera(views.default, opts.aspect),
    target: new THREE.Vector3(...views.default.target), views,
    probes: [{ position: [0, 1.6, 0], influenceSize: [3.6, 3.2, 8], projectionSize: [3.6, 4, 8] }],
  };
}

/** mirrorWall with a sliding, turning knot and a bouncing ball (object motion), for motion vectors. */
export function moving(opts: SceneOptions = {}): KitScene {
  const base = mirrorWall(opts);
  const knot = add(base.scene, new THREE.Mesh(new THREE.TorusKnotGeometry(0.4, 0.13, 160, 24), std(0xc9a46a, 0.25, 1)), [0, 1.2, 0]);
  const ball = add(base.scene, new THREE.Mesh(new THREE.SphereGeometry(0.3, 48, 24), std(0xff4fa0, 0.3)), [2, 0.3, 0.6]);
  const update = (t: number) => {
    knot.position.set(2.2 * Math.sin(t * 0.8), 1.2, 0.4 * Math.cos(t * 0.8));
    knot.rotation.set(0.4, t * 1.2, 0);
    ball.position.set(-2 + 0.5 * Math.sin(t * 0.5), 0.3 + Math.abs(Math.sin(t * 2.4)) * 1.1, 0.8);
  };
  update(0);
  return { ...base, id: 'moving', title: 'Moving objects (motion vectors)', update };
}
