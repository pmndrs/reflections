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

TIMING_TABLE

## Answers

ANSWERS
