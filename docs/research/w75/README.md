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
