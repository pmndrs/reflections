// W54: material masks at W50's camera on the showcase main page (index.html?manual&scene=carConcept&w=1280&h=1280).
// Every mesh gets an unlit colour by material group (black otherwise), rendered straight to the canvas:
//   masks-a.png: R = Disc / Brake / Mechanical (wheel interior), G = Rim2 (the chrome hub), B = Glass
//   masks-b.png (glass hidden): R = the cabin's interior materials seen through the glass, G = Rim1, B = tyres
P.stop();
P.kit.camera.fov = 40; P.kit.camera.updateProjectionMatrix();
P.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
await P.step(2);
const T = P.THREE, scene = P.kit.scene, cam = P.kit.camera, r = P.renderer;
const keep = new Map(); const vis = new Map();
scene.traverse((o) => { if (o.isMesh) { keep.set(o, o.material); vis.set(o, o.visible); } });
const bg = [scene.background, scene.environmentNode, scene.backgroundNode];
const basic = (c) => { const m = new T.MeshBasicNodeMaterial({ color: c, side: T.DoubleSide }); m.toneMapped = false; return m; };
const black = basic(0x000000);
const INTERIOR = /^(Interior|Floormat|Dashboard|Panel Sides|Hardware)/;
const pass = async (pick, name, hideGlass) => {
  const cache = new Map();
  for (const [o, m0] of keep) {
    const ms = [].concat(m0);
    const out = ms.map((m) => { const c = pick(m.name ?? ''); if (c === null) return black; if (!cache.has(c)) cache.set(c, basic(c)); return cache.get(c); });
    o.material = Array.isArray(m0) ? out : out[0];
    if (hideGlass && ms.some((m) => m.name === 'Glass')) o.visible = false;
  }
  scene.background = new T.Color(0); scene.backgroundNode = null; scene.environmentNode = null;
  r.setRenderTarget(null);
  const tm = r.toneMapping; r.toneMapping = T.NoToneMapping;
  r.render(scene, cam);
  save(name, r.domElement.toDataURL('image/png'));
  r.toneMapping = tm;
  for (const [o, m0] of keep) { o.material = m0; o.visible = vis.get(o); }
  [scene.background, scene.environmentNode, scene.backgroundNode] = bg;
};
await pass((n) => (/^(Disc|Brake|Mechanical)$/.test(n) ? 0xff0000 : n === 'Rim2' ? 0x00ff00 : n === 'Glass' ? 0x0000ff : null), 'masks-a.png', false);
await pass((n) => (INTERIOR.test(n) || n === '' ? 0xff0000 : n === 'Rim1' ? 0x00ff00 : /^Tire/.test(n) ? 0x0000ff : null), 'masks-b.png', true);
return { errors: P.gpuErrors.slice(0, 3) };
