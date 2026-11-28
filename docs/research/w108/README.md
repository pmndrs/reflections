# W108: oriented probe boxes (T23)

Decision 18's second half: probe boxes that turn. D3701 (the front-tyre step), D5720-D5722.

## What was built

- **Core** (`packages/core/src/probes/{table,lookup,set}.ts`). `ProbeVolume.rotation`, a quaternion (x, y, z, w) taking
  the box's frame to world about `center`. The table holds 6 rows per volume (was 5). Row +5 is the normalized
  quaternion (w >= 0; the identity for an axis-aligned box), and flags bit 1 (row +1 w, `PROBE_FLAG_ORIENTED`) marks an
  oriented volume. One quaternion row is the smallest layout that keeps vec4 alignment. Three rotation rows would make 8
  rows per volume.
- **Lookup**. Behind the flag, `P - centre` and the direction turn by the conjugate quaternion (`pr_toLocal`). The box
  test, the fade and the box projection (`pr_parallaxDistance` against the local box and its local offset) run in that
  frame. The corrected direction is rebuilt in world space, `P + dir * t - origin`, because the captures stay
  world-aligned cubes. An axis-aligned volume takes the old code. The proxy share does the same. The W63 grid lists an
  oriented box by its world bounds. `orientedVolumes: false` compiles the branch out.
- **three**. `ReflectionProbe.oriented` (default false, so #35046's behaviour is kept). The rotation comes from the
  probe's world matrix, the same transform its position and scale use. The influence and projection boxes, the blend,
  `projectionOffset` and `originOffset` all turn with it. The probe node, the proxy share and the RT hit shading compile
  the oriented branch only when a baked probe is oriented (`orientedSignature`, part of the cache key).
  `ReflectionProbesHelper` draws the turned boxes. Exported: `probeWorldRotation`.
- **Babylon**. `BabylonProbe.rotation`: a Babylon quaternion, passed through to core, which also turns `originOffset`.
  pixi: no change; it builds.

## Numbers

| what | result |
|---|---|
| Axis-aligned parity vs main (`--only probe-parity --parity-base main`) | 29 / 29 shots, 0 differing px: ssr rooms + Sponza × 4 layouts × final / probeSpecular, rt=1, probes page (cube array, 2D array, mirror grid), Babylon |
| probe-core, rooms turned 0.62 rad about a tilted axis, vs the CPU lookup in each box's frame | coverage err 2.0e-6, direction err mean 0.0005, max 0.003 (axis-aligned rooms: 7.9e-7, 0.0005, 0.003). Control with the rotation dropped: coverage err 1.0 |
| probes page, the whole world turned 0.5 rad, camera turned with it | oriented 0.19 / 255 mean (2.2 % px > 2) from the unturned image; world-axis-aligned boxes 4.75 (22.8 %) |
| Babylon, a probe turned 90° = the axis-aligned probe with its projection box turned | mean 0.0000, max 1 / 255 (unturned probe: 1.503) |
| core ProbeSet lookup cost, axis-aligned, 1080p of lookups, branch in / out (`--only probe-orient-cost`) | 3 volumes 0.670 / 0.680 ms, 8: 0.620 / 0.650, 32: 0.690 / 0.740. No cost |
| three materials + composite with the runtime branch forced in (`lookup-ab.txt`) | +0.03-0.38 ms at 3-8 volumes, within noise at 16-32. three therefore compiles the branch only when a probe is oriented |

## D3701: carConcept's front-tyre step

`?carProbeOrient=oriented` (bench `carProbeOrient`) places each wheel's box in the wheel's heading. The heading is the
yaw of the wheel's world rotation, steering included. The cabin's box goes in the car's frame.

The spin had to go. The wheel groups carry 20-45° of spin about the axle, and the full frame tilted the box's square
section across the tyre. The shrink then cut the box down to 0.54 / 0.50 of the front wheels' vertices (`scripts/boxes.js`).

- **The step is gone.** `front-tyre-coverage.png` shows where the wheel probe changes the probes-only image (|wheels − off| × 8):
  - World boxes: the box edge cuts the visible tyre with a vertical line.
  - Turned boxes: the covered area follows the tyre's silhouette.

  `front-tyre.jpg` has the crops: probes only, ours-rt, and the path tracer. In the box's own frame, the front box still
  misses 5 cm of the tyre's far horizontal extent (world box: 9 cm), but that part is the arch interior, not the visible
  tyre face.
- **Bench Measure** (w50, 1280 × 1280, ours-rt vs PT, wheels 64, world → oriented; `measure-1280.txt`):

  | region | world | oriented | PT |
  |---|---|---|---|
  | hub | 25.2 | 26.7 | 27.1 |
  | wheelFace | 28.5 | 30.0 | 35.9 |
  | wheel | 36.8 | 37.9 | 39.7 |
  | floorWheel | 32.5 | 34.6 | 30.1 |
  | car | 94.5 | 95.4 | 101.3 |
  | frame MAD | 13.2 | 13.0 | |
- **Flicker** (`flicker-w108-wheels.md`, carConcept@w50, off → world → oriented):

  | region | metric | off | world | oriented |
  |---|---|---|---|---|
  | wheel | drift | 1.23 | 1.33 | 1.31 |
  | wheel | orbit std | 1.91 | 2.06 | 2.01 |
  | car | drift | 0.574 | 0.604 | 0.579 |
  | reflection | drift | 0.267 | 0.297 | 0.268 |

  Turning the boxes takes back part of the wheel probes' rise. The wheel region still rises 5-6 %.
- **Defaults are unchanged.** The car probes stay off (D5600). With them on, `world` is still the bench default.

## Scripts

- `scripts/boxes.js`: the wheel boxes against the wheels and the body, world vs oriented.
- `scripts/step.py`: tyre coverage in the probes-only shots.

Both run through W55's driver (`docs/research/w55/scripts/drive.mjs`), and so does W55's `shots.js` / `measure.js`
with a `CONFIGS` prelude:

```
node docs/research/w55/scripts/drive.mjs 'http://127.0.0.1:5430/showcase/bench.html?manual&scene=carConcept&pose=w50&size=1280x1280&left=ours-rt&right=pathtraced' out/w108/shots docs/research/w55/scripts/shots.js "const CONFIGS = [['probes-off','probes',{}],['probes-world','probes',{carProbes:'wheels'}],['probes-oriented','probes',{carProbes:'wheels',carProbeOrient:'oriented'}],['rt-world','ours-rt',{carProbes:'wheels'}],['rt-oriented','ours-rt',{carProbes:'wheels',carProbeOrient:'oriented'}]];"
```
