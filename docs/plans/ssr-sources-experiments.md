# Plan: experiments from the external SSR sources

Status: **planned, not started** (2026-11-12). The maintainer approved all nine ideas from `docs/research/ssr-external-sources.md` as experiments. Work starts once the two running agent flows wrap up; the maintainer launches it.

Background, sources and line references are in the research note. This file is the spec: what each experiment builds, its settings, how it is tested, and what decides it.

## Ground rules (maintainer, 2026-11-12)

- **Experiment, measure, then decide.** Nothing becomes a default because it sounds right. Every idea ships first as a setting whose default reproduces today's output bit for bit.
- **Settings stay settings.** A winner may become the default, but the old path stays reachable as an option (for perf, or to turn it off). Each setting goes into the tuning bench schema (`examples/showcase/src/bench/schema.ts`, W51), so it gets a URL key, a bench control and a `docs/SETTINGS.md` entry with its GPU cost.
- **Diverging from FFX is fine when quality rises on our platform.** We use FFX SSSR as the foundation; we aren't doing a 100 % port. Each divergence gets its DIVERGES row (reserve **D5000–D5099** for this plan).
- **Denoiser-shaped work starts here.** Rule 9 is about scale: the FFX reflection denoiser lives in the denoiser repo, and we don't grow a second denoiser here. A small filter we need can be built and tested in this repo. It moves to the denoiser repo only if it helps reflection setups other than ours (see X3, "Promotion").
- Usual rules: real GPU (`pnpm check`), commit after every run with numbers and verdict, time with the render loop stopped, A/B only within one worktree, and time-box blockers to about 30 minutes.

## Streams

| id | ideas | worktree | depends on | size |
|---|---|---|---|---|
| X0 | Shared test scenes and metrics | first, small | none | S |
| X1 | #1 quad base rotation, #2 depth-scaled thickness, #3 grazing lobe shrink, #4 history edge confidence | one worktree, four separate commits | X0 | S × 4 |
| X2 | #5 cone-footprint hit colour, #6 `mirrorBias` coupled to it | own worktree | X0; #3 from X1 if landed | M |
| X3 | #7 ratio-estimator ray reuse | own worktree | X0 | L |
| X4 | #8 half-rate glossy RT misses + bilateral fill | own worktree | X0 | S–M |
| X5 | #9 half-res trace + denoise + joint bilateral upsample | own worktree, parallel experiment | X0; reuses X4's fill kernel; better with X3 | L |

Ordering: X0 first. Then X1, X2, X3 and X4 can run in parallel. X5 starts with X4 or after it, since it reuses the fill kernel.

**Hot files.** `packages/core/src/sssr/shaders.ts` and `sssr.ts` are touched by X1, X2 and X3. Keep each stream's edits to new functions and new Params words, and merge in the order X1 → X2 → X3. Params words: each stream claims the next free words at merge time and states them in its row (W52 used 137–139).

Agent ids and ports are assigned at launch (the lead's agents use 5430+ per HANDOFF).

## X0: shared test scenes and metrics

Several experiments need the same yardsticks. Build them once in `examples/shared/metrics/` and wire them into `scripts/run-headless.mjs` as `--only ssr-exp-*` sections.

| Metric / scene | What it measures | Used by |
|---|---|---|
| **Line spread**: a thin emissive strip reflected in a glossy floor at roughness 0.05 / 0.15 / 0.3 / 0.5; the reflected strip's full width at half maximum (FWHM) vs the path tracer | Total blur. This is the **double-blur gate**: any combination of filters must keep the reflected width within ±10 % of the PT | X1 #3, X2, X3, X5 |
| **Grazing sweep**: one glossy floor at camera elevations 5°, 15°, 30°, 60°; error vs PT per elevation and gradient energy in the reflection region | Over- and under-blur by view angle | X1 #3, X2 |
| **Rest drift**: frames 120 vs 240 with the camera still, with and without the upscaler (backlog: contact, mean 1.5/255, 3 % px > 8/255 in blocks) | Static pattern and settling | X1 #1, X5 |
| **2×2 energy**: power at the half-Nyquist frequency of the reflection region | The quad copy's grid made visible | X1 #1, X3, X4, X5 |
| **Edge pan**: a scripted pan over facingMirrors and carConcept; frame-to-frame difference in the outer 10 % of the screen | Pops at screen edges | X1 #4 |
| **Energy**: 64-frame linear mean of raw vs denoised (W45's carConcept skirt / door metric) | Energy the denoiser loses (26–46 % today) | X2, X3 |
| **Thin silhouettes**: sphere-fringe red px (W44: D4303's metric), carConcept sill dark band (W41) | Leaks and holes at thin edges | X3, X4, X5 |
| Existing: the bench's Measure per region vs PT (W51), `pnpm check` sections ssr / hybrid / ssr-rt / showcase-compare / regressions, GPU ms by timestamp queries | Overall error and cost | all |

Scenes: examples/ssr (mirrorWall, contact, facingMirrors, moving, offscreen, rooms), the showcase (carConcept, toyCar, chess, Sponza), the pixi3d arcade (raw-signal speckle), sssr-core.

Every experiment reports **default-is-identical** (max 0/255 with the setting at its default) before any other number.

## X1: four small core settings

### #1 Rotate the quad's traced pixel
- **Setting.** `quadBaseRotation: 'fixed' | 'frame' | 'pattern'`, default `'fixed'` (FFX top-left).
  - `'frame'`: the base corner cycles with the frame index.
  - `'pattern'`: a 4×4 Latin square by position, offset per frame (Diligent's `PostFX_Common.fxh:45` uses position only).
- **Where.** Classify's `isBaseRay` (`sssr/shaders.ts:199-205`). The copy flags in the packed ray entry follow the chosen base. The subgroup and workgroup variants must still give identical lists after sorting.
- **Tests.**
  - Rest drift with and without the upscaler.
  - 2×2 energy.
  - Orbit flicker (the W39 pendulum).
  - W53's source-edge stair step (D3663) on carConcept's lip with `hitSource` on.
- **Decides.** Adopt if rest drift or 2×2 energy drops and orbit flicker is not worse. Expect the denoiser's history to need a few more frames to settle; report it.

### #2 Thickness that scales with depth
- **Setting.** `thicknessDepthFactor` (k, default 0). Thickness becomes `depthBufferThickness + thicknessRoughnessFactor·α + thicknessLengthFactor·L + k·|viewZ|`. Also try Diligent's pure-relative form (thickness = k·|viewZ| alone) as a value of the same setting's mode.
- **Where.** `finishRay` (`shaders.ts:719`) and the settings and Params.
- **Tests.**
  - A sweep of k on toyCar (small scale), rooms, carConcept and Sponza (large).
  - Streaks behind objects (W9's metric, 4.6 % with D1001).
  - Holes vs `?rt=1` miss fill, and the reflected-sphere stripe ratio.
- **Decides.** Whether one k serves all scales better than today's per-scene numbers. DIVERGES row beside D1001.

### #3 Shrink the lobe filter at grazing angles
- **Setting.** `hitLobeFilterGrazing` (0..1, default 0 = off). The lobe-filter spread is scaled by `lerp(1, lerp(sat(2·NdotV), 1, sqrt(r)), hitLobeFilterGrazing)`, which is SSSR15 slide 85's formula at 1.
- **Where.** `sssr/shaders.ts:726`, `trace/shaders.ts:317`. It composes with `hitLobeFilterMixed` (W52, D3641); test both on and off.
- **Test case (maintainer asked for one).** A new section, `--only ssr-exp-grazing`, runs the grazing sweep with the setting at 0, 0.5 and 1, and the line spread at 15°.
- **Decides.** Adopt if error at 5–15° drops, 60° is unchanged (within noise), and the line spread stays inside the gate.

### #4 History colour: confidence at the edge
- **Setting.** `historyEdgeConfidence: boolean`, default false at first; the default is decided by measurement. The maintainer wants it as an option either way, so it can be turned off if traced rays rise.
  - When on, the vignette is min(this frame's, the previous position's).
  - Where last frame's texel is off screen, confidence drops to 0 instead of falling back to this frame's colour without specular.
  - It applies only with `hitColor: 'history'`.
- **Where.** Core intersect (`shaders.ts:442`, D1002).
- **Tests.** Edge pan, plus the traced-ray count and RT ms with `?rt=1` (cost).

## X2: cone-footprint hit colour (#5) and coupled bias (#6)

**#5. Settings.** `hitColorFilter: 'off' | 'cone'` (default 'off') and `hitColorConeScale` (default 1).
- A mip pyramid of the hit-colour source (the specular-free lit colour, or history) is built with the maintainer's `downsampler`, 5–6 mips.
- At a hit, the mip is `log2(cone diameter in px at the hit)`, from the lobe's cone tangent (alpha-based) × hit distance, projected at the hit's depth. Contacts stay sharp. Use #3's grazing shrink if it landed.
- First a plain pyramid, then measure leakage at depth edges. Try a depth-aware pyramid (reject taps far from the hit's depth) only if leakage shows.

**The double-blur budget.** Four things can blur a reflection:
1. the ray's sampling spread;
2. the cone mip;
3. `hitLobeFilter` at probe and RT lookups (×1.41 alpha today, D3550);
4. the denoiser's spatial pass.

The rule: blur from (1) and (2) adds in squares to the surface's lobe, `α² = α_sample² + α_cone²`. With `hitColorFilter: 'cone'`, `hitLobeFilter`'s widening is reduced by the same share so it doesn't stack. The line spread is the gate: every combination stays within ±10 % of the PT's reflected width at all four roughness values.

**#6.** `mirrorBias` already exists (D49, default 0). New setting: `mirrorBiasCompensate: boolean` (default false; it needs `hitColorFilter: 'cone'`). When on, the sample uses `α·sqrt(1−f)` and the cone supplies `α·sqrt(f)` (`f` = `mirrorBias`). This is D3550's revisit and makes the knob honest. Sweep f = 0, 0.3, 0.5, 0.7 (SSSR15 shipped 0.7).

**Tests.**
- Raw speckle count: raw-signal pixels > 3σ on the r 0.35 sphere, the pixi3d arcade floor and carConcept paint.
- Energy (does the denoiser's loss shrink?), the line-spread gate, the grazing sweep.
- GPU ms for the extra downsample and the intersect.

## X3: ratio-estimator ray reuse (#7)

**What it is, in scale.** A small resolve step, not a denoiser. It replaces FFX's quad copy (one ray's colour pasted onto the other three pixels of a 2×2) with a weighted reuse of a few nearby rays: 4–8 taps, one pass, before the denoise seam. The FFX denoiser still runs after it, unchanged: reprojection, prefilter, temporal resolve.

Frostbite's whole pipeline was this resolve plus a temporal pass, and Diligent's is this plus its own temporal and bilateral passes. We take only the resolve.

**Phase A (core, this repo).**
- **Setting.** `rayReuse: 'copy' | 'ratio'`, default 'copy' (FFX). Also `rayReuseTaps` (4 | 8) and `rayReuseRadius` (px, scaled by roughness like Diligent's `4·sat(5r)`).
- **Intersect stores per traced pixel:** the hit point (or direction + hit distance; direction octahedral 2 × 16-bit snorm, as the miss list) and its pdf. The pdf can be recomputed from the source pixel's G-buffer and VNDF instead of stored.
  - Intersect already has 3 of 4 storage textures (D600), so use a storage buffer indexed like the ray list, or pack.
- **Resolve, for each pixel the denoiser will see:**
  - Gather K traced neighbours.
  - For each, re-derive the direction from *this* pixel to the neighbour's hit point (SSSR15 does this; it is what makes reuse correct across different positions).
  - Weight `w = BRDF_this(L) · NdotL / pdf_neighbour`, rejected when `NdotL ≤ 0`, by a plane-distance and normal test, and across a hit-source change (W53, D3660).
  - Output `Σ L·w / Σ w`, with the pixel's own ray included if it has one.
  - Confidence and hit distance get weighted the same way (D2400 and the composite read confidence).
- Phase A doesn't need the RT layer; it covers SSR hits first, then traced hits with the same store.

**Phase B (optional, decided after A).**
- Replace FFX prefilter's luminance `radianceWeight` with BRDF/pdf weights. This touches the denoiser shader.
- Do it the way W53 did: a denoiser-repo branch in its own worktree, run with `DENOISER_REPO=`, with the main checkout's Denoiser untouched.

**Tests.**
1. Noise: denoised std on glossy floors, `ratio` at spq 1 vs `copy` at spq 1 and at spq 4. The target is ratio at 1 ≈ copy at 4 (SSSR15's claim).
2. Energy: the carConcept skirt and door vs PT. Does the 26–46 % loss shrink?
3. Leaks: thin silhouettes, and the source-edge stair step (D3663).
4. Over-blur: the line-spread gate (a second spatial filter in front of FFX's is the risk).
5. GPU ms: resolve pass and extra store.

**Promotion to the denoiser repo.** Port it only if both are true. Record the answer in this file when X3 ends.
- The resolve needs only generic inputs: per-pixel direction or hit point, pdf, hit distance, the G-buffer. No SSSR internals.
- It improves a reflection signal that isn't ours, e.g. the denoiser repo's own three SSR pages, or RT-only reflections.

**Answer (W73, 2026-11-13): not promoted.**
- The first criterion holds for the most part. The exceptions are the snap to classify's traced pixels and the hit-source split for our depth-aware blend.
- The second criterion isn't shown. On our own signal the denoised output is 30-50 % noisier than the copy.
- What carries over is the weighting: the plan's phase B, BRDF / pdf weights inside the FFX prefilter.
- Details: `docs/research/w73/ratio-reuse-phase2.md`.

## X4: half-rate glossy RT misses (#8)

- **Setting.** `tracedMissRate: 'full' | 'half'` (default 'full'), and `tracedHalfRateMinRoughness` (default near FFX's mirror test, so mirrors stay full rate).
  - With 'half', intersect appends one glossy miss per 2×2 (checkerboard by frame) to the miss list.
- **Fill pass (new core kernel `bilateralFill`, shared with X5).** An untraced miss pixel takes traced neighbours weighted by:
  - plane distance;
  - `pow(dot(n_p, n_q), k)`;
  - roughness difference;
  - same hit source.
  If the weight sum is near 0, it takes the probe.
- **Tests.**
  - RT ms and traced-ray count on offscreen, carConcept and moving with `?rt=1`.
  - Error vs PT, thin silhouettes, 2×2 energy, and orbit flicker; with and without the denoiser.
- **Decides.** Adopt as the RT layer's default if the error rises less than the noise floor. This also answers SPEC open question 4 for the RT layer.

## X5: half-res trace and denoise, joint bilateral upsample (#9)

**Setting.** `reflectionResolution: 'full' | 'half'`, default 'full'.

**Build in two steps.**
1. Everything at half res, mirrors included, to measure what mirrors lose.
2. Mixed: pixels below `halfResMinRoughness` take a full-res path.

**Pass order.**
1. A half-res G-buffer, point-sampled from one pixel per quad. That pixel rotates with #1's pattern if it landed.
2. Hi-Z, classify, trace and signal at half res.
3. The denoise seam at half res: it already writes motion, roughness and normal; it downsamples them, passes half-res depth and calls `configure({w/2, h/2})`. No denoiser API change.
4. Upsample the **residual** (`denoised − probeEnv_half`) with X4's `bilateralFill` kernel extended to a 2×2 or 3×3 joint bilateral gather. Upsample confidence and hit distance with the same weights.
5. The composite adds the full-res `probeEnv`.

**Tests (the cons list is the test plan).**

| Con | Test | Pass if |
|---|---|---|
| Mirrors lose resolution | mirrorWall and facingMirrors: reflected-edge width and error vs PT, step 1 vs step 2 vs full | Step 2's mirrors match full res |
| Normal-mapped paint copies texture or goes blocky | carConcept door / skirt (W45/W46 metrics), 2×2 energy on the paint | Within noise of full res |
| Thin silhouettes | Sphere-fringe px, carConcept sill band | Not worse than full res |
| A cheaper route exists | GPU ms vs the denoiser tile-list route (D1400) if built by then; else vs full res | Saves ≥ 0.5 ms at 1080p |
| Stacking with the final upscale (maintainer's question) | `?upscale=` at ratio 1.5 and 2 with half-res reflections (reflections then at ¼ or less of output); rest drift, orbit flicker, error vs PT | No visible compounding at ratio 1.5 |
| The denoiser at half res blurs 2× wider on screen | Line-spread gate | Within ±10 % of the PT |
| Total cost | trace + denoise + upsample + composite ms at 1080p and 1440p | Net saving |

It pairs with X3: reuse is what makes sparse rays look full-res in SSSR15. Run the table with and without `rayReuse: 'ratio'` if X3 has landed.

## Reporting

- Each stream writes `docs/research/<id>/` and one HANDOFF row, as usual.
- Each stream proposes a default for the decisions page. The maintainer picks.
- Each stream adds its settings to the bench schema, so `docs/SETTINGS.md` lists them with their GPU cost.
