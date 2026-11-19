# Results: the SSR-sources experiments (X0-X5)

Status: 2026-11-13. Plan: `docs/plans/ssr-sources-experiments.md`. Background: `docs/research/ssr-external-sources.md`. Streams W70-W75, one worktree each. Every stream reviewed by a separate Opus pass, review fixes applied, merged into main. Main checks after each merge on 5389: typecheck, test 68, and the sssr-core, ssr-exp-x1, ssr, hybrid, half-res, ssr-rt, ssr-rt-bvh, showcase, regressions and bench sections, all passing.

**Every new setting defaults to today's behaviour.** Each stream checked bit-identity (0/255) against a build of main, not only against the setting being absent. That comparison was done on Metal only: D3D12 and Vulkan have not been compared (backlog).

## Headline

- **No idea became a default by itself.** Every one of them trades something. The measurements say "option" for all nine, and propose two defaults for the maintainer: X2's coupled bias at 0.5, and X1's relative thickness when RT is on.
- **The best quality finding is the thin-strip test.** At roughness 0.15, a small bright emitter's reflection is **lost** today (2-8 % of the path tracer's peak), under the upscaler's clamp plus the FFX denoiser. Two settings bring it back:
  - X2's cone + `mirrorBiasCompensate` at 0.5: 0.99x the PT's width with AA on, 0.95x with AA off;
  - X3's `rayReuse: 'ratio'`: 0.95x, peak 67 %.
  Nothing tried brings back roughness 0.3 or 0.5.
- **The best performance finding is X5.** Half resolution saves 1.6-3.4 ms at 1080p, but doubles the error at silhouettes, because the half-res denoiser covers twice the screen area. It is a preset, not a default.
- **The denoiser is where several of these limits live.** It drops sparse glossy hits, over-blurs grazing floors, and makes Sponza's denoised glossy error worse than raw (43 vs 28.5). X3's phase B (BRDF/pdf weights inside the FFX prefilter) and a radius scale for half-res are the denoiser-repo follow-ups.

## X0 (W70): shared metrics and today's baseline

Built in `examples/shared/metrics/`: rest drift, orbit flicker, 2x2 energy, edge pan, raw speckle, energy, line spread, grazing sweep. They are bench Measure columns, `__p.metrics.*`, and `--only ssr-exp-*`.

- Noise floor across page loads: drift ≤ 0.03/255, orbit std ≤ ~2 %.
- Findings at today's defaults:
  - the line-spread gate fails (r 0.05 is 1.28x the PT's width; r ≥ 0.15 is lost);
  - SSR thickness turns thin geometry into a slab (4x too wide, 70x too bright);
  - contact flickers at rest under the upscaler (4.5/255);
  - the denoiser over-blurs grazing floors and worsens Sponza.

## X1 (W71): four small settings

| Setting | Verdict | Numbers |
|---|---|---|
| `quadBaseRotation` | option, off | 2x2 energy down (contact 0.34 → 0.28, chess 0.071 → 0.044), but orbit flicker up (contact 0.27 → 0.38-0.40). Doesn't move contact's rest flicker, so that flicker isn't the quad copy. `quadCopy: 'sameSurface'` fixes the lip stair-step better. |
| `thicknessDepthFactor` / `Mode` | option, off. **Proposal: 'relative' 0.02 when RT is on** | 'relative' fixes the thin-strip slab (x4.25 → x1.45). Neutral with RT. Without RT it is mixed: mirrorWall stripes 6.1 → 12.5 at 0.01, near neutral at 0.02. |
| `hitLobeFilterGrazing` | not a default candidate; code kept | No effect beyond noise. The grazing over-blur is the denoiser's. Belongs with X2's cone. |
| `historyEdgeConfidence` | option, off | No measurable change. Only acts with history hit colour and re-shade off. |

Costs ≤ +0.06 ms at 1080p.

## X2 (W72): cone-footprint hit colour and coupled bias

These are the final numbers, after the review fixes and the merge with main. The ratio resolve now uses the compensated sample alpha, and on-screen reused RT hits read the pyramid.

- Line spread, as denoised / RT width relative to the PT's:

| Config | r 0.05 | r 0.15, AA on | r 0.15, AA off |
|---|---|---|---|
| default | x1.24 / x1.29 | lost | lost |
| cone | x1.23 / x1.28 | lost | lost |
| cone + comp. f 0.3 | x1.22 / x1.27 | x0.98 / x0.96 | x0.94 / x0.94 |
| cone + comp. f 0.5 | x1.19 / x1.24 | **x1.00 / x0.98** | **x0.96 / x0.95** |

  - r 0.3 and r 0.5 stay lost in every configuration.
  - f 0.7 fails with AA off (phase 2).
- Still sharper than the truth under compensation:
  - the diffuse / emissive of provider-shaded traced hits;
  - history-coloured reused hits;
  - `fallbackRoughness: 'mirror'` misses (D5024).
- Cone alone: raw fireflies down (sphere outliers 24 → 3x the mean, arcade floor halved, grazing raw MAD 4x lower). Blurrier at grazing angles.
- Coupled f 0.5 on the r 0.3 car floor: denoised 17.2 → 15.7, silhouettes 29.9 → 28.3. Blurrier at grazing (sharpness 0.79 → 0.52) until a grazing shrink applies to the cone. More raw specular outliers on the car paint.
- Energy, speckle, flicker and depth-edge leakage are within the noise. About +0.25 ms (pyramid pass).
- Proposed: cone alone stays an option; **cone + compensation at `mirrorBias` 0.5 is a candidate default**.

## X3 (W73): ratio-estimator ray reuse

- **Verdict:** `rayReuse` stays an option, default 'copy'. **Not promoted** to the denoiser repo: it isn't shown to help any signal but ours, and on ours the denoised noise rises. **Phase B recommended.**
- For: brings back the r 0.15 line (peak 3 → 67 %); the denoiser's energy loss on the lip goes 9.4 → 4.4 % (skirt 18 → 3 %); rooms 2x2 grid 0.072 → 0.024.
- Against: denoised std up (mirrorWall r 0.3: 0.45 → 0.64); +0.54 ms at 1080p, about the cost of spq 4.
- Phase B: ratio@4 keeps copy@4's noise and still recovers the energy. So the weights help and the separate small pass hurts: put the BRDF/pdf weights inside FFX's prefilter (denoiser-repo branch, seam carries the sample direction).

## X4 (W74): half-rate glossy RT misses

- **Verdict:** `tracedMissRate: 'half'` stays an option. RT stays full rate by default (SPEC open question 4).
- At 0.05: error within ~0.3 MAD; ~0.3 ms net saving on carConcept 1080p; denoised orbit flicker +2.4 % (carConcept) / +4.8 % (moving), above the 2 % floor.
- At 0.01: half the rays, but the fill eats the saving and flicker rises 14-21 %.
- Review caught two fill bugs, both fixed:
  - linear averaging of confidence grew silhouettes by a quad;
  - the majority vote darkened mixed fills by 11 %; it is now a stochastic pick, +0.7 %.

## X5 (W75): half-res trace, denoise and upsample

- **Verdict:** `reflectionResolution: 'half'` is a performance-preset option, used with `hitSource: 'hits'`. Not with `?upscale=` > 1 (errors add; contact flicker +15 %). `halfResMinRoughness` stays 0, unless the full-res mirror path gets a denoiser.
- Saves 1.6-3.4 ms at 1080p (RT 2.5 → 0.9, denoiser 1.9 → 0.5, upsample +0.4).
- carConcept denoised band 30.6 → 58.3, lip 41.5 → 50.5. `?upscale=2` at full res gives the same loss, so the cause is the denoiser's footprint, not the upsample. `hitSource: 'hits'` recovers band 39.4 / lip 36.9.
- Mirrors show jagged edges. Car paint is not blocky, but its error rises. `rayReuse: 'ratio'` doesn't recover what half loses.
- Review caught two bugs, both fixed:
  - a uniform layout that would fail on Safari / Firefox / older Chrome;
  - stale composites after a runtime switch.

## Decisions for the maintainer

1. X2: make cone + `mirrorBiasCompensate` at `mirrorBias` 0.5 the default? (confirmed after the review fixes: the only setting that passes the relative line-spread gate)
2. X1 #2: `thicknessDepthMode: 'relative'`, k 0.02, as the default when RT is on?
3. X3 phase B: a denoiser-repo branch putting BRDF/pdf weights in FFX's prefilter (seam carries per-sample direction)?
4. X5: a "performance" preset (half res + `hitSource: 'hits'`), and a denoiser-repo option to scale the spatial radius at half res?
5. Keep or remove the code for the options that measured as no-ops (X1 #3 grazing shrink, X1 #4 history edge confidence, X5 `halfResMinRoughness`)?

## What W76 made of decisions 1, 2 and 5

- **Default: cone + compensation at `mirrorBias` 0.5** (`hitColorFilter: 'off'` is the one switch back, bit for bit vs main). The pyramid pass costs 0.24-0.27 ms at 1080p and 0.43-0.63 ms at 1440p; the intersect moves within the noise. Details and the baseline at the new defaults: `docs/research/w76/README.md`.
- **Default with RT: 'relative' thickness 0.02** (explicit values win); docs/SETTINGS.md lists every RT-dependent default under "What changes when ray tracing is on".
- **The grazing shrink on the cone**: an option, off. It recovers half of the grazing sharpness the cone costs, but takes the r 0.15 line out of the gate.

## Removed options (W76, 2026-11-13)

The maintainer's decision 5: options that measured as no-ops go, with the experiment written down here and in their DIVERGES rows (status "removed"). Their Params words stay as padding (SSSR 143 now carries the cone's grazing shrink, 144 bit 0 stays 0, 157 padding; RT 67 padding; upsample 37 padding).

| Option (stream) | What was tried | Numbers | Why removed |
|---|---|---|---|
| `historyEdgeConfidence` (W71, X1 #4, D5003) | Diligent's screen-edge rule for hits coloured from last frame: confidence x min(vignette now, vignette at the previous position), and 0 where the previous texel was off screen (probe / RT instead of this frame's specular-free colour). | X0 edgePan, border-reflection d2 (off -> on): facingMirrors 11.68 -> 11.81, mirrorWall 7.44 -> 7.45, carConcept (re-shade off) 0.598 -> 0.602; offscreen inside its own 12 % run-to-run spread. At rest max 0/255. Traced rays +0.03-0.17 % while panning. | No measurable change on any page, and it only acts with `hitColor: 'history'` and `hitShading: 'off'`, which is not the default (the re-shade reads this frame's colour). |
| `halfResMinRoughness` and the full-res mirror path (W75, X5 step 2, D5084) | Under `reflectionResolution: 'half'`, pixels below this roughness traced by a second full-res tracer (spq 4, its own RT pass and history, no denoiser) and composited at full res. | At 0.05: carConcept's 0.03 floor lands on the undenoised path, 1080p 28.0 ms vs full 23.1 (mirror RT trace 5.3 ms). At 0.01: mirrorWall / facingMirrors MAD vs full 1.36 -> 0.69 / 1.24 -> 0.61, at full res's cost (8.4 vs 8.2 ms), orbit std 0.48 -> 0.88 / 0.62 -> 1.10. | It buys mirror sharpness only by dropping the denoiser (orbit flicker x2) and costs as much as full res, so the performance preset never wants it. A denoised mirror path would be a new design. |
| `hitLobeFilterGrazing` (W71, X1 #3, D5002) | SSSR 2015 slide 85's grazing shrink on `hitLobeFilter` (re-shaded SSR hits and traced hits), g 0 / 0.5 / 1, with and without `hitLobeFilterMixed`. | X0 grazing (r 0.15 floor, 5-60 deg): denoised MAD within 0.06 and gradient ratio within 0.005 of off, + RT within 0.04; the bench sweep on toyCar, carConcept, chess within 0.06; line spread r 0.05 unchanged. | The lobe filter only widens the probe / environment lookup at a hit, a fraction of a mip; the blur at grazing is the cone's and the denoiser's. The formula moved to the cone (`hitColorConeGrazing`, D5100), where it does move the grazing floor (gradient x0.53 -> x0.67 at 5 deg) but narrows the line-spread gate's r 0.15 line out of the gate (x1.01 -> x0.84, AA on), so it is off there too; with the lobe-filter half the numbers are the same to 0.01. The RT pass's second trace pipeline went with it. |

