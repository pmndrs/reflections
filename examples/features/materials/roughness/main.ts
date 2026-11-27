// Materials: which ones get reflections, and how roughness, metalness and clear coat shape them.
//
// What it shows: the roughness ramp, from 0 (left) to 1 (right): a row of gold metal spheres (back), a row of blue plastic ones
// (front) and chrome floor strips. Every reflection in this package (screen space, rays, probes) takes the place of three's own
// specular environment term, so it follows a physical material's roughness, metalness and clear coat:
//   - metal reflects in its own colour, plastic weakly (about 4 %, more at grazing angles) and in white;
//   - roughness widens the reflected lobe; above 0.447 the tracer stops and the prefiltered probe alone reflects;
//   - a clear coat (MeshPhysicalMaterial) adds a second, sharper reflection over a rough base.
// MeshBasicMaterial, MeshLambertMaterial and MeshPhongMaterial get none, by design (README "Which materials get reflections",
// docs/DIVERGES.md D2802): they have no physical specular term to replace. Phong's highlight is a light's, not a reflection.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflections, ReflectionProbe, ReflectionProbes, createReflectionsRenderer, installCubeArraySupport } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { roughnessRamp } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('materials/roughness');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const classicBox = document.querySelector<HTMLInputElement>('#classic')!;
const classicSelect = document.querySelector<HTMLSelectElement>('#classicKind')!;
const blueSelect = document.querySelector<HTMLSelectElement>('#blueRow')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

type Classic = 'phong' | 'lambert' | 'basic';

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const kit = roughnessRamp({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  await installCubeArraySupport(renderer);
  const probes = new ReflectionProbes();
  for (const v of kit.probes) {
    const p = new ReflectionProbe(...v.influenceSize);
    p.position.set(...v.position);
    if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
    probes.add(p);
  }
  scene.add(probes);
  probes.bake(renderer, scene);
  const reflections = await Reflections.create(renderer, scene, {
    probes,
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });

  // ---- the materials -----------------------------------------------------------------------------
  // The spheres of the ramp, each with its standard material (the scene's) and the alternatives, built once.
  const spheres: { mesh: THREE.Mesh; metal: boolean; roughness: number; standard: THREE.Material; coat: THREE.Material; classic: Record<Classic, THREE.Material> }[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !(mesh.geometry instanceof THREE.SphereGeometry)) return;
    const m = mesh.material as THREE.MeshStandardMaterial;
    const metal = m.metalness > 0.5, r = m.roughness, color = m.color;
    // Phong's shininess for the same lobe width (Blinn-Phong exponent ~ 2 / alpha^2 - 2, alpha = roughness^2)
    const shininess = THREE.MathUtils.clamp(2 / Math.max(r ** 4, 1e-4) - 2, 1, 1000);
    spheres.push({
      mesh, metal, roughness: r, standard: m,
      // a clear coat (its roughness the ramp's) over a rough blue base
      coat: new THREE.MeshPhysicalMaterial({ color, roughness: 0.7, metalness: 0, clearcoat: 1, clearcoatRoughness: r }),
      classic: {
        phong: new THREE.MeshPhongMaterial(metal ? { color: 0x111111, specular: color, shininess } : { color, specular: 0x222222, shininess }),
        lambert: new THREE.MeshLambertMaterial({ color }),
        basic: new THREE.MeshBasicMaterial({ color }),
      },
    });
  });

  let classic = false, classicKind: Classic = 'phong', blueRow: 'standard' | 'clearcoat' = 'standard', sinceSwitch = 0;
  const apply = () => {
    for (const s of spheres) s.mesh.material = classic ? s.classic[classicKind] : !s.metal && blueRow === 'clearcoat' ? s.coat : s.standard;
    classicBox.checked = classic; classicSelect.value = classicKind; blueSelect.value = blueRow;
    sinceSwitch = 0;
    status.textContent = classic
      ? `spheres: Mesh${classicKind[0].toUpperCase()}${classicKind.slice(1)}Material: no reflections (no physical specular term to replace); the floor strips keep theirs`
      : `spheres: ${blueRow === 'clearcoat' ? 'gold MeshStandardMaterial, blue MeshPhysicalMaterial (clear coat 1, coat roughness 0 to 1 over a base of 0.7)' : 'MeshStandardMaterial, gold metal and blue plastic'}; roughness 0 (left) to 1 (right)`;
  };
  classicBox.onchange = () => { classic = classicBox.checked; apply(); };
  classicSelect.onchange = () => { classicKind = classicSelect.value as Classic; classic = true; apply(); };
  blueSelect.onchange = () => { blueRow = blueSelect.value as typeof blueRow; classic = false; apply(); };
  apply();

  // a little higher than the scene's default, so both rows of spheres show
  const views: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = { ...kit.views, default: { pos: [0, 2.4, 5.6], target: [0, 0.25, -0.4] } };
  const setView = (name: string) => {
    const v = views[name] ?? views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    viewSelect.value = name;
  };
  viewSelect.onchange = () => setView(viewSelect.value);
  setView('default');

  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
    sinceSwitch++;
  };
  renderer.setAnimationLoop(frame);

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    /** Stops the loop and pins the tracer's noise (frame index 0), so shots repeat exactly (the check compares them); the next shot settles on it. */
    stop() { renderer.setAnimationLoop(null); reflections.ssr.settings.frameIndex = 0; sinceSwitch = 0; },
    /** Render n frames (at least 120 after a switch: the denoiser's history settles), then the PNG data URL of the canvas. */
    async shot(n = 1) { const k = Math.max(n, 120 - sinceSwitch); for (let i = 0; i < k; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true puts classic (Phong) materials on the spheres. */
    setCompare(on: boolean) { classic = on; apply(); },
    setMaterials(o: { classic?: boolean; classicKind?: Classic; blueRow?: 'standard' | 'clearcoat' }) {
      ({ classic = classic, classicKind = classicKind, blueRow = blueRow } = o); apply();
    },
    setView,
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
