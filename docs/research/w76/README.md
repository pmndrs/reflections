# W76: the maintainer's SSR-sources decisions 1, 2 and 5

Branch `worktree-agent-a9fe942389106ffc7`, from main 62f7162, main 22adc27 (W79, W80) merged in. Port 5448, `DENOISER_REPO=~/Developer/Denoiser-w53-rebase` (denoiser#29, `240f39f`). DIVERGES: [diverges.md](diverges.md) (D5100-D5104 and the status changes). HANDOFF row: [handoff-row.md](handoff-row.md).

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

**Verdict: kept as an option of the cone, default 0 (off).** It measurably recovers part of the grazing sharpness (x0.53 -> x0.67 at 5 deg at full strength, about half of what the cone + compensation lost), so it is not removed. But the thin r 0.15 line, the reason the cone default was chosen, is seen at 15 deg, and the shrink makes it too sharp: out of the +-10 % gate at 0.5 (RT, AA off) and at 1 (AA on). The maintainer may still prefer the grazing floor; then 0.25 is the most the gate allows (x0.97 / 0.95).

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

Data: data/ident-*.log, data/ident-finals.txt. Two harness traps on the way (documented in the scripts): a second server on another root, and settings applied after page load (RT budget feedback and the probe state carry the first frames), both gave false differences; same server + URL settings from the first frame gives the result above.

## Checks whose expectations changed

CHECKS_CHANGED

## Performance

PERF

## Baseline at the new defaults vs W70

BASELINE

## Left

LEFT
