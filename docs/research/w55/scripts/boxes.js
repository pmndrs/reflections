// W55: the interior probe boxes carProbes.ts derives from carConcept's geometry (world space), and how long that takes.
const { SHOWCASE } = await import('/showcase/src/scenes.ts');
const { carInteriorProbes } = await import('/showcase/src/carProbes.ts');
const kit = await SHOWCASE.find((e) => e.id === 'carConcept').build(1);
kit.scene.updateMatrixWorld(true);
const t0 = performance.now();
const v = carInteriorProbes(kit, 'both', 128);
const ms = performance.now() - t0;
const r = (a) => a.map((x) => +x.toFixed(3));
return { ms: +ms.toFixed(1), volumes: v.map((p) => ({ name: p.name, min: r(p.position.map((c, i) => c - p.influenceSize[i] / 2)), max: r(p.position.map((c, i) => c + p.influenceSize[i] / 2)), size: r(p.influenceSize), capture: r(p.position.map((c, i) => c + p.originOffset[i])), blend: +p.blendDistance.toFixed(3) })) };
