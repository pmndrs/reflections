# W106: T3, the cone-footprint hit colour (X2), re-measured on 0.1.0

Branch `worktree-agent-a859c403edde3bbb2`, from main `6175aac`. Port 5428. Loop stopped for every number; configs alternate within one page (A, B, C, A, B), all in this worktree.

## What was already there

T3's row (TRIAGE, built 2026-11-13) predates its own build. The setting asked for exists and is the default:

- **W72** built it: `hitColorFilter: 'off' | 'cone'`, `hitColorConeScale`, `mirrorBiasCompensate`, an 8-level rgba16float pyramid of the hit colour (downsampler, `reduction: 'average'`), mip = log2 of the reflected GGX FWHM cone at the hit (D5020), the double-blur budget (sample alpha x sqrt(1 - f), cone and `hitLobeFilter` alpha x sqrt(f), D5021 / D5022), the RT side (D5024).
- **W76** made it the default on the maintainer's call (D5101): `hitColorFilter` 'cone', `mirrorBiasCompensate` true, `mirrorBias` 0.5. `hitColorFilter: 'off'` alone is the pre-W76 tracer bit for bit. Cone pipelines cached per device (D5105). three, pixi and babylon get it through core (`resolveScreenSpaceSettings`).

So no code changed here. This run re-measures the default against `off` with the T1 metrics that came after W76 (W85's `--only flicker`), re-checks the line-spread gate and the raw speckle, times the cost on 0.1.0, and looks at why r 0.3 / 0.5 stay lost.

Configs: **default** = cone + compensation at 0.5; **off** = `hitColorFilter: 'off'` (pre-W76: no pyramid, no bias); **cone no comp** = `mirrorBiasCompensate: false` (the cone over the full sample lobe, W72's plain 'cone').

## 1. Flicker (T1, `pnpm check -- --only flicker`, FLICKER_REPEAT 2)

`data/flicker-ab1.json` (table: `python3 -I scripts/flicker-table.py data/flicker-ab1.json`). Reflection region, 8-bit display luma. drift = rest drift (frames 120 vs 240), rest = per-frame rest change, orbit = orbit std, d2 = orbit second difference; speckle = T1's raw speckle (% px > 3 sigma over their 5x5 neighbours on the **linear raw signal**). "a / b" = the page's two repeats. The run hit the section's 10-minute cap during the second `off`, so `off b` has the two ssr scenes only.

| scene | config | drift | rest | orbit std | d2 | speckle % |
|---|---|---|---|---|---|---|
| ssr contact | default | 0.368 / 0.375 | 0.0065 | 0.453 / 0.444 | 0.570 | 0.0161 |
| | off | 0.365 / 0.367; b 0.373 / 0.385 | 0.0067 | 0.453 / 0.452; b 0.450 | 0.571 | 0.0135 / b 0.0133 |
| | cone no comp | 0.368 / 0.373 | 0.0066 | 0.459 / 0.448 | 0.570 | 0.0140 |
| ssr mirrorWall | default | 0.309 / 0.303; b 0.305 / 0.306 | 0.0093 | 0.458 / 0.457; b 0.464 | 0.750 | 0.0144 / b 0.0154 |
| | off | 0.308 / 0.305; b 0.307 / 0.307 | 0.0094 | 0.464 / 0.464; b 0.468 | 0.749 | 0.0151 / b 0.0131 |
| | cone no comp | 0.305 / 0.306 | 0.0094 | 0.464 / 0.465 | 0.748 | 0.0154 |
| bench cubeFloor | default | 0.0357 / 0.0352 | 0.0012 | 0.0717 | 0.152 | 0 |
| | off | 0.0364 / 0.0364 | 0.0012 | 0.0720 | 0.153 | 0 |
| bench edgesFloor | default | 0.199 / 0.200 | 0.0032 | 0.207 | 0.366 | 0 |
| | off | 0.200 / 0.203 | 0.0036 | 0.223 | 0.370 | 0 |
| | cone no comp | 0.185 / 0.184 | 0.0029 | 0.198 | 0.356 | 0 |
| bench plateFloor | default | 0.0108 / 0.0105 | 0.0004 | 0.0556 | 0.132 | 0.0001 |
| | off | 0.0116 / 0.0117 | 0.0004 | 0.0542 | 0.133 | 0.0001 |
| bench carConcept w50 | default | 0.267 / 0.265 | 0.0074 | 0.382 | 0.325 | 0.0563 |
| | off (= cone no comp) | 0.260 / 0.259 | 0.0072 | 0.380 | 0.324 | 0.0541 |
| bench Sponza hero | default | 0.306 / 0.314; b 0.300 | 0.0113 | 0.554 | 5.318 | 0.334 |
| | off | 0.314 / 0.323 | 0.0112 | 0.561 | 5.323 | 0.321 |
| | cone no comp | 0.302 / 0.311 | 0.0114 | 0.555 | 5.317 | 0.353 |

- **Display flicker: no rise beyond noise.** Every drift / rest / orbit / d2 is within the run-to-run spread of the same config (contact `off` vs `off b`: drift 0.365 vs 0.373, 2 %). The largest move against the default is carConcept drift +2.7 % (0.267 vs 0.260; rest +0.0002, orbit +0.5 %, d2 +0.2 %); the largest in its favour edgesFloor orbit -7 % and Sponza drift -3 %. On carConcept the cone alone is identical to off (its rays hit the dark mirror floor: W72's finding); what moves is the bias / compensation.
- **The 2x2 raw energy** (`quadRaw`, in the JSON) halves on mirrorWall with the cone (0.34-0.36 -> 0.15-0.16): the quad copy's grid is weaker in the raw signal.
- **T1's raw speckle does not go down.** It is flat on mirrorWall (both 0.013-0.015 %), up on contact (0.0135 -> 0.0161 %, a few px), carConcept +4 % and Sponza +4 % (cone no comp +10 %). T1 counts *spatial* outliers against their 5x5 neighbours, and the cone smooths those neighbours (smaller sigma), so the same outlier counts more often. The **temporal** outliers, which are what flicker, drop sharply (section 2).

## 2. Raw speckle, temporal (W72's `speckle.js` on the tracer's radiance, 32 frames, frame index advancing)

`data/speckle-*.log`. relStd = mean per-px temporal std / mean; fireflies = samples > the px mean + 2 x the region mean; p999 = 99.9th percentile of (L - mean_px) / region mean. Two repeats each (a / b).

| region | config | mean | relStd | fireflies | p999 |
|---|---|---|---|---|---|
| mirrorWall r 0.35 sphere (4834 px, no denoiser) | off | 0.138 / 0.139 | 0.81 / 0.80 | 2.19 / 2.09 % | 23.4 / 23.2 |
| | **default** | 0.140 / 0.140 | **0.44 / 0.44** | **0.84 / 0.83 %** | **3.2 / 3.2** |
| | cone no comp | 0.134 | 0.53 | 1.08 % | 3.1 |
| | comp 0.7 | 0.144 | 0.36 | 0.58 % | 2.8 |
| carConcept, alpha 0.105-0.18 (211k px, hero, RT off) | off | 0.303 / 0.302 | 1.40 / 1.40 | 7.41 / 7.39 % | 16.5 / 16.6 |
| | **default** | 0.288 / 0.289 (-4.8 %) | 1.39 / 1.40 | **6.02 / 6.03 %** | **22.6 / 22.5** |
| | cone no comp | 0.302 | 1.39 | 7.39 % | 16.5 |
| | comp 0.7 | 0.283 | 1.16 | 5.77 % | 19.1 |

- The sphere: the default halves the raw noise and cuts fireflies 2.6x and the worst outliers 7x, at +1.4 % mean.
- carConcept paint: the cone alone does nothing (W72: its rays see the floor's re-shaded specular, which is `hitLobeFilter`'s part). The default cuts fireflies 7.4 -> 6.0 % but the worst outliers rise (p999 16.5 -> 22.6) and the mean drops 4.8 %: the lobe filter's share falls from x1.41 to sqrt(0.5) under compensation (D5101's open "revisit"). This is the one raw metric the default makes worse; denoised and display flicker do not show it (section 1, carConcept).

## 3. Line spread (X0's double-blur gate; bench `lineSpread`, e15, PT 512 spp)

`data/linespread-{1,2,3,4}.jsonl`; table: `python3 -I scripts/ls-table.py <file>`. Cell = width ratio vs the PT (peak as % of the PT's peak); **lost** = peak < 10 % of the PT's. The gate is x0.9-1.1. AA on (the upscaler) unless stated.

| config | denoised r 0.05 | r 0.15 | r 0.3 | r 0.5 | + RT r 0.05 | r 0.15 | raw r 0.05 | raw r 0.15 |
|---|---|---|---|---|---|---|---|---|
| **default** | x1.24 (55) | **x1.00 (16)** | lost (0) | lost (0) | x1.17 (55) | **x1.01 (16)** | x0.65 (121) | x0.75 (20) |
| off | x1.29 (52) | lost (3) | lost (0) | lost (0) | x1.22 (51) | lost (3) | x0.63 (126) | lost (0) |
| cone no comp | x1.26 (44) | lost (4) | lost | lost | x1.23 (45) | lost (4) | x0.78 (63) | lost (4) |
| comp 0.7 | x1.17 (54) | x0.95 (13) | lost | lost | x1.15 (56) | x0.95 (14) | x0.80 (84) | x0.74 (19) |
| comp 0.9 | x1.13 (60) | x0.86 (12) | lost | lost | x1.12 (63) | x0.86 (12) | x0.83 (101) | x0.72 (18) |
| cone scale 2 | x1.23 (50) | lost (2) | lost | lost | x1.20 (50) | lost (1) | x0.91 (70) | lost (2) |
| cone scale 4 | x1.35 (47) | lost (0) | lost | lost | x1.33 (47) | lost (0) | x1.09 (65) | lost (0) |
| default, AA off | x1.19 (75) | x0.97 (16) | lost (0) | lost | x1.20 (76) | x0.98 (17) | x1.11 (105) | x1.04 (19) |
| off, AA off | x1.24 (69) | lost (8) | lost (0) | lost | x1.24 (69) | lost (9) | x1.12 (89) | **x1.50 (50)** |

PT width: r 0.05 3.5 px, r 0.15 10.1 px, r 0.3 32.8 px, r 0.5 25.8 px.

- **Within the gate:** the default at r 0.15 (x1.00 denoised, x1.01 + RT, x0.97 / 0.98 with AA off). Nothing else passes: r 0.05 is too wide in every config (x1.13-1.35; the default narrows it a little vs off, 1.29 -> 1.24), r 0.3 / 0.5 are lost in every config.
- f 0.7 keeps r 0.15 in the gate (x0.95) and narrows r 0.05 to x1.17; f 0.9 leaves the gate (x0.86). A larger cone (scale 2, 4) loses r 0.15 and widens r 0.05. W72's choices (scale 1, f 0.5) hold.

### Why r 0.3 / 0.5 stay lost, and a new finding: the cone loses a thin emitter's energy

Denoised and with the upscaler, r 0.3 / 0.5 are lost with the cone off too (W70: the upscaler's clamp and the FFX denoiser remove the sparse hits of a small emitter). But **raw with AA off, off keeps r 0.3 and the cone loses it** (`linespread-3.jsonl`, 256 spp):

| raw, AA off, r 0.3 | width (peak) |
|---|---|
| off | x1.18 (107) |
| default (cone + comp 0.5) | lost (2) |
| cone no comp | lost (1) |
| default, cone scale 0.5 | x0.77 (15) |
| default, cone scale 0.25 | x0.83 (66) |
| off + D49 truncation 0.5 | x0.96 (171) |

and at r 0.15 the default keeps x1.04 width but 19 % peak where off has 50 % (x1.50 wide): about a quarter of off's energy. The loss grows with the cone's size, so it is the pyramid read, not the bias. The free-floating strip (`lineSpreadThin`, thickness 0.01 and no alpha term, so only rays that really hit the strip count; `linespread-4.jsonl`) shows the mechanism plainly: off 119 % peak at r 0.3, the cone 1 %. A ray that hits a thin bright object reads it diluted over the cone's footprint (strip / k), but the rays around it that would carry the rest of that footprint miss (environment) and read nothing, so the line keeps about 1/k of its energy. With the black wall behind the strip the neighbours do hit (the wall), yet the loss is the same (2 %); the cause there is not pinned down (time-boxed; candidates: the wall hits' cone reads, the 0.2 m + 10 alpha thickness catching the rays above the strip on the strip itself).

What a user sees: a thin bright light (neon strip, a lit edge) over a floor at r ~0.3 reflects in the raw signal with the cone off and vanishes with it on. In the default pipeline (upscaler + denoiser) it is lost either way, so the default's output does not change; it would matter for a pipeline without the denoiser and the upscaler, or once the denoiser keeps rare bright samples (D3550's third option).

Filtered importance sampling (Colbert & Krivanek) assumes every sample of the lobe reads the filtered source; screen-space SSR reads it only for samples that hit something on screen. That is SSSR 2015's own limitation, not ours; it is now written down in D5680.

## 4. Cost (1080p, loop stopped, configs alternating per round, 10 rounds x 20 frames, medians; `data/timing-1080p.jsonl`)

| page | hit colour pyramid | intersect off -> cone | core total off -> cone |
|---|---|---|---|
| ssr mirrorWall (off first) | 0.335 ms | 1.506 -> 1.553 | 1.916 -> 2.532 |
| ssr mirrorWall (cone first) | 0.279 ms | 1.471 -> 1.371 | 1.914 -> 2.197 |
| showcase carConcept + RT | 0.320 ms | 0.838 -> 0.777 | 5.327 -> 5.449 (RT trace 3.79 -> 3.62) |

- The pyramid costs **0.28-0.34 ms** at 1080p; the cone fetch in intersect is within noise (-0.10 to +0.05 ms).
- Classify and the depth downsample read +0.06-0.14 ms higher in every cone round though neither changes with the setting (both run before the pyramid); per-pass timestamps on this Apple GPU split overlapping work unevenly, so the honest whole-cost figure is the core total: **+0.28 to +0.62 ms** on mirrorWall, +0.12 ms on carConcept + RT. Backlog line: re-time on a quiet GPU and check the classify delta.

## Recommendation

**Keep the default as it is: `hitColorFilter: 'cone'` with `mirrorBiasCompensate` at `mirrorBias` 0.5.**

- Flicker: no display metric rises beyond noise on any of the 7 T1 scenes (rule: a default may stay only if flicker doesn't rise; it doesn't).
- Raw temporal noise: sphere relStd 0.81 -> 0.44, fireflies 2.2 -> 0.84 %, p999 23 -> 3.2; carConcept fireflies 7.4 -> 6.0 %.
- Line spread: the only config that keeps the r 0.15 line in the gate (x1.00, AA on and off, with and without RT); off loses it.
- Cost: 0.28-0.34 ms for the pyramid at 1080p.

Against it, all known and unchanged by this run: carConcept paint's raw worst outliers up (p999 16.5 -> 22.6, mean -4.8 %), T1's spatial raw speckle flat to +4-19 % (tiny absolute counts), and the thin-emitter energy loss above (no effect on the default pipeline's output today). f 0.7 is the next candidate if the maintainer wants more noise cut (sphere relStd 0.36, carConcept fireflies 5.8 %, line r 0.15 x0.95 still in the gate), at a little more bias.

## Left over

- T3 can close (its build is W72 / W76; this run is its measurement on 0.1.0).
- The thin-emitter energy loss (D5680): an energy-preserving variant would need the rays that miss to read the filtered colour too (e.g. a miss within the cone of on-screen geometry reads the pyramid at the ray's end point), or a per-ray weight; both are experiments, not fixes.
- carConcept paint outliers under compensation: give `hitLobeFilter` its own share (keep k = 1 for the specular re-shade, take sqrt(f) only for the screen colour) and re-measure.
- Re-time the pyramid on a quiet GPU (the classify / depth-downsample deltas).
