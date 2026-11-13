# W78: X3 phase B, BRDF / pdf weights inside FFX's prefilter

Maintainer decision 3 (2026-11-13). W73 found that BRDF / pdf weights (SSSR 2015's ratio estimator) recover the energy the FFX reflection denoiser loses and bring back the r 0.15 thin-strip reflection, but as a pass in front of the denoiser they cost +0.54 ms and raised denoised noise (mirrorWall r 0.3: 0.45 → 0.64). Phase B moves the weights into FFX's prefilter. Two repos:

- **reflections** branch `w78-brdf-prefilter` (this worktree), merged with main `22adc27`.
- **Denoiser** branch `w78-brdf-prefilter` in `~/Developer/Denoiser-w78` (from main `7014384`): `6d54fca` BRDF weights, `26c54ba` keepHistoryOnBlack, `e8873dd` test-bed flag, `fd5a59b` brdfMinAlpha, then the status doc.

Run everything with `DENOISER_REPO=~/Developer/Denoiser-w78`. Nothing is pushed.

## Short answer

- **The BRDF weights work inside the prefilter, but FFX's temporal resolve was throwing their result away.**
  - Its early-out writes 0 to the output *and to the history* wherever a frame's prefiltered radiance is black (< 1e-4).
  - Over a black environment, a sparse glossy reflection (the line-spread strip at r 0.15 / 0.3) is black in most frames at most pixels, so it never accumulates.
  - With the resolve bypassed, the BRDF prefilter alone already holds r 0.15 at x0.81 (peak 60 %) and r 0.3 at x0.69 (peak 40 %).
  - A new option, **`keepHistoryOnBlack`**, lets black samples accumulate. That alone, with FFX's own weights, brings r 0.15 back: x0.95-1.06, peak 26-30 %.
- **`brdfWeights: 'replace'` + `keepHistoryOnBlack` is the only spq-1 setting that brings r 0.3 back with AA on:** x0.70, peak 18 %. It also doubles r 0.15's peak (53-65 %, against W73's 67 %).
- **The energy the denoiser loses comes back, better than W73's pass did.** On carConcept's lip the loss goes 9.2 → 2.0-2.7 % (+ RT 14.4 → 0.2-3.8 %), against W73's 4.4 %. The door goes 7.9 → 1.2 %.
- **The cost is noise and GPU time, at today's defaults:**
  - mirrorWall's denoised std with 'replace' is 0.56 / 0.79 / 0.95 at r 0.2 / 0.3 / 0.4. That is noisier than W73's pass (0.53 / 0.64 / 0.64) and copy@1 (0.39 / 0.46 / 0.46). Dropping FFX's luminance weight also drops its firefly suppression.
  - 'combine' keeps copy-level noise (0.41 / 0.47 / 0.48), but it recovers almost nothing more than `keepHistoryOnBlack` alone.
  - The prefilter costs +0.8-0.9 ms at 1080p (0.41 → 1.20 ms).
- **On near-mirrors the weights add flicker,** so there is a gate, **`brdfMinAlpha`**:
  - On carConcept's r 0.03 floor, orbit flicker rises +42-70 % (door 0.51 → 0.72, wheel 2.18 → 3.71). At alpha ~1e-3 the ratio is so peaked that the 15 taps barely average.
  - With the gate at perceptual 0.1, the floor matches off, and every gain above r 0.1 stays.
  - What the gate gives up: 'replace' had sharpened r 0.05 from x1.30 to x1.10 of the PT, and that goes.
- **Under the proposed default (cone + `mirrorBiasCompensate` 0.5), the BRDF weights hardly matter:**
  - r 0.15 is x0.95-0.99 with or without them, and r 0.3 stays lost.
  - Noise is low in every mix (0.21-0.24).
  - On the lip, compensation loses energy (18.9 %), and 'replace' restores it (4.8 %).

## Verdict

1. **Does it beat W73's pass on the thin strip without the noise?**
   - On the strip, yes: replace + keepBlack holds r 0.15 at x1.04 / x0.95 (AA on / off), and only it brings r 0.3 back (W73: lost at spq 1). It also recovers more of the lip's energy.
   - Without the noise, no, not at today's defaults: 'replace' is noisier than W73's pass.
   - The hypothesis that "the temporal pass after it hides the noise" didn't hold. The noise isn't the separate pass's correlated error. It is losing the luminance weight.
2. **Does it beat cone + compensation?**
   - On r 0.15, it ties (both x0.95-1.06; compensation's peak is only 14 %).
   - On r 0.3, yes: compensation never brings it back.
   - On noise, no: compensation is the quietest setting measured.
   - Combined with compensation, the weights add only the lip energy.
3. **Promotion (does it help a signal that isn't ours?):**
   - **`keepHistoryOnBlack` is generic.** It needs no input, it is identical where nothing is black (the Denoiser repo's test bed reads 23.4556 dB / flicker 0.00803 both ways), and it fixes a loss any dark-environment glossy signal would have. It is the part worth a Denoiser PR.
   - **`brdfWeights` needs a producer** that hands per-pixel direction + pdf. The Denoiser repo's own SSR pages (`three-temporal/reflections-rooms`) sample with three's `ggxReflectionSample` and pass radiance already multiplied by its sample weight (F G2 / G1). Before the ratio estimator could apply there, those pages would need an unweighted signal and a pdf output. Not shown to help any signal but ours, so not promotable yet.

## What was built

**Seam (reflections, off by default):**
- Core option `sampleDirection`. Intersect's variant writes `outputs.sampleDirection`, an rgba32float: the ray's world direction (.xyz) and its VNDF pdf at the sample alpha (.w).
  - It is written at every pixel the ray's value lands on (the quad copies too).
  - A render-pass clear each frame leaves 0 ("no sample") wherever no ray landed. Mirrors write 0.
  - The ray-traced pass traces the miss list's stored direction, so its pixels keep their sample.
- `SpecularInputs.direction` (denoiser-core's existing field; the pdf goes in .a) is passed through the seam.
- three: `settings.sampleDirection` (rebuilds the tracer on a flip) and `HybridReflections.denoiserSampleDirection`.
- Examples:
  - `?brdf=replace|combine`, `?keepBlack=1`, `?brdfMin=<perceptual>`.
  - Per-frame keys `settings.denoiserBrdf / denoiserKeepBlack / denoiserBrdfMin` (examples/ssr and the showcase).
  - `?keepSample=1`: A/B runs without a tracer rebuild.
  - Bench keys `brdf`, `keepBlack`, `brdfMin`.
  - Shared `syncDenoiserBrdf`, which also sets `brdfAlphaScale` from `mirrorBiasSplit` (D5023's rule).

**Denoiser (`FfxReflectionDenoiser`, all off by default, all in `setOptions`):**
- `brdfWeights: 'off' | 'replace' | 'combine'` and `brdfAlphaScale`. A second prefilter pipeline, built on first use: `prefilterWgsl(true)` binds `direction` at 11, and the default pipeline stays FFX's WGSL.
  - Neighbour weight = FFX's normal × depth × variance weights × hit-source affinity × f_centre(L) cos / pdf_q.
  - L runs from the centre to q's hit point (q's position + dir × hit distance), or along q's direction for a miss.
  - 'replace' drops FFX's luminance weight, and 'combine' keeps it.
  - A centre without a sample takes FFX's weights; a neighbour without one is skipped.
- `brdfMinAlpha`: the weights apply only where the centre's alpha is at least this.
- `keepHistoryOnBlack`: skips the resolve's black early-out.
- `PARAMS_SIZE` goes 256 → 272: words 64-67, as #29 said the next option would need.

**Default identical** (`identical.md`): with every option off, hashes match main + Denoiser main on 5 ssr scenes (denoised, radiance, hit distance, confidence, RT source) and the final PNGs are 0/255. carConcept's denoised hash varies between runs of the same build (2 px at 1/255, W74's class). The Denoiser test bed's eval reads the same as main.

## Numbers

### Line spread (bench `lineSpread`, PT 256 spp; x PT, peak % of the PT's; `data/linespread2.md`, `linespread3.jsonl`)

| config | AA on: r 0.05 / 0.15 / 0.3 | AA off: r 0.05 / 0.15 / 0.3 |
|---|---|---|
| off (today) | x1.29 / lost (3) / lost | x1.23 / lost (8) / lost |
| keepBlack | x1.31 / x1.06 (26) / lost (8) | x1.23 / x0.95 (30) / x0.78 (10) |
| replace | x1.10 (64) / lost (5) / lost | x1.14 (82) / x0.46 (12) / lost |
| **replace + keepBlack** | x1.15 (65) / **x1.04 (53)** / **x0.70 (18)** | x1.16 (83) / **x0.95 (65)** / **x0.79 (26)** |
| replace + keepBlack, min 0.1 | x1.31 (47) / x1.04 (53) / x0.71 (18) | x1.23 / x0.95 (65) / x0.79 (27) |
| combine + keepBlack | x1.12 / x1.01 (27) / lost (8) | x1.13 / x0.92 (31) / x0.78 (11) |
| cone + comp 0.5 | x1.29 / x0.99 (14) / lost | x1.19 / x0.96 (14) / lost |
| cone + comp 0.5 + replace (+ keepBlack) | x1.08-1.10 (67) / x0.97 (14) / lost | x1.11-1.12 (86) / x0.95 (14) / lost |
| W73 ratio@1 (W73's runs) | x1.30 / x0.95 (67) / lost | x1.48 / x0.93 (85) / lost (11) |

**Where the line went** (diagnostics, temporary shader edits, reverted; AA off, replace; `data/linespread-diag*.jsonl`):

| variant | r 0.05 / 0.15 / 0.3 |
|---|---|
| raw signal | x1.11 / x1.48 (42) / x1.14 (76) |
| prefilter output, resolve bypassed | x1.08 (83) / x0.81 (60) / x0.69 (40) |
| resolve's outlier clip skipped | = as built |
| resolve's history clip skipped | = as built |
| resolve's black early-out skipped | x1.16 / x0.95 (65) / x0.79 (26) |

### Denoised noise, mirrorWall floor (examples/ssr `configStats`, page AA, 48 frames; `data/noise-mirrorwall.md`)

| config | std r 0.2 / 0.3 / 0.4 | signed bias vs spq-4 raw |
|---|---|---|
| copy@1 | 0.389 / 0.459 / 0.463 | +4.8 / +4.1 / +2.2 |
| copy@4 | 0.290 / 0.337 / 0.341 | +4.6 / +3.8 / +2.0 |
| W73 ratio@1 | 0.529 / 0.639 / 0.643 | +6.6 / +7.3 / +5.5 |
| replace | 0.559 / 0.792 / 0.946 | +6.1 / +7.2 / +6.1 |
| combine | 0.407 / 0.469 / 0.475 | +4.8 / +4.5 / +2.9 |
| keepBlack | 0.401 / 0.463 / 0.453 | = copy@1 |
| cone + comp 0.5 | 0.220 / 0.208 / 0.214 | +6.4 / +7.8 / +4.8 |
| cone + comp 0.5 + replace | 0.241 / 0.215 / 0.209 | +6.5 / +8.0 / +5.3 |

### carConcept @ w50 (bench, 960x540; `data/bench-metrics-carConcept-w50*.jsonl`)

| config | energy loss lip (dn / + RT) | door | orbit std door / wheel / car / lip |
|---|---|---|---|
| off | 9.2 / 14.4 % | 7.9 % | 0.51 / 2.18 / 0.80 / 0.84 |
| replace | 2.7 / 3.8 % | 1.2 % | 0.72 / 3.71 / 1.17 / 0.78 |
| combine | 10.5 / 16.9 % | 1.7 % | 0.71 / 3.47 / — / 0.78 |
| replace + keepBlack, min 0.1 | **2.0 / 0.2 %** | 7.9 % | **0.51 / 2.12 / 0.78** / 0.85 |
| cone + comp 0.5 | 18.9 / 26.9 % | 7.8 % | 0.51 / 2.12 / — / 0.90 |
| cone + comp 0.5 + replace | 4.8 / 6.9 % | 1.3 % | 0.69 / 3.72 / — / 0.76 |
| W73 ratio@1 (W73) | 4.4 / 4.5 % | — | — |

### GPU (1920x1080, per-pass minimum of 40 frames, median of 3 interleaved rounds; relative only, the GPU was shared)

| scene | FFX prefilter off | replace | combine | replace + keepBlack + min 0.1 |
|---|---|---|---|---|
| rooms | 0.408 ms | 1.199 | 1.206 | 1.240 |
| mirrorWall r 0.3 | 0.477 | 1.412 | 1.574 | 1.416 |

The intersect's sample write adds 0.02-0.04 ms, plus a clear that isn't timed.

## For a PR

- **Denoiser, worth proposing on its own:** `keepHistoryOnBlack`, `26c54ba` plus the test-bed flag `e8873dd`. It is generic and needs no input. It brings back the r 0.15 reflection FFX loses over dark environments, with no noise or cost change measured.
- **Denoiser, as an experimental option:** `brdfWeights` + `brdfAlphaScale` + `brdfMinAlpha` (`6d54fca`, `fd5a59b`), with denoiser-core's `direction` doc (pdf in .a). Before it could default anywhere:
  - its noise at default sampling needs work (e.g. a firefly clamp in place of the dropped luminance weight);
  - its cost needs work (+0.8 ms: workgroup memory, per-tap GGX).
- **reflections:** the seam's sample output, the three switches and the example keys (all off by default). Setting to offer on the bench: `brdf=replace&keepBlack=1&brdfMin=0.1`.

## Backlog (fine-tune)

- 'replace' noise: try a soft luminance clamp instead of dropping radianceWeight altogether.
- Prefilter cost: pack `wg_hp` to f16 / fewer LDS words; precompute the centre terms.
- `sampleDirection` at rgba16float (oct + log pdf) to halve its 16 B/px.
- Half-res path doesn't hand the sample on.
- Under compensation r 0.3 stays lost even with the BRDF prefilter and keepBlack. Find where (the cone's hit colour of a 1.5 cm strip?).

## Scripts (`scripts/`)

`drive.mjs` (W73's), `lib.js`, `smoke.js`, `identical.{sh,js,py}`, `linespread.js` + `linespread-configs*.js`, `noise.js`, `bench-metrics.js` + `bench-configs*.js`, `energy.js` (W73's, not run), `timing.js`, `summarise.py`.
