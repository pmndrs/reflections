// The hybrid, explained: probe, screen space, rays and the composite in one room, with the per-pixel source map.
//
// Rebuilt from the denoiser repo's reflections-hybrid page ("reflections explained: probe, SSR, ray tracing"), which drew the
// same room with three's SSRNode and inline three-mesh-bvh rays. Here every mode is a setting on ONE `Reflections` pipeline:
//
//   probe   three's lit image with the probe as its environment (the composite's `lit` term): no rays, no noise
//   ssr     `reflections.ssr.rayTracing = false`: screen space, the probe where it misses
//   rt      every pixel sent to the rays (`settings.missConfidenceThreshold` above 1, roughness cutoff 1): rays everywhere
//   hybrid  the default: probe above the roughness cutoff, below it screen space, a ray where screen space misses
//
// The source map is `HybridReflections.sourceIndex(composite, roughnessThreshold)`: what answered each pixel this frame.
// What changed from the denoiser page, and why: docs/DIVERGES.md (D5510).
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { float, renderOutput, uniform, vec3, vec4 } from 'three/tsl';
import { HYBRID_SOURCE, HybridReflections, ReflectionProbe, ReflectionProbes, Reflections, createReflectionsRenderer } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx';
import { explainer } from '../../../shared';
import { mountShell } from '../../../shell';

mountShell('hybrid/explained', { placement: 'inline' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any; // TSL node typings are too strict for hand-written shader maths
type Mode = 'probe' | 'ssr' | 'rt' | 'hybrid';
type Verdict = 'good' | 'bad' | 'part';
const q = new URLSearchParams(location.search);
if (q.has('thumb')) document.body.classList.add('thumb');
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const canvas = $<HTMLCanvasElement>('#view');
const status = $('#status');

const SHORT: Record<Mode, string> = { probe: 'probe', ssr: 'screen space + probe', rt: 'rays', hybrid: 'hybrid' };
const LABEL: Record<Mode, string> = {
  probe: 'reflection probe (box-projected, prefiltered), no rays',
  ssr: 'screen space, the probe where it misses',
  rt: 'a traced ray for every pixel, the probe where it leaves the room',
  hybrid: 'probe above the roughness cutoff; below it screen space, a ray where that misses',
};

// ---- the guided tour (the denoiser page's situations, on this pipeline) ------------------------------
interface Scenario {
  id: string; short: string; title: string; pos?: [number, number, number]; target?: [number, number, number];
  left: Mode; right: Mode | null; view?: 'image' | 'source'; spin?: boolean; gloss?: number;
  look: string; verdicts: [Mode, Verdict, string][]; why?: string;
}
const SCENARIOS: Scenario[] = [
  {
    id: 'mirror', short: 'A mirror', title: 'A mirror: what\'s behind the camera', pos: [0.3, 1.45, 2.3], target: [0.15, 1.5, -2.08], left: 'ssr', right: 'hybrid',
    look: 'The mirror faces you, so it shows the half of the room behind the camera: a blue wall, a sofa, three lit bars, a globe lamp and a plant. None of it is on screen. Switch between the two methods and look at the globe lamp and the bars.',
    verdicts: [
      ['ssr', 'bad', 'Screen space finds nothing, so every mirror pixel falls back to the probe: soft (the probe is a 256-pixel cube), the globe lamp and the plant drawn where the probe saw them, the table\'s reflection smeared.'],
      ['hybrid', 'good', 'A traced ray per mirror pixel: sharp, and everything where it really is, including the back of the sculpture.'],
      ['probe', 'bad', 'The same as screen space here.'],
    ],
    why: 'Mirrors, windows, car paint and water facing the camera are where screen-space methods break down, and why games use ray tracing or a planar reflection (rendering the scene a second time, mirrored) for them.',
  },
  {
    id: 'offscreen', short: 'Off the top of the screen', title: 'Off the top of the screen', pos: [-1.0, 1.0, 2.4], target: [-1.75, 0, 0.9], gloss: 0.04, left: 'ssr', right: 'hybrid',
    look: 'Looking down at the polished floor. The glowing floor lamp is above the frame; its shade is reflected in the middle of the image. Switch and watch where the reflected shade sits.',
    verdicts: [
      ['ssr', 'bad', 'Screen space can\'t see the lamp, so the probe guesses, and draws the shade in the wrong place: the probe saw the lamp from above the table, not from here.'],
      ['hybrid', 'good', 'Screen space misses too, so a ray is traced and finds the real shade.'],
      ['probe', 'part', 'The orange ring on the left is mounted on the wall, so box projection gets it about right. Box projection works for walls and nothing else.'],
    ],
    why: 'This is screen space\'s most common failure in games: look down at a wet street or a glossy floor and the reflections of things above the screen fade or jump. Drag the view up and down and watch the floor.',
  },
  {
    id: 'moving', short: 'Things that move', title: 'Things that move', pos: [-0.9, 1.35, 1.4], target: [0.6, 1.15, -1.9], spin: true, left: 'probe', right: 'hybrid',
    look: 'The gold sculpture turns. The mirror behind it shows its back, which the camera never sees. With the hybrid the reflection turns with it.',
    verdicts: [
      ['probe', 'bad', 'The probe photographed the sculpture from the middle of the room and box projection paints that image onto the wall, so it sits in the wrong place, and it is frozen at the moment of the bake (press "re-bake probe").'],
      ['hybrid', 'good', 'Rays see the scene as it is this frame: `reflections.trace.refit()` moves the sculpture in the BVH every frame.'],
      ['ssr', 'bad', 'Screen space only has the side of the sculpture facing the camera, so it can\'t show its back in the mirror.'],
    ],
    why: 'A re-bake renders six faces per probe and prefilters them: cheap on demand, but every probe re-baked every frame adds that again. Engines re-bake on demand or one face per frame, and keep probes for static things and screen space or rays for moving ones.',
  },
  {
    id: 'contact', short: 'Where things touch', title: 'Where things touch the floor', pos: [0.4, 0.5, -1.75], target: [-1.6, 0.3, -1.55], gloss: 0.05, left: 'probe', right: 'hybrid',
    look: 'A low view along the polished floor at the teal vase. A reflection should start exactly where the vase touches the floor.',
    verdicts: [
      ['probe', 'bad', 'The vase\'s reflection is faint and in the wrong place, and the chair shows up on the floor where nothing should be: the probe saw them from somewhere else and painted them onto the walls.'],
      ['hybrid', 'good', 'The reflection starts at the base and mirrors the vase exactly.'],
      ['ssr', 'good', 'The vase is on screen, so screen space finds it exactly too.'],
    ],
    why: 'Box projection is exact only for the walls of the box. Everything inside the room is drawn as if it were painted on the walls, which is why probe reflections look "floaty" and don\'t touch the things that cast them.',
  },
  {
    id: 'rough', short: 'Rough surfaces', title: 'Rough surfaces: why the hybrid has a cutoff', pos: [-0.2, 1.3, 1.4], target: [-1.2, 0, -0.4], left: 'rt', right: 'hybrid',
    look: 'The rug is fully rough. Its reflection is a blur of the whole room, so one random ray per pixel is mostly noise. Look at the rug with each method.',
    verdicts: [
      ['rt', 'part', 'Right on average, but the rug crawls: one ray on a rough surface carries too little, and the denoiser is built for glossy reflections.'],
      ['hybrid', 'good', 'Above the cutoff (the slider below) it takes the prefiltered probe instead: smooth, free, and the blur hides that it is approximate.'],
      ['probe', 'good', 'Good on rough surfaces, for the same reason.'],
    ],
    why: 'Drag the "hybrid roughness cutoff" slider to 1 and the hybrid traces the rug too. AMD\'s hybrid reflections and most engines draw the line around 0.4 to 0.5 (0.447 here, FFX\'s alpha 0.2).',
  },
  {
    id: 'sources', short: 'Where reflections come from', title: 'Where each pixel\'s reflection comes from', left: 'ssr', right: 'hybrid', view: 'source',
    look: 'Each pixel is tinted by what answered its reflection ray: <b class="c-ssr">screen space found it</b>, <b class="c-rt">a ray traced against the scene</b>, <b class="c-miss">nothing found it, so the probe guessed</b>, or <b class="c-probe">the prefiltered probe, no ray at all</b>. Switch between the two methods, or drag the view: tilt down at the floor and watch green turn red with screen space and blue with the hybrid.',
    verdicts: [
      ['ssr', 'part', 'Green on the floor and the table, where what they reflect is on screen. The mirror is red: it shows what\'s behind the camera, and screen space has nothing to find there.'],
      ['hybrid', 'good', 'The same green, but the red turns blue: rays answer what screen space can\'t. Rough surfaces (the rug, the walls) are orange: they skip rays and take the prefiltered probe.'],
    ],
    why: 'This is the whole idea of a hybrid: use the cheap answer where it is right, and pay for rays only where it isn\'t.',
  },
  {
    id: 'explore', short: 'Explore', title: 'Explore', left: 'hybrid', right: null, spin: true,
    look: 'The slow orbit. Drag the view to look around (it then holds still) and scroll to move. Pick a method under "Reflections from" below, or switch "Show" to see where reflections come from.',
    verdicts: [],
  },
];

async function main() {
  const renderer = await createReflectionsRenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const kit = explainer({ aspect: 16 / 9 });
  const { scene, camera } = kit;
  // the floor and the table top (roughness 0.12 in the kit): the "floor gloss" slider
  const glossy = new Set<THREE.MeshStandardMaterial>();
  scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial; if (m?.isMeshStandardMaterial && m.roughness === 0.12) glossy.add(m); });

  // The room's probe (the original's box and capture point), baked once.
  const probes = new ReflectionProbes();
  for (const v of kit.probes) {
    const p = new ReflectionProbe(...v.influenceSize);
    p.position.set(...v.position);
    if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
    if (v.originOffset) p.originOffset.set(...v.originOffset);
    if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
    probes.add(p);
  }
  scene.add(probes);
  probes.bake(renderer, scene);

  // ---- the pipeline: one Reflections, every mode a setting on it ----------------------------------------
  let ffx: FfxReflectionDenoiser | null = null, ffxCut = 0.447;
  const reflections = await Reflections.create(renderer, scene, {
    probes,
    rayTracing: true,
    denoiser: (device, { roughnessThreshold }) => (ffx = new FfxReflectionDenoiser(device, { roughnessThreshold: (ffxCut = roughnessThreshold) ** 2 })),
  });
  const { ssr, hybrid } = reflections;
  // FFX gates at the tracer's cutoff (alpha), fixed at construction: a new cutoff gets a new denoiser
  const gateDenoiser = (cut: number) => {
    if (!ffx || cut === ffxCut) return;
    const old = ffx;
    hybrid.setDenoiser(ffx = new FfxReflectionDenoiser(ssr.device, { roughnessThreshold: cut * cut }));
    old.dispose();
    ffxCut = cut;
  };

  // The output: the image or the source map, of the composite or of the probe alone (three's lit image).
  const uProbe = uniform(0), uSource = uniform(0);
  const applyOutput = () => {
    const c = hybrid.composite();
    const base: N = uProbe.equal(1).select((renderOutput(vec4(c.lit.rgb, 1)) as N).rgb, (renderOutput(c.final) as N).rgb);
    const s: N = HybridReflections.sourceIndex(c, hybrid.roughnessThreshold);
    const tint: N = uProbe.equal(1).or(s.equal(HYBRID_SOURCE.rough)).select(vec3(1, 0.61, 0.05),
      s.equal(HYBRID_SOURCE.ssr).select(vec3(0.18, 0.8, 0.29), s.equal(HYBRID_SOURCE.traced).select(vec3(0.23, 0.53, 1), vec3(1, 0.23, 0.16))));
    const map: N = c.geometry.select(base.mul(0.3).add(tint.mul(0.7)), base.mul(0.3));
    reflections.pipeline.outputColorTransform = false; // tone-mapped and encoded above
    reflections.pipeline.outputNode = vec4(uSource.equal(1).select(map, base) as N, float(1));
    reflections.pipeline.needsUpdate = true;
  };
  applyOutput();

  // ---- state and controls -----------------------------------------------------------------------------
  let mode: Mode = 'hybrid', cutoff = 0.447, settle = 0;
  let scenario = SCENARIOS[0];
  const press = (sel: string, v: string) => document.querySelectorAll<HTMLButtonElement>(`${sel} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  const seg = (sel: string, on: (v: string) => void) => document.querySelectorAll<HTMLButtonElement>(`${sel} button`).forEach((b) => b.addEventListener('click', () => on(b.dataset.v!)));
  const resetHistory = () => { hybrid.resetHistory(); ssr.resetHistory(); };

  const setMode = (m: Mode) => {
    mode = m;
    ssr.rayTracing = (m === 'rt' || m === 'hybrid') && !!reflections.trace;
    // rays everywhere: every pixel goes to the miss list (confidence is never above 1), rough ones too
    if (m === 'rt') Object.assign(ssr.settings, { missConfidenceThreshold: 1.01, roughnessThreshold: 1 });
    else { delete ssr.settings.missConfidenceThreshold; ssr.settings.roughnessThreshold = cutoff; }
    gateDenoiser(ssr.settings.roughnessThreshold!);
    uProbe.value = m === 'probe' ? 1 : 0;
    press('#seg-mode', m); press('#ab', m);
    $('#lab').textContent = `${SHORT[m]}: ${LABEL[m]}`;
    settle = 60;
  };
  seg('#seg-mode', (v) => setMode(v as Mode));
  seg('#ab', (v) => setMode(v as Mode));
  const setShow = (v: string) => { uSource.value = v === 'source' ? 1 : 0; press('#seg-show', v); $('#legend').hidden = v !== 'source'; };
  seg('#seg-show', setShow);
  const setDenoise = (on: boolean) => { hybrid.denoise = on; press('#seg-denoise', on ? 'on' : 'off'); };
  seg('#seg-denoise', (v) => setDenoise(v === 'on'));

  const cutIn = $<HTMLInputElement>('#cutoff'), roughIn = $<HTMLInputElement>('#roughness');
  cutIn.oninput = () => { $('#cutoff-v').textContent = Number(cutIn.value).toFixed(2); };
  cutIn.onchange = () => { cutoff = Number(cutIn.value); if (mode !== 'rt') setMode(mode); };
  const setGloss = (r: number) => { roughIn.value = String(r); for (const m of glossy) m.roughness = r; $('#roughness-v').textContent = r.toFixed(2); };
  roughIn.oninput = () => setGloss(Number(roughIn.value));
  cutIn.oninput(new Event('input'));

  // The camera: a slow orbit (two shots; "camera cut" jumps between them) or held where you put it.
  const controls = new OrbitControls(camera, canvas);
  controls.minDistance = 0.3; controls.maxDistance = 6;
  const SHOTS = [
    { target: new THREE.Vector3(-0.35, 0.5, -0.8), r: 4.1, h: 1.65, a0: 0.2, amp: 0.3 },
    { target: new THREE.Vector3(-0.55, 0.2, -0.5), r: 2.0, h: 0.75, a0: 0.55, amp: 0.18 },
  ];
  const ROOM_MIN = new THREE.Vector3(-2.85, 0.08, -1.95), ROOM_MAX = new THREE.Vector3(3.2, 3.3, 4.45);
  let orbit = false, shot = 0, tCam = 0, spin = false, tKnot = 0, frozen = false;
  const setOrbit = (on: boolean) => { if (on && !orbit) resetHistory(); orbit = on; press('#seg-motion', on ? 'on' : 'off'); };
  seg('#seg-motion', (v) => setOrbit(v === 'on'));
  controls.addEventListener('start', () => setOrbit(false));
  $('#cut').onclick = () => { setOrbit(true); shot = 1 - shot; resetHistory(); };
  const setSpin = (on: boolean) => { spin = on; press('#seg-spin', on ? 'on' : 'off'); };
  seg('#seg-spin', (v) => setSpin(v === 'on'));
  const rebake = $<HTMLButtonElement>('#rebake');
  rebake.onclick = () => { reflections.bake(); applyOutput(); }; // bake() rebuilds the composite: the page's output again

  const applyScenario = (sc: Scenario) => {
    scenario = sc;
    if (sc.pos) {
      setOrbit(false);
      camera.position.set(...sc.pos);
      controls.target.set(...sc.target!);
      camera.lookAt(controls.target);
    } else { setOrbit(true); shot = 0; }
    setShow(sc.view ?? 'image'); setDenoise(true); setSpin(sc.spin ?? false); setGloss(sc.gloss ?? 0.12);
    const pair = sc.right ? [sc.left, sc.right] : [];
    $('#ab').innerHTML = pair.map((m) => `<button data-v="${m}" aria-pressed="false">${SHORT[m]}</button>`).join('') || '<button disabled>pick one below</button>';
    seg('#ab', (v) => setMode(v as Mode));
    setMode(sc.right ?? sc.left);
    resetHistory();
    press('#tour', sc.id);
    const word = { good: 'gets it', bad: 'wrong', part: 'partly' };
    $('#scenario').innerHTML = `<h3>${sc.title}</h3><p>${sc.look}</p><ul class="verdicts">${sc.verdicts.map(([m, v, t]) =>
      `<li><button class="v v-${v}" data-m="${m}" title="show ${SHORT[m]}">${SHORT[m]}: ${word[v]}</button> ${t}</li>`).join('')}</ul>${sc.why ? `<p class="why">${sc.why}</p>` : ''}`;
    $('#scenario').querySelectorAll<HTMLButtonElement>('button[data-m]').forEach((b) => { b.onclick = () => setMode(b.dataset.m as Mode); });
  };
  $('#tour').innerHTML = SCENARIOS.map((sc, i) => `<button data-v="${sc.id}" aria-pressed="false">${i + 1}. ${sc.short}</button>`).join('');
  seg('#tour', (id) => applyScenario(SCENARIOS.find((sc) => sc.id === id)!));
  applyScenario(SCENARIOS.find((sc) => sc.id === q.get('scenario')) ?? SCENARIOS[0]);

  // ---- the loop -----------------------------------------------------------------------------------------
  const frame = () => {
    if (orbit) {
      if (!frozen) tCam += 1 / 60;
      const s = SHOTS[shot], a = s.a0 + s.amp * Math.sin(tCam * 0.21), r = s.r + 0.25 * Math.sin(tCam * 0.13);
      camera.position.set(s.target.x + r * Math.sin(a), s.h + 0.15 * Math.sin(tCam * 0.17), s.target.z + r * Math.cos(a));
      camera.lookAt(s.target);
      controls.target.copy(s.target); // a drag starts from where the orbit is
    } else {
      controls.update();
      camera.position.clamp(ROOM_MIN, ROOM_MAX);
    }
    if (spin && !frozen) {
      tKnot += 1 / 60;
      kit.update!(tKnot);
      scene.updateMatrixWorld();
      reflections.trace?.refit(); // the turning sculpture, in the BVH
    }
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); // a no-op unless the size changed
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    reflections.render(camera);
  };
  renderer.setAnimationLoop(frame);
  const describe = () => {
    const info = (reflections.trace?.provider as { info?: { triangles?: number } } | undefined)?.info;
    const rt = !reflections.trace ? 'ray tracing unavailable (@pmndrs/raytracer / @pmndrs/bvh could not be loaded): the rays modes show screen space + probe'
      : ssr.traceError ? `ray tracing is off on this device: ${ssr.traceError}` : `BVH over ${info?.triangles ?? '?'} triangles`;
    status.textContent = `${rt}; 1 probe (${probes.bakedResolutions[0]} px); denoiser: FFX (denoiser/ffx)`;
  };
  setTimeout(describe, 1000); // traceError is known after the first traced frame

  // headless driver (scripts/run-headless.mjs, section `catalog`)
  (window as unknown as { __p: unknown }).__p = {
    reflections,
    /** Stops the loop, the orbit and the sculpture, and pins the tracer's noise (frameIndex 0): a stopped page shows one image. */
    stop() { renderer.setAnimationLoop(null); frozen = true; ssr.settings.frameIndex = 0; },
    /** Render n frames (at least 60, more after a switch: the denoiser settles), then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < Math.max(n, 60) + settle; i++) frame(); settle = 0; return canvas.toDataURL('image/png'); },
    /** The baseline of `brief.compare`: true shows the situation's weaker method alone (the mirror: screen space + probe). */
    setCompare(on: boolean) { setMode(on ? scenario.left : (scenario.right ?? scenario.left)); },
    setMode, setShow, setDenoise, setGloss,
    scenario: (id: string) => applyScenario(SCENARIOS.find((sc) => sc.id === id)!),
    info: () => ({ mode, scenario: scenario.id, rt: !!reflections.trace, rayTracing: ssr.rayTracing, traceError: ssr.traceError, cutoff: ssr.settings.roughnessThreshold, denoiserCut: ffxCut }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
