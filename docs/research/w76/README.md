# W76: the maintainer's SSR-sources decisions 1, 2 and 5

Branch `worktree-agent-a9fe942389106ffc7`, from main 62f7162; main 22adc27 (W79, W80) and then W77's presets merged in. Port 5448, `DENOISER_REPO=~/Developer/Denoiser-w53-rebase` (denoiser#29, `240f39f`). DIVERGES: [diverges.md](diverges.md) (D5100-D5104 and the status changes). HANDOFF row: [handoff-row.md](handoff-row.md).

## What changed

### 1. Cone hit colour + compensation is the default

- Core resolves the defaults in one place, `resolveScreenSpaceSettings()` (`packages/core/src/sssr/sssr.ts`), called by every dispatch:
  - `hitColorFilter` 'cone' (`DEFAULT_HIT_COLOR_FILTER`);
  - `mirrorBiasCompensate` true (`DEFAULT_MIRROR_BIAS_COMPENSATE`);
  - `mirrorBias` 0.5 when both are on (`DEFAULT_COMPENSATED_MIRROR_BIAS`), else 0.
- An explicit value always wins. Every one stays a setting.
- **The switch back: `hitColorFilter: 'off'`.** With it, compensation has no filter to hand the bias to and `mirrorBias` falls back to 0, which is the pre-W76 tracer bit for bit (below). `mirrorBiasCompensate: false` keeps the cone alone (W72's "cone" option).
- The RT pass takes its lobe split (and the cone scale) from what the tracer ran (`outputs.settings`, D5103) unless its own settings give one; the three adapter no longer passes the raw settings.
- Adapters: three, pixi and babylon all dispatch core, so they all get it. Checked on a real GPU: three (every section below), pixi3d arcade and babylon (new checks: the tracer ran `cone`, `mirrorBias` 0.5, compensation on, active, no GPU errors).
- Bench / SETTINGS: the defaults show as cone / 0.5 / on; the bench rows show the effective value of an unset field (`ours.ts` `get()`), and `describe()` (ssr page, bench) carries the effective values.

### 1b. The grazing shrink on the cone

X1 #3's `coneTan *= lerp(sat(2 NdotV), 1, sqrt(r))` now acts on the cone's mip: setting `hitColorConeGrazing` (0..1, SSSR word 143, D5100). W71's `hitLobeFilterGrazing` (the same formula on `hitLobeFilter`, SSSR + RT) is removed: the runs with and without its lobe-filter half give the same denoised numbers to 0.01 (data/grazing-g1-both.jsonl vs data/grazing-cone.jsonl).

X0 grazing (bench `metrics.grazing`, r 0.15 floor, PT 256 spp + OIDN; denoised MAD / gradient ratio vs the PT):

| config | 5 deg | 15 deg | 30 deg | 60 deg |
|---|---|---|---|---|
| pre-W76 default | 7.74 / x0.79 | 9.97 / x0.75 | 10.54 / x0.78 | 13.91 / x0.50 |
| new default (shrink 0) | 6.98 / x0.53 | 8.91 / x0.53 | 10.13 / x0.68 | 13.94 / x0.50 |
| shrink 0.5 | 6.49 / x0.59 | 9.05 / x0.58 | 10.16 / x0.69 | 13.94 / x0.50 |
| shrink 1 | 6.50 / x0.67 | 9.24 / x0.63 | 10.19 / x0.71 | 13.94 / x0.50 |

Raw MAD at 5 deg: pre-W76 32.1, new 7.1, shrink 1 9.6-11.4.

Line spread (`metrics.lineSpread`, e15, PT 512 spp; width ratio vs the PT, denoised / + RT; the gate is x0.9-1.1):

| config | r 0.05 AA on | r 0.15 AA on | r 0.05 AA off | r 0.15 AA off |
|---|---|---|---|---|
| pre-W76 default | x1.24 / 1.30 | lost / lost | x1.23 / 1.24 | lost / lost |
| new default (shrink 0) | x1.19 / 1.24 | **x1.01 / 0.99** | x1.19 / 1.19 | **x0.96 / 0.95** |
| shrink 0.25 | x1.19 / 1.25 | x0.97 / 0.95 | | |
| shrink 0.5 | x1.19 / 1.24 | x0.91 / 0.90 | x1.20 / 1.20 | x0.86 / 0.86 |
| shrink 1 | x1.19 / 1.25 | x0.84 / 0.84 | x1.20 / 1.20 | x0.93 / 0.92 |

**Verdict: kept as an option of the cone, default 0 (off).** (The maintainer's priority, flicker > noise > colour > sharpness, puts sharpness last; the line-spread gate is what the cone default rests on.) It measurably recovers part of the grazing sharpness (x0.53 -> x0.67 at 5 deg at full strength, about half of what the cone + compensation lost), so it is not removed. But the thin r 0.15 line, the reason the cone default was chosen, is seen at 15 deg, and the shrink makes it too sharp: out of the +-10 % gate at 0.5 (RT, AA off) and at 1 (AA on). The maintainer may still prefer the grazing floor; then 0.25 is the most the gate allows (x0.97 / 0.95).

### 2. 'relative' thickness 0.02 when ray tracing is on

- In core's resolution, keyed on `missesTraced` (the three adapter sets it while its traced pass runs; a direct core user sets it on the dispatch): unset `thicknessDepthMode` -> 'relative', and an unset `thicknessDepthFactor` -> 0.02 when the mode resolves to 'relative' (`RT_THICKNESS_DEPTH_FACTOR`). So `thicknessDepthMode: 'add'` or `thicknessDepthFactor: 0` alone restores the old thickness with RT; an explicit factor keeps 'relative' as the mode with RT.
- docs/SETTINGS.md has a generated section, **"What changes when ray tracing is on"**: the schema's new `rtDefault` / `rtWhy` fields (thickness factor and mode), plus `RT_BEHAVIOUR` for what the RT path does differently without a setting (missesTraced, D3542's on-screen re-shade without the visibility ray, specular occlusion skipping traced misses, `hitLobeFilterMixed` acting only with RT, ratio reuse leaving traced pixels, the traced lobe split). No other RT-specific default existed: W52's and W53's options are all off by default with or without RT.
- The bench shows the effective value (relative / 0.02 on ours + RT) and the Default column says "with RT on: ...".

### 3. Removed

`historyEdgeConfidence`, `halfResMinRoughness` with the full-res mirror path (three `traceMinRoughness`, `mirrorTargets()`, `mirrorPath`, the composite's `upsampled.mirror`, core `minRoughness`, the upsample's `minRoughness`, `?res=mixed`), and `hitLobeFilterGrazing` (with the RT pass's second pipeline). Params words kept as padding with a comment (SSSR 144 bit 0, 157; RT 67; upsample 37). Experiments and reasons: `docs/research/ssr-sources-results.md` "Removed options", DIVERGES D5002 / D5003 / D5084.

### Also

- `?s.<field>=<value>` on examples/ssr and the showcase (examples/shared/ssrQuery.ts) sets the pass's settings from the first frame (D5104).
- sssr-core: comparisons warm the cone (its intersect variant builds asynchronously; a tracer runs 'off' until it resolves, so a fresh tracer and a warm one disagreed).

## Default off = main

`scripts/identical.sh` (W75's captures): ssr page offscreen, contact, mirrorWall, facingMirrors, moving (RT on raw and denoised, RT off denoised), showcase carConcept + RT and Sponza; frameIndex 5, occupancy 0, 12 frames, AA off. This branch with `?s.hitColorFilter=off&s.thicknessDepthFactor=0` against a build of main **22adc27** (after the merge), both on port 5448 with the sources swapped (`git checkout main -- packages examples src`), one warm-up load each:

- every raw-output hash (radiance, hit distance, confidence, RT source) equal on all 16 ssr / carConcept captures; finals **0/255, 0 px** on all 17;
- Sponza: final 0/255, its radiance hash differs, but it differs between runs of main itself (3 hashes in 3 runs).

**Re-run after merging W77's presets**, against a build of main **d844ce2**: every raw-output hash equal on all 17 captures (Sponza included this time), finals 0/255 (0 px).

Data: data/ident-*.log, data/ident-finals.txt. Two harness traps on the way (documented in the scripts): a second server on another root, and settings applied after page load (RT budget feedback and the probe state carry the first frames), both gave false differences; same server + URL settings from the first frame gives the result above.

## Checks

Final, after both merges (port 5448, denoiser#29): typecheck clean, test 75; `pnpm check` sssr-core 42, ssr 33, hybrid 19 (incl. half-res), ssr-rt 29, ssr-rt-bvh 39, showcase 8, regressions 54, bench 9, ssr-exp-metrics 3, pixi3d 12, babylon 9, preset 7: all pass ([data/checks-final.txt](data/checks-final.txt)). New W76 lines: [data/checks-w76-lines.txt](data/checks-w76-lines.txt).

### Checks whose expectations changed

Each failed at the new defaults first, then was changed (scripts/run-headless.mjs):

- **sssr-core**: subgroup / workgroup parity and the X1 identities compared a tracer still on 'off' (the cone builds asynchronously) with one on 'cone'; the page now warms the cone before comparing (`warm()`). New: the W76 default cases (absent = explicit cone + compensation 0.5; 'off' alone = the pre-W76 explicit path; `missesTraced` = 'relative' 0.02; `missesTraced` + mode 'add' or factor 0 = RT off's thickness) and that the defaults act. `hitLobeFilterGrazing` / `historyEdgeConfidence` identities replaced by `hitColorConeGrazing`.
- **ssr, W72 hitColorFilter check**: it encoded "unset = 'off'"; now unset = explicit cone + compensation 0.5 = 'cone', 'off' = 'off' + compensation (ignored). The glossy raw-radiance mean bound: the cone alone stays within 10 % of off (1.003); the compensated default reads +13 % (the narrower sample validates more hits, and raw radiance is confidence x hit over a black fallback), bound 0.9-1.25. The rt=1 case: unset = explicit default, stable.
- **ssr, rayReuse and mirrorBias (D49) checks**: run with `hitColorFilter: 'off'` (they test the copy path and D49's truncation; the async cone changed the hash mid-check, and with compensation the bias narrows instead of truncating).
- **ssr-rt / ssr-rt-bvh**: D901's hit shading vs on-screen colour (contact, @pmndrs/bvh 1.08 -> 1.10 against a 10 % bound) and D4702's mixed-size atlas check (each probe set rebuilds the tracer, whose cone comes up a few frames later) run on the pre-W76 rays: they test hit shading and atlases, calibrated on that ray set.
- **hybrid, half-res**: the 'mixed' check went with `halfResMinRoughness`; shots wait for the cone after a resolution switch (the pass recreates its tracer on the next trace, and the old tracer's flag passed the wait: full -> half -> full max 133/255 until fixed, 0 after).
- **ssr-exp-x1**: no `historyEdgeConfidence` edge-pan check; with RT the X1 defaults compared are W76's ('relative' 0.02).
- **New adapter checks**: pixi3d arcade and babylon run the cone at 0.5 with compensation without any settings, and 'off' still switches it off (pixi).

## Performance

**Rough only: re-time on a quiet machine.** The GPU was shared with other worktrees all session (the maintainer dropped the quiet-GPU measurement); passes this change doesn't touch moved up to 6x between configs. Loop stopped, RT on, AA off, 8 interleaved rounds x 20 frames, medians ([data/timing-1.jsonl](data/timing-1.jsonl), scripts/timing.sh):

| | carConcept 1080p | Sponza 1080p | mirrorWall 1080p | carConcept 1440p | Sponza 1440p | mirrorWall 1440p |
|---|---|---|---|---|---|---|
| hit colour pyramid (new pass) | 0.26 | 0.25 | 0.27 | 0.44 | 0.48-0.63 | 0.17 |
| intersect old -> new | 1.64 -> 1.40 | 0.54 -> 0.51 | 2.27 -> 2.36 | 2.44 -> 2.47 | 1.26 -> 1.06 | 4.10 -> 4.71 |
| traced rays old -> new (RT thickness) | 259k -> 259k | 35.0k -> 40.1k (+15 %) | 66.1k -> 68.1k (+3 %) | 467k -> 466k | 67.8k -> 76.8k (+13 %) | 130k -> 133k |
| rt trace old -> new | 4.30 -> 4.48 | 1.59 -> 1.69 | 0.24 -> 0.24 | 7.47 -> 7.41 | 2.83 -> 2.97 | 0.37 -> 0.38 |

So: the cone costs one pass, ~0.25 ms at 1080p and ~0.45-0.6 ms at 1440p (W72 measured 0.24-0.26 at 1080p); the intersect moves within the noise; the relative thickness costs traced rays where thick geometry used to catch them (Sponza +13-15 %, ~+0.1 ms of RT trace). These are in the schema's `cost` (SETTINGS.md), marked "re-time on a quiet machine".

## Baseline at the new defaults vs W70

`pnpm check -- --only ssr-exp-baseline` (with `SSR_EXP_MEASURE_METHODS=ours-denoised,ours-raw,ours-rt`) into [baseline.json](baseline.json); `scripts/compare.py` against W70's: [data/baseline-compare.md](data/baseline-compare.md). Same machine, 960x540, the page / bench defaults (upscaler, denoiser), so the ssr pages are RT off; the RT side is below.

**Flicker (the maintainer's first priority): no rise beyond the noise floor** (drift <= 0.05 abs or 10 %, orbit std 2 %):

| reflection region | rest drift W70 -> W76 | orbit std W70 -> W76 |
|---|---|---|
| mirrorWall | 0.307 -> 0.309 | 0.462 -> 0.470 (+1.7 %) |
| contact | 0.732 -> 0.776 (+0.044) | 9.71 -> 9.83 (+1.2 %) |
| facingMirrors | 0.404 -> 0.406 | 0.611 -> 0.607 |
| moving | 0.403 -> 0.400 | 0.578 -> 0.569 |
| offscreen | 0.306 -> 0.299 | 3.17 -> 3.17 |
| rooms | 0.123 -> 0.116 | 0.344 -> 0.344 |
| carConcept @w50 (bench) | 0.265 -> 0.271 | 0.391 -> 0.394 |
| toyCar / chess / Sponza | 0.119 -> 0.120 / 0.127 -> 0.130 / 0.315 -> 0.300 | 0.215 -> 0.213 / 0.222 -> 0.221 / 0.561 -> 0.555 |

Rest flicker (per frame) unchanged everywhere (contact 4.50 -> 4.51). One flag, rooms rest drift with AA off 0.096 -> 0.381, is the cone coming up mid-measurement after the page load (its pipelines build asynchronously; the machine was loaded): re-measured on fresh pages once the cone ran, 0.08 new vs 0.10 pre-W76 ([scripts/drift.js](scripts/drift.js)). That is a real, if brief, effect worth knowing: **a new tracer (page load, resize, a rebuild) runs the old path for its first frames and then switches**, a one-time pop (Left).

With RT on (examples/ssr, ?rt=1, new vs `?s.hitColorFilter=off&s.thicknessDepthFactor=0`, two runs each; [data/flicker-rt.jsonl](data/flicker-rt.jsonl)): contact drift 0.79 / 0.65 vs 0.76 / 0.75 (the page's own spread is 0.14), orbit std 9.38 / 9.47 vs 9.57 / 9.46, d2 11.3 vs 11.7; mirrorWall drift 0.301 vs 0.302, orbit 0.410 vs 0.409; offscreen drift 0.344 / 0.350 vs 0.345 / 0.333, orbit 2.82 / 2.53 vs 2.83 / 2.54. The cone alone and the relative thickness alone are inside the same spread. No flicker cost from either default.

**Noise**: raw 2x2 (the quad copy's grid in the denoiser's input) down where the cone acts (mirrorWall 0.345 -> 0.137, rooms 0.751 -> 0.509); raw grazing MAD 33 -> 7.5 at 5 deg (the cone's firefly cut). Speckle: Sponza 0.332 -> 0.353 %, facingMirrors 0.032 -> 0.040 %, others within 0.003.

**Colour / energy**: glossy MAD vs the PT carConcept 13.75 -> 13.61, toyCar 11.56 = 11.56, chess 9.89 -> 9.82, Sponza 43.09 -> 43.00; with RT 8.66 / 11.56 / 9.70 / 28.09 (no W70 RT column). carConcept regions unchanged to 0.1 (lip 114.1, band 161.1, door 13.8). Denoiser energy loss carConcept 3.0 -> 4.2 %, others within 1 point.

**Sharpness**: line spread r 0.15 comes back (x0.98 AA on, x0.95 AA off; lost before); r 0.05 x1.28 -> 1.23 (AA off 1.23 -> 1.19); the grazing floor is softer (denoised gradient x0.81 -> x0.54 at 5 deg, x0.78 -> x0.54 at 15), the known cost of the cone (1b). Thin strip (`lineSpreadThin`): + RT r 0.05 x1.34 -> x1.26, but **+ RT r 0.15 goes from x0.70 (peak 0.95) to lost (peak 0.06)**: not split yet between the cone + compensation and the relative thickness (W71 measured only r 0.05 with RT); denoised (RT off) r 0.15 x2.40 -> x2.02 and the r 0.3 slab (70x peak) is gone.

## Left

- **A new tracer runs 'off' for its first frames.** The cone's intersect variant and the downsampler's kernels build with `createComputePipelineAsync` per tracer (W72), so after a page load, a resize or a tracer rebuild (probe set change, `hitLobeFilterMixed` crossing 1) the frames until it resolves run the pre-W76 path (and a compensated bias as 0), then switch: a one-time pop. Checks wait for it now. Fine-tune: cache the cone pipelines per device across tracers, or warm them when the tracer is created.
- Thin geometry with RT at r 0.15 (`lineSpreadThin` + RT): lost at the new defaults (x0.70, peak 0.95 before). Not yet split between the cone + compensation and the relative thickness: one `lineSpread({ scene: 'lineSpreadThin' })` run with each switched off would say which.
- Timings are rough (shared GPU): re-time the pyramid pass, the intersect and the RT-thickness ray counts on a quiet machine.
- The grazing shrink at 0.25 is the most the line-spread gate allows (x0.97 / 0.95); the maintainer may still want the grazing floor over the thin line.
- D5024: the RT pass's on-screen reused hits read the pyramid without the grazing shrink (moot while it is off).
- Bit identity was compared on Metal only (as W71-W75).
- `pnpm test` once timed out on three heavy CPU tests (5 s limit) while the machine was loaded; 75/75 pass after the last merge.
