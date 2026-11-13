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

## Phase 2 (X0's metrics, main a234de9 merged)

X0's page metrics (`__p.metrics`, examples/ssr at its defaults: upscaler AA, denoiser on; the bench) and PT metrics (`lineSpread`, `grazing`), 960x540. Noise: within a page the same config run first and last ("fixed" / "fixed2", "off" / "off2") gives the floor; across reloads W70's table. Scripts `scripts/phase2-*.sh`, `p2-*.js`; data `data/p2/`; summaries `python3 scripts/summarise.py <page|measure|line|graz|time> <log>`. GPU ms: relative A/B in this worktree, 1920x1080, loop stopped, median of 3 rounds of `time(30)`; another worktree may have shared the GPU.

### #1 quadBaseRotation: keep as option, default stays 'fixed'

Reflection region; drift = rest drift mean (120 vs 240, phase-aligned), rest = per-frame rest flicker, orbit = orbit std, quad = display 2x2 ratio.

| page | fixed / fixed2 (noise) | frame | pattern |
|---|---|---|---|
| contact (upscaler) | drift 0.745 / 0.793, rest 4.50 / 4.50, orbit 9.75 / 9.44, quad 0.011 / 0.018 | 0.698, 4.49, 9.69, -0.001 | 0.732, 4.50, 9.74, -0.000 |
| contact AA off | 0.209 / 0.202, 0.084 / 0.082, **0.271** / 0.271, quad **0.340** / 0.339 | 0.221, 0.165, **0.400**, 0.282 | 0.301, 0.130, **0.380**, 0.280 |
| contact upscale 1.5 | 0.904 / 0.902, 3.89 / 4.20, **8.53** / 8.53 | 1.002, 4.00, **9.35** | 1.013, 4.16, **9.23** |
| mirrorWall | 0.308 / 0.302, orbit 0.468 / 0.468, quad 0.024 / 0.020 | 0.314, 0.462, 0.020 | 0.309, 0.469, 0.019 |
| offscreen | 0.253 / 0.298, rest 1.59 / 1.59, orbit 2.67 / 3.04 | 0.292, 1.58, 3.17 | 0.264, 1.57, 2.87 |
| rooms | 0.121 / 0.122, orbit 0.354 / 0.352, quad 0.085 / 0.091 | 0.139, 0.368, 0.067 | 0.137, 0.369, 0.055 |
| bench carConcept w50 | 0.261 / 0.266, orbit 0.390 / 0.392, quad 0.047 / 0.047 | 0.268, 0.407, 0.046 | 0.263, 0.398, 0.044 |
| bench chess hero | 0.128 / 0.131, orbit 0.223 / 0.221, quad 0.071 / 0.066 | 0.134, 0.226, 0.049 | 0.129, 0.222, 0.044 |

- 2x2 energy drops where the grid shows (contact AA off 0.34 -> 0.28, rooms 0.085 -> 0.055, chess 0.071 -> 0.044).
- Rest drift does not drop (within noise, or up: contact upscale 0.90 -> 1.00, rooms 0.12 -> 0.14).
- Orbit flicker gets worse wherever the AA doesn't hide it: contact AA off 0.27 -> 0.38-0.40 (+40-48 %), upscale 1.5 8.53 -> 9.2-9.35 (+8-10 %), carConcept +2-4 %, rooms +4 %. The corner that traces changes per frame, so a pixel's sample changes per frame: the grid becomes temporal noise.
- **W70's contact rest flicker (4.5/255 under the upscaler) is not the quad copy:** 4.50 / 4.49 / 4.50 with every rotation. It is the jitter changing which rays validate.
- D3663's stair step (carConcept w50, ours + RT, `hitSource=1`, Measure vs PT 32 spp, lip): MAD 32.2 -> 27.8 (pattern), quad 0.42 -> 0.39, but temporal std 0.40 -> 0.46. `quadCopy: 'sameSurface'` does more (20.5, quad 0.085); both together 20.6.
- Cost: classify +0.06 ms at 1080p (0.154 -> 0.211, 'pattern', contact + RT).
- The plan's rule ("adopt if drift or 2x2 energy drops and orbit flicker is not worse") fails on orbit flicker. Verdict: **keep as option**, default 'fixed'. For D3663, 'sameSurface' is the better lever.

### #2 thicknessDepthFactor: keep as option; 'relative' fixes thin geometry, 'add' doesn't

`lineSpreadThin` (W70's floating strip; FWHM ours / PT, peak vs the PT's):

| config | r 0.05 denoised | r 0.05 raw | r 0.15 denoised (PT peak 0.060) | r 0.3 denoised (PT peak 0.0056) | + RT r 0.05 |
|---|---|---|---|---|---|
| default | x4.25 | x4.02 | x2.41, peak 0.47 | x1.45, peak 0.39 (70x) | x1.33 |
| add k 0.01 / 0.02 | x4.84 / x5.51 | x4.62 / x5.22 | | x1.49 / x1.53 | x1.39 / x1.46 |
| relative 0.025 | x2.20 | x1.92 | | lost (peak 0) | x1.32 |
| relative 0.01 | **x1.45** | x1.12 | x0.49, peak 0.019 | lost (peak 0) | x1.28 |
| relative 0.005 | x1.30 | x0.62 | lost | lost | x1.27 |

The plain `lineSpread` scene (strip on a wall) is unchanged by any of these (r 0.05 denoised x1.296 / x1.285 / x1.296 at k0 / rel 0.01 / rel 0.025).

Elsewhere (Measure vs PT, glossy MAD `dn | RT`; mirrorWall `stats()` without RT at frame 7):

| config | carConcept w50 glossy / wheel | toyCar | chess | Sponza | mirrorWall sphere stripe ratio / streak % / misses | misses contact / rooms |
|---|---|---|---|---|---|---|
| default | 13.94 \| 8.77 / 57.8 \| 30.0 | 11.62 \| 11.58 | 9.91 \| 9.71 | 32.74 \| 21.38 | 6.1 / 4.6 / 9241 | 25182 / 15715 |
| add 0.01 | 13.06 \| 8.35 / 43.2 \| 28.2 (phase 1) | 11.33 \| 11.27 | | 32.91 \| 21.27 | 5.6 / 5.5 / 9162 | 25071 / 15374 |
| add 0.02 | 12.46 \| 8.36 / 34.8 \| 27.8 (phase 1) | 11.33 \| 11.26 | | 32.88 \| 21.27 | 5.4 / 6.5 / 9114 | 25068 / 15155 |
| rel 0.005 | 14.67 \| 8.76 / 73.9 \| 30.1 | 11.68 \| 11.59 | 10.01 \| 9.72 | 33.43 \| 21.37 | | |
| rel 0.01 | 14.06 \| 8.75 / 62.5 \| 29.9 | 11.62 \| 11.58 | 9.96 \| 9.72 | 33.24 \| 21.36 | **12.5** / 4.4 / 10035 | 28394 / 17266 |
| rel 0.02 | 13.22 \| 8.76 / 47.4 \| 29.8 | 11.49 \| 11.57 | 9.95 \| 9.71 | 33.03 \| 21.36 | (0.025: 6.7 / 4.6 / 9575) | (0.025: 27149 / 16132) |

- 'add' raises the thickness, which is what makes the thin strip a slab: it helps carConcept's under-car regions without RT (more hits instead of the too-bright miss fill) but makes `lineSpreadThin` worse (x4.25 -> x5.51) and streaks rise (4.6 -> 6.5 %). Not a default.
- 'relative' is one number for every scale. At 0.01 it fixes the thin strip (x4.25 -> x1.45, r 0.3's 70x peak gone), with RT everything is flat (within 0.15), but without RT it costs on surfaces close to the camera (carConcept wheel 57.8 -> 62.5, Sponza +0.5), the reflected sphere on mirrorWall stripes 2x (6.1 -> 12.5: thinner than its 2-px depth step) and 9-13 % more rays reach the miss list. At 0.02-0.025 the stripes and misses are back near today's (6.7, +3.6 %), carConcept and toyCar improve, Sponza +0.3, and the thin strip still halves (x2.20).
- Cost: 'add' intersect +0.008 ms at 1080p; 'relative' none measured; more misses = more traced rays with RT.
- Verdict: **keep as option** (default unchanged). Candidate for the maintainer: `thicknessDepthMode: 'relative'` at 0.02 as the default when RT is on (it is never worse with RT on in these scenes and removes per-scene thickness); without RT it is mixed (Sponza +1 %), so not adopted under the "never worse" rule.

### #3 hitLobeFilterGrazing: drop as a default candidate (keep the option off)

- X0's `grazing` (floor r 0.15, 5/15/30/60 deg, PT 256 spp + OIDN; denoised MAD / gradient ratio): g 0 7.82 / 9.93 / 10.43 / 13.93, x0.79 / 0.76 / 0.78 / 0.51; g 1 7.76 / 9.96 / 10.47 / 13.92, x0.79 / 0.76 / 0.78 / 0.51. + RT within 0.04. With `hitLobeFilterMixed` 0: the same.
- The bench sweep (`--only ssr-exp-grazing`, floor r 0.2, glossy and floor half, dn and RT, mixed 1 / 0) on toyCar, carConcept and chess: every row within 0.06 MAD of g 0.
- `lineSpread` (AA off): r 0.05 unchanged (x1.233 -> x1.238 denoised); raw at r 0.3 x1.22 -> x1.10 (closer to the PT), denoised lost either way.
- Why nothing moves: the filter only widens the probe / environment lookup of re-shaded and traced hits' specular lobes; the over-blur W70 sees at grazing (gradient x0.5-0.8) is the denoiser's, and at the hits the shrink changes a lookup's lod by a fraction of a mip. SSSR 2015 shrinks its colour-pyramid cone, which is X2's #5.
- Cost: intersect +0.01 ms; a second RT pipeline on first use.
- Verdict: **drop** as a default candidate; leave the option off (or remove it) and revisit with X2's cone-footprint hit colour, where the formula belongs.

### #4 historyEdgeConfidence: keep as option, default off

X0's `edgePan` (0.25 deg/frame, 24 frames), `borderReflection` d2 / % d2 > 4, ?rt=1 hit final re-shade off:

| page | off / off2 (noise) | on |
|---|---|---|
| facingMirrors | 11.68 / 11.62, 28.0 / 27.7 % | 11.81, 28.2 % |
| mirrorWall | 7.44 / 7.45, 24.9 / 24.8 % | 7.45, 24.9 % |
| offscreen | 10.26 / 11.51, 33.5 / 38.1 % | 9.10, 29.0 % |
| bench carConcept w50 (ours + RT, re-shade off) | 0.598, 2.60 % | 0.602, 2.64 % |

- No change on three pages; offscreen reads better (9.10 vs 10.26 / 11.51) but its own two off runs differ by 12 %, so it isn't shown.
- Traced rays while panning (0.25 deg/frame, 24 frames): +0.03 % (facingMirrors), +0.17 % (mirrorWall), +0.16 % (offscreen).
- Cost at rest: intersect +0.01, rt trace +0.005 ms at 1080p (mirrorWall); no change in the image (max 0/255).
- It acts only with `hitShading: 'off'` and history; the default re-shade reads this frame's colour, so the pop it targets doesn't occur at today's defaults.
- Verdict: **keep as option**, default off (the maintainer wants it switchable).

### Defaults after the merge

On the merged branch: same-build identity (`--only sssr-core`, `--only ssr-exp-x1`) passes; cross-build vs main a234de9 (`scripts/xbuild.sh`) 0 px differing on the five examples/ssr configs and the showcase carConcept + RT and Sponza. Checks on 5443: sssr-core, ssr-exp-x1, bench, ssr-rt pass (phase 1: ssr, hybrid, regressions, showcase too); typecheck, test 68. Bench `cost` lines added for all four from the timings above; `docs/SETTINGS.md` regenerated.

## Files

Core: `packages/core/src/sssr/{shaders,sssr}.ts`, `packages/core/src/trace/{shaders,pass}.ts`. three: `packages/three/src/sssr/ScreenSpaceReflectionsPass.ts`. Examples: `examples/sssr-core/src/main.ts` (`identity()`, `quadCorners()`), `examples/showcase/src/bench/schema.ts`, `examples/showcase/src/compare/ours.ts`. Checks: `scripts/run-headless.mjs` (`x1CoreChecks` in sssr-core, `--only ssr-exp-x1`, `--only ssr-exp-grazing`). Docs: `docs/SETTINGS.md`, this folder.
