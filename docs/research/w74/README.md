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
// the includer defines:
fn bilateralTap(cell: vec2i, pixel: vec2i) -> BilateralTap
```

- `cell` walks the caller's sample grid: footprint 2 = `originCell + {0,1}^2` (bilinear 2x2), 3 = `+ {-1,0,1}^2`, 4 = `+ {-1..2}^2`. X4's grid is 2x2 quads (`originCell = pixel >> 1`, footprint 3, tap = the quad's pixel nearest `pixel`); X5's would be the half-res texels with `spatial` = bilinear weights and footprint 2 (or 3/4).
- Weight = `spatial` x `saturate(1 - |dot(n_p, x_q - x_p)| / (planeTolerance x |x_p - camera|))` x `pow(saturate(dot(n_p, n_q)), normalPower)` x `saturate(1 - |r_p - r_q| / roughnessTolerance)` x (bit `source` of `sourceMask`). A tolerance / power of 0 turns its term off. Defaults 0.01 / 16 / 0.1 / RT_SOURCE {1, 2, 4} / min sum 0.01.
- Radiance (all four channels), hit distance and confidence are normalised with the same weights (confidence is what the composite and D2400 read). For a residual upsample (X5 step 4), pass the residual in `radiance`.
- The caller compares `weightSum` with `minWeightSum` and decides the fallback (X4: keep intersect's probe term).

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

## Not done yet (phase 2, after X0)

- Thin silhouettes, 2x2 energy and orbit flicker, with and without the denoiser (X0's metrics).
- Measure at 1080p and on toyCar / chess; a sweep of `tracedHalfRateMinRoughness` and of the fill weights.
- Making the scatter cheaper before judging 0.01.
- The verdict: adopt as the RT layer's default only if the error rise stays inside X0's noise floor.

## Notes

- The fill-list capacity is half the quads plus a row. `samplesPerQuad` 2 / 4 overflow it on large glossy areas; the overflow is traced (`fillOverflow` in the stats).
- `PassTimer` now clears its map per readback. Before, keys from passes a frame didn't run stayed in `readTimings()`, and A/B medians picked up stale values.
- `examples/assets` in the worktree is a symlink to the main checkout's assets (untracked; not staged).
