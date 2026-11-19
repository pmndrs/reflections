# W86: NRC as the hit shading of ray-traced reflections

Question: for the hit shading of a ray-traced mirror reflection, how does the pathtracer sibling's hash radiance cache (NRC: full direct at the hit + cached strict indirect) compare with probes (today's default) and `rtShade` (`raytracerHitShading`), on accuracy vs a path-traced reference and on flicker, and what does a move cost?

Everything is an examples-only experiment (`examples/nrc/`); nothing in `packages/` or `src/` changed. Pathtracer sibling read only, at its HEAD `0e4435b` (its working tree has uncommitted NRC edits by another session; only committed bench modules were used: `bench/nrc/{hash-grid,reflection-consumer-wgsl,reflection-transport}.ts`, `bench/scenes`, `bench/metrics`).

## How the page works

`examples/vite.config.ts` resolves the sibling's `bench/` (`@nrc-bench/*`) and `@pmndrs/pathtracer` from the same sibling checkout as `findRaytracer()` (`__NRC_AVAILABLE__`; stub + notice when absent). `examples/nrc/src/main.ts` runs the bench's consumer kernel (primary ray, one mirror bounce, shade the receiver) on core's `createRaytracerTraceProvider` (the current tree, not the bench's old `36e206a`), once per method:

| method | hit shading |
|---|---|
| `probes` | core `probeHitShading` over a `ProbeSet` baked from the traced scene. An IDEAL bake (path-traced radiance at the probe, mirrors followed): the best case of the default, not three's rasterised bake. One probe (two for the partition scene), box-projected over the room. |
| `rtshade` | core `raytracerHitShading` (emission + one light sample + shadow ray, no indirect) |
| `nrc` | bench consumer: full direct at the hit + hash cache strict indirect; the cache trains every frame from the camera's rays (`HashGrid`, 2^15 cells, 1.3 MB) |
| `nrc-frozen` | the same lookups, training stopped (splits cache learning from lookup effects) |
| `traced` | full direct + strict indirect traced, no cache (the cache's target; quality bound) |

Reference: the sibling's `PtMegakernel` at 2048 spp. Two bench-owned seams are patched at runtime in the page (nothing edited in the sibling): a training stride and a ray counter for the training pass. Scenes are the bench fixtures (`bench/scenes/tier2/nrc-locality.ts`), mirror floor roughness 0: `mirror` (blue card offscreen, seen only in the floor mirror), `thin` (8 mm partition, red lamp one side, blue the other: contact / light-leak case, views red and blue), `moving` (card moves across the floor at a fixed camera) and `cut` (warm red side, look at blue). No facingMirrors-style scene (the bench has none; skipped). 128x72, region = the bench's reflection crop, errors at 64 spp (linear RGB relMSE with the bench's +0.01 denominator, and relBias).

Run: `REFLECTIONS_PORT=5405 pnpm examples`, open `/nrc/`, then `window.__p.errors()`, `.flicker({spp, restFrames, passes, stride, history, probeZ}, scenes)`, `.recovery({history})`, `.smoke()`. Headless: `pnpm check -- --only nrc` (smoke; skipped with an info line without the sibling); the numbers below with `SSR_EXP_URL='nrc/' SSR_EXP_EVAL='window.__p.errors()' pnpm check -- --only ssr-exp-run`. Raw JSON next to this file.

Machine loaded: no ms claims, rays per mirror pixel instead. Rays/px: probes 2 (primary + mirror; the lookup is a texture read), rtShade 3 (+ shadow), NRC display 3 (+ its training pass, below), traced 4.1-4.8.

## Accuracy (64 spp, vs 2048 spp PT)

| scene / view | method | relMSE | relBias | rays/px (display) |
|---|---|---:|---:|---:|
| mirror / offscreen card | probes (ideal bake) | 0.0476 | +5.0 % | 2 |
| | rtShade | 0.0597 | -30.6 % | 3 |
| | **NRC** | **0.0101** | -0.7 % | 3 (+3.8 training) |
| | traced (no cache) | 0.0436 | +0.1 % | 4.79 |
| thin / red side | probes, probe z=0.9 (best of two placements) | 0.0158 | -17.4 % | 2 |
| | probes, probe z=2.2 | 0.2275 | -67.8 % | 2 |
| | rtShade | 0.0972 | -42.1 % | 3 |
| | **NRC** | **0.0083** | +0.3 % | 2.83 (+3.4) |
| | traced | 0.0407 | +0.1 % | 4.29 |
| thin / blue side | probes z=0.9 | 0.0159 | -17.4 % | 2 |
| | rtShade | 0.1049 | -42.2 % | 3 |
| | **NRC** | **0.0162** | +0.1 % | 2.67 (+3.4) |
| | traced | 0.0457 | -2.0 % | 4.13 |
| moving card (before the move) | probes | 0.671 | -81.8 % | 2 |
| | NRC | 0.0116 | +0.3 % | 3 |

Reading it: bias is the clean column. rtShade has no indirect and is 30-42 % dark here (the bench measured the same for full-direct-only). NRC's bias is under 1 %. NRC's relMSE beats `traced` at the same sample count only because it is a lower-variance estimate of the same quantity (a cached average instead of a one-sample bounce); at 256 spp the bench's traced arm reaches 0.011. Probes depend entirely on placement and on the diffuse-lookup approximation (lookup along N at roughness 1 is not an irradiance integral): z=0.9 vs 2.2 moves the partition scene from -17 % to -68 %; the moving scene (one probe at z=-0.9) is -82 % (not tuned further; one extra placement try was within the time box for the partition only). So "probes vs NRC" here is bounded by how well the one probe was placed, which is the honest property of probes, and a real set of baked probes (more of them, three's raster bake) would be different.

## Flicker (display 8-bit sRGB luma over the crop; 64 spp per frame as the denoiser's input; 64 rest frames, 4 orbit passes of +-0.6 deg at 0.2 deg per frame; metric code = W85's `examples/shared/metrics/stats.ts` (`Accumulator`, `SecondDifference`, `drift`); the page does its own loop, not W85's page harness)

Rest: `std` = per-pixel temporal std over the frames, `d1` = mean |frame - previous|, `drift` = mean |mean(first 32) - mean(last 32)| (the systematic part; the noise floor of a 32-frame mean is about the rtShade value). Orbit: `std` at the revisited start pose, `d2` = second difference (cancels smooth motion).

| scene | method | rest std | rest d1 | rest drift | orbit std | orbit d2 |
|---|---|---:|---:|---:|---:|---:|
| mirror | probes | 0.11 | 0.12 | 0.02 | 0.11 | 0.22 |
| | rtShade | 6.18 | 7.00 | 1.24 | 6.00 | 12.12 |
| | **NRC (live training)** | 6.13 | 5.80 | **3.62** | 6.37 | 9.98 |
| | NRC frozen | 5.02 | 5.68 | 1.00 | 4.85 | 9.83 |
| | traced | 14.81 | 16.82 | 2.93 | 14.38 | 29.07 |
| thin / red | probes | 0.04 | 0.04 | 0.01 | 0.04 | 0.07 |
| | rtShade | 8.18 | 9.23 | 1.66 | 7.92 | 16.02 |
| | **NRC (live)** | 6.30 | 6.77 | **2.42** | 6.26 | 11.58 |
| | NRC frozen | 5.92 | 6.74 | 1.18 | 5.68 | 11.56 |
| | traced | 15.30 | 17.36 | 3.06 | 14.88 | 30.36 |

What it says:

- Probes are deterministic: the lowest flicker by two orders of magnitude (and the biggest bias). rtShade and NRC are both sampling-noise limited at 1 light sample per hit; the denoiser sees the same input noise from NRC as from rtShade (NRC's std is slightly lower: its indirect is a cached value, not a sampled one). The noise is the denoiser's job, as for rtShade.
- The cache adds one thing: **rest drift**, the cell values wandering as noisy records are averaged in each frame (it is steady state: 512 warm-up frames give the identical 3.62). Live NRC drifts 2.9x rtShade's value on the mirror scene (3.62 vs 1.24; frozen: 1.00) and 1.5x on thin. Under the maintainer's "I hate flicker" that is the number to watch.
- Knobs (mirror, same setup): training 1 pixel in 8 raises drift to 6.08 (fewer samples per cell). `historyFrames` 32 (bench default) -> 128: drift 1.84, -> 512: 1.49, i.e. near the noise floor, at the price of slower recovery (next section). Orbit d2 of live NRC equals frozen NRC (9.98 vs 9.83) and is below rtShade (12.1): the world-space cell grid does not add camera-motion flicker at these orbit sizes.

## Recovery frames (nrc-frozen display after N live training frames; 64 spp; relMSE vs a fresh PT of the new state; converged value = frame 128)

| event | history | frame 0 | settles within 2x of converged | within 1.25x |
|---|---|---|---:|---:|
| cold start (mirror) | 32 | 0.043 (= `traced` fallback: a cold cell traces its whole suffix, not black) | 32 frames | 128 |
| | 128 | same | 64 | 128 |
| card moves (stale cache) | 32 | 0.0455, bias -3.2 % (stale, dark) | 16 | 64 |
| | 128 | 0.0487, bias -2.4 % | 32 | 128 |
| camera cut red -> blue (blue side cold) | 32 / 128 | 0.0536 | 8 | 32 |

Converged relMSE: 0.0099-0.0112 (cold, moved, h32), 0.0075-0.011 (h128). The first 2-4 frames after a cold start dip to -3 % bias (cells with a few samples accepted), then converge. rtShade is correct on the first frame after a move (0.098, bias -33 %: stateless, so a move costs it nothing, it is just dark throughout). Probes after the move: 0.666 (stale) and 0.666 after a rebake: the rebake did not help because the error is the placement bias, not staleness; a rebake costs about 18.9 M rays = 683 frames of this view's 3 rays/px.

Training cost: 3.4-3.8 rays per pixel per training frame at stride 1 (primary + mirror + suffix + shadow), so about 0.2-0.24 rays/px/frame at 1 pixel in 16, but stride 8 already raised drift 1.7x. A real integration trains on a small fraction of pixels and so lives at stride 8-64: the drift/recovery trade at those strides is the open measurement.

## Verdict

NRC hit shading is accurate where it is the only method that is (no dark bias, no placement, no per-hit indirect ray: 3 rays/px display vs traced 4-5 at lower variance), and it fixes the biggest defect of `rtShade` (-30 to -42 % dark). It is not a free upgrade under the flicker rule:

1. Live training adds slow drift (2.9x rtShade's at the bench defaults, near parity at `historyFrames` 128-512) and recovers over 16-64 frames after a scene change (3 % dark in between). Static or slowly changing scenes: worth integrating. Scenes with objects moving every few frames: the cache lags (a visible 3 % darkening that fades), which is a "slightly different colour", not flicker, but it is a lag the maintainer should accept explicitly.
2. A defensible default is: NRC opt-in as an alternative to `raytracerHitShading`, `historyFrames >= 128`, a warm-up (cold cells already fall back to traced, so there is no dark start, only 2-4 frames of -3 %), and a freeze option (`nrc-frozen` is as stable as rtShade) for captures / when the scene is static. Do not make it the default until the stride 8-64 numbers exist.
3. Probes stay the default for the speed / stability ordering (deterministic, no flicker, 2 rays/px) but their bias is placement-bound (-17 % to -82 % here with one idealised probe), so NRC is the quality option where probes are sparse.

## What the pathtracer side would need to expose

- A published package for the hash cache (today `bench/nrc/hash-grid.ts`, bench-only, imports the repo's WGSL helpers): `HashGrid.create/bindRecords/encodeUpdate/displayHook/setCameraPosition/clear`, settings (`historyFrames`, `minSamples`, `cellPixels`, `fallbackLevels`).
- The strict-indirect transport as a library (`reflection-transport.ts`: `rcSuffix`, `rcDirect`, mirror weights) and a **training-pass hook** that takes a `TraceProvider` so Reflections can run the camera-ray training pass itself (this repo's page patches the consumer kernel by string to add a stride and a ray counter; that should be a parameter).
- A `HitShading`-shaped adapter (`wgsl` defining `shadeTracedHit`, `layout`, `bindGroup`) so the three adapter can take it next to `probeHitShading` / `raytracerHitShading`, plus a way to inject a custom `HitShading` into `ScreenSpaceReflectionsPass` (today it builds its own: a small opt-in hook, not added here).
- Receiver scope: the bench handles delta-conductor origins and Lambert receivers only; rough GGX origins and denoised / upscaled output are untested.
- Invalidation: `setTransforms` is the only change signal the cache needs; an explicit `invalidateRegion` / faster-forget would shorten recovery.

## Limits of this experiment

Small (128x72), three bench scenes, no denoiser or TAA in the loop (flicker is of the denoiser's input at 64 spp), one idealised probe per room, probe placement tried twice at most, 1 light sample per hit for rtShade and NRC direct, errors at 64 spp (noise-limited for stochastic methods), orbit amplitude 0.6 deg. Flicker numbers of different methods are comparable to each other, not to W85's page metrics (different frame source).
