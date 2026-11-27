// The denoiser on glossy reflections, with a live flicker meter.
//
// What it shows: a glossy surface reflects a cone of directions, and the screen-space tracer sends one ray per 2x2 quad per
// frame through that cone. One frame of it is noise; frame after frame it shimmers. A temporal denoiser (`denoiser/ffx`, AMD's
// reflection denoiser in WGSL, through the package's denoise seam) reprojects the last frames and filters spatially, so the
// reflection settles into a steady image. The meter reads the canvas every frame at rest and reports how much it changes.
//
// The roughness ramp: gold (metal) and blue (plastic) spheres and chrome floor strips from roughness 0 (left) to 1 (right).
// Mirrors (left) need little denoising; the middle of the ramp is where the noise is. Above roughness 0.447 the tracer stops and
// the probe alone reflects (no noise there either).
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflections, ReflectionProbe, ReflectionProbes, createReflectionsRenderer, installCubeArraySupport } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { roughnessRamp } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('denoise/glossy');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const meterEl = document.querySelector<HTMLElement>('#meter')!;
const offBox = document.querySelector<HTMLInputElement>('#denoiseOff')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const kit = roughnessRamp({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(kit.target);
  controls.enableDamping = true;

  // A probe for what the screen cannot see (and for everything rougher than the tracer's threshold): the scene's suggested box.
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

  // ---- the part to copy ------------------------------------------------------------------------
  // FFX compares alpha (perceptual roughness squared) against its threshold; the tracer's is perceptual.
  const reflections = await Reflections.create(renderer, scene, {
    probes,
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });
  // `reflections.hybrid.denoise = false` shows the raw signal the denoiser gets (the compare switch).
  // ----------------------------------------------------------------------------------------------

  let sinceSwitch = 0; // frames since the denoiser was switched (its history restarts when it comes back on)
  const setDenoiseOff = (off: boolean) => { reflections.hybrid.denoise = !off; offBox.checked = off; sinceSwitch = 0; meter.reset(); };
  offBox.onchange = () => setDenoiseOff(offBox.checked);

  const setView = (name: string) => {
    const v = kit.views[name] ?? kit.views.default;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    viewSelect.value = name;
    meter.reset();
  };
  viewSelect.onchange = () => setView(viewSelect.value);

  // ---- the flicker meter: frame-to-frame change of the displayed image while nothing moves ---------
  // A 1:1 crop of the canvas centre (no downscale, which would average the noise away), as 8-bit Rec. 709 luma. Reported:
  // the mean |change| per pixel and the share of pixels that changed by more than 1/255 (the repo's rest-flicker measures,
  // examples/shared/metrics). Averaged over the last ~30 frames; it waits for the camera to settle first.
  const meter = (() => {
    const crop = document.createElement('canvas');
    const g = crop.getContext('2d', { willReadFrequently: true })!;
    let prev: Float32Array | null = null, still = 0, mean = 0, pct = 0, n = 0;
    return {
      reset() { prev = null; still = 0; n = 0; },
      moved() { still = 0; prev = null; },
      sample() {
        const w = Math.min(640, canvas.width), h = Math.min(360, canvas.height);
        if (crop.width !== w || crop.height !== h) { crop.width = w; crop.height = h; prev = null; }
        g.drawImage(canvas, (canvas.width - w) >> 1, (canvas.height - h) >> 1, w, h, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        const luma = new Float32Array(w * h);
        for (let i = 0; i < luma.length; i++) luma[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
        if (++still > 20 && prev) {
          let s = 0, over = 0;
          for (let i = 0; i < luma.length; i++) { const c = Math.abs(luma[i] - prev[i]); s += c; if (c > 1) over++; }
          const k = Math.min(++n, 30); // running mean over the last ~30 frames
          mean += (s / luma.length - mean) / k; pct += ((100 * over) / luma.length - pct) / k;
        }
        prev = luma;
      },
      get reading() { return n >= 10 ? { mean, pctOver1: pct } : null; },
    };
  })();
  controls.addEventListener('change', () => meter.moved());

  const frame = () => {
    controls.update();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
    sinceSwitch++;
    meter.sample();
  };
  renderer.setAnimationLoop(frame);
  setInterval(() => {
    const r = meter.reading;
    meterEl.innerHTML = r
      ? `flicker at rest (centre crop)\nmean change  <b>${r.mean.toFixed(3)}</b> / 255\npixels > 1/255 <b>${r.pctOver1.toFixed(2)} %</b>`
      : 'flicker at rest (centre crop)\nwaiting for the camera to settle...';
  }, 250);
  status.textContent = `screen space + probe + ${reflections.hybrid.denoise ? 'denoiser (denoiser/ffx)' : 'no denoiser'}; roughness 0 (left) to 1 (right); drag to orbit, then let go and read the meter`;

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    stop() { renderer.setAnimationLoop(null); },
    /** Render n frames (at least 120 after a switch: the denoiser's history settles), then the PNG data URL of the canvas. */
    async shot(n = 1) { const k = Math.max(n, 120 - sinceSwitch); for (let i = 0; i < k; i++) frame(); return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows it (denoiser off). */
    setCompare(on: boolean) { setDenoiseOff(on); },
    setView,
    /** The meter's reading after `frames` more frames at rest (null until it has 10 samples). */
    async flicker(frames = 60) { for (let i = 0; i < frames; i++) frame(); return meter.reading; },
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
