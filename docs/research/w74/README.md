# W74 (plan X4): half-rate glossy RT misses + bilateral fill: phase 1

Branch `worktree-agent-acb8568d453dd7241`, from main `0abd154`. Port 5446. DIVERGES rows: [diverges.md](diverges.md) (D5060-D5062). HANDOFF row: [handoff-row.md](handoff-row.md).

## What was built

- **Setting** `tracedMissRate: 'full' | 'half'` (default 'full') and `tracedHalfRateMinRoughness` (default perceptual 0.05 = `DEFAULT_TRACED_HALF_RATE_MIN_ROUGHNESS`), on core `ScreenSpaceReflectionsSettings` (intersect decides) and `TracedReflectionsSettings` (runs the fill), three `ssr.traceSettings` (passed to both), bench `t.tracedMissRate`, `t.tracedHalfRateMinRoughness`, `t.fill*`.
- **'half'**: a glossy miss whose 2x2 quad is on the odd cell of a quad checkerboard (flips each frame) goes to a **fill list** (after the miss list's own entries in the same buffer: no new binding in intersect). With `samplesPerQuad` 1 the glossy rays are already one per quad, so 'half' is one traced glossy miss per two quads. Mirrors (alpha < 1e-4) and pixels below the min roughness are never skipped.
- **Fill** (RT pass, after the trace, one thread per (entry, quad pixel)): mark (source = fillPending), gather (core `bilateralFill` over the 3x3 quads around the pixel; the checkerboard leaves the 4 edge quads traced), scatter. It writes the same radiance / hit distance / confidence / source targets as the trace; no usable neighbour (weight sum < 0.01) keeps intersect's probe fallback with source 'capped'.
- **Params**: SSSR words 154-156 (PARAMS_SIZE 640), RT words 68-74 (RT_PARAMS_SIZE 320), RT state words 12-13. No storage buffer added to intersect or the trace pipeline; the fill pipelines have 4 storage buffers / 7 sampled (gather) and 3 / 4 storage textures (scatter, at the core limit).
- **Check**: `pnpm check --only ssr-rt` has a `'half'` line (contact: fewer rays, quads filled, no errors).

## The `bilateralFill` interface (for X5)

`packages/core/src/bilateral/fill.ts`, exported from core: `BILATERAL_FILL_WGSL`, `BilateralFillWeights`, `DEFAULT_BILATERAL_FILL_WEIGHTS`, `resolveBilateralFillWeights`, `bilateralFillWeightWords` (writes the 5 weight words into a uniform block), `BILATERAL_SOURCE_CODES` (8).

```wgsl
struct BilateralSurface { position: vec3f, normal: vec3f, roughness: f32 /* perceptual */, valid: bool }
struct BilateralTap { surface: BilateralSurface, radiance: vec4f /* rgb + ray length */, hitDistance: f32, confidence: f32, source: u32, spatial: f32 }
struct BilateralWeights { planeTolerance: f32, normalPower: f32, roughnessTolerance: f32, sourceMask: u32, minWeightSum: f32 }
struct BilateralResult { radiance: vec4f, hitDistance: f32, confidence: f32, source: u32 /* largest weight share */, weightSum: f32, taps: u32 }
fn bilateralWeight(p: BilateralSurface, viewDistance: f32, q: BilateralTap, w: BilateralWeights) -> f32
fn bilateralFill(p: BilateralSurface, cameraPosition: vec3f, pixel: vec2i, originCell: vec2i, footprint: u32, w: BilateralWeights) -> BilateralResult
fn bilateralFillMajority(p: BilateralSurface, cameraPosition: vec3f, pixel: vec2i, originCell: vec2i, footprint: u32, w: BilateralWeights) -> BilateralResult  // review fix 1
fn bilateralFillStochastic(p: BilateralSurface, cameraPosition: vec3f, pixel: vec2i, originCell: vec2i, footprint: u32, w: BilateralWeights, u: f32) -> BilateralResult  // X4 uses it (bias follow-up)
// the includer defines:
fn bilateralTap(cell: vec2i, pixel: vec2i) -> BilateralTap
```

- `cell` walks the caller's sample grid: footprint 2 = `originCell + {0,1}^2` (bilinear 2x2), 3 = `+ {-1,0,1}^2`, 4 = `+ {-1..2}^2`.
  - For footprint 3, pass the cell holding the pixel.
  - For footprints 2 and 4, pass the lower cell of the bilinear pair, `floor(pixel position in cell units - 0.5)`. Otherwise the footprint leans toward +x / +y (review fix 2).
  - X4's grid is 2x2 quads: `originCell = pixel >> 1` for 3, `(pixel - 1) >> 1` for 2 / 4; the tap is the quad's pixel nearest `pixel`.
  - X5's grid would be the half-res texels, with `spatial` = bilinear weights and footprint 2 (or 3 / 4).
- Weight = `spatial` x `saturate(1 - |dot(n_p, x_q - x_p)| / (planeTolerance x |x_p - camera|))` x `pow(saturate(dot(n_p, n_q)), normalPower)` x `saturate(1 - |r_p - r_q| / roughnessTolerance)` x (bit `source` of `sourceMask`). A tolerance / power of 0 turns its term off. Defaults 0.01 / 16 / 0.1 / RT_SOURCE {1, 2, 4} / min sum 0.01.
- **`bilateralFill` (linear).** Radiance rgb and confidence are the weighted means. Since review fix 1, ray length (`radiance.w`) and hit distance are confidence-weighted means, i.e. over the hits only: two hits and two misses give confidence 0.5 at the hits' t, not t/2. For a residual upsample (X5 step 4), pass the residual in `radiance.rgb`.
- **`bilateralFillStochastic` (X4 uses it, bias follow-up).** As the majority, but the hit class wins with probability = its weight share (`u` = the caller's uniform number; X4 hashes pixel and frame, RT word 75). One class per px, and the expected confidence is unbiased.
- **`bilateralFillMajority`.** The taps split into hits (confidence >= 0.5) and misses. The class with the larger weight wins and the result is that class alone: its rgb, confidence, t and dominant source. `weightSum` is the total over both classes (for the gate).
- The caller compares `weightSum` with `minWeightSum` and decides the fallback (X4: keep intersect's probe term).
- **Interface change since phase 1 (for X5):** structs and the `bilateralFill` signature are unchanged. Its `radiance.w` / `hitDistance` are now confidence-weighted, and there's a new sibling, `bilateralFillMajority`. Internal helpers `bilateralGatherClasses` / `bilateralResolve` / `BilateralClass` are new names in the module.

## Default-identical

Bit for bit vs main `0abd154` ([identical.md](identical.md)): raw radiance / hit distance / confidence / source hashes equal on ssr offscreen, contact, mirrorWall, facingMirrors, moving (denoiser off and on) and showcase carConcept; finals 0/255. Re-run after every shader change since (last: `b52a697` on the fill rewrite, all equal, finals 0/255). Needs `minTraversalOccupancy: 0` and a fixed `frameIndex`: FFX's occupancy exit makes two runs of one build differ.

## First numbers (phase 1)

**Traced rays and RT ms**, 1920x1080, @pmndrs/bvh, render loop stopped, configs alternating order per round, 6 rounds x 20 frames, medians (`scripts/timing.js`). Relative inside this worktree only. Untouched passes (depth downsample) drift up to ~10 % between configs, so that is the noise on these ms.

| scene | config | traced | rt trace ms | fill ms (mark + gather + scatter) |
|---|---|---|---|---|
| carConcept (showcase) | full | 259k | 3.57 | - |
| | half (0.05) | 245k (-5.3 %) | 3.15 | 0.12 |
| | half (0.01) | 138k (-47 %) | 2.68 | 0.84 (0.06 + 0.38 + 0.41) |
| moving (ssr) | full / half | 165k / 157k (-5 %) | 0.64 / 0.56 | 0.06 |
| offscreen (ssr) | full / half | 277k / 275k (-0.8 %) | 0.89 / 0.76 (drift) | 0.05 |
| contact (ssr) | full / half | 99k / 84k (-15 %) | 0.62 / 0.66 | 0.13 |

Most traced rays on these scenes are mirrors or near-mirrors: carConcept's floor is perceptual 0.03, under the 0.05 default, so it stays full rate. At 0.01 the floor goes half rate: -47 % rays, -0.9 ms trace, but the fill costs 0.84 ms (481k filled px), so the net is about -0.05 ms. The scatter (0.41 ms) is the part to make cheaper (D5062). The ssr scenes' second timing run was disturbed (depth downsample 0.15 -> 0.8 ms); the rows above are from the first, undisturbed one.

**Error vs the path tracer** (bench Measure, carConcept w50, 960x540, 16 spp PT, 48 warm-up + 8 measured frames, MAD /255; [measure-car960.jsonl](measure-car960.jsonl)). Two Measures of 'full' differ by at most 0.1 on every region (the noise floor).

| region (PT luma) | full raw / denoised | half 0.05 raw / denoised | half 0.01 raw / denoised |
|---|---|---|---|
| frame | 7.7 / 7.8 | 7.7 / 7.8 | 7.8 / 7.9 |
| glossy | 8.3 / 8.4 | 8.4 / 8.5 | 8.4 / 8.5 |
| lip (74) | 19.5 / 36.5 | 19.7 / 37.5 | 19.6 / 37.7 |
| band (5) | 13.8 / 27.0 | 13.6 / 26.7 | 14.3 / 27.5 |
| wheel (25) | 28.9 / 28.6 | 28.7 / 28.6 | 29.1 / 28.9 |
| door (119) | 15.8 / 14.1 | 15.7 / 14.1 | 15.7 / 14.0 |
| car (105) | 14.8 / 14.5 | 14.8 / 14.5 | 15.0 / 14.7 |

The error rises by +0.1 to +1.2 MAD. The largest rise is the denoised lip (the source edge, D3663), and it is above the 0.1 noise floor. Whether that is "less than the noise floor" depends on X0's noise-floor definition (orbit flicker, 2x2 energy), which is phase 2.

A first Measure had the fill writing confidence 0 at full confidence (an f32 rounding bug, fixed in `4e7e6dd`). Band raw read 86.5, which is how the bug was found. Those numbers are void.

## Phase 2 (X0's metrics, main a234de9 merged)

Raw data in `data/` (jsonl per run). Noise floors from W70: orbit std about 2 %, rest drift 0.03/255, Measure 0.1 MAD between two runs of one setting. All page metrics run with the page defaults (upscaler AA), `ours-rt` (@pmndrs/bvh), reflection region.

**Orbit flicker** (W39 pendulum), std of the reflection, denoised / raw; change vs full:

| scene | full | half 0.05 | half 0.03 | half 0.02 | half 0.01 |
|---|---|---|---|---|---|
| carConcept w50 | 0.362 / 0.851 | 0.378 (+4.3 %) / 1.120 | 0.377 (+4.2 %) / 1.130 | 0.413 (+14 %) / 1.216 | 0.415 (+15 %) / 1.244 |
| toyCar hero | 0.230 / 0.349 | 0.230 (-0.1 %) / 0.364 | | | 0.273 (+19 %) / 0.448 |
| chess hero | 0.234 / 0.400 | 0.234 (0 %) / 0.476 | | | 0.283 (+21 %) / 0.570 |
| ssr moving | 0.547 / 1.097 | 0.580 (+6.1 %) / 1.201 | | | 0.579 (+5.9 %) / 1.196 |
| ssr contact | 9.46 / 9.10 | 9.45 (-0.1 %) / 8.76 | | | 9.49 (+0.3 %) / 9.19 |

Orbit d2 (denoised) moves less: carConcept 0.295 / 0.300 / 0.300 / 0.307 / 0.307. The raw signal flickers more at every threshold (+4-32 % at 0.05): the checkerboard flips each frame, and the denoiser absorbs most of it. (contact is dominated by the upscaler's jitter at rest, W70 finding 1.)

**2x2 energy** (quad ratio): flat or lower with 'half' everywhere. carConcept display denoised 0.066 / 0.063 / 0.059 (full / 0.05 / 0.01), raw signal 0.916 / 0.900 / 0.899. The fill gives the skipped quads per-pixel gathers instead of one copied ray, so it adds no grid.

**Thin geometry.**
- `lineSpreadThin` (256 spp PT), ours-rt width (ratio to the PT) at r 0.05 / 0.15 / 0.3 / 0.5:
  - full 5.09 (1.43) / 6.94 (0.68) / 15.4 (0.47) / lost
  - half 0.05: 5.06 / 7.38 / 13.97 / lost
  - half 0.01: 5.23 / 7.19 / 14.75 / lost
  - Peaks are within 10 % of full and pass / fail is unchanged, so 'half' keeps what RT does there.
- carConcept sill: the band region in Measure (below).
- Sphere fringe (D4303): it lives in the facingMirrors mirrors (alpha 0), which 'half' never skips. Unchanged by construction; not re-measured.

**Measure vs PT** (MAD /255, raw / denoised; 960x540 unless marked; 16 spp, 48 + 8 frames).

| | full | 0.05 | 0.03 | 0.02 | 0.01 |
|---|---|---|---|---|---|
| carConcept 960: lip | 19.5 / 36.5 | 19.7 / 37.5 | 20.5 / 37.3 | 19.7 / 37.7 | 19.6 / 37.7 |
| band (sill) | 13.8 / 27.0 | 13.6 / 26.7 | 13.7 / 26.7 | 14.4 / 27.4 | 14.3 / 27.5 |
| car | 14.8 / 14.5 | 14.8 / 14.5 | 14.8 / 14.6 | 15.0 / 14.7 | 15.0 / 14.7 |
| carConcept 1080: lip / band / car (denoised) | 21.3 / 16.6 / 13.4 | 21.4 / 16.4 / 13.4 | | | 21.3 / 16.9 / 13.5 |
| toyCar glossy | 11.3 / 11.3 | 11.3 / 11.3 | | | 11.3 / 11.3 |
| chess glossy | 9.6 / 9.5 | 9.5 / 9.4 | | | 9.6 / 9.5 |

**Fill weights** (carConcept 960 at 0.01, denoised lip / band / car; defaults 37.7 / 27.5 / 14.7):
- normal power 4 or 64: 37.8 / 27.5 / 14.7 and 37.7 / 27.3 / 14.7.
- plane tolerance 0.003 or 0.03: 37.8 / 27.4 / 14.7 and 37.6 / 27.4 / 14.7.
- roughness tolerance 0.3: 37.5 / 27.4 / 14.7.
- footprint 4: 38.1 / 28.9 / 14.9 (worse).
- screen-space taps accepted (mask 23): 43.9 / 31.9 / 15.3 (much worse: a miss pixel isn't a screen hit).
- The defaults stay.

**Ray counts and cost** (carConcept 1080p): traced rays 259k (full), 245k (0.05 and 0.03), 138k (0.02 and 0.01). carConcept's floor is perceptual 0.03, so the threshold has two steps: floor in or out. Phase 1 timing: at 0.05 the trace drops 0.42 ms and the fill adds 0.12 ms. At 0.01 the trace drops 0.9 ms and the fill adds 0.84 ms.

**Cheaper scatter (tried, reverted).** The gather wrote hit distance and confidence in place (r32float read-write storage; race-free, because a pending pixel is never a tap), and the scatter wrote only radiance and source. Scatter went 0.41 -> 0.21 ms, but the gather went 0.38 -> 0.72 / 0.83 ms: read-write storage loads at the taps are slower than sampled loads. Net loss. The fill's cost is per filled pixel (gather + scatter about 1.7 ns/px), so it only pays where a traced ray costs much more than that.

## Verdict

- **Not the RT layer's default.** The plan's rule is to adopt only if the error rises less than the noise floor.
  - At the 0.05 default threshold, Measure stays within about 0.3 MAD (1080p) and 2x2 energy and thin geometry hold.
  - But denoised orbit std rises +4.3 % on carConcept and +6.1 % on moving, against a ~2 % floor (+2.6 % / +4.8 % after the review fixes).
  - At 0.02 / 0.01 it rises +14-21 % on every showcase scene.
- **Keep it as an option** (`tracedMissRate: 'half'`, `tracedHalfRateMinRoughness` 0.05).
  - **Where it pays:** at 0.05 (0.03 is the same on the car), where most glossy misses are above the threshold and traced rays are expensive. carConcept 1080p saves about 0.3 ms net (-0.42 trace, +0.12 fill) for +4 % denoised orbit flicker and ≤ 0.3 MAD.
  - **Where it doesn't pay:** at 0.02 / 0.01. The fill eats the trace saving (-0.9 vs +0.84 ms), and the flicker is well above the floor.
- **SPEC open question 4 for the RT layer:** no. RT stays full rate by default; half rate is an option for scenes with costly glossy RT.

## Review fixes (after main 2c3ec3a merged: W71's words 141-144 / RT 67 kept)

1. **Coverage, not linear mixing (fix 1, with fix 5).**
   - The problem: the fill averaged confidence and t linearly. Two hits and two misses gave confidence 0.5 at t/2. The composite's depth-aware blend (D2400) read that 0.5 as a thickness falloff and gave the hit full weight, so silhouettes on the fill side grew by about a quad and flipped every frame. t/2 also skewed probeConsistency and the denoiser's reprojection.
   - **Choice:** X4 fills with `bilateralFillMajority`. A filled pixel is either a hit (the hit taps' radiance, confidence about 1, their confidence-weighted t, a hit source) or a miss (confidence 0, the miss source). Mixed coverage never reaches D2400 as a partial confidence: the edge falls where the weighted majority of neighbours puts it.
   - **Source (fix 5):** it is the winning class's. A mostly-miss fill is RT_SOURCE traced miss with confidence 0, which is consistent with the composite's AO skip.
   - **Bias:** the still-frame content check reads a radiance bias of -18.7 % on contact. The linear kernel reads -6.8 %, and the 8x8 block error is the same 14.5 % for both. The extra bias is in radiance only: a miss-class pixel is black in three's radiance, and the composite adds its probe.
2. **Centred even footprints (fix 2).** For footprints 2 and 4, X4 passes `(c - 1) >> 1` (the lower cell of the bilinear pair). The kernel header states the convention. On contact, footprint 2 fills 13.8k px with 1358 fallbacks (a centred 2x2 of quads holds two traced quads); footprint 4 fills 14.8k with 331.
3. **Settings precedence (fix 3).** The three adapter takes `traceSettings` first, then `settings`, and gives both passes the same value. Measured: settings only → 3794 quads on the fill list; traceSettings only → 3859; traceSettings 'full' over settings 'half' → 0.
4. **Async pipelines (fix 4).** `prepareHalfRate()` uses `createComputePipelineAsync`, and `halfRateReady` reports when they're in. Until then a 'half' dispatch runs no fill, and the adapter keeps both passes at 'full'.
5. See fix 1.
6. **Content check (fix 6).** ssr-rt traces contact on a still frame at full and at half rate and compares the changed pixels.
   - It reads means (a per-pixel comparison is ray-sample noise): radiance bias -18.7 % (|x| < 30 %), 8x8 block mean error 14.4 % (< 30 %), confidence 0.636 vs 0.754 (> 0.7x).
   - The confidence-0 bug of `4e7e6dd` would fail it.
7. **Failed fills (fix 7, backlog).** 3.9 % of fill pixels on contact find no usable neighbour. Their quad alternates between traced and probe each frame. A fill-time fix can't trace them (intersect decides before the trace). Backlog line in `handoff-row.md`.

**After the fixes:**
- **Default-identical vs main HEAD `2c3ec3a`:** all raw hashes equal, finals 0/255 (6 scenes, denoiser on and off).
- **Checks:** ssr-rt (with the content check), ssr-rt-bvh, hybrid and regressions pass.
- **Orbit flicker at 0.05, denoised (raw):**
  - carConcept: 0.364 → 0.373, +2.6 % (raw +16 %); before the fixes +4.3 % (raw +32 %).
  - moving: 0.546 → 0.572, +4.8 % (raw +6 %); before +6.1 %.
  - Still over the ~2 % floor, so the verdict holds: an option, not the RT default.

## Bias follow-up (lead's question)

On contact, a still frame at half vs full (`scripts/bias.js`). The fill pixels are found by a run where every fill falls back. Each stage is a mean over those pixels:

| fill | px | radiance | raw signal (with the probe term) | denoised | confidence half / full |
|---|---|---|---|---|---|
| majority, succeeded | 14412 | -11.2 % | -11.4 % | -0.07 % | 0.266 / 0.292 |
| majority, fell back | 583 | -89 % | +2.6 % | -0.8 % | 0.069 / 0.676 |
| **stochastic, succeeded** | 14412 | **+0.7 %** | -7.3 % | -0.08 % | 0.297 / 0.292 |
| stochastic, succeeded (moving) | 6890 | +6.3 % | +5.5 % | +1.2 % | 0.383 / 0.380 |
| stochastic, footprint 2 | 13798 | +1.6 % | -6.8 % | -0.01 % | 0.287 / 0.281 |

- The check's -18.7 % was mostly real. The majority vote turned glossy pixels with a stochastic 29 % hit share into misses: raw signal -11 % on successful fills. The denoiser hid it (-0.07 %).
- Fallback pixels read -89 % in radiance only (black in three). With their probe term they are +2.6 %.
- **Fix:** X4 now uses `bilateralFillStochastic` (the hit class wins with probability = its weight share). Radiance and confidence are unbiased (+0.7 %, 0.297 vs 0.292).
- **Left over:** a scene-dependent ±5-7 % in the raw signal (contact -7.3 %, moving +5.5 %). By class, hits match (0.166 vs 0.168) and misses differ (0.211 vs 0.232): the fill moves which pixels are misses within about a quad, so their own probe term differs. The denoised output is within 1.2 %. Logged, not chased (time-box).
- **After the fix:**
  - ssr-rt content check: bias -8.0 % over the changed pixels (mostly the 583 fallbacks), confidence 0.665 vs 0.706.
  - carConcept denoised orbit std at 0.05: +2.4 % (majority +2.6 %).
- The verdict is unchanged.

## Notes

- The fill-list capacity is half the quads plus a row. `samplesPerQuad` 2 / 4 overflow it on large glossy areas; the overflow is traced (`fillOverflow` in the stats).
- `PassTimer` now clears its map per readback. Before, keys from passes a frame didn't run stayed in `readTimings()`, and A/B medians picked up stale values.
- `examples/assets` in the worktree is a symlink to the main checkout's assets (untracked; not staged).
