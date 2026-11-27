// The ray-traced fallback: where screen space has nothing (above the frame, behind the camera), rays against a BVH of the
// scene find the real surface; without them the probe fills in.
//
// What it shows: the wall mirror faces the camera, so it shows what is behind it (coloured bars, a glow sphere) and the backs
// of the cylinder and the box; the floor near the camera reflects a ring above the frame. Screen space cannot see any of it.
// With `rayTracing: true` the pixels it misses trace a ray through `@pmndrs/raytracer` (BVH built once at create), so those
// reflections are sharp and in the right place; off, they take the box-projected probe: softer, right only where the
// reflected thing sits on the probe's box, and without the objects the probe was baked without (`noProbe` in the kit).
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { float, renderOutput, uniform, vec3, vec4 } from 'three/tsl';
import { HYBRID_SOURCE, HybridReflections, ReflectionProbe, ReflectionProbes, Reflections, createReflectionsRenderer } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { offscreen } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('rt/fallback');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any; // TSL node typings are too strict for hand-written shader maths

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const rtBox = document.querySelector<HTMLInputElement>('#rayTracing')!;
const sourcesBox = document.querySelector<HTMLInputElement>('#sources')!;
const legend = document.querySelector<HTMLElement>('#legend')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // The scene: a mirror floor and a wall mirror; what they reflect is above the frame or behind the camera (examples/shared).
  const kit = offscreen({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  // The probes the scene suggests (a room, the floor, the wall mirror), baked once: the fallback when there is no ray.
  const probes = new ReflectionProbes();
  for (const v of kit.probes) {
    const p = new ReflectionProbe(...v.influenceSize);
    p.position.set(...v.position);
    if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
    if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
    if (v.originOffset) p.originOffset.set(...v.originOffset);
    if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
    if (v.resolution !== undefined) p.resolution = v.resolution;
    probes.add(p);
  }
  scene.add(probes);
  probes.bake(renderer, scene);

  // ---- the part to copy ------------------------------------------------------------------------
  const reflections = await Reflections.create(renderer, scene, {
    probes,
    rayTracing: true, // a BVH over every visible mesh (needs @pmndrs/raytracer and @pmndrs/bvh installed)
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });
  // The compare switch: `reflections.ssr.rayTracing` is read every frame; off, the misses take the probe.
  // ----------------------------------------------------------------------------------------------
  let settle = 0; // frames to let the denoiser's history settle after a switch (the check's shots)
  const setRayTracing = (on: boolean) => {
    reflections.ssr.rayTracing = on; rtBox.checked = on;
    reflections.hybrid.resetHistory(); reflections.ssr.resetHistory();
    settle = 60;
  };
  rtBox.onchange = () => setRayTracing(rtBox.checked);

  // The source map: the hybrid's per-pixel source (HybridReflections.sourceIndex) over a dimmed image.
  const uSources = uniform(0);
  const c = reflections.hybrid.composite();
  const image = renderOutput(c.final) as N;
  const s = HybridReflections.sourceIndex(c, reflections.hybrid.roughnessThreshold) as N;
  const tint = s.equal(HYBRID_SOURCE.ssr).select(vec3(0.15, 0.85, 0.25), s.equal(HYBRID_SOURCE.traced).select(vec3(0.2, 0.45, 1),
    s.equal(HYBRID_SOURCE.rough).select(vec3(1, 0.6, 0.05), vec3(1, 0.23, 0.16))));
  const map: N = c.geometry.select(image.rgb.mul(0.3).add(tint.mul(0.7)), image.rgb.mul(0.3));
  reflections.pipeline.outputColorTransform = false; // `image` is tone-mapped and encoded above
  reflections.pipeline.outputNode = vec4(uSources.equal(1).select(map, image.rgb) as N, float(1));
  reflections.pipeline.needsUpdate = true;
  sourcesBox.onchange = () => { uSources.value = sourcesBox.checked ? 1 : 0; legend.hidden = !sourcesBox.checked; };

  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    camera.fov = v.fov ?? 50;
    viewSelect.value = name;
    reflections.hybrid.resetHistory(); // a camera cut
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  const describe = () => {
    const rt = reflections.trace
      ? (reflections.ssr.traceError ? `ray tracing is off on this device: ${reflections.ssr.traceError}` : `ray-traced fallback ${reflections.ssr.rayTracing ? 'on' : 'off (misses take the probe)'}`)
      : 'ray tracing unavailable (@pmndrs/raytracer / @pmndrs/bvh could not be loaded)';
    status.textContent = `${rt}; screen space + ${probes.bakedProbes.length} probes + denoiser; drag to orbit`;
  };
  let frames = 0;
  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
    if (++frames % 30 === 1) describe(); // traceError is known after the first traced frame
  };
  renderer.setAnimationLoop(frame);

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    stop() { renderer.setAnimationLoop(null); },
    /** Render n frames (more right after a switch: the denoiser's history), then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n + settle; i++) frame(); settle = 0; return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows it (ray tracing off, misses take the probe). */
    setCompare(on: boolean) { setRayTracing(!on); },
    setView,
    setSources(on: boolean) { sourcesBox.checked = on; sourcesBox.onchange!(new Event('change')); },
    info: () => ({ rt: !!reflections.trace, rayTracing: reflections.ssr.rayTracing, traced: !!reflections.ssr.traced, traceError: reflections.ssr.traceError, probes: probes.bakedProbes.length }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
