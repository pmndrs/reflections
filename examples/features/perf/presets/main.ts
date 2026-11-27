// Presets: 'default' against 'performance' (half-resolution reflections), with the GPU ms of each pass.
//
// What it shows: the 'performance' preset traces, ray-traces and denoises at half size in each axis (a quarter of the pixels) and
// upsamples the result with a joint bilateral filter. The reflection passes cost about half; the price is softer reflections,
// jagged reflected edges on mirrors and lost thin bright lines (docs/SETTINGS.md "Presets"). Rough surfaces barely change.
//
// The frame is built from the pieces (`ScreenSpaceReflectionsPass`, `HybridReflections`, a `RenderPipeline`), as
// `Reflections.create` builds it, because the pass's per-pass GPU timestamps are an option of its constructor (`timestamps`).
// Switching a preset at run time: `applyReflectionsPreset({ ssr, hybrid }, name)`; when it changes the resolution the hybrid is
// rebuilt and the composite built again (`hybrid.rebuild()`, `hybrid.composite()`). `Reflections` users call `reflections.rebuild()`.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  HybridReflections, ReflectionProbe, ReflectionProbes, ScreenSpaceReflectionsPass, applyReflectionsPreset, createReflectionsRenderer,
  installCubeArraySupport, reflectionProbes, type ReflectionsPresetName,
} from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { rooms } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('perf/presets');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const timingsEl = document.querySelector<HTMLElement>('#timings')!;
const perfBox = document.querySelector<HTMLInputElement>('#performance')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  const kit = rooms({ aspect: innerWidth / innerHeight });
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
    if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
    if (v.originOffset) p.originOffset.set(...v.originOffset);
    probes.add(p);
  }
  scene.add(probes);
  probes.bake(renderer, scene);
  scene.environmentNode = reflectionProbes(probes) as never;

  // ---- the part to copy ------------------------------------------------------------------------
  let preset: ReflectionsPresetName = 'default';
  const ssr = new ScreenSpaceReflectionsPass(renderer, { preset, timestamps: true }); // timestamps: needs 'timestamp-query'
  const denoiser = new FfxReflectionDenoiser(ssr.device, { roughnessThreshold: 0.447 ** 2 }); // times its passes when it can
  const hybrid = new HybridReflections(ssr, { preset, denoiser, probes, environment: scene.environment, environmentIntensity: scene.environmentIntensity });
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = hybrid.composite().final;

  const setPreset = (name: ReflectionsPresetName) => {
    const { resolutionChanged } = applyReflectionsPreset({ ssr, hybrid }, name); // drops the history
    if (resolutionChanged) {
      hybrid.rebuild();                               // its passes for the new resolution
      pipeline.outputNode = hybrid.composite().final; // and the composite, which reads different textures at half size
      pipeline.needsUpdate = true;
    }
    preset = name;
  };
  // ----------------------------------------------------------------------------------------------

  let sinceSwitch = 0;
  const choose = (performance: boolean) => { setPreset(performance ? 'performance' : 'default'); perfBox.checked = performance; sinceSwitch = 0; ms.clear(); };
  perfBox.onchange = () => choose(perfBox.checked);

  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    viewSelect.value = name;
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  // GPU ms per pass, smoothed. The trace passes come from `ssr.readTimings()` (a promise, resolved a few frames later: never wait on
  // it in the loop), the denoiser's from its `gpuTimings`, the half-res upsample from `hybrid.readTimings()`.
  const timed = ssr.device.features.has('timestamp-query');
  const ms = new Map<string, number>();
  const add = (k: string, v: number) => ms.set(k, ms.has(k) ? ms.get(k)! * 0.9 + v * 0.1 : v);
  let reading = false;
  const readTimings = () => {
    if (!timed || reading) return;
    reading = true;
    Promise.all([ssr.readTimings(), hybrid.readTimings()]).then(([trace, up]) => {
      for (const [k, v] of trace) if (k !== 'total') add(k, v);
      for (const [k, v] of up) if (k !== 'total') add(k, v);
      for (const [k, v] of denoiser.gpuTimings ?? []) if (k !== 'total') add(`denoise ${k}`, v);
    }).catch(() => {}).finally(() => { reading = false; });
  };

  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed (the G-buffer follows)
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    ssr.render(scene, camera); // G-buffer + trace
    hybrid.update();           // resolve + denoise (+ upsample at half resolution)
    pipeline.render();         // composite
    sinceSwitch++;
    readTimings();
  };
  renderer.setAnimationLoop(frame);

  setInterval(() => {
    const W = ssr.gbuffer.width, H = ssr.gbuffer.height, half = (ssr.settings.reflectionResolution ?? 'full') === 'half';
    const head = `${preset}: reflections at ${half ? `${Math.ceil(W / 2)} x ${Math.ceil(H / 2)}` : `${W} x ${H}`} (frame ${W} x ${H})`;
    if (!timed) { timingsEl.textContent = `${head}\n(no timestamp-query on this device: no GPU times)`; return; }
    const lines = [...ms].map(([k, v]) => `${k.padEnd(24)}${v.toFixed(2).padStart(6)} ms`);
    const sum = [...ms.values()].reduce((s, v) => s + v, 0);
    timingsEl.textContent = [head, ...lines, `${'reflections total'.padEnd(24)}${sum.toFixed(2).padStart(6)} ms`, '(G-buffer and composite not timed)'].join('\n');
  }, 500);
  status.textContent = 'screen space + probes + denoiser on the two rooms; drag to orbit. Times are this GPU\'s, smoothed; compare them on one machine, not across machines';

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    ssr, hybrid,
    /** Stops the loop and pins the tracer's noise (frame index 0), so shots repeat exactly (the check compares them); the next shot settles on it. */
    stop() { renderer.setAnimationLoop(null); ssr.settings.frameIndex = 0; sinceSwitch = 0; },
    /** Render n frames (at least 120 after a switch: the denoiser's history settles), then the PNG data URL of the canvas. */
    async shot(n = 1) { const k = Math.max(n, 120 - sinceSwitch); for (let i = 0; i < k; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true = the performance preset. */
    setCompare(on: boolean) { choose(on); },
    setView,
    timings: () => Object.fromEntries(ms),
    /** The GPU ms of one more frame, read back (null without timestamp-query). Loop stopped. */
    async gpuMs() {
      if (!timed) return null;
      while (reading) await new Promise((r) => setTimeout(r, 5));
      frame();
      await new Promise((r) => setTimeout(r, 50));
      const [trace, up] = await Promise.all([ssr.readTimings(), hybrid.readTimings()]);
      return { ...Object.fromEntries(trace), ...Object.fromEntries([...up].filter(([k]) => k !== 'total')), ...Object.fromEntries([...(denoiser.gpuTimings ?? [])].map(([k, v]) => [`denoise ${k}`, v])) };
    },
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
