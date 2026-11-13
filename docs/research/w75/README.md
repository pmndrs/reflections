# W75 (plan X5): half-res trace + denoise + joint bilateral upsample: phase 1

Branch `worktree-agent-a0b37e695fc04e460`, from main `0abd154` with W74 (`worktree-agent-acb8568d453dd7241`, X4's `bilateralFill`) merged in. Port 5447, `DENOISER_REPO=~/Developer/Denoiser-w53-rebase` (denoiser#29, `240f39f`). DIVERGES rows: [diverges.md](diverges.md) (D5080-D5084). HANDOFF row: [handoff-row.md](handoff-row.md).

## What was built

**Setting** `ScreenSpaceReflectionsPass.settings.reflectionResolution: 'full' | 'half'` (three; bench `s.reflectionResolution`, Rebuild; ssr page and showcase `?res=half`), and for step 2 `settings.halfResMinRoughness` (default 0; `?res=mixed&halfResMin=`; bench `s.halfResMinRoughness`). Composites are built for one mode: `HybridReflections.composite()` adds the half-res branch only when the setting is 'half' at build time, so 'full' builds the same node graph as main (pages: `__p.setResolution('full' | 'half' | 'mixed')` rebuilds them).

Pass order in 'half':
1. **Half frame** (core `createHalfResolutionFrame`): every frame-contract texture point-sampled at the top-left pixel of each 2x2 quad into ceil(w/2) x ceil(h/2) targets (depth as r32float, two-channel targets as rgba16float), one compute pass. The half frame's camera carries a clip-space affine (`halfResolutionClipTransform`) so that half texel (x, y) reconstructs full-res pixel (2x, 2y) exactly (D5082). Checked: half signal[x, y] = full signal[2x, 2y] on 99.97 % of probe-only px, mean 0 (`scripts/mapping.js`).
2. **Tracer, RT pass, history** run on the half frame unchanged (the RT pass over the half-res miss list).
3. **Signal at half res** (the composite at each texel's sample pixel uv), **denoise seam on the half frame** (it calls `configure({w/2, h/2})` itself; no denoiser API change).
4. **Residual at half res**: `specular - (1 - ssrWeight) x SO x probeEnv` with `ssrWeight` in alpha (D5081: the plan's `denoised - probeEnv` showed the probe's full-res detail through confidence-1 hits).
5. **Upsample** (core `createReflectionUpsample`, on W74's `bilateralFill`): bilinear spatial weight in sample space (an even pixel is its own sample), plane distance 0.01 / normal power 16 / roughness 0.1 / all sources, a 4x4 tent gather where no bilinear tap fits, zero where nothing fits. Residual, confidence, hit distance and source with the same weights. `HybridReflections.upsampleSettings` sets the weights.
6. **Composite at full res**: `specular = residual.rgb + (1 - residual.a) x SO x probeEnv` at the pixel's own probe lookup; `final = lit + weight x (specular - probeEnv)`.

Step 2 (`halfResMinRoughness` > 0, D5084): a second core tracer at full res traces the pixels below it (its `roughnessThreshold` = that value, `samplesPerQuad` 4, its own RT pass, its own full-res history, no denoiser); the half tracer skips them (new core `ScreenSpaceReflectionsSettings.minRoughness`, Params word 157) and the upsample drops them as taps. Composites pick per G-buffer pixel.

Params: SSSR word 157 only (158-159 and RT words 77-79 unused). New passes use their own uniforms (upsample: 160 B). Bindings: upsample 7 sampled + 4 storage textures (`checkStageLimits`); the half-res sample pass 1 + 1.

## Default-identical

Bit for bit vs main `0abd154` ([identical.md](identical.md)), W74's setup (ssr page 5 scenes with denoiser off and on, showcase carConcept; `?rt=1`, `frameIndex` 5, `minTraversalOccupancy` 0): all raw-output hashes equal, finals 0/255, 0 px; re-run after step 2's shader change, same.

## Checks

`pnpm check` sssr-core, ssr, hybrid, ssr-rt, showcase, regressions: 143 PASS, 0 FAIL ([checks-step1.txt](checks-step1.txt)). New: `--only half-res` (also in hybrid): mirrorWall / contact with RT and the denoiser at half size, final within 6/255 mean of full (1.43 / 2.48).

## First numbers

**GPU ms at 1080p** (render loop stopped, 6 rounds x 20 frames, configs alternating inside one page, medians; [timing-1080p.jsonl](timing-1080p.jsonl)). Sum = three's render passes + core passes + denoiser + upsample. The GPU was shared (untouched passes drift up to ~4x between configs), so relative only.

| scene | full | half | mixed 0.05 | where half saves |
|---|---|---|---|---|
| carConcept (showcase, rt) | 23.1 | 13.7 | 28.0 | rt trace 3.26 -> 1.10, denoise 2.89 -> 0.63, core 4.19 -> 1.51; costs upsample 0.45, sample 0.17 |
| contact (ssr, rt) | 19.5 | 16.1 | 22.1 | denoise 2.28 -> 0.57, rt 0.58 -> 0.18 |
| mirrorWall (ssr, rt) | 15.0 | 12.8 | 14.3 | intersect 1.33 -> 0.28, denoise 1.80 -> 0.53 |

The plan's gate (saves >= 0.5 ms at 1080p) is met by step 1. Step 2 at 0.05 costs more than full: carConcept's 0.03 floor lands on the full-res path at spq 4 (mirror rt trace 5.3 ms).

**Error vs the path tracer** (bench Measure, 960x540, 16 spp, ours-rt, MAD /255, raw | denoised; [measure-car960.jsonl](measure-car960.jsonl), [measure-toy960.jsonl](measure-toy960.jsonl)):

| region | full | half | mixed 0.05 |
|---|---|---|---|
| carConcept frame | 7.2 \| 7.9 | 7.6 \| 9.1 | 7.1 \| 7.4 |
| lip | 18.7 \| 41.5 | 22.8 \| 50.5 | 13.5 \| 16.8 |
| band | 14.0 \| 30.6 | 16.4 \| 58.3 | 13.5 \| 13.4 |
| door | 14.5 \| 14.1 | 15.0 \| 15.5 | 13.6 \| 13.7 |
| car | 13.7 \| 14.9 | 14.8 \| 17.7 | 13.3 \| 13.3 |
| toyCar glossy (hero) | 11.1 \| 11.4 | 11.2 \| 11.9 | 11.0 \| 11.0 |

- Half raw costs +0.4..+4.1; half denoised much more at the skirt (band 30.6 -> 58.3): the half-res denoiser's radii are twice as wide on screen and spread the bright skirt over the dark floor band (the "denoiser blurs 2x wider" con; the line-spread gate in phase 2 will say how much).
- Mixed beats full everywhere, but not as a half-res win: it is the carConcept floor at spq 4 and undenoised (no quad copy and no denoiser mixing across the lip, W58's finding).
- mirrorWall / facingMirrors have no PT on the bench; vs full res on the ssr page (luma MAD, % px > 8/255, floor gradient ratio; [mirrors-960.txt](mirrors-960.txt)): mirrorWall half 1.36 / 3.0 % / 0.91, mixed 0.69 / 1.6 % / 1.12; facingMirrors 1.24 / 3.6 % / 0.95, 0.61 / 1.6 % / 1.06; contact 2.00 / 6.2 % / 0.88, 2.74 / 8.1 % / 1.75 (contact's glossy floor is below 0.05: raw on the mirror path). Step 1's mirrors show jagged reflected edges (sphere, cube top); step 2 brings mirrorWall / facingMirrors back to about half the difference.

## Not done (phase 2, after X0)

- The cons table with X0's metrics: line spread (2x-wide denoise), rest drift / orbit flicker, 2x2 energy on the paint, thin silhouettes; the stacking test with `?upscale=` 1.5 and 2; with W73's `rayReuse: 'ratio'`.
- 1440p; a sweep of `halfResMinRoughness` (~0.01 = FFX's mirror test) and of the upsample weights.
- Step 2 variants: spq 1 + a full-res denoise on the mirror path, or denoiser radii halved at half res.

## Notes

- A first Measure passed `denoise: '0'` (a string) to the bench: its "raw" rows were denoised; discarded, re-run with `false`.
- `examples/assets` in the worktree is a symlink to the main checkout's assets (untracked; not staged).
- The vite server logs a missing `@pixi/3d` (pixi3d pages); the pages used here are unaffected.

# Phase 2 (X0's metrics; main a234de9 merged)

All numbers 960x540 unless marked; page metrics on the reflection region (G-buffer roughness < 0.447), today's defaults (upscaler AA at ratio 1, FFX denoiser), one page per scene with the mode switched in-page (`__p.setResolution`; deterministic after a reset, W70). Noise floor (W70): drift <= 0.03, orbit std <= ~2 %. Files: [pagemetrics-ssr.jsonl](pagemetrics-ssr.jsonl), [pagemetrics-upscale.jsonl](pagemetrics-upscale.jsonl), [benchmetrics-car.jsonl](benchmetrics-car.jsonl), [measure2-car960.jsonl](measure2-car960.jsonl), [linespread.jsonl](linespread.jsonl), [timing2-1080p.jsonl](timing2-1080p.jsonl). W73's `rayReuse` branch does not merge cleanly (core Params words, the pass): no ratio row.

## The cons table

| con | test | full | half | verdict |
|---|---|---|---|---|
| Mirrors lose resolution | ssr page vs full (luma MAD, floor gradient ratio) | — | mirrorWall 1.36, x0.91; facingMirrors 1.24, x0.95 | visible (jagged reflected edges). Step 2 at 0.01 (mirrors at full res): 0.69 / 0.61, but see flicker below |
| | orbit std / rest drift, mirrorWall | 0.46 / 0.31 | 0.48 / 0.33 | within ~5 % |
| | same, mixed 0.01 | | 0.88 / 0.15 (d2 0.75 -> 2.30) | the full-res mirror path has no denoiser: drift halves, orbit flicker doubles. **Fails** |
| Paint goes blocky / texture copy | carConcept bench metrics (ours-rt): quad ratio door / car | 0.29 / 0.25 | -0.14 / -0.08 | no 2x2 grid (the upsample's bilinear spatial weight); Measure door 14.1 -> 15.5, car 15.0 -> 17.7. Worse, not blocky |
| | orbit std reflection / band | 0.36 / 0.86 | 0.42 / 1.19 | +15 % / +38 %: real |
| Thin silhouettes | carConcept band (W41's sill band) MAD denoised | 30.5 | 58.3 | **fails** (raw 14.0 -> 16.4) |
| | lineSpreadThin r 0.05 (AA off) denoised / +RT width ratio, +RT peak | x4.42 / x1.37, 0.88 | x4.02 / x1.21, 0.32 | thickness slab the same (X1 #2's case); RT keeps the width but loses 2/3 of the peak |
| Cheaper route | GPU ms 1080p, AA off, rt, loop stopped, median of 8 x 20 alternating (quieter run than phase 1) | carConcept 14.0, contact 11.2, mirrorWall 8.2 | 10.6 / 9.0 / 6.6 | **saves 1.6-3.4 ms** (rt trace 2.53 -> 0.89, denoise 1.94 -> 0.51, core 3.17 -> 1.25; upsample +0.37-0.49, sample +0.15). Gate (>= 0.5 ms) met. No tile-list route (D1400) to compare |
| Stacking with the upscale | ssr page, `?upscale=1.5`: contact orbit std / drift | 8.53 / 0.90 | 9.85 / 1.02 | +15 % / +13 % (vs +5 % / -7 % at ratio 1): compounds on the glossy floor; mirrorWall +2 % / +10 % |
| | `?upscale=2` | 9.41 / 1.11 | 9.67 / 1.17 | +3 % |
| | carConcept Measure denoised frame / band / lip | up 1.5: 8.3 / 31.1 / 40.5 | 9.8 / 64.8 / 51.9 | adds up (half alone 9.1 / 58.3 / 50.5); up 2: 9.4 / 60.3 / 50.7 vs 10.9 / 83.2 / 59.7 |
| Denoiser 2x wider on screen | line spread r 0.05, AA off: width ratio, peak / PT's | x1.23, 0.63 | x1.08, **0.14** | the width stays in the gate, a thin emitter's peak drops 78 %. r >= 0.15 lost in both (W70). Raw: r 0.15 x1.48 -> x1.22, r 0.3 x1.15 -> x1.02 |
| | carConcept band: is it the 2x footprint? | full at `upscale=2` (the whole pipeline at 480x270): band 60.3, lip 50.7 | 58.3, 50.5 | **yes**: half res = the full pipeline at half render size. Not the upsample |
| Total cost | trace + denoise + upsample + composite | see cheaper route | | net saving at 1080p; 1440p not run |

**Band and the 2x spread.** FFX's denoiser exposes no radius or kernel scale (`FfxReflectionDenoiserOptions`: temporal stability, roughness gate, hit source, hit-distance weight; the 8x8 average and 9x9 neighbourhood are WGSL constants), so the footprint can't be halved without a denoiser-repo branch (fine-tune backlog). What the options do at half res (carConcept denoised band / lip / frame): `hitSource=hits` 39.4 / 36.9 / 8.6 (full + hitSource 23.0 / 28.7 / 7.6), `quadCopy: 'sameSurface'` 50.0 / 38.6 / 8.7. Keeping sources apart recovers about two thirds of half's band loss; half + hitSource is about full's default.

**Step 2 threshold.** At 0.05 carConcept's 0.03 floor lands on the undenoised full-res path (phase 1: better MAD, 28 ms). At 0.01 (FFX's mirror test) carConcept is identical to half (no px below; 11.6 ms with the mirror tracer's fixed cost), mirrorWall / facingMirrors get full-res mirrors (MAD vs full 0.69 / 0.61) for full res's cost (8.4 vs 8.2 ms) and twice the orbit flicker. Denoising that path means a second full-res denoiser (full res's denoise cost again); not tried.

## Verdict (proposed for the decisions page)

- **`reflectionResolution: 'half'`: option, not default.** It saves 1.6-3.4 ms at 1080p (25-35 % of the reflection frame on carConcept) and keeps rest drift and orbit flicker within ~5 % on the ssr scenes at ratio 1. It costs at silhouettes and thin emitters: carConcept band 30.5 -> 58.3, the line's peak -78 %, carConcept orbit +15 %; stacking with `?upscale=1.5` adds +15 % orbit on contact. Recommend it as a performance preset, paired with `hitSource: 'hits'` (band 39.4) and not combined with an upscale ratio > 1.
- **`halfResMinRoughness` (step 2): keep at 0 (off); drop unless the mirror path gets a denoiser.** 0.01 is the only sensible threshold (0.05 catches smooth glossy floors); there it restores mirror sharpness but doubles orbit flicker on mirrors and costs as much as full res.

# After the review and the main merges (main 6b2e35f: W74's kernel fixes, W73 rayReuse, W71)

- **Kernel.** The upsample keeps the linear `bilateralFill`, not the majority or stochastic pick: a residual upsample wants the weighted mean, and a per-pixel class pick would make it binary. W74's kernel now weights the ray length (radiance.w) by confidence. The residual's alpha is the composite's ssrWeight, which needs a plain mean, so `ReflectionUpsampleInputs.weightInAlpha` upsamples it in the confidence slot instead. Origin: footprints 2 / 4 take floor(p / 2), the lower cell of the bilinear pair in sample space, which is W74's convention.
- **Re-measure** (carConcept w50, ours-rt, MAD vs PT, [measure3-car960.jsonl](measure3-car960.jsonl)). The kernel change moves nothing (same as phase 2 to within 0.1).

| config | frame | lip | band | door | car |
|---|---|---|---|---|---|
| full (denoised) | 7.9 | 41.5 | 30.6 | 14.1 | 14.9 |
| half | 9.1 | 50.5 | 58.3 | 15.5 | 17.7 |
| half + hitSource 'hits' | 8.6 | 36.9 | 39.4 | 15.4 | 16.6 |
| full + rayReuse 'ratio' | 7.9 | 41.7 | 30.5 | 14.1 | 15.0 |
| half + ratio | 9.1 | 50.5 | 60.1 | 15.5 | 17.8 |
| half + ratio + hitSource | 8.6 | 35.5 | 40.2 | 15.4 | 16.6 |
| raw: full / half / half + ratio | 7.2 / 7.6 / 7.6 | 18.6 / 22.8 / 22.5 | 14.0 / 16.4 / 16.4 | 14.5 / 15.0 / 15.0 | 13.7 / 14.8 / 14.8 |

  With RT on, `rayReuse: 'ratio'` changes almost nothing here: its resolve leaves the traced pass's pixels to it (D5043), and carConcept's floor rays are mostly traced. It does not recover what half res loses.
- **Smoke:** half res + `rayReuse: 'ratio'` + `tracedMissRate: 'half'` together (contact, RT): all finite, 940 quads skipped, 3594 px filled, no validation errors (a `--only half-res` line). On the way: at full res on the ssr page, W74's `halfRateReady` stayed false after 80 frames (scripts/triple-debug.js; W74's lane).
- **Checks** (after the merge): sssr-core, ssr, hybrid (+ half-res), ssr-rt, showcase, regressions: 166 PASS, 0 FAIL ([checks-merge2.txt](checks-merge2.txt)). Default-identical vs main 6b2e35f: hashes equal, finals 0/255.

## Final verdict

- **`reflectionResolution: 'half'`: an option, not the default.** Pair it with `hitSource: 'hits'` as a performance preset (1080p frame -1.6 to -3.4 ms; carConcept denoised band 30.6 -> 39.4, lip 41.5 -> 36.9, frame 7.9 -> 8.6). Don't combine it with an upscale ratio above 1. Without hitSource, the band doubles (the denoiser's 2x screen footprint) and a thin emitter loses ~3/4 of its peak.
- **`halfResMinRoughness`: keep 0; drop it unless the mirror path gets a denoiser** (orbit flicker x2 on mirrors at 0.01, at full res's cost).
- **Ratio reuse:** no effect on the half-res losses with RT on; the two compose without errors.
