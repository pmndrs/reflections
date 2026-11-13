# W73 (X3 phase A, phase 1): ratio-estimator ray reuse

Stream X3 of `docs/plans/ssr-sources-experiments.md`. Phase 1 = build, default-identical, `pnpm check`, first measurements with what main has today. Phase 2 (X0's shared metrics, the promotion verdict) waits for the lead.

## Verdict so far

- **Built and runs.** `rayReuse: 'copy' | 'ratio'` (default 'copy'), `rayReuseTaps` 4 | 8, `rayReuseRadius` (px, x sat(5 r)), `rayReuseMixSources` (default false), `missesTraced` (the three adapter sets it). Core only; the three adapter passes `ssr.settings` through. Bench keys `s.rayReuse`, `s.rayReuseTaps`, `s.rayReuseRadius`, `s.rayReuseMixSources`.
- **Default is identical**: tracer radiance / hit distance / confidence hashes equal before (0abd154) and after, unset and explicit 'copy', with and without RT, 5 kit scenes (`default-identical.json`). Max 0/255.
- **Raw noise drops a lot; denoised noise does not.** Raw temporal std on the mirrorWall floor falls 30-47 %, but the FFX denoiser's output is *noisier* with ratio@1 than with copy@1 (0.57-0.69 vs 0.41-0.48 /255), and copy@4 stays the quietest (0.31-0.37). **The target ratio@1 ≈ copy@4 is not met.** The resolve's error is spatially correlated (blobs a tap radius wide, re-rotated per frame), and the denoiser keeps blobs that it would have averaged away as white noise (`door-skirt-1280.jpg`, bottom middle).
- **The denoiser's energy loss shrinks.** On carConcept's skirt the loss goes from 18 % to 3 %, and on the door from 15 % to 11 % (`denoised / raw`, linear, 64 frames). ratio@4 keeps the same energy with copy-level denoised noise. So the reweighting helps the energy, and the spq-1 reuse adds the mottling.
- **Against the path tracer it's a wash so far.** At W50's pose, 960x540, ours + RT, denoised: glossy MAD 8.5 (copy@1) vs 8.5 (ratio@1); lip 41.7 vs 41.3; door 14.2 vs 13.8. ratio + sameSurface matches sameSurface (lip 34.1 vs 34.4). Raw: frame 7.7 → 7.1, glossy 8.2 → 7.6.
- One trap found and fixed: mixing hits and misses breaks the three composite's depth-aware blend (below).

## What it does

Per traced ray, intersect's 'ratio' variant writes one 16 B record into a W×H storage buffer: radiance × confidence, confidence, oct direction, f16 hit distance, a 15-bit stamp and the miss-listed bit (D5044). A resolve pass runs after intersect, one 8×8 group per denoiser tile through the indirect args at byte 12. For every glossy non-mirror pixel it computes

`out = Σ w·value / Σ w`, with `w = D(h_p)·G2(V_p, L) / (4 N_p·V_p)  /  [G1(V_q)·D(h_q) / (4 N_q·V_q)]`

- `L` is the direction from this pixel to the neighbour's hit point. For a miss it is the ray's own direction.
- The denominator is the neighbour's VNDF pdf, recomputed from its G-buffer (D5041).
- The terms come from the pixel's own ray, its quad's ray, and `rayReuseTaps` golden-angle taps, each snapped to its quad's traced pixel (D5046).
- A neighbour is skipped on another surface (normal dot < 0.9, or plane distance > 2 % of the view distance) or if it's a mirror (D5042). It is also skipped if it's of another hit source: a screen hit vs a miss (D5047), or miss-listed while the traced pass runs (D5043).
- Confidence and hit distance are resolved with the same weights (D5045). With the 'surface' fallback the pixel's own fallback fills `1 − confidence`. A pixel with nothing usable keeps the copy.
- Built on the first 'ratio' frame. The default path compiles the same intersect WGSL text as before.

Params words 150-153 (`rayReuseFlags`, `rayReuseTaps`, `rayReuseRadius`, `rayReuseStamp`). 141-149 are padded for the other streams; `PARAMS_SIZE` is 640. The storing intersect (+1 storage buffer) and the resolve (3 storage buffers, 3 storage textures, 3 sampled textures + the fallback's) are counted in `checkStageLimits`.

## The trap: mixed hit sources vs the depth-aware blend (fixed, D5047)

The first version reused hits and misses together. On carConcept's door, SSR only (1280x720, hero, x 560-720, y 345-388, 32-frame linear means):

| | tracer confidence | tracer radiance | hybrid raw signal |
|---|---|---|---|
| copy | 0.266 | 0.371 | 1.043 |
| ratio, mixed | 0.269 | 0.378 | **1.376** |
| ratio, mixed, radius 1 | 0.269 | 0.378 | 1.214 |
| ratio, radius 0 (own quad only) | 0.264 | 0.370 | 1.045 |
| ratio, mixed, `depthAware` 0 | 0.269 | 0.378 | 1.043 |
| **ratio (sources kept apart, now the default)** | 0.267 | 0.375 | **1.065** |

The resolve itself was unbiased: its outputs kept their means. The shift came from the composite. Mixed, confidence becomes the share of hits around a pixel (about 0.27 everywhere instead of 0 or about 1 per quad). D2400's `w = max(c, v (1 − (1 − c/v) k))` reads that as one ray's thickness confidence and gives the hits the whole weight. Keeping sources apart (D3660, as the plan asked) leaves +2 %: partial confidences averaged within the hits. The mixed form stays reachable as `rayReuseMixSources` for a composite that is linear in confidence (`depthAware` 0). It is quieter raw (roughnessRamp r 0.2: 4.65 vs 7.98), but with the default composite it's biased.

## Noise on glossy floors (examples/ssr, 960x540, 8-bit luma of the final image, `configStats`)

Static camera, 64 frames (32 warm-up when denoised). "bias" is the noise-corrected RMS of the mean against one shared reference: the mean of 256 raw copy@4 frames. Full table: `data/noise.txt`.

**mirrorWall floor, r 0.2 / 0.3 / 0.4 (196,692 px):**

| config | raw std | denoised std | denoised bias vs raw copy@4 |
|---|---|---|---|
| copy@1 (default) | 20.9 / 22.7 / 20.8 | 0.41 / 0.48 / 0.48 | 9.9 / 8.3 / 5.7 |
| copy@4 | 20.9 / 22.7 / 20.9 | **0.31 / 0.36 / 0.37** | 9.0 / 7.2 / 4.7 |
| **ratio@1** | **11.2 / 14.3 / 15.1** | 0.57 / 0.69 / 0.69 | 11.9 / 11.5 / 8.6 |
| ratio@1 taps 4 | 12.8 / 15.8 / 16.3 | 0.54 / 0.63 / 0.63 | 11.6 / 10.8 / 7.8 |
| ratio@4 | 11.0 / 14.1 / 15.1 | 0.37 / 0.42 / 0.42 | 11.3 / 11.0 / 8.1 |
| sameSurface@1 | 20.9 / 22.7 / 20.8 | 0.41 / 0.48 / 0.48 | 9.9 / 8.2 / 5.7 |
| ratio@1 + sameSurface | 11.1 / 14.2 / 15.1 | 0.56 / 0.68 / 0.69 | 11.7 / 11.3 / 8.4 |
| ratio@1 mixed | 9.6 / 12.5 / 13.9 | 0.63 / 0.86 / 1.04 | 12.0 / 12.1 / 10.3 |

**roughnessRamp strips, r 0.1 / 0.2 / 0.3 / 0.4:**

| config | raw std | denoised std |
|---|---|---|
| copy@1 | 0.89 / 9.78 / 11.54 / 9.41 | 0.16 / 0.33 / 0.27 / 0.24 |
| copy@4 | 0.91 / 9.99 / 11.59 / 9.40 | 0.14 / 0.29 / 0.22 / 0.18 |
| ratio@1 | 1.04 / 7.98 / 8.64 / 7.64 | 0.19 / 0.37 / 0.30 / 0.26 |

Reading it:

- **spq 4 doesn't lower a pixel's raw temporal std.** Each pixel still has one ray per frame. It lowers what the denoiser has left, because the denoiser's spatial reuse gets 4x the independent samples. So "ratio@1 ≈ copy@4" can only be judged on the denoised column, and there ratio@1 loses.
- **The raw-reference "bias" penalises any smoothing.** These are display-space means, and the tone curve is concave in this range (Jensen): a smoother signal reads brighter than the mean of noisy frames. ratio@4 shows the same +5/255 as ratio@1, and the denoiser itself shows +4.7 against the same reference. This column is not an over-blur measure. The path tracer (below) and X0's line spread are.
- Near-mirrors (r 0.1) barely change: the radius scales down to their own quad.

## Energy the denoiser loses (W45's metric, D3550)

carConcept, showcase 1280x720, pose hero. Boxes x 560-720: door rows 345-388, skirt rows 396-438. Values are linear luminance, 64-frame means of the hybrid's raw signal and of the denoiser's output; `std` is the mean per-pixel temporal std. Data: `data/energy-hero-1280.txt`.

| SSR only | raw door (std) | denoised door (std) | den/raw door | raw skirt (std) | denoised skirt (std) | den/raw skirt |
|---|---|---|---|---|---|---|
| copy@1 | 1.042 (0.61) | 0.883 (0.007) | 0.848 | 1.056 (0.77) | 0.869 (0.020) | 0.823 |
| copy@4 | 1.043 (0.61) | 0.883 (0.004) | 0.847 | 1.070 (0.78) | 0.868 (0.017) | 0.811 |
| **ratio@1** | 1.069 (0.48) | 0.953 (0.018) | **0.892** | 1.081 (0.44) | 1.051 (0.061) | **0.973** |
| ratio@4 | 1.057 (0.47) | 0.944 (0.006) | 0.893 | 1.082 (0.42) | 1.054 (0.019) | 0.974 |
| ratio@1 + sameSurface | 1.068 | 0.952 | 0.892 | 1.081 | 1.052 | 0.974 |

| + RT | den/raw door | den/raw skirt | denoised std door / skirt |
|---|---|---|---|
| copy@1 | 0.832 | 0.822 | 0.009 / 0.023 |
| copy@4 | 0.826 | 0.807 | 0.005 / 0.018 |
| ratio@1 | 0.881 | 0.973 | 0.015 / 0.059 |
| ratio@4 | 0.883 | 0.973 | 0.007 / 0.021 |

- Today's loss with copy is 15-19 %. W45's 26-46 % was measured before `hitLobeFilter` 1.
- Ratio cuts the loss to 11 % (door) and 3 % (skirt). The reused signal is less heavy-tailed (raw std 0.77 → 0.44 on the skirt), so the FFX prefilter's luminance weight clips less.
- ratio@1 pays for it with 2-3x the denoised temporal std. ratio@4 doesn't.
- The raw means rise by 1-3 %: the +2 % residual above, where partial confidences are averaged within the hits.

## Against the path tracer (bench Measure)

carConcept at W50's pose, 960x540, PT 16 spp + OIDN, mean of 8 frames after 48 warm-up frames, 8-bit display. Each cell is MAD / luma. Data: `data/measure-w50-960.*`.

PT luma: glossy 148.2, lip 74.0, band 5.1, wheel 24.6, door 118.8, car 104.8.

| ours + RT | glossy | lip | band | wheel | door | car | frame |
|---|---|---|---|---|---|---|---|
| copy@1 raw | 8.2 | 16.9 | 15.5 | 28.8 | 11.9 | 13.6 | 7.7 |
| ratio@1 raw | 7.6 | 18.3 | 14.0 | 27.5 | 14.0 | 13.5 | 7.1 |
| copy@4 raw | 7.5 | 11.3 | 13.4 | 27.9 | 13.7 | 13.3 | 7.0 |
| sameSurface@1 raw | 7.5 | 11.8 | 12.1 | 27.7 | 14.5 | 13.5 | 7.0 |
| ratio@1 + sameSurface raw | 7.5 | 11.4 | 12.2 | 27.7 | 14.1 | 13.4 | 7.0 |
| copy@1 denoised | 8.5 | 41.7 | 30.5 | 28.9 | 14.2 | 15.0 | 7.9 |
| ratio@1 denoised | 8.5 | 41.3 | 31.0 | 28.8 | 13.8 | 14.9 | 7.9 |
| copy@4 denoised | 8.3 | 34.2 | 27.7 | 28.5 | 13.4 | 14.4 | 7.7 |
| sameSurface@1 denoised | 8.3 | 34.4 | 27.0 | 28.5 | 14.1 | 14.7 | 7.7 |
| ratio@1 + sameSurface denoised | 8.3 | 34.1 | 27.3 | 28.6 | 13.8 | 14.6 | 7.7 |
| ratio@1 taps 4 denoised | 8.5 | 41.7 | 30.9 | 28.7 | 13.9 | 14.9 | 7.9 |

- The lip / band halo is the silhouette copy. W58's sameSurface fixes it, and ratio alone doesn't: the edge pixels are miss-listed rays the traced pass still copies (D5043), and the resolve won't reuse across the silhouette. ratio + sameSurface ≈ sameSurface.
- SSR only (ours-denoised), every config is within 0.5 of copy@1 in every region (`data/measure-w50-960.txt`). The band is 159 without RT for all of them.

## Not done in phase 1

- **No GPU timings.** The GPU is shared. The cost to time in phase 2: the resolve pass plus intersect's 16 B/px store, 33 MB at 1080p.
- **Traced (RT) hits aren't reused.** Their pixels keep the copy (D5043). Reusing them needs the resolve after the traced pass, with its own output targets.
- X0's metrics (2×2 energy, line spread, thin silhouettes, orbit flicker) are not in yet.

## Phase B (BRDF / pdf weights in the FFX prefilter): A argues for it

The energy result says the loss is about the shape of the input: the luminance weight clips heavy-tailed samples, and BRDF/pdf weighting cuts the loss from about 18 % to 3 % on the skirt. But doing that weighting in front of the denoiser, at spq 1, turns white noise into blobs the denoiser keeps (denoised std 2-3x). ratio@4 keeps the energy with copy-level noise, which says the weighting is right and the separate small kernel is the problem. Phase B puts the same weights inside FFX's prefilter. Its kernel is already wide, and its temporal resolve follows, so the reuse would happen where the samples are already being averaged. That should keep the energy gain without the mottling. Phase B needs the record's direction and pdf (or the G-buffer recompute used here) through the denoise seam.

## Phase 2 leads (cheap, in this worktree)

- **The blobs.** Try a tap pattern fixed per pixel (no per-frame rotation), so the error stays put and the denoiser's temporal pass sees it as bias instead of noise. Try a smaller radius (2) at spq 1. Weight the own quad's ray more.
- **Promotion.** The resolve's inputs are generic: per-pixel direction, hit distance, confidence, radiance and the G-buffer. The only SSSR-specific part is the snap to classify's traced pixels. That snap could become "any pixel whose record is this frame's".

## Files

- Package: `packages/core/src/sssr/shaders.ts` (Params words 150-153, `RAY_RECORD_STORE_WGSL`, intersect's `rayReuse` variant, `rayReuseResolveWgsl`) and `packages/core/src/sssr/sssr.ts` (the settings, lazy `ensureReuse()`, the 'ray reuse' pass, limits). `packages/three/src/sssr/ScreenSpaceReflectionsPass.ts` passes `missesTraced`.
- Bench: `examples/showcase/src/bench/schema.ts`, `compare/ours.ts`, `docs/SETTINGS.md`. `examples/ssr` `__p.configStats`.
- Check: `scripts/run-headless.mjs` `rayReuseChecks` (in `ssr`, or alone as `--only ray-reuse`).
- `w73/scripts/`:
  - `drive.mjs`
  - `hash.js` (default-identical)
  - `noise.js` (configStats)
  - `energy.js` (W45 metric)
  - `door-diag.js`, `depth-aware.js` (the trap)
  - `measure.js` + `configs.js` (bench vs PT)
  - `signal-shots.js`, `radiance-shots.js`
- Images:
  - `door-skirt-1280.jpg`: hero, x 540-740, y 330-450, 2x. Top row is the raw signal, bottom row denoised. Columns: copy@1, ratio@1, copy@4.
  - `mirrorwall-raw-960.jpg`: mirrorWall floor r 0.3, the tracer's raw radiance, x 300-500, y 330-480, 2x. Columns: copy@1, ratio@1, copy@4, ratio@1 mixed.
