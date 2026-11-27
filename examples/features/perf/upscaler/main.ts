// Upscaling after the composite: render the scene and its reflections below the display size, then let a temporal upscaler
// (@pmndrs/upscaler) rebuild the display size and anti-alias it.
//
// What it shows: every reflection pass (G-buffer, trace, denoiser) scales with the pixel count, so rendering at 1 / 1.5 of the display
// size per axis costs about 44 % of the pixels. The upscaler jitters the camera by a sub-pixel each frame and accumulates the jittered
// frames, which also smooths the edges and the denoised reflections' last shimmer. At 1x it is temporal anti-aliasing alone.
//
// The wiring, per frame (examples/shared/antialias.ts `DisplayAA` holds the upscaler's side: its jitter, the motion conversion, the
// present pass):
//   const j = aa.begin(camera);          // the upscaler's jitter, as `{ jitter, projection }`
//   ssr.render(scene, camera, j);        // the G-buffer rasterises jittered; motion, the tracer and the denoiser stay unjittered
//   aa.end(camera);
//   hybrid.update();
//   renderer.setRenderTarget(aa.target); pipeline.render(); renderer.setRenderTarget(null);   // the composite, linear, render size
//   aa.resolve(camera);                  // upscale, tone-map, present
// The G-buffer is sized to the render size (`gbufferOptions`), which is why this page builds the pieces instead of `Reflections.create`.
import * as THREE from 'three/webgpu';
import { renderOutput, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  HybridReflections, ReflectionProbe, ReflectionProbes, ScreenSpaceReflectionsPass, createReflectionsRenderer, installCubeArraySupport, reflectionProbes,
} from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { DisplayAA, UPSCALER_DEFAULTS, type AAMode } from '../../../shared/antialias';
import { rooms } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('perf/upscaler');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const infoEl = document.querySelector<HTMLElement>('#info')!;
const offBox = document.querySelector<HTMLInputElement>('#off')!;
const ratioSelect = document.querySelector<HTMLSelectElement>('#ratio')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  const display = () => renderer.getDrawingBufferSize(new THREE.Vector2());

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
  const ssr = new ScreenSpaceReflectionsPass(renderer, { gbufferOptions: { width: 1, height: 1 } }); // sized below, to the render size
  const denoiser = new FfxReflectionDenoiser(ssr.device, { roughnessThreshold: 0.447 ** 2 });
  const hybrid = new HybridReflections(ssr, { denoiser, probes, environment: scene.environment, environmentIntensity: scene.environmentIntensity });
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false; // the upscaler wants linear colour; DisplayAA tone-maps after it
  const tone = (c: N) => (renderOutput(c, THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace) as N).rgb;
  const final = (hybrid.composite().final as N).rgb;

  let aa: DisplayAA | null = null, mode: AAMode = 'upscaler', ratio = 1.5, sinceSwitch = 0, aaFrames = 0;
  /** (Re)build the upscaler for `mode` and `ratio`: the G-buffer goes to the render size, the history starts over. */
  const configure = async () => {
    aa?.dispose();
    const { x, y } = display();
    const next = new DisplayAA(renderer, ssr.gbuffer, { mode, ratio: mode === 'off' ? 1 : ratio, settings: UPSCALER_DEFAULTS, displayWidth: x, displayHeight: y, tone });
    await next.init();
    ssr.gbuffer.setSize(next.renderWidth, next.renderHeight);
    ssr.resetHistory(); hybrid.resetHistory();
    // linear while the upscaler runs (it tone-maps after); tone-mapped when the composite goes straight to the canvas
    pipeline.outputNode = vec4((next.linear as N).equal(1).select(final, tone(final)), 1);
    pipeline.needsUpdate = true;
    aa = next; sinceSwitch = 0; aaFrames = 0;
  };
  let rebuilt = configure();
  await rebuilt;
  // ----------------------------------------------------------------------------------------------

  const setOff = async (off: boolean) => { mode = off ? 'off' : 'upscaler'; offBox.checked = off; ratioSelect.disabled = off; await configure(); };
  offBox.onchange = () => void setOff(offBox.checked);
  ratioSelect.onchange = () => { ratio = Number(ratioSelect.value); void configure(); };
  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    viewSelect.value = name;
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  let last = performance.now();
  const frame = () => {
    if (!aa) return;
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    const { x, y } = display();
    if (x !== aa.displayWidth || y !== aa.displayHeight) {
      const r = aa.setSize(x, y);
      ssr.gbuffer.setSize(r.width, r.height); ssr.resetHistory(); hybrid.resetHistory();
    }
    camera.aspect = x / y;
    camera.updateProjectionMatrix();
    // mode 'off' renders at the display size (ratio 1): no jitter, the composite straight to the canvas
    const j = aa.begin(camera);
    ssr.render(scene, camera, j);
    aa.end(camera);
    hybrid.update();
    renderer.setRenderTarget(aa.target);
    pipeline.render();
    renderer.setRenderTarget(null);
    const now = performance.now();
    aa.resolve(camera, Math.min((now - last) / 1000, 0.1));
    last = now;
    sinceSwitch++; aaFrames++;
  };
  renderer.setAnimationLoop(frame);

  setInterval(() => {
    if (!aa) return;
    const r = aa.mode === 'upscaler' ? aa.ratio : 1, share = 100 / (r * r);
    const lines = [`render  ${aa.renderWidth} x ${aa.renderHeight}`, `display ${aa.displayWidth} x ${aa.displayHeight}`, `pixels rendered ${share.toFixed(0)} %`];
    const t = aa.mode === 'upscaler' ? aa.timings : new Map<string, number>(); // empty without timestamp-query
    if (t.size) lines.push(`upscaler GPU ${(t.get('total') ?? [...t.values()].reduce((s, v) => s + v, 0)).toFixed(2)} ms`);
    infoEl.textContent = lines.join('\n');
  }, 500);
  status.textContent = 'screen space + probes + denoiser on the two rooms, then @pmndrs/upscaler; drag to orbit, then let go: the image settles over ~2 s';

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    /** Stops the loop, pins the tracer's noise (frame index 0) and rebuilds the upscaler, so shots repeat exactly (the check compares them). */
    stop() { renderer.setAnimationLoop(null); ssr.settings.frameIndex = 0; rebuilt = configure(); },
    /** Render n frames (at least 200 after a switch or stop(): the upscaler accumulates up to 128), then the PNG data URL of the canvas. */
    async shot(n = 1) {
      await rebuilt;
      // and end on the same jitter phase every time (the upscaler restarts its sequence when rebuilt; 288 = a multiple of 8, 18 and 32 phases)
      const k = Math.max(n, 200 - sinceSwitch); for (let i = 0; i < k || aaFrames % 288 !== 0; i++) frame();
      return canvas.toDataURL('image/png');
    },
    /** The baseline of `brief.compare`: true = upscaler off (display resolution, no anti-aliasing). */
    async setCompare(on: boolean) { await setOff(on); },
    async setRatio(r: number) { ratio = r; ratioSelect.value = String(r); await configure(); },
    setView,
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
