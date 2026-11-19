# W88: normal-offset nudge on core's radiance-fallback origin (D5440)

## What
W87 (D5420) moved three's composite probe lookups to `P + N x (2e-5 |viewPosition| + 1e-5)`: P is rebuilt from depth (error ~7e-6 m, either sign), so a surface on a probe volume's face flipped between the volume and the environment slot. Core's `sampleRadianceFallback(world_space_origin, ...)` takes the same rebuilt P. D5440 applies the same nudge there.

- `packages/core/src/probes/lookupOrigin.ts`: `PROBE_LOOKUP_NUDGE_SCALE`, `PROBE_LOOKUP_NUDGE_BIAS`, `probeLookupNudge()`, `PROBE_LOOKUP_ORIGIN_WGSL` (`probeLookupOrigin(P, N, viewDistance)`), exported from core. Three's composite imports the two constants; core's WGSL includes the helper (sssr common prelude and the trace pass). One definition, so they cannot drift.
- Call sites: `sssr/shaders.ts` classify's rough-pixel lookup, `storeRadianceSurface` (rough pixels), intersect's mirror lookup, ray reuse's own-pixel fill; `trace/shaders.ts` `storeTracedMiss`. View distance = |view-space position| (`P.viewMatrix`) or |s - cameraPosition| (trace).
- Unchanged: ray origins, the march and hit tests, `hitSpecularRadiance` (exact hit position), the seam signature (adapters and custom fallbacks need no change).

## Does it matter
Not measurably here.
- Three never reaches core's probe fallback: the pass runs the tracer with a black fallback and the composite does the probe lookup (D5420). The seven three scenes in `--only flicker` are unchanged (below).
- Babylon / pixi do use it. `examples/babylon?probeFace` (new: the one volume's box starts at the floor, y = 0) with `__p.fallbackFlicker()`: miss pixels of the lower half (about 128k px), radiance view, mean 8-bit abs frame-to-frame diff over 24 frames: 2.77 before, 2.79 after (jitter-dominated raw view; a control with the box off the floor gave 2.87-3.90 with unstable masks). Final view: 0.0118 before, 0.0102 after. That floor is a mirror hit by SSR, so the fallback is a small share of its pixels. A face flip on the fallback could not be isolated on any scene in the repo.
- Colour change: final-view mean luma 98.328 -> 98.338 (/255) on babylon probeFace; flicker scenes' rest drift unchanged to 4 digits. The nudge is hygiene closing the same exposure at no cost (a few ALU per lookup); no pixel a user sees changes in the repo's scenes.
- The new check in `scripts/run-headless.mjs` (babylon section) only guards the variant (renders, no GPU errors, miss pixels exist, diff < 6); it cannot tell before from after.

## Flicker (`pnpm check -- --only flicker`, FLICKER_REPEAT 2, reflection region; two numbers = the two repeats; before = core call sites reverted)
| scene | drift before | drift after | rest before | rest after | orbit std before | orbit std after |
|---|---|---|---|---|---|---|
| ssr:contact | 0.376 / 0.3802 | 0.4517 / 0.3754 | 0.0068 | 0.0069 | 0.4761 / 0.4669 | 0.4704 / 0.4716 |
| ssr:offscreen | 0.1938 / 0.1945 | 0.1933 / 0.1941 | 0.0036 | 0.0036 | 0.1824 / 0.1856 | 0.1829 / 0.1857 |
| ssr:mirrorWall | 0.3052 / 0.3065 | 0.3049 / 0.3065 | 0.0094 | 0.0094 | 0.4635 / 0.465 | 0.4633 / 0.4651 |
| bench:cubeFloor | 0.0358 / 0.0353 | 0.0357 / 0.0354 | 0.0012 | 0.0012 | 0.0717 / 0.0716 | 0.0718 / 0.0717 |
| bench:edgesFloor | 0.1999 / 0.1986 | 0.1991 / 0.1991 | 0.0032 | 0.0032 | 0.2071 / 0.2075 | 0.2075 / 0.2077 |
| bench:plateFloor | 0.011 / 0.0107 | 0.0109 / 0.0104 | 0.0004 | 0.0004 | 0.056 / 0.0564 | 0.0563 / 0.0565 |
| bench:carConcept@w50 | 0.2678 / 0.2689 | 0.2701 / 0.269 | 0.0074 | 0.0074 | 0.392 / 0.3918 | 0.3905 / 0.3929 |
| bench:sponza@hero | 0.3077 / 0.3121 | 0.3075 / 0.3131 | 0.0114 | 0.0114 | 0.5543 / 0.5543 | 0.5541 / 0.5545 |

contact's one 0.4517 drift is the known contact noise (0.38-0.45 across runs: W87 saw 0.39-0.40; the other repeat 0.3754). Nothing rises beyond noise.

## Checks (port 5407)
typecheck, test 82; sssr-core 45, probe-core 29 (no expectation changed: the fallback checks do not sit on a face), ssr 33 (first run: rayReuse load flake, passed on rerun), hybrid 20 (first run: half-res switch max 5/255 flake, passed on rerun), ssr-rt 29, ssr-rt-bvh 40, babylon 10 (+ the new one), pixi3d 2 (setup notice), showcase 8, regressions 54, preset 7, quickstart 10, flicker pass.
