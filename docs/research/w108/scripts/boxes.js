// W108 (D3701): carConcept's wheel boxes, world-axis-aligned (W55) vs oriented to each wheel (?carProbeOrient=oriented):
// per wheel, the share of the wheel group's vertices (tyre, rim, disc, caliper) inside its box (tested in the box's own
// frame) and the body-shell points inside (must be 0), plus the wheel's yaw against the world axes.
// node docs/research/w55/scripts/drive.mjs 'http://127.0.0.1:5430/showcase/bench.html?manual&scene=carConcept' out/w108 docs/research/w108/scripts/boxes.js
const { SHOWCASE } = await import('/showcase/src/scenes.ts');
const { carInteriorProbes } = await import('/showcase/src/carProbes.ts');
const THREE = P.THREE;
const kit = await SHOWCASE.find((e) => e.id === 'carConcept').build(1);
kit.scene.updateMatrixWorld(true);
const wheels = {}, shell = [];
kit.hero.traverse((o) => {
  if (/^Wheel(Front|Rear)(L|R)$/.test(o.name)) wheels[o.name] = o;
  if (o.isMesh && [].concat(o.material).some((m) => /^(Paint|Mirror|Glass)/.test(m.name) || (m.transmission ?? 0) > 0)) {
    const pos = o.geometry.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 2) shell.push(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).clone());
  }
});
const inside = (vol, p) => {
  const q = new THREE.Quaternion(...(vol.rotation ?? [0, 0, 0, 1])).invert();
  const l = p.clone().sub(new THREE.Vector3(...vol.position)).applyQuaternion(q);
  return Math.abs(l.x) < vol.influenceSize[0] / 2 && Math.abs(l.y) < vol.influenceSize[1] / 2 && Math.abs(l.z) < vol.influenceSize[2] / 2;
};
const out = {};
for (const orient of ['world', 'oriented']) {
  const t0 = performance.now();
  const vols = carInteriorProbes(kit, 'wheels', 64, orient);
  const ms = performance.now() - t0;
  out[orient] = { ms: +ms.toFixed(0), wheels: vols.map((vol) => {
    const w = wheels[vol.name], pts = [], v = new THREE.Vector3();
    w.traverse((m) => { if (!m.isMesh) return; const pos = m.geometry.attributes.position; for (let i = 0; i < pos.count; i++) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone()); });
    const e = new THREE.Euler().setFromQuaternion(w.getWorldQuaternion(new THREE.Quaternion()), 'YXZ');
    return { name: vol.name, yawDeg: +(e.y * 180 / Math.PI).toFixed(1), size: vol.influenceSize.map((x) => +x.toFixed(3)),
      wheelInside: +(pts.filter((p) => inside(vol, p)).length / pts.length).toFixed(3), shellInside: shell.filter((p) => inside(vol, p)).length };
  }) };
}
return out;
