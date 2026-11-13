# W71 (X1): four small core settings, phase 1

Stream X1 of `docs/plans/ssr-sources-experiments.md` (#1-#4 of `docs/research/ssr-external-sources.md`). Branch `worktree-agent-a2bcf484583d8b4ed`, port 5443. Phase 1 = build, prove the defaults identical, first numbers with the tools on main (the bench's Measure vs the path tracer). Phase 2 (after X0's shared metrics land) decides each setting per the plan's "Decides" lines.

## Settings

| # | setting (core `ScreenSpaceReflectionsSettings`) | default | Params | bench key | DIVERGES |
|---|---|---|---|---|---|
| 1 | `quadBaseRotation: 'fixed' \| 'frame' \| 'pattern'` | 'fixed' (FFX top-left) | u32 141 | `s.quadBaseRotation` | D5000 |
| 2 | `thicknessDepthFactor` (k) + `thicknessDepthMode: 'add' \| 'relative'` | 0, 'add' | f32 142, bit 1 of u32 144 | `s.thicknessDepthFactor`, `s.thicknessDepthMode` | D5001 |
| 3 | `hitLobeFilterGrazing` (0..1), SSSR re-shade + RT (`TracedReflectionsSettings.hitLobeFilterGrazing`) | 0 | f32 143; RT f32 67 | `s.hitLobeFilterGrazing` | D5002 |
| 4 | `historyEdgeConfidence` | false | bit 0 of u32 144 | `s.historyEdgeConfidence` | D5003 |

`PARAMS_SIZE` 576 -> 640 (words 145-159 padded for X2 / X3); `RT_PARAMS_SIZE` 272 -> 320 (68-79 padded). The three adapter passes core settings through as before and the tracer's `hitLobeFilterGrazing` to the RT pass unless `traceSettings` sets one. `docs/SETTINGS.md` regenerated.

Notes on scope:
- #4 applies only where intersect reads last frame's colour: `hitColor: 'history'` **and** `hitShading: 'off'`. With the re-shade (the package default and the showcase's) a hit's colour is this frame's, so the setting does nothing there. The RT pass's on-screen reuse with history (D906) isn't covered.
- #3 in SSSR acts only in the re-shade (where the lobe filter lives).
- #3 on the RT side is compiled into a second trace pipeline, built on first use with g > 0 (see "Default identical").

## Default identical

1. **Same build, absent vs explicit default** (`--only sssr-core`, new `x1CoreChecks`): each of the five fields at its default, and all at once, gives the same ray / tile / miss lists and radiance / hit distance bit for bit (rays 123689, misses 4210, 0 px). `--only ssr-exp-x1` (new): examples/ssr 960x540 denoised, AA off, hit final, re-shade off, on mirrorWall, mirrorWall rt=1, facingMirrors: max 0/255 for every field and all together.
2. **Cross-build vs main** (`scripts/xbuild*.{sh,js}`: this branch on 5443 vs `0abd154` exported to `out/w71-base` on 5943; settings absent, frameIndex 7, occupancy 0, history reset): first run, contact rt=1 differed by max 2/255 on 63 px and rooms rt=1 by max 14/255 on 6 px, deterministic per build (each build repeated: 0). The cause was the RT grazing branch itself: present but not taken, it still changed the compiled trace shader (Metal); removing it gave 0, moving it after `hitLobeSpread` or taking V from the offset origin did not. Fix: the branch lives only in a second pipeline. After: **0 px differing** on examples/ssr mirrorWall rt 0/1, contact rt 1 (re-shade off), facingMirrors (re-shade off), rooms rt 1, and the showcase carConcept + RT, toyCar + RT, Sponza.

Parity: subgroup vs workgroup lists (sorted) and images bit for bit with `quadBaseRotation` frame, pattern, pattern + spq 2, pattern + `quadCopy: 'sameSurface'`. Copy-carrying rays per corner [tl, tr, bl, br] (sssr-core): fixed [20016, 0, 0, 0]; frame cycles one corner per frame (tl, br, tr, bl); pattern [5004, 4993, 5022, 5024].

Checks on 5443 (one section at a time): ssr, hybrid, ssr-rt, regressions, showcase, bench (every control incl. the new ones moved and reset), sssr-core, ssr-exp-x1: all pass. typecheck, test 64.

## First numbers (phase 1)

Bench Measure, 960x540, AA off, vs the path tracer (32 spp + OIDN), mean of 8 frames after 24, MAD of the mean (8-bit). `ours dn | ours + RT`. Data: `data/*.log`. GPU shared with other worktrees: no timings.

**#1 quadBaseRotation, carConcept pose w50** (PT: lip 56.5, band 5.2, wheel 25.1, door 118.0, car 104.8)

| config | frame | glossy | lip | band | wheel | door | car |
|---|---|---|---|---|---|---|---|
| fixed | 12.55 \| 7.75 | 13.78 \| 8.35 | 96.3 \| 48.8 | 160.1 \| 23.7 | 55.7 \| 28.4 | 13.6 \| 13.6 | 31.1 \| 14.4 |
| frame | 12.46 \| 7.65 | 13.67 \| 8.23 | 96.3 \| 43.5 | 159.4 \| 23.6 | 55.4 \| 28.2 | 12.8 \| 12.8 | 30.8 \| 14.1 |
| pattern | 12.45 \| 7.65 | 13.67 \| 8.24 | 96.3 \| 43.1 | 159.4 \| 23.4 | 55.2 \| 28.1 | 12.8 \| 12.9 | 30.8 \| 14.1 |
| sameSurface | 12.53 \| 7.58 | 13.76 \| 8.16 | 95.9 \| 38.7 | 160.0 \| 21.5 | 55.8 \| 28.3 | 13.6 \| 13.6 | 31.2 \| 14.2 |
| sameSurface + pattern | 12.44 \| 7.55 | 13.66 \| 8.12 | 96.2 \| 38.7 | 159.3 \| 22.7 | 55.0 \| 28.1 | 12.9 \| 12.9 | 30.8 \| 14.0 |

toyCar hero, floor r 0.2: glossy 14.31 \| 14.14 -> 14.27 \| 14.11 (frame), 14.27 \| 14.10 (pattern). Small gains everywhere, larger on the RT lip (48.8 -> 43.1) and the door (13.6 -> 12.8); it stacks with `quadCopy: 'sameSurface'`. Not yet measured: rest drift, 2x2 energy, orbit flicker, D3663's stair step (X0), which decide it.

**#2 thicknessDepthFactor** (`add` on top of each scene's own thickness; `rel` = k x view depth alone)

| k | carConcept frame | glossy | band | wheel | car | toyCar glossy | Sponza glossy |
|---|---|---|---|---|---|---|---|
| 0 | 12.54 \| 7.75 | 13.77 \| 8.35 | 160.1 \| 23.6 | 55.5 \| 28.4 | 31.1 \| 14.4 | 11.46 \| 11.28 | 32.93 \| 21.26 |
| 0.002 | 12.40 \| 7.75 | 13.61 \| 8.35 | 159.0 \| 23.7 | 52.5 \| 28.4 | 30.4 \| 14.4 | 11.43 \| 11.28 | 32.93 \| 21.26 |
| 0.005 | 12.21 \| 7.75 | 13.39 \| 8.35 | 157.2 \| 23.6 | 48.9 \| 28.3 | 29.6 \| 14.4 | 11.38 \| 11.28 | 32.92 \| 21.26 |
| 0.01 | 11.92 \| 7.75 | 13.06 \| 8.35 | 154.0 \| 23.5 | 43.2 \| 28.2 | 28.3 \| 14.4 | 11.33 \| 11.27 | 32.91 \| 21.27 |
| 0.02 | 11.38 \| 7.76 | 12.46 \| 8.36 | 143.8 \| 24.1 | 34.8 \| 27.8 | 26.0 \| 14.4 | 11.33 \| 11.26 | 32.88 \| 21.27 |
| rel 0.025 | 11.69 \| 7.74 | 12.81 \| 8.34 | 148.7 \| 23.6 | 41.0 \| 28.1 | 27.5 \| 14.4 | 11.33 \| 11.26 | 33.22 \| 21.25 |
| rel 0.05 | 10.61 \| 7.78 | 11.59 \| 8.38 | 121.8 \| 26.1 | 29.3 \| 26.9 | 23.2 \| 14.4 | 11.34 \| 11.25 | 32.98 \| 21.26 |

Without RT, a thicker test on carConcept fills the dark under-car regions with hits instead of the too-bright probe fill (wheel 55.5 -> 34.8 at k 0.02, band 160 -> 144): the error there is the miss fill's, not streaks. With RT the same pixels go to the tracer either way (flat; band slightly worse at rel 0.05: 23.6 -> 26.1). Sponza and toyCar are flat. Not yet measured: streaks behind objects (W9), holes vs `?rt=1`, stripe ratio, which decide one k for all scales.

**#3 hitLobeFilterGrazing**: `--only ssr-exp-grazing`, toyCar, floor r 0.2, elevations 5 / 15 / 30 / 60 deg, g 0 / 0.5 / 1 x `hitLobeFilterMixed` 1 / 0 (`data/grazing-toyCar.*`). Every row within 0.06 MAD of g 0 (5 deg glossy denoised 17.66 -> 17.64 -> 17.61, floor half 17.35 -> 17.29; 60 deg identical to 0.01). On this floor the reflection is mostly misses (studio / probe), which the lobe filter doesn't touch, so the test doesn't exercise the setting much yet. Ours is brighter than the PT at every elevation (5 deg glossy 186.5 vs 173.4). Next: the same sweep on carConcept / chess (floor reflecting on-screen geometry) and X0's gradient energy + line spread.

**#4 historyEdgeConfidence** (`scripts/edgepan.js`, examples/ssr hit final, re-shade off, RT on, 30-frame yaw pan at 0.01 rad/frame; a stand-in for X0's edge pan: mean |frame k - frame k-1| in the outer 10 %): mirrorWall edge 7.344 -> 7.344, inner 11.61 -> 11.61, traced rays 10990 -> 10997; facingMirrors 4.327 -> 4.327, 31480 -> 31479. At 0.02 rad/frame (ssr-exp-x1): mean 0.0017, max 7/255 vs off. No measurable edge effect at these rates in these scenes, and no cost. Phase 2: X0's edge pan on facingMirrors and carConcept (needs `?reshade=off` there for the setting to act).

## Phase 2 (waiting on X0)

Rest drift (with / without the upscaler), 2x2 energy, orbit flicker and D3663's stair step for #1; W9 streaks / holes / stripe ratio for #2; X0's grazing sweep (gradient energy) + line spread for #3 (and this sweep on carConcept / chess); edge pan + traced-ray count and RT ms for #4. Re-run the cross-build check (`scripts/xbuild.sh`, `out/w71-base` is the main export) after merging main.

## Files

Core: `packages/core/src/sssr/{shaders,sssr}.ts`, `packages/core/src/trace/{shaders,pass}.ts`. three: `packages/three/src/sssr/ScreenSpaceReflectionsPass.ts`. Examples: `examples/sssr-core/src/main.ts` (`identity()`, `quadCorners()`), `examples/showcase/src/bench/schema.ts`, `examples/showcase/src/compare/ours.ts`. Checks: `scripts/run-headless.mjs` (`x1CoreChecks` in sssr-core, `--only ssr-exp-x1`, `--only ssr-exp-grazing`). Docs: `docs/SETTINGS.md`, this folder.
