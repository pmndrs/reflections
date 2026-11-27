// A whole animated scene: the camera on a path, objects moving, and camera cuts that reset the history.
//
// What it shows: reflections are temporal. The denoiser blends each pixel with where it was last frame (by the G-buffer's motion
// vectors), and the screen-space tracer takes its hit colours from last frame's image. Between cuts that is what keeps a moving
// camera and moving objects steady. At a camera cut there is no "where it was last frame": the previous shot's image is unrelated,
// so the page drops the history at each cut:
//
//   reflections.ssr.resetHistory();     // hit colours: this frame's scene colour, not last frame's image
//   reflections.hybrid.resetHistory();  // the denoiser starts over
//
// With denoiser/ffx the compare (no reset) shows little: its reprojection rejects history whose depth and normals disagree, so the
// previous shot barely shows through (the frame after the doorway -> front cut: 0.08 / 255 mean against a 0.07 noise floor). The
// reset is still the contract; a denoiser without that rejection depends on it. The catalog check does not require an image change.
//
// The scene: Ben Houston's two rooms (three.js #35046) with a polished floor, the knot turning and the mirror ball on its figure
// eight. Three shots of 6 s, each a slow camera move, then a cut.
import * as THREE from 'three/webgpu';
import { Reflections, ReflectionProbe, ReflectionProbes, createReflectionsRenderer, installCubeArraySupport } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { rooms, type Vec3 } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('motion/animated');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const noResetBox = document.querySelector<HTMLInputElement>('#noReset')!;
const slowBox = document.querySelector<HTMLInputElement>('#slow')!;
const pauseBox = document.querySelector<HTMLInputElement>('#pause')!;
const cutButton = document.querySelector<HTMLButtonElement>('#cut')!;

/** A shot: the camera moves from `from` to `to` (position and target) over `seconds`. */
interface Shot { name: string; seconds: number; from: [Vec3, Vec3]; to: [Vec3, Vec3] }
const SHOTS: Shot[] = [
  { name: 'left room, past the table', seconds: 6, from: [[-6.2, 2.1, 3.3], [0.0, 1.0, -0.8]], to: [[-2.0, 1.9, 3.6], [-5.0, 0.8, -0.6]] },
  { name: 'through the doorway', seconds: 6, from: [[6.6, 1.5, 1.9], [-4.0, 0.9, -0.4]], to: [[5.0, 1.4, 1.2], [-4.0, 0.9, -0.4]] },
  { name: 'both rooms, from the front', seconds: 6, from: [[-2.0, 2.3, 8.5], [-0.4, 2.05, 0]], to: [[2.0, 2.3, 8.5], [0.4, 2.05, 0]] },
];
const LOOP = SHOTS.reduce((s, x) => s + x.seconds, 0);
/** The shot at time t (seconds, looping) and how far into it (0..1). */
function shotAt(t: number) {
  let u = ((t % LOOP) + LOOP) % LOOP;
  for (let i = 0; i < SHOTS.length; i++) { if (u < SHOTS[i].seconds) return { index: i, k: u / SHOTS[i].seconds }; u -= SHOTS[i].seconds; }
  return { index: 0, k: 0 };
}
/** When shot `i` starts, in seconds. */
const shotStart = (i: number) => SHOTS.slice(0, i).reduce((s, x) => s + x.seconds, 0);

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  const kit = rooms({ aspect: innerWidth / innerHeight });
  const { scene, camera } = kit;

  // One probe per room and one in the doorway (the scene's suggestion); the moving ball stays out of the captures.
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
  const reflections = await Reflections.create(renderer, scene, {
    probes,
    denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
  });

  let resetAtCuts = true, paused = false, speed = 1, time = 0, current = -1, sinceCut = 0;
  const resetHistory = () => {
    // ---- the part to copy: on a camera cut (or a teleport, a scene switch) -------------------------
    reflections.ssr.resetHistory();
    reflections.hybrid.resetHistory();
    // ----------------------------------------------------------------------------------------------
  };
  const look = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  /** One frame `dt` seconds after the last (0 = paused: the camera and the objects hold still). */
  const frame = (dt: number) => {
    time += dt * speed;
    const { index, k } = shotAt(time);
    if (index !== current) {
      if (current >= 0 && resetAtCuts) resetHistory(); // a cut
      current = index; sinceCut = 0;
    }
    sinceCut++;
    const s = SHOTS[index], e = k * k * (3 - 2 * k); // ease in and out
    camera.position.copy(a.set(...s.from[0]).lerp(b.set(...s.to[0]), e));
    camera.lookAt(look.copy(a.set(...s.from[1]).lerp(b.set(...s.to[1]), e)));
    kit.update?.(time);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
  };
  /** Jump to time t: a cut of its own, so the history resets whatever the switch says. */
  const seek = (t: number) => { time = t; current = shotAt(t).index; sinceCut = 0; resetHistory(); };

  let last = 0;
  renderer.setAnimationLoop((now: number) => {
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    frame(paused ? 0 : dt);
    status.textContent = `shot ${current + 1} / ${SHOTS.length}: ${SHOTS[current].name}` +
      (sinceCut < 40 ? (resetAtCuts ? '   CUT: history reset' : '   CUT: no history reset') : '');
  });

  noResetBox.onchange = () => { resetAtCuts = !noResetBox.checked; };
  slowBox.onchange = () => { speed = slowBox.checked ? 0.25 : 1; };
  pauseBox.onchange = () => { paused = pauseBox.checked; };
  cutButton.onclick = () => { time = Math.floor(time / LOOP) * LOOP + shotStart(current + 1) + 1e-3; }; // the next frame cuts

  // headless driver (scripts/run-headless.mjs, section `catalog`). Time steps by 1/60 s per frame here, so shots repeat exactly.
  const CUT = shotStart(2); // doorway -> front: the floor's reflections change the most
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    stop() { renderer.setAnimationLoop(null); },
    /**
     * The frame `max(n, 6)` frames after a camera cut, as a PNG data URL: seek to 1.5 s before the doorway -> front cut (the history
     * settles over the doorway shot), play through the cut, and stop 6 frames into the front shot.
     */
    async shot(n = 1) {
      seek(CUT - 1.5 + 0.5 / 60);
      for (let i = 0; i < 90 + Math.max(n, 6); i++) frame(1 / 60);
      return canvas.toDataURL('image/png');
    },
    /** The baseline of `brief.compare`: true = no history reset at the cuts. */
    setCompare(on: boolean) { resetAtCuts = !on; noResetBox.checked = on; },
    seek,
    /** Rest flicker (the quick start's measure): paused mid-shot, settled 120 frames; % of px whose mean |change| over 6 frame pairs > 1/255. */
    async restFlicker() {
      renderer.setAnimationLoop(null);
      seek(shotStart(1) + 3);
      for (let i = 0; i < 120; i++) frame(0);
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      let prev: Float32Array | null = null; const acc = new Float32Array(c.width * c.height);
      for (let k = 0; k < 7; k++) {
        frame(0);
        g.drawImage(canvas, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data, l = new Float32Array(acc.length);
        for (let i = 0; i < l.length; i++) l[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
        if (prev) for (let i = 0; i < l.length; i++) acc[i] += Math.abs(l[i] - prev[i]);
        prev = l;
      }
      let over = 0; for (let i = 0; i < acc.length; i++) if (acc[i] / 6 > 1) over++;
      return (100 * over) / acc.length;
    },
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
