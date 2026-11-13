# W70 (X0): shared metrics and today's baseline

This is the SSR-sources experiment plan's stream X0 (`docs/plans/ssr-sources-experiments.md`) and TRIAGE T1.

- The API and the definitions are in `examples/shared/metrics/README.md`.
- The numbers are in `baseline.json` (written by `pnpm check -- --only ssr-exp-baseline`).
- Main at `0abd154`; 960x540, M-series GPU, headless Chrome. Other worktrees shared the GPU, so there are no timings here.

## Method

- **examples/ssr**: mirrorWall, contact, facingMirrors, moving, offscreen and rooms. The page's defaults: upscaler AA at ratio 1, FFX denoiser on, hit colour `current`, no RT. The loop is stopped, so `moving`'s object stands still.
  - Every page metric runs once (`__p.metrics.all()`).
  - Rest drift and orbit flicker run a second time on the same page and a third time after a page reload. That gives the noise floor.
  - Rest drift also runs with `?aa=off` and with `?upscale=quality` (ratio 1.5, 640x360 to 960x540).
- **Showcase via the bench** (`ours-denoised`, the bench's defaults: upscaler AA, hit colour `final`). Poses: carConcept at `w50` (W50's regions), the others at `hero`.
  - First, Measure against the PT (128 spp + OIDN, 48 warm-up, mean of 16) with ours denoised and ours raw, plus the new X0 columns.
  - Then every page metric on ours denoised, with rest drift and orbit flicker twice.
- **Line spread** (`lineSpread`, e15, floor r 0.05 / 0.15 / 0.3 / 0.5): the PT at 512 spp, raw. Methods: ours denoised, raw and + RT.
  - Runs at the bench defaults, again with AA off, and on `lineSpreadThin` (the floating strip).
- **Grazing** (`grazing`, floor r 0.15, elevations 5 / 15 / 30 / 60 degrees): the PT at 256 spp + OIDN, the same three methods.

Units: 8-bit display luma unless marked linear. "Glossy" / "reflection" = G-buffer perceptual roughness < 0.447.

## Noise floor (what change is real)

The same page with the same history gives the same numbers to about 0.01, because the pipeline is deterministic after a reset (blue noise by frame index). Across page reloads:

| metric | spread across 3 runs (ssr) / 2 runs (showcase) | treat as real |
|---|---|---|
| rest drift mean (reflection) | <= 0.03 (offscreen 0.28-0.31, contact 0.71-0.73; the others <= 0.01; showcase <= 0.003) | > 0.05 absolute, or > 10 % |
| rest drift % px > 8 | <= 0.07 points | > 0.1 points |
| orbit std (reflection) | <= 0.03 (contact 9.71-9.74, offscreen 3.15-3.17; the others <= 0.01; showcase <= 0.006) | > 0.05 absolute, or > 2 % |
| orbit d2, quad, pan, speckle, energy | single runs; deterministic after a reset on the same page | > 5 % relative (a guess, from the two above) |

## Baseline: examples/ssr (reflection region)

| scene | drift (runs 1 / 2 / 3) | % px > 8 | rest flicker | drift AA off | drift upscale 1.5 (unaligned) | orbit std (1 / 2 / 3) | orbit d2 | quad display / raw signal | pan d2 border / centre (glossy) | speckle % (signal) | energy loss |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mirrorWall | 0.31 / 0.31 / 0.30 | 0.05 | 0.01 | 0.03 | 0.39 (0.36) | 0.46 / 0.46 / 0.47 | 0.75 | 0.023 / 0.345 | 7.67 / 10.04 | 0.015 | 0.5 % |
| contact | 0.73 / 0.72 / 0.71 | 0.44 | **4.50** | 0.21 | 1.01 (6.17) | 9.71 / 9.71 / 9.74 | 12.24 | 0.017 / 0.614 | 21.25 / 16.39 | 0.016 | 2.3 % |
| facingMirrors | 0.40 / 0.40 / 0.40 | 0.03 | 0.01 | 0.04 | 0.50 (0.47) | 0.61 / 0.61 / 0.61 | 1.22 | 0.061 / 0.250 | 11.47 / 10.61 | 0.032 | 1.2 % |
| moving | 0.40 / 0.40 / 0.40 | 0.05 | 0.01 | 0.08 | 0.49 (0.48) | 0.58 / 0.58 / 0.57 | 0.96 | 0.053 / 0.503 | 8.62 / 10.84 | 0.043 | 2.2 % |
| offscreen | 0.31 / 0.31 / 0.28 | 0.28 | 1.59 | 0.04 | 0.35 (0.94) | 3.17 / 3.17 / 3.15 | 5.21 | -0.013 / 0.424 | 11.03 / 7.53 | 0.004 | 2.8 % |
| rooms | 0.12 / 0.12 / 0.13 | 0.00 | 0.00 | 0.10 | 0.25 (0.25) | 0.34 / 0.35 / 0.35 | 0.29 | 0.081 / 0.751 | 1.62 / 3.54 | 0.034 | 2.8 % |

## Baseline: showcase (glossy px; Measure vs PT 128 spp)

| scene @pose | glossy MAD dn / raw | std dn / raw | quad dn / raw / PT | speckle % dn / raw | drift (1 / 2) | rest flicker | orbit std (1 / 2) | orbit d2 | quad raw signal | pan d2 border (glossy) | speckle % (signal) | energy loss |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| carConcept @w50 | 13.7 / 13.0 | 0.049 / 0.20 | 0.047 / -0.081 / -0.010 | 0.002 / 0.01 | 0.265 / 0.264 | 0.007 | 0.391 / 0.391 | 0.33 | 0.864 | 0.68 | 0.054 | 3.0 % |
| toyCar @hero | 11.6 / 11.2 | 0.029 / 0.08 | 0.061 / -0.180 / 0.034 | 0.000 / 0.00 | 0.119 / 0.118 | 0.004 | 0.215 / 0.217 | 0.32 | 0.074 | 0.54 | 0.010 | 1.6 % |
| chess @hero | 9.9 / 9.7 | 0.026 / 0.07 | 0.070 / 0.029 / -0.031 | 0.002 / 0.00 | 0.127 / 0.130 | 0.003 | 0.222 / 0.222 | 0.32 | 0.020 | 0.54 | 0.034 | 2.1 % |
| sponza @hero | **43.1 / 28.5** | 0.064 / 0.10 | -0.005 / -0.012 / 0.005 | 0.027 / 0.03 | 0.315 / 0.317 | 0.011 | 0.561 / 0.567 | 5.32 | 0.342 | 7.09 | 0.332 | -0.4 % |

carConcept energy at w50 (linear, 64 frames; raw → denoised, loss):

| region | raw → denoised | loss |
|---|---|---|
| lip | 1.184 → 1.078 | 9.0 % |
| door (floor reflection) | 0.509 → 0.468 | 8.0 % |
| wheel | 0.198 → 0.171 | 13.7 % |
| car | 0.539 → 0.520 | 3.6 % |
| band | 0.679 → 0.686 | -1.1 % |

W45's 26-46 % was the paint itself at hero, before `hitLobeFilter`. These regions are W50's floor regions.

## Line spread (e15; FWHM in px, ours / PT; "lost" = peak < 10 % of the PT's)

| floor r | PT | bench defaults: denoised / raw / + RT | AA off: denoised / raw / + RT | floating strip: denoised / raw / + RT |
|---|---|---|---|---|
| 0.05 | 3.57 | 4.57 (x1.28) / 2.29 (x0.64) / 4.42 (x1.24) | 4.40 (x1.23) / 3.97 (x1.11) / 4.40 (x1.23) | **15.1 (x4.24)** / 14.4 (x4.04) / 4.77 (x1.34) |
| 0.15 | 10.35 | lost (peak 2 %) / lost / lost | lost (6 %) / 15.5 (x1.50, peak 37 %) / lost | 24.7 (x2.40, **peak x7.8**) / 21.9 / 7.16 (x0.70) |
| 0.3 | 33.0 | lost / lost / lost | lost / 37.5 (x1.14, peak 73 %) / lost | 47.0 (x1.45, **peak x70**) / 37.8 / 16.2 (x0.50) |
| 0.5 | 26.5 | lost / lost / lost | lost / lost / lost | (not run) |

## Grazing (floor r 0.15; glossy px; MAD / signed bias vs PT, gradient energy ours / PT)

| elevation | px | denoised | raw | + RT |
|---|---|---|---|---|
| 5° | 276k | 7.9 / -2.2, x0.81 | 33.2 / -23.1, x87 | 12.6 / -10.2, x0.94 |
| 15° | 310k | 10.0 / -3.0, x0.78 | 26.1 / -17.5, x28 | 20.1 / -17.9, x0.82 |
| 30° | 360k | 10.5 / -2.2, x0.81 | 17.9 / -9.5, x11.9 | 24.9 / -22.7, x0.82 |
| 60° | 454k | 13.9 / -2.4, **x0.52** | 14.9 / -3.8, x4.1 | 19.6 / -13.5, x0.59 |

## Findings (logged, not chased: not X0's lane)

1. **The upscaler's jitter is visible at rest on contact.** Consecutive frames differ by 4.5/255 mean on the reflection (W36's rest metric), 7.2 in a separate probe. That probe found 22 % px > 8/255, in blocks on the floor reflection. With AA off it is 0.09.
   - Phase-aligned drift (120 vs 240) is 0.73, so the image cycles with the 8-frame jitter: "jitter changes which rays validate" (backlog W39), frame to frame.
   - offscreen shows the same at 1.59; the other ssr scenes and the showcase are at <= 0.01.
   - Under `?upscale=quality` the jitter period is 18. Plain 120 vs 240 (different phases) reads 6.2 on contact against 1.0 aligned. `restDrift` aligns by default and reports the per-frame part as `rest`.
2. **The line-spread gate fails at today's defaults for a thin emitter.** With the stripe on a wall, r 0.05 is within 28 %. At r >= 0.15 the reflection is gone: the peak is 2 % of the PT's, raw and + RT too.
   - Neither `lobeFilter=0` nor `hit=current` brings it back.
   - With AA off, raw returns (r 0.15 x1.50, r 0.3 x1.14 width) but the denoised output is still lost. The upscaler's clamp and the FFX denoiser both remove the sparse glossy hits on a small bright emitter. This is the extreme case of W45's energy loss, and it bears on X2 and X3.
   - With AA off, the raw width at r 0.15 is 1.5x the PT's: the sampling alone already over-spreads.
3. **SSR thickness turns thin geometry into slabs** (`lineSpreadThin`, `lineSpreadThin-pt-raw-rt.png`; rows r 0.05 / 0.3, columns PT raw / ours raw / ours + RT).
   - The floating 1.5 cm strip reflects 4x too wide at r 0.05, and at r 0.3 with 70-83x the PT's peak: the 0.2 m + 10 alpha depth thickness accepts every ray passing behind it.
   - Ours + RT matches the PT there.
   - This is X1 #2's test case. A body behind the strip doesn't help, because it isn't in the depth buffer.
4. **Sponza: the denoised glossy MAD is worse than raw** (43.1 vs 28.5 vs the PT). Its speckle on the signal is 0.33 %, 10x the other scenes.
5. **Grazing.** The denoised output is over-blurred at every elevation: gradient x0.78-0.81, and x0.52 at 60°.
   - Ours + RT is darker than the PT by 10-23/255 there, so the traced hits on the emissive checker wall lose light. The emissive map at RT hits is a suspect (per-triangle hit materials, D1701 / D1702), not checked.
6. Quad energy: the raw signal's 2×2 ratio is 0.25-0.86. After the denoiser and AA it is <= 0.08 everywhere. carConcept's raw signal is the most quad-copied (0.86).

## Not done

- **T53's simple scenes** (cube on the mirror, thin plate). The procedural bench-scene path is there (`examples/shared/metrics/scenes.ts`: one `ShowcaseEntry` each), so adding them is one entry per scene plus a schema choice.
- **The pixi3d arcade's raw-signal speckle.** The pixi3d page has no `MetricsHost` yet.
- **Edge pan on carConcept** ran at `w50` only (the plan named facingMirrors and carConcept; both are in the baseline).
