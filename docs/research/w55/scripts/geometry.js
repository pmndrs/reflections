// W55: carConcept's meshes as the showcase builds them (stage(): scaled to 4.6 m, turned -1.0 rad, on the floor):
// name, ancestors, materials (transmission), world AABB. Run on any page with window.__p (the bench).
const { SHOWCASE } = await import('/showcase/src/scenes.ts');
const THREE = P.THREE;
const kit = await SHOWCASE.find((e) => e.id === 'carConcept').build(1);
kit.scene.updateMatrixWorld(true);
const out = [];
kit.scene.traverse((o) => {
  if (!o.isMesh) return;
  const b = new THREE.Box3().setFromObject(o, true);
  const anc = []; for (let p = o.parent; p && p !== kit.scene; p = p.parent) anc.push(p.name);
  const ms = [].concat(o.material);
  out.push({ name: o.name, anc: anc.slice(0, 4).join('<'), mat: ms.map((m) => m.name + (m.transmission > 0 ? '[T' + m.transmission + ']' : '') + `(m${m.metalness?.toFixed(2)} r${m.roughness?.toFixed(2)})`).join(','),
    min: b.min.toArray().map((v) => +v.toFixed(3)), max: b.max.toArray().map((v) => +v.toFixed(3)), tris: (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 });
});
const all = new THREE.Box3().setFromObject(kit.hero, true);
return { meshes: out, car: [all.min.toArray(), all.max.toArray()], probes: kit.probes, hero: { rot: kit.hero.rotation.toArray(), pos: kit.hero.position.toArray(), scale: kit.hero.scale.toArray() } };
