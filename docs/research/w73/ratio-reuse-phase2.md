# W73 (X3 phase A, phase 2): X0's metrics, the blobs, cost, verdicts

Phase 1 is in `ratio-reuse-phase1.md`. This phase starts from main `a234de9` (X0 / W70's metrics, `examples/shared/metrics/README.md`), merged at `8260ee0`. The default path still hashes the same: radiance `a1fec223` (unset = copy).

## Verdicts

- **`rayReuse`: keep it as an option, default 'copy'.**
  - What it wins:
    - The visible 2×2 grid on glossy surfaces goes down: rooms 0.072 → 0.024.
    - The first build also cut it on carConcept's near-mirror floor (door 0.29 → 0.18). That came from 1 px taps, the same taps that widened the r 0.05 line, so the fix gave it up (door 0.288 → 0.294 now).
    - The denoiser's energy loss on carConcept's lip halves (9 → 4.5 %; + RT 14 → 4.6 %), and on the skirt it goes from 18 % to 3 %.
  - What it costs:
    - Denoised noise on glossy floors is 30-50 % higher than copy@1. copy@4 stays the quietest.
    - Orbit flicker rises a little. After the fix: rooms +1.5 %, the carConcept floor unchanged, the lip +1 %. The first build reached +5-7 % in carConcept's band and wheel, and contact / offscreen drift moved ±10 %, which is within run-to-run noise there.
    - The resolve costs 0.54 ms at 1080p on a glossy screen (rooms: total 0.47 → 1.04 ms). That is about what spq 4 costs (0.98 ms).
  - Against the PT it is neutral on carConcept (phase 1).
  - **It brings back the r 0.15 emitter the line-spread gate loses.** Denoised, ratio reads 9.9 px (x0.96 of the PT, peak 67 %) where copy loses it (peak 3 %). With AA off: x0.93, peak 85 %. r 0.3 stays lost at spq 1; ratio@4 recovers it (x0.67, peak 63 %).
  - It doesn't widen the line at r 0.05 any more (x1.30, the same as copy), since near-mirrors take no taps (`b8291d3`).
  - **Not the default:** 2x the SSR cost on glossy screens, 30-50 % more denoised noise, a little more flicker. Its value is the energy, and phase B can get that without the extra pass.
- **Promotion to the denoiser repo: no, not now.**
  - Criterion 1 (generic inputs): mostly yes. It needs per-pixel radiance × confidence, confidence, direction, hit distance and the G-buffer. Two parts are ours: the snap to classify's traced pixels (that could become "any pixel with this frame's record"), and the source split, which exists for our composite's depth-aware blend.
  - Criterion 2 (helps a signal that isn't ours): not shown. It wasn't run on the denoiser repo's SSR pages or on RT-only reflections. On our own signal the denoised result is noisier, not better.
- **Phase B: yes, do it.** The same BRDF/pdf weights recover the energy:
  - lip loss 9 → 4.5 %, skirt 18 → 3 %;
  - the r 0.15 line comes back (peak 3 → 67 %).
  Done in front of the denoiser, they cost an extra 0.54 ms pass and add correlated noise. Inside FFX's prefilter, the reuse would happen where the samples are already being averaged, and the temporal resolve would see the same variance as before. See the end of this file.

## The blobs (per-pixel fixed tap pattern, radius 2)

Setting `rayReusePattern: 'frame' | 'pixel'` (flag bit 3, bench `s.rayReusePattern`; default 'frame'). Run on examples/ssr at 960x540 with `configStats`: 48 frames, against a 128-frame copy@4 raw reference. Data: `data/noise-pattern.txt`.

Denoised std (8-bit luma), mirrorWall floor r 0.2 / 0.3 / 0.4:

| config | denoised std |
|---|---|
| copy@1 | 0.39 / 0.45 / 0.45 |
| copy@4 | 0.29 / 0.34 / 0.34 |
| ratio, frame, r 4 (phase 1) | 0.53 / 0.64 / 0.65 |
| ratio, pixel, r 4 | 0.50 / 0.62 / 0.63 |
| ratio, frame, r 2 | 0.50 / 0.60 / 0.61 |
| ratio, pixel, r 2 | 0.47 / 0.59 / 0.62 |

Neither the pattern nor the radius is the cause: they account for a few %. The extra denoised noise follows the reuse itself. A likely mechanism, not proven: FFX's temporal resolve clips history to the neighbourhood's spread. The resolve cuts *spatial* variance (raw std −30-47 %) more than *temporal* change (each pixel still gets new rays every frame), so the clip box narrows while frames still differ, and less history survives. That would also explain why ratio@4 (all pixels traced, the same weights) keeps copy-level denoised noise.

## X0 page metrics (examples/ssr, page defaults: upscaler AA, FFX denoiser; reflection region)

Data: `data/page-metrics-ssr.jsonl`. Noise floor (W70): orbit std about 2 %; drift ≤ 0.03 or 10 %; single-run metrics about 5 %.

| scene | quad signal copy@1 / ratio / copy@4 | quad display | orbit std | rest drift (mean) | speckle % (signal) | energy loss |
|---|---|---|---|---|---|---|
| mirrorWall | 0.36 / **0.19** / 0.04 | 0.022 / 0.020 / 0.023 | 0.458 / 0.462 / 0.462 | 0.314 / 0.314 / 0.307 | 0.017 / 0.019 / 0.044 | 0.5 / 0.5 / 0.5 % |
| contact | 0.59 / 0.59 / −0.01 | 0.019 / 0.017 / −0.024 | 9.74 / 9.83 / 9.66 | 0.705 / **0.776** / 0.640 | 0.016 / 0.049 / 0.279 | 2.3 / 2.1 / 2.3 % |
| facingMirrors | 0.25 / 0.22 / 0.18 | 0.067 / 0.068 / 0.062 | 0.608 / 0.612 / 0.609 | 0.405 / 0.401 / 0.405 | 0.031 / 0.035 / 0.095 | 1.2 / 1.2 / 1.2 % |
| offscreen | 0.42 / 0.37 / 0.16 | −0.033 / −0.038 / −0.049 | 2.87 / 2.86 / 3.14 | 0.269 / **0.299** / 0.275 | 0.004 / 0.007 / 0.037 | 2.8 / 2.7 / 2.7 % |
| rooms | 0.72 / **0.31** / 0.00 | 0.091 / **0.025** / 0.018 | 0.354 / **0.367** / 0.329 | 0.131 / 0.130 / 0.116 | 0.034 / 0.074 / 1.63 | 2.8 / 2.2 / 3.0 % |

After the 1.5 px fix (`data/page-metrics-ssr-after-fix.jsonl`, copy@1 → ratio@1):
- rooms: quad display 0.072 → 0.024, quad signal 0.70 → 0.28, orbit 0.360 → 0.366 (+1.5 %), energy loss 2.9 → 2.2 %.
- mirrorWall: quad signal 0.34 → 0.18, orbit 0.469 → 0.469.
- contact: orbit 9.44 → 9.74. offscreen: orbit 3.17 → 3.03.
- The copy rows for contact and offscreen moved between the two runs: contact drift 0.705 → 0.800, orbit 9.74 → 9.44. The check sections ran on the GPU at the same time. Read contact and offscreen as within noise.

contact's grid doesn't move in the first run. Its floor is near-mirror, so the radius scales down to the quad. Speckle counts single-pixel outliers against their 5×5 neighbours. The resolve spreads a bright ray over a few pixels, and copy@4 has no copies to dilute it, so this column ranks the configs oddly. Read it next to quad.

## carConcept @ w50 (bench, W50's regions)

Two runs:
- **The first build (1 px taps on the floor):** `data/bench-metrics-carConcept-w50.jsonl`, the table below.
- **After the 1.5 px fix:** `data/bench-metrics-carConcept-w50-after-fix.jsonl`.
  - The floor (r 0.03) now takes no taps, so its regions read as copy: quad display door 0.288 → 0.294, car 0.115 → 0.117; orbit door 0.508 → 0.509; + RT wheel 1.057 → 1.074.
  - The skirt paint keeps its gain: lip energy loss 9.4 → 4.4 % (+ RT 14.3 → 4.5 %); lip quad signal 0.92 → 0.45.

First build:

| | ours denoised: copy → ratio | ours + RT: copy → ratio |
|---|---|---|
| quad display: door | 0.288 → **0.182** | 0.287 → **0.181** |
| quad display: car | 0.115 → 0.081 | 0.248 → 0.198 |
| quad display: wheel | 0.192 → 0.157 | 0.603 → 0.549 |
| quad signal: door | 1.00 → 0.60 | 1.00 → 0.66 |
| energy loss: lip | 9.3 → **4.5 %** | 14.3 → **4.6 %** |
| energy loss: door | 7.9 → 7.5 % | 8.0 → 7.7 % |
| energy loss: wheel | 13.2 → 13.4 % | 25.0 → 25.0 % |
| orbit std: door | 0.510 → 0.517 | 0.479 → 0.491 |
| orbit std: band | 0.244 → 0.257 (+5 %) | 0.787 → 0.800 |
| orbit std: wheel | 2.19 → 2.19 | 1.06 → 1.14 (+7 %) |
| orbit std: lip | 0.842 → 0.851 | 1.810 → 1.805 |

## Line spread (the double-blur gate) and thin silhouettes

Bench `lineSpread`, pose e15, PT 256 spp (raw), mean of 16 frames after 48 warm-up frames. Each cell is FWHM in px (ratio to the PT, peak as % of the PT's). "lost" means peak < 10 %. Every run threw away its first row: right after a scene load the PT reads peak 0 (`ptPeak: 0`, `pt: null`). Data: `data/line-spread.jsonl`; the copy + AA row is in commit `b8291d3`'s message.

**lineSpread (strip on the wall), denoised**

| config | r 0.05 (PT 3.57) | r 0.15 (PT 10.34) | r 0.3 (PT 33.3) | r 0.5 |
|---|---|---|---|---|
| copy@1, AA on (today) | 4.61 (x1.29, 46 %) | lost (3 %) | lost | lost |
| ratio@1, AA on, first build | 5.54 (x1.55, 42 %) | **9.91 (x0.96, 67 %)** | lost (2 %) | lost |
| **ratio@1, AA on, taps from 1.5 px (now)** | **4.62 (x1.30, 46 %)** | **9.86 (x0.95, 67 %)** | (unchanged: lost) | lost |
| copy@4, AA on | 4.61 (x1.29, 52 %) | 7.21 (x0.70, 16 %) | lost | lost |
| ratio@4, AA on (first build) | 4.95 (x1.39, 53 %) | 11.20 (x1.08, 82 %) | **22.4 (x0.67, 63 %)** | lost |
| ratio@1 + sameSurface, AA on | = ratio@1 | = ratio@1 | lost | lost |
| copy@1, AA off | 4.39 (x1.23, 63 %) | lost (8 %) | lost | lost |
| ratio@1, AA off (first build) | 5.29 (x1.48, 53 %) | **9.65 (x0.93, 85 %)** | lost (11 %) | lost |

- Raw and + RT follow the denoised column. With AA off at r 0.15: raw copy reads x1.48 at 41 %, raw ratio x1.14 at 85 %. At r 0.3: ratio + RT reads 18.4 (x0.55).
- **Over-blur relative to the default.** At r 0.05 the first build widened the line, x1.29 → x1.55. Its 1 px taps (4 · sat(5 · 0.05)) landed on the next quads. Now a radius under 1.5 px takes no taps, only the pixel's own quad, and r 0.05 matches copy. Floors at r ≥ 0.1 keep a radius ≥ 2, so the noise and energy numbers above are unchanged. At r 0.15 ratio is the only spq-1 config near the PT's width, slightly narrower (x0.95).
- **The energy recovery brings the r 0.15 reflection back, with AA on and with AA off.** The upscaler's clamp and the FFX denoiser (W70's finding 2) no longer erase it: the reused, BRDF-weighted signal is less sparse. At r 0.3, spq 1 isn't enough; ratio@4 is.

**lineSpreadThin (the floating strip: the thickness slab, X1 #2's case), denoised / + RT**

| | r 0.05 | r 0.15 | r 0.3 |
|---|---|---|---|
| copy@1 | x4.25 / x1.43 | x2.40 / x0.74 | x1.45 / x0.46 |
| ratio@1 | x4.36 / x1.43 | x2.60 / x0.74 | x1.54 / x0.46 |

Ratio spreads the slab's false hits 3-8 % wider. The slab itself is thickness (W70 finding 3), and + RT is unchanged.

The sphere fringe (D4303) is on the facing mirrors. Mirrors trace every pixel and the resolve skips them, so ratio can't change it. The carConcept sill's dark band is W50's `band`: orbit std +5 %, energy loss unchanged, and PT MAD 30.5 → 31.0 denoised (phase 1).

## GPU cost

examples/ssr at 1920x1080, `__p.time(30)`: per-pass medians with the loop stopped, the median of 3 interleaved copy / ratio / copy@4 rounds. Other agents shared the GPU, so read these as relative only. Data: `data/timing.json`.

| scene | copy@1 total | ratio@1 total (resolve, intersect) | copy@4 total |
|---|---|---|---|
| rooms (glossy floors and walls) | 0.473 | **1.043** (0.541, 0.262 vs 0.246) | 0.978 |
| mirrorWall (mirror floor, which the resolve skips) | 0.958 | 1.029 (0.048, 0.747 vs 0.727) | 1.058 |

- The record store in intersect costs +0.02 ms.
- The resolve costs about 0.55 ms on a glossy 1080p screen: up to 9 candidates per pixel, each loading its record, depth, normal and roughness.
- A workgroup-memory cache of the tile's records and G-buffer (8×8 plus a 4 px apron) would cut that a lot. Not done: it only matters if ratio stays.

## Phase B recommendation

**Recommend phase B** (BRDF/pdf weights replacing `radianceWeight` in FFX's prefilter, on a denoiser-repo branch the way W53 did it).

- **The weights are the win.** BRDF/pdf weighting:
  - halves the denoiser's energy loss on carConcept's lip (9.3 → 4.5 %; + RT 14.3 → 4.6 %);
  - cuts it on the skirt from 18 to 3 % (phase 1);
  - brings back the r 0.15 line (peak 3 → 67 %, x0.95 width).
  ratio@4 (every pixel traced, the same weights) keeps copy@4's denoised noise. So the weighting isn't what adds noise.
- **The separate pass is the cost.** It adds 0.54 ms on a glossy 1080p screen and 30-50 % more denoised noise (spatially correlated error, likely clipped history), plus a few % more orbit flicker. Neither the tap pattern nor the radius changes that (−5 %).
- **Inside the prefilter, the reuse happens where the samples are already being averaged.** The prefilter already gathers a neighbourhood per pixel. What it lacks is each sample's direction and pdf.
  - Phase A's records carry the direction and hit distance. The pdf is recomputed from the G-buffer, as here.
  - The seam would pass a direction texture (oct, rg16snorm-sized) or the record buffer.
  - The temporal resolve then sees the same variance it sees today, because the input is still white noise.
- What to measure there, with this file's metrics: the lip energy, the r 0.15 / 0.3 line, mirrorWall denoised std, orbit std and the cost.
- If phase B gets the energy at copy-level noise, `rayReuse: 'ratio'` stays an option for setups without the FFX denoiser (the D50 "resolve-less path").

## Files (phase 2)

- `packages/core/src/sssr/{shaders,sssr}.ts`: `rayReusePattern` (flag bit 3). Bench `s.rayReusePattern`; `docs/SETTINGS.md`.
- `scripts/`: `page-metrics.js`, `bench-metrics.js`, `line-spread.js`, `timing.js`.
- `data/`: `noise-pattern.txt`, `page-metrics-ssr.jsonl`, `bench-metrics-carConcept-w50.jsonl`, `line-spread.jsonl`, `timing.json`.
- Shader change after the metrics: taps only from a 1.5 px radius (`b8291d3`). It only affects perceptual r < 0.075, so the noise, page and carConcept numbers above (floors r ≥ 0.1, or mirrors) stand.
- Found, not mine: a non-manual examples/ssr load throws `TypeError: Cannot read properties of null (reading 'mipmaps')` in `packReflectionProbesTable` (ReflectionProbesNode.ts:76). It shows in the page log once per page load, before the metrics run. The metrics were unaffected.
