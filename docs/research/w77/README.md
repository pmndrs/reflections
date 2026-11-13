# W77: the 'performance' preset, and half-res reflections x the upscaler

Maintainer's decision 4 (2026-11-13, SSR-sources results): ship half-res reflections as a "performance" preset, and test how reduced reflection resolution and the upscaler's render ratio interact.

Branch `worktree-agent-a236ab3f3d4eb74e3`, from main `62f7162`. Every number below was measured on that base (main `62f7162` + this branch's preset commits), before main's W79 / W80 merge. Port 5449, `DENOISER_REPO=~/Developer/Denoiser-w53-rebase` (denoiser#29, `240f39f`). DIVERGES rows: [diverges.md](diverges.md). HANDOFF row: [handoff-row.md](handoff-row.md).

**W76's future defaults are pinned in every run:** `hitColorFilter: 'cone'`, `mirrorBiasCompensate: true`, `mirrorBias: 0.5`. W76 is making them the defaults, so these numbers are what users will get. (Bench: URL keys; ssr page and showcase: set on `ssr.settings` by the scripts; the scripts wait for the cone's async intersect variant before measuring, and the timing rows record that it was active.) One control run without them is marked.

## The preset (what was built)

- **Core** (`packages/core/src/presets.ts`, plain data, engine-agnostic): `REFLECTION_PRESETS` (`default`, `performance`), `reflectionsPreset(name, overrides)` (explicit settings win key by key; `undefined` is ignored), `denoiserHitSourceOptions(mode)` (FFX's option names), types `ReflectionResolution`, `DenoiserHitSourceMode`.
  - `performance` = `{ tracer: { reflectionResolution: 'half' }, denoiser: { hitSource: 'hits' } }`.
  - `default` spells out the package defaults of every key another preset sets (`full`, `off`), so applying it undoes one.
- **three**:
  - `new ScreenSpaceReflectionsPass(renderer, { preset: 'performance', settings })`: `settings` override the preset.
  - `new HybridReflections(ssr, { preset: 'performance', denoiser })`: sets `denoiserHitSource` and the denoiser's own options through its `setOptions` (FFX: `separateHitSources` + `missesMatchAnySource`); an explicit `denoiserHitSource` wins. It warns once if the denoiser can't take a hit source (no silent no-op).
  - `hybrid.setDenoiserHitSource('off' | 'hits' | 'all')`, also kept for a denoiser attached later.
  - `applyReflectionsPreset({ ssr, hybrid }, name, overrides)` at runtime; returns `resolutionChanged` (the app rebuilds its composites, as for any `reflectionResolution` change).
- **Pages**: `?preset=` and `__p.setPreset(name, overrides)` on examples/ssr and the showcase; `?hitSource=` on examples/ssr. **Bench**: a `preset` select (first group): it sets the URL keys the preset names wherever the URL doesn't, and clearing one of them returns it to the preset's value.
- **Docs**: docs/SETTINGS.md has a generated "Presets" section (cost, trade-offs, when not to use it, with the upscaler), from `PRESET_DOCS` in the bench schema.
- **Checks**: `pnpm check -- --only preset` (also in `half-res` and `hybrid`): `?preset=performance` traces at half size with FFX's hit-source options on, and renders bit for bit what `?res=half&hitSource=hits` renders; explicit `?res=full&hitSource=off` wins over the preset; at runtime `default` undoes it and an override wins. `test/presets.test.ts`: the merge rules, `default` covers every key, FFX's options, and the bench's URL-key mapping against its schema.
- Babylon and pixi: not wired. Neither adapter has half-res reflections yet. They can read the same `reflectionsPreset()` data once they do.

## Method

- **Cells**: reflections {full (`default`), half + hitSource 'hits' (`performance`)} x upscaler render ratio {1 (native: the upscaler as TAA), 1.5 (quality), 2 (performance)}. Two reference cells at ratio 1 split the preset: half without hits, full with hits.
- **Error vs the path tracer**: bench Measure at 960x540 display, PT 16 spp + OIDN, 48 warm-up + 8 frames, MAD /255 per region, ours-rt (RT on; the hit source only acts with RT). carConcept at pose w50 (W50's lip / band / door / car / wheel regions); chess and Sponza at hero (frame / glossy). ours-denoised (no RT) in the jsonl too.
- **Flicker**: X0's `orbitFlicker` (std /255) and `restDrift` on ours-rt after each Measure (bench), and on examples/ssr's reflection region (mirrorWall, contact; RT, today's AA). A throwaway warm-up configuration ran first on every page. The bench metrics are deterministic: the carConcept page run twice agrees within 0.1 MAD and 0.01 std (`bench-carConcept-repeat.jsonl`).
- **Error on mirrorWall / contact** (no PT on that page): luma MAD of the settled frame vs full x1's (`ssr-framediff.txt`). Contact's frames carry its 4.6/255 rest flicker (X0), so its MADs are noisy.
- **Line spread**: X0's `lineSpread`, r 0.05 / 0.15, width ratio and peak vs the PT, per cell.
- **GPU ms**: 1080p display, render loop stopped, presets alternating inside one page (6 rounds x 20 frames, medians); the ratio is per page, run in ABBA page order, twice. Frame = three's render passes + core + denoiser + upsample + the upscaler's passes. **The GPU was shared** with 6 other agents' headless Chromes; the same cell varies up to 2.3x between pages. So the table takes the least-contended page per cell (min of the page medians), and also lists the in-page deltas. Treat the absolute ms as rough; the reflection part is the steadier number.

Scripts: [scripts/](scripts/) (`bench-matrix.*`, `ssr-matrix.*`, `linespread.js`, `timing.*`, `cells.js`, `summarise.py`, `timing-table.py`, `framediff.py`). Data: [data/](data/).

## Results

### Error vs the path tracer and flicker (bench, 960x540, ours-rt)

MAD /255; orbit = orbit-flicker std of the reflection region (band's in brackets for carConcept).

| cell | carConcept frame / lip / band / door / car | orbit (band) | chess frame / glossy | orbit | Sponza frame / glossy | orbit |
|---|---|---|---|---|---|---|
| full x1 | 7.8 / 41.8 / 30.6 / 14.1 / 14.8 | 0.36 (0.90) | 6.9 / 9.4 | 0.23 | 23.6 / 21.2 | 0.53 |
| **half+hits x1** | 8.4 / 36.7 / 39.3 / 15.4 / 16.5 | 0.51 (2.94) | 7.2 / 9.9 | 0.25 | 23.6 / 21.3 | 0.57 |
| full x1.5 | 8.2 / 40.5 / 30.9 / 13.8 / 15.7 | 0.41 (0.88) | 7.1 / 9.7 | 0.37 | 23.6 / 21.2 | 0.53 |
| half+hits x1.5 | 9.0 / 42.5 / 35.0 / 15.8 / 18.2 | 0.53 (2.93) | 7.5 / 10.3 | 0.36 | 23.6 / 21.3 | 0.57 |
| full x2 | 9.2 / 50.0 / 59.7 / 15.1 / 17.6 | 0.43 (1.51) | 7.4 / 10.1 | 0.41 | 23.7 / 21.5 | 0.56 |
| half+hits x2 | 9.7 / 50.9 / 37.3 / 19.4 / 19.9 | 0.55 (2.73) | 8.1 / 11.1 | 0.39 | 23.7 / 21.5 | 0.59 |
| ref: half, no hits, x1 | 8.9 / 50.0 / 57.9 / 15.5 / 17.5 | 0.41 (1.16) | 7.2 / 9.9 | 0.25 | 23.7 / 21.4 | 0.55 |
| ref: full + hits, x1 | 7.5 / 28.1 / 23.2 / 14.1 / 14.2 | 0.40 (1.32) | 6.9 / 9.4 | 0.23 | 23.6 / 21.1 | 0.54 |

Rest drift (reflection region) moves with the ratio more than with half res: carConcept 0.31 / 0.39 / 0.45 (full x1 / x1.5 / x2) vs 0.39 / 0.43 / 0.51 (half+hits); chess 0.17 / 0.20 / 0.26 vs 0.20 / 0.23 / 0.28; Sponza 0.30 / 0.33 / 0.38 vs 0.31 / 0.36 / 0.40.

### examples/ssr (mirrorWall, contact; RT, upscaler AA, FFX)

| cell | mirrorWall orbit / drift | MAD vs full x1 (% px > 8) | contact orbit / drift | MAD vs full x1 (% px > 8) |
|---|---|---|---|---|
| full x1 | 0.41 / 0.30 | 0 | 9.46 / 0.75 | 0 |
| **half+hits x1** | 0.43 / 0.32 | 1.11 (2.4 %) | 9.81 / 0.80 | 5.57 (15.8 %) |
| full x1.5 | 0.86 / 0.37 | 1.39 (3.7 %) | 9.14 / 0.89 | 3.94 (11.0 %) |
| half+hits x1.5 | 1.00 / 0.41 | 2.24 (6.0 %) | 9.30 / 0.92 | 7.80 (24.2 %) |
| full x2 | 1.11 / 0.49 | 2.47 (6.3 %) | 8.98 / 1.00 | 5.31 (16.4 %) |
| half+hits x2 | 0.99 / 0.41 | 3.80 (9.8 %) | 9.46 / 1.25 | 7.63 (24.2 %) |

Control, contact with today's defaults (no cone): full -> half+hits orbit x1 9.47 -> 9.60, **x1.5 8.39 -> 9.46 (+13 %)**: W75's +15 % reproduces. With the cone defaults it is 9.14 -> 9.30 (+2 %).

### Line spread (the thin bright strip; width x PT, peak / PT's peak; ours-rt)

| cell | r 0.05 | r 0.15 |
|---|---|---|
| full x1 | x1.19, 0.49 | x0.98, 0.14 |
| **half+hits x1** | x0.79, 0.13 | **lost** (0.06) |
| full x1.5 | x1.57, 0.32 | x1.11, 0.70 |
| half+hits x1.5 | **lost** (0.07) | x1.23, 0.46 |
| full x2 | x1.14, 0.19 | **lost** (0.08) |
| half+hits x2 | **lost** (0.00) | **lost** (0.01) |

The strip is 1.5 cm at 4 m: a pixel or two at 960x540. The peaks swing with where the samples fall on it (full x1.5 keeps more of r 0.15 than full x1), so read this as "survives or not", not as a ranking.

### GPU ms at 1080p (least-contended page per cell)

| scene | ratio | full: frame (reflections) | half+hits: frame (reflections) | in-page frame delta, median (pages) |
|---|---|---|---|---|
| carConcept | 1 | 24.7 (6.00) | 17.8 (2.62) | -6.85 (-6.9, -5.8, -27.7, -14.3) |
| carConcept | 1.5 | 8.8 (2.37) | 7.8 (1.25) | -1.06 (-1.1, +1.7, -3.8, -14.5) |
| carConcept | 2 | 8.7 (1.70) | 8.2 (1.04) | -0.52 (-0.5, -2.4, +1.3, -5.4) |
| chess | 1 | 15.8 (3.99) | 13.2 (1.62) | -3.59 (-5.7, -2.6, -3.6, -12.4) |
| chess | 1.5 | 11.1 (1.64) | 10.1 (0.80) | -1.07 (-3.7, -1.1, -1.0, -3.5) |
| chess | 2 | 13.2 (1.18) | 12.1 (0.69) | -0.91 (-0.6, -1.1, -1.3, -0.9) |
| sponza | 1 | 27.9 (3.34) | 25.7 (2.36) | -2.15 (-2.2, -2.2, +7.9, -17.8) |
| sponza | 1.5 | 14.1 (1.28) | 13.8 (1.18) | -0.30 (-2.4, -0.3, -6.7, +4.5) |
| sponza | 2 | 13.1 (0.89) | 14.4 (0.89) | +1.32 (+0.6, +1.3, +3.3, -3.0) |
| mirrorWall | 1 | 32.7 (10.71) | 30.1 (5.01) | -3.81 (-2.5, -6.3, -3.8, -7.1) |
| mirrorWall | 1.5 | 11.3 (3.23) | 11.0 (2.45) | -3.31 (-6.1, -0.3, -3.3) |
| mirrorWall | 2 | 9.2 (1.53) | 9.3 (2.24) | +0.14 (+0.1, -0.5, +0.5, -1.5) |
| contact | 1 | 41.3 (12.40) | 36.5 (7.39) | -5.17 (-4.4, -16.1, -5.9, -5.2) |
| contact | 1.5 | 27.4 (5.17) | 26.2 (3.79) | -1.79 (-1.2, -8.6, -2.8, -1.8) |
| contact | 2 | 21.5 (2.73) | 19.6 (2.51) | -0.17 (-1.9, -0.2, -1.0, +1.5) |

Frame = the whole 1080p frame (G-buffer and lighting at the render size, reflections, denoiser, upsample, the upscaler at display size); reflections = core passes + denoiser + upsample. 4 pages per cell (3 for mirrorWall x1.5: one page hung under contention). The in-page deltas swing by several ms between pages: they agree in sign at ratio 1 everywhere, not at 2.

## Answers

**1. Which combinations give the best quality per ms?**
- **The render ratio is the big lever, not the reflection resolution.** Upscaling at 1.5 shrinks the whole frame: carConcept 24.7 -> 8.8 ms, chess 15.8 -> 11.1, Sponza 27.9 -> 14.1. Error barely moves: carConcept frame MAD 7.8 -> 8.2, chess 6.9 -> 7.1, Sponza 23.6 -> 23.6. Half res only shrinks the reflection passes: carConcept 6.0 -> 2.6 ms of a 24.7 ms frame.
- **Ratio 2 is not worth it over 1.5.** The frame is about the same (carConcept 8.7 vs 8.8; chess and Sponza within the noise), but quality drops: carConcept band 30.9 -> 59.7 and lip 40.5 -> 50.0, the thin strip is lost at r 0.15, and mirrorWall orbit flicker goes 0.86 -> 1.11.
- **Ranking, best quality per ms first:**
  1. full x1.5;
  2. half+hits x1.5 (about another 1 ms; carConcept frame MAD +0.8, reflection orbit +30 %);
  3. half+hits x1 (when the ratio has to stay at 1);
  4. anything at x2.
- **Where the preset pays.** At ratio 1 it is a clear saving where reflections are a big share of the frame: mirrorWall 10.7 -> 5.0 ms of reflection work, contact 12.4 -> 7.4.

**2. Half reflections at native vs full reflections at upscale 1.5, at similar cost?**
- The two cost about the same in reflection work: carConcept 2.6 vs 2.4 ms, chess 1.6 vs 1.6. In whole-frame cost, x1.5 is far cheaper (carConcept 17.8 vs 8.8 ms).
- **Error vs the PT: full x1.5 is as good or better.**
  - carConcept: frame 8.2 vs 8.4, band 30.9 vs 39.3, door 13.8 vs 15.4; the lip is the exception, 40.5 vs 36.7 in half's favour, from the hit source.
  - chess: 7.1 vs 7.2.
  - Line spread: x1.5 keeps the strip at both roughnesses; half x1 loses r 0.15.
- **Flicker in motion: half x1 is better on mirrors and chess.**
  - Orbit std: mirrorWall 0.43 vs 0.86, chess 0.25 vs 0.37, contact 9.81 vs 9.14. mirrorWall's settled frame is also closer to full x1 (MAD 1.11 vs 1.39).
  - The upscaler's reconstruction in motion costs more stability than half-res reflections do.
  - carConcept is the exception: 0.51 vs 0.41, because of the hit source (see below).
- **Verdict:** upscale 1.5 first if the app can. Use half reflections when the ratio must stay at 1, or when orbit flicker on mirrors matters more than accuracy at silhouettes.

**3. Where exactly does stacking compound?**
- **Thin bright detail.** The line-spread strip survives one 2x step in the reflection's pixel pitch (half at x1, or x2 alone at r 0.05), not two. At half+x1.5, r 0.05 is lost (0.07 of the PT's peak); at half+x2 both roughnesses are lost.
- **carConcept body at x2.** Half adds +4.3 door MAD at x2, against +1.3 at x1 and +2.0 at x1.5. Car: +2.3 vs +1.7. The frame and the lip add up, with no compounding.
- **mirrorWall orbit at x1.5.** Half adds +17 % there, against +5 % at x1; at x2 it is -10 % (the x2 base is already 2.7x x1's).
- **contact rest drift at x2.** Half adds +25 % (1.00 -> 1.25), against +7 % at x1.
- **Not compounding:**
  - orbit flicker on carConcept, chess and Sponza (half adds the same or less at every ratio);
  - carConcept's band (the hit source helps more at higher ratios: x2 59.7 -> 37.3).
- **W75's +15 % contact flicker at x1.5 is gone under the future defaults.** Without the cone it reproduces (+13 %, 8.39 -> 9.46). With cone + compensation it is +2 % (9.14 -> 9.30): the cone raises full x1.5's own flicker, so half adds little on top.
- **Cost.** Half's fixed passes (the half-res sample, ~0.2-1.2 ms; the upsample, ~0.15-2 ms, both scaling with the display size) eat its saving at x2. Sponza's frame goes +1.3 ms, and mirrorWall's reflection part goes 1.5 -> 2.2 ms.

**4. What the preset's docs should recommend** (now in docs/SETTINGS.md, "Presets"):
- Use `performance` at ratio 1, when reflections are a large share of the frame: RT on, mirror floors, 1080p and up.
- At ratio 1.5 it still saves ~1 ms but stacks: thin emitters vanish, and orbit flicker on mirrors goes +17 %.
- Don't combine it with ratio 2: there is no saving, and both thin features and silhouettes get worse.
- If the app can choose, upscale 1.5 first and keep full-res reflections.
- It is wrong for mirror close-ups (jagged reflected edges, W75) and for neon or specular strips on glossy floors.

## Finding for the maintainer: the hit source trades error for flicker on carConcept

- **Error:** the preset's `hitSource: 'hits'` brings carConcept's band from 57.9 to 39.3 and the lip from 50.0 to 36.7 at half res (W75's reason to pair them).
- **Flicker:** it also triples the band's orbit flicker (1.16 -> 2.94) and raises the reflection region's from 0.41 to 0.51 (+24 %, against half without it). At full res it does the same, more mildly: band 0.90 -> 1.32.
- This is the stair step at source edges (D3663) moving under the camera. It reproduced on a second page, within 0.01.
- **Elsewhere:** chess, Sponza and the ssr scenes see no difference. Without RT it does nothing.
- **The question:** flicker ranks above accuracy in TRIAGE. Should `performance` drop the hit source (band 58, flicker as full) or keep it (band 39, carConcept +24 % orbit)?
- The preset ships as decided (with 'hits'). This is a proposed decision-page question, not a change made here.

## Checks (after merging main 22adc27)

- `pnpm typecheck` and `pnpm test` (19 files, 75 tests) pass.
- `pnpm check` preset, ssr, hybrid, half-res, showcase, bench, regressions: 135 PASS, 1 FAIL ([checks.txt](checks.txt)).
- The failure is W75's "runtime switch full -> half -> full ends identical" at max 1/255 (mean 0.000). The same check passed in the hybrid section two minutes earlier, and passed again when the half-res section was re-run ([checks-half-res-rerun.txt](checks-half-res-rerun.txt)). It reads as a sub-pixel flake under a shared GPU (backlog line in handoff-row.md).

## Not done

- 1440p; a quiet GPU. The timings here were taken next to other agents' runs; re-time on an idle machine before quoting absolute ms.
- Babylon / pixi preset wiring (no half-res path there yet).
- Contact's per-frame MAD comparisons include its 4.6/255 rest flicker. A K-frame mean (as the bench's Measure takes) would settle them.
