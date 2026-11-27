// Ray tracing moving meshes: `reflections.trace.refit()` each frame keeps the BVH where the meshes are.
//
// What it shows: a gold knot slides and turns and a pink ball bounces over a mirror floor. Screen space reflects what the
// camera sees of them; the rest of their reflection (the undersides, the parts hidden behind other things or off screen)
// comes from rays against the BVH, which `Reflections.create` builds once from the meshes as they are. `refit()` copies
// every traced mesh's current world matrix into it (rigid motion: position, rotation, scale, instances). It does not see
// changed geometry (skinning, morph targets, edited vertices): those need a new build. Without refit the rays hit the
// meshes where they stood at load, so those reflections lag behind or show ghosts.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { float, renderOutput, uniform, vec3, vec4 } from 'three/tsl';
import { HYBRID_SOURCE, HybridReflections, ReflectionProbe, ReflectionProbes, Reflections, createReflectionsRenderer } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { moving } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('rt/animated');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any; // TSL node typings are too strict for hand-written shader maths

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const refitBox = document.querySelector<HTMLInputElement>('#refit')!;
const animateBox = document.querySelector<HTMLInputElement>('#animate')!;
const sourcesBox = document.querySelector<HTMLInputElement>('#sources')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // The scene: a mirror floor before a patterned wall, a sliding knot and a bouncing ball (examples/shared). The two moving
  // meshes are kept out of the probe (`noProbe`): a baked probe would hold their first pose forever.
  const kit = moving({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  const probes = new ReflectionProbes();
  for (const v of kit.probes) {
    const p = new ReflectionProbe(...v.influenceSize);
    p.position.set(...v.position);
    if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
    if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
    if (v.originOffset) p.originOffset.set(...v.originOffset);
    probes.add(p);
  }
  scene.add(probes);
  probes.bake(renderer, scene);

  // ---- the part to copy ------------------------------------------------------------------------
  const reflections = await Reflections.create(renderer, scene, {
    probes,
    rayTracing: true, // the BVH is built here, from the meshes' current pose
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });
  let refit = true;
  let time = 0;
  const step = () => {
    kit.update!(time);              // move the meshes
    scene.updateMatrixWorld();      // refit reads matrixWorld
    if (refit) reflections.trace?.refit(); // then the BVH follows them
  };
  // ----------------------------------------------------------------------------------------------

  // The compare switch. Refit off: the BVH keeps the pose it was built with (t = 0), as in an app that never calls refit().
  let settle = 0; // frames to let the denoiser's history settle after a switch (the check's shots)
  const setRefit = (on: boolean) => {
    refit = on; refitBox.checked = on;
    if (!on) { kit.update!(0); scene.updateMatrixWorld(); reflections.trace?.refit(); }
    step();
    reflections.hybrid.resetHistory(); reflections.ssr.resetHistory();
    settle = 60;
  };
  refitBox.onchange = () => setRefit(refitBox.checked);

  // Traced pixels in blue over a dimmed image (HybridReflections.sourceIndex): where a stale BVH shows.
  const uSources = uniform(0);
  const c = reflections.hybrid.composite();
  const image = renderOutput(c.final) as N;
  const traced = (HybridReflections.sourceIndex(c, reflections.hybrid.roughnessThreshold) as N).equal(HYBRID_SOURCE.traced);
  const map: N = traced.select(image.rgb.mul(0.3).add(vec3(0.2, 0.45, 1).mul(0.7)), image.rgb.mul(0.4));
  reflections.pipeline.outputColorTransform = false; // `image` is tone-mapped and encoded above
  reflections.pipeline.outputNode = vec4(uSources.equal(1).select(map, image.rgb) as N, float(1));
  reflections.pipeline.needsUpdate = true;
  sourcesBox.onchange = () => { uSources.value = sourcesBox.checked ? 1 : 0; };

  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    camera.fov = v.fov ?? 50;
    viewSelect.value = name;
    reflections.hybrid.resetHistory(); // a camera cut
  };
  viewSelect.onchange = () => setView(viewSelect.value);
  setView('default');

  const clock = new THREE.Timer();
  const frame = () => {
    clock.update();
    if (animateBox.checked) time += Math.min(clock.getDelta(), 0.05);
    step();
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
  };
  renderer.setAnimationLoop(frame);
  const traceNote = () => reflections.trace ? (reflections.ssr.traceError ? `ray tracing is off on this device: ${reflections.ssr.traceError}` : 'ray tracing on') : 'ray tracing unavailable (@pmndrs/raytracer / @pmndrs/bvh could not be loaded)';
  setTimeout(() => { status.textContent = `${traceNote()}; refit() each frame for the knot and the ball; drag to orbit`; }, 1000); // traceError: after the first traced frame

  // headless driver (scripts/run-headless.mjs, section `catalog`). stop() freezes the animation: shots are at a fixed time.
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    // the loop stops, the tracer's noise is pinned (frameIndex 0) and the denoiser's history (built on motion) settles on the frozen pose
    stop() { renderer.setAnimationLoop(null); reflections.ssr.settings.frameIndex = 0; settle = 60; },
    /** Render n frames (at least 30) at the current time, then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < Math.max(n, 30) + settle; i++) { step(); reflections.render(camera); } settle = 0; return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows it (refit off: the BVH as built). */
    setCompare(on: boolean) { setRefit(!on); },
    setTime(t: number) { time = t; step(); },
    setView,
    setSources(on: boolean) { sourcesBox.checked = on; uSources.value = on ? 1 : 0; },
    info: () => ({ time, refit, rt: !!reflections.trace, traced: !!reflections.ssr.traced, traceError: reflections.ssr.traceError }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
