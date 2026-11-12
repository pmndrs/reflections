// W56: where the chrome star's mirror rays go, by CPU ray casting (three-mesh-bvh over the scene's own
// meshes and normals), at W50's camera on the showcase main page (index.html?manual&scene=carConcept&w=1280&h=1280).
// For every px of the front wheel box (x 180-520, y 660-1000) whose camera ray first hits Rim2: the
// interpolated (smooth) vertex normal there, the mirror ray R, what R hits first (material name / 'sky'),
// and, when R hits the floor, what the floor's own mirror ray hits next (the floor is metal, r 0.03),
// plus whether the floor point sees the key light. Saves rays.png (class per px, colours below) and
// returns counts and mean directions. prelude (optional): FLAT = true (the face normal instead).
P.stop();
P.kit.camera.fov = 40; P.kit.camera.updateProjectionMatrix();
P.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
await P.step(2);
const T = P.THREE, scene = P.kit.scene, cam = P.kit.camera;
const flat = typeof FLAT !== 'undefined' && FLAT;
const bvh = await import(BVH_URL);
const meshes = [];
scene.updateMatrixWorld(true);
scene.traverse((o) => { if (o.isMesh && o.visible && o.geometry?.attributes?.position) meshes.push(o); });
const t0 = performance.now();
const items = meshes.map((m) => {
  if (!m.geometry.boundsTree) m.geometry.boundsTree = new bvh.MeshBVH(m.geometry);
  m.geometry.computeBoundingBox();
  const box = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
  return { m, box, inv: m.matrixWorld.clone().invert(), nrm: new T.Matrix3().getNormalMatrix(m.matrixWorld) };
});
const buildMs = performance.now() - t0;
const matName = (m, face) => { const mm = Array.isArray(m.material) ? m.material[face.materialIndex ?? 0] : m.material; return mm?.name || (m === floorMesh ? 'floor' : '(unnamed)'); };
const floorMesh = meshes.find((m) => m.geometry.type === 'CircleGeometry');
const lr = new T.Ray(), A = new T.Vector3(), B = new T.Vector3(), C = new T.Vector3(), bc = new T.Vector3();
function cast(o, d) {
  const ray = new T.Ray(o, d);
  let best = null;
  for (const it of items) {
    if (!ray.intersectsBox(it.box)) continue;
    lr.copy(ray).applyMatrix4(it.inv);
    const h = it.m.geometry.boundsTree.raycastFirst(lr, T.DoubleSide);
    if (!h) continue;
    const p = h.point.clone().applyMatrix4(it.m.matrixWorld);
    const dist = p.distanceTo(o);
    if (dist < 1e-4) continue;
    if (!best || dist < best.dist) best = { it, h, p, dist };
  }
  if (!best) return null;
  const { it, h } = best;
  const g = it.m.geometry, pos = g.attributes.position, nor = g.attributes.normal;
  let n;
  if (!flat && nor) {
    A.fromBufferAttribute(pos, h.face.a); B.fromBufferAttribute(pos, h.face.b); C.fromBufferAttribute(pos, h.face.c);
    T.Triangle.getBarycoord(h.point, A, B, C, bc);
    n = new T.Vector3().fromBufferAttribute(nor, h.face.a).multiplyScalar(bc.x)
      .add(new T.Vector3().fromBufferAttribute(nor, h.face.b).multiplyScalar(bc.y))
      .add(new T.Vector3().fromBufferAttribute(nor, h.face.c).multiplyScalar(bc.z));
  } else n = h.face.normal.clone();
  n.applyMatrix3(it.nrm).normalize();
  if (n.dot(d) > 0) n.negate();
  return { mesh: it.m, name: matName(it.m, h.face), p: best.p, n, dist: best.dist };
}
const key = scene.children.find((o) => o.isDirectionalLight);
const toKey = key.position.clone().sub(key.target.position).normalize();
const W = 1280, H = 1280;
const ndc = new T.Vector3();
const c = document.createElement('canvas'); c.width = W; c.height = H;
const g2 = c.getContext('2d'); g2.fillStyle = '#000'; g2.fillRect(0, 0, W, H);
const counts = {}, second = {}, third = {};
const COL = { floorUnderCar: '#ff0000', floorOpen: '#ffff00', wheel: '#00ff00', body: '#0000ff', sky: '#ffffff', other: '#ff00ff' };
const WHEEL = /^(Rim|Tire|Disc|Brake|Mechanical|Bolt|Lug)/i;
const reflect = (d, n) => d.clone().sub(n.clone().multiplyScalar(2 * d.dot(n)));
const dirs = { sum: new T.Vector3(), n: 0 };
const t1 = performance.now();
const STEP = typeof STEPPX !== 'undefined' ? STEPPX : 1;
for (let y = 660; y < 1000; y += STEP) for (let x = 180; x < 520; x += STEP) {
  ndc.set(((x + 0.5) / W) * 2 - 1, -(((y + 0.5) / H) * 2 - 1), 0.5).unproject(cam);
  const o = cam.position.clone();
  const d = ndc.sub(o).normalize();
  const h1 = cast(o, d);
  if (!h1 || h1.name !== 'Rim2') continue;
  const r1 = reflect(d, h1.n);
  dirs.sum.add(r1); dirs.n++;
  const h2 = cast(h1.p.clone().addScaledVector(h1.n, 1e-3), r1);
  let cls;
  const n2 = h2 ? h2.name : 'sky';
  second[n2] = (second[n2] ?? 0) + 1;
  if (!h2) cls = 'sky';
  else if (h2.mesh === floorMesh) {
    const r2 = reflect(r1, h2.n);
    const h3 = cast(h2.p.clone().addScaledVector(h2.n, 1e-3), r2);
    const n3 = h3 ? h3.name : 'sky';
    third[n3] = (third[n3] ?? 0) + 1;
    const lit = !cast(h2.p.clone().addScaledVector(h2.n, 1e-3), toKey);
    third[lit ? '(floor sees key)' : '(floor in shadow)'] = (third[lit ? '(floor sees key)' : '(floor in shadow)'] ?? 0) + 1;
    cls = h3 ? 'floorUnderCar' : 'floorOpen';
  } else if (WHEEL.test(n2)) cls = 'wheel';
  else cls = 'body';
  counts[cls] = (counts[cls] ?? 0) + 1;
  g2.fillStyle = COL[cls]; g2.fillRect(x, y, STEP, STEP);
}
save(flat ? 'rays-flat.png' : 'rays.png', c.toDataURL('image/png'));
const sortd = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
return { meshes: meshes.length, buildMs: Math.round(buildMs), castMs: Math.round(performance.now() - t1), starPx: dirs.n, meanR: dirs.sum.divideScalar(dirs.n).toArray().map((v) => +v.toFixed(3)), counts: sortd(counts), second: sortd(second), third: sortd(third) };
