# Probe layouts × storage formats (phase 1)

W1, 2026-11-10. The bench is `examples/probe-bench/` (raw WebGPU, core only). Reproduce with
`REFLECTIONS_PORT=5371 pnpm check -- --only probe-bench --probe-bench` (writes `out/probe-bench.json`), then
`node examples/probe-bench/report.mjs` for the tables. The numbers below come from run 8 (commit `9a20b16`, data in the appendix).
Machine: Apple Silicon (M-series, `metal-3`), Chrome 157 headless, WebGPU through Dawn/Metal.

## The question, answered

> "I thought we should use octahedral probes for efficiency, but it seems we can use compressed (cube) arrays for better performance. Validate this."

**Compressed cube arrays are not faster than octahedral probes on this machine. Compression is what is faster, and it helps octahedral probes just as much.**

- **Coherent lookups** (neighbouring pixels read neighbouring texels, as in a real frame): a 1080p pass with one probe lookup per pixel costs about 0.08–0.10 ms for every layout and every format. A cube array (`cube-hw`) and `octa` are within ±10% of each other. With 8 lookups per pixel, where sampling rather than the render-target write dominates, `octa` is 12–16% *faster* than `cube-hw` (ratio 0.84–0.88). BC6H changes nothing here (0.93–1.07×).
- **Scattered lookups** (random direction, roughness and probe per pixel, a cache worst case): BC6H is **2.5–3× faster** than `rgba16float` (ratio 0.35–0.41), for cube arrays and octa alike. Here `octa` in `rgba16float` is 1.2–1.36× *slower* than `cube-hw`.
- **The real per-frame win is over today's path.** `cube2d-warp` (what the three adapter ships) costs 1.24–1.38× `cube-hw` with one lookup per pixel, and 1.43–1.49× with eight. Moving to a hardware cube array removes that cost, and also the mirror-mip error and the seams (below).

**Cube arrays win on quality per byte.** A cube capture copies into a cube array without resampling, so its mirror mip is exact. `octa` has to resample the capture, and at equal memory its mirror mip is clearly worse (p99 19.9 vs 12.7 / 255 for `cube2d-warp` and 0.0 for `cube-hw`). At roughness > 0 it matches the cube.

**Hardware-specific.** All of this is Apple's tile-based GPU in Chrome: the coherent pass is limited by fill and bandwidth, the texture units decode BC6H at no visible cost, and the texture cache is generous. On a discrete desktop GPU the coherent costs may separate more, and the scattered BC6H advantage may shrink or grow. Mobile WebGPU has no BC6H at all. The error numbers depend only on the maths, so they carry to any GPU.

## Verdict against the SPEC gate

| Gate | Condition | Result | Verdict |
|---|---|---|---|
| `octa` default | matches `cube2d-warp` error at ≤ memory | `octa@320` (1066 KiB, 1.04× the 128 cube's 1023 KiB) matches or beats warp at every r > 0 (p99 3.6/3.2/1.9/2.7 vs 4.0/3.0/1.6/2.4). It loses at the mirror mip: mean 0.73 vs 0.41, p99 19.9 vs 12.7. `octa@256` (0.67× memory) is worse at r = 0 (p99 24.2) and r = 1 (4.0 vs 2.4). | **fails** (the mirror mip) |
| | costs no more per frame | 0.97–1.11× `cube-hw` and 0.75–0.85× `cube2d-warp` with 1 lookup/px; 0.84–0.88× `cube-hw` with 8/px; 1.2–1.36× `cube-hw` when scattered | passes (coherent) |
| | **`octa` stays an option, not the default.** | | |
| BC6H opt-in | p99 within 2× the layout's own, at ≥ 128 px | **Re-run 9 (G1, after F1's anchor fix D203), `normal`:** `cube-hw@128` p99 per mip r = 0/.13/.29/.5/1: 1.3/4.6/3.7/2.8/4.1 vs `rgba16float` 0.0/3.9/3.0/1.6/2.0, so 1.18× / 1.23× / 1.71× / **2.05×** (r = 0: 1.3 / 255 against an exact mirror mip). At 256 px: ≤ 1.21× to r = 0.37, 1.81× at r = 0.55, **2.20× at r = 1**. `fast` is worse at the rough end (2.72× / 2.57× at r = 1). | **fails**, by a hair at 128 px, on the roughest mip only |
| | sampling no slower | 0.92–1.06× coherent, 0.35–0.38× scattered (run 9) | passes |
| | **BC6H stays off as a whole-texture format.** The fix changed no error cell at the reported precision (the overflow was one texel per hit block, 128 of 7315 blocks). BC6H on the sharp mips with an uncompressed rough tail would pass (see "BC6H split" below), but needs a two-texture lookup. | | |

The format default stays `rgba16float`. The cheapest lossless-looking option is **`rgb9e5ufloat`**: half the memory, at most +0.05 mean / 255 of extra error, and no slower to sample.

For the core path (phase 2) the bench points at **`cube-hw`, a raw-WebGPU cube array**. It has the lowest error at every mip and no seams, and it is the cheapest or equal-cheapest lookup. The three adapter keeps `cube2d-warp` until TSL can bind cube arrays (D1). `octa` is worth keeping for engines without cube arrays (WebGL2-class backends, D5).

## Method

- **Environment** (`examples/probe-bench/src/env.ts`): a procedural HDR sky, rasterized into the capture cube with 4×4 supersampling. Its high-contrast features sit on cube face edges and on octa folds:
  - a sun (radius 1°, value 500) on a vertical cube edge and on the horizon, which is the octa diamond fold;
  - a lamp (radius 1.5°, value 200) at a cube corner;
  - three windows (value 20) across a vertical edge, a top edge and the octa border;
  - 0.3° lines (value 2–3) on the lower meridians every 45°, which are the octa border and the vertical cube edges, and on the 45° elevation ring.
  - No real capture yet (see "Not done").
- **Captures**: 128 px and 256 px cubes (`rgba16float`). Each class has `maxLod = log2(size) − 3`, so the roughness mips are the same for every layout in the class: 0/.134/.293/.5/1 at 128, 0/.106/.225/.368/.553/1 at 256.
- **Layouts** (`packages/core/src/probes/layouts/`):
  - `cube2d-warp` and `cube2d-none`: today's 6-layer 2D arrays.
  - `cube-hw`: a `texture_cube_array`. It binds and samples fine in raw WebGPU on Chrome.
  - `octa`: full sphere, +y pole. Its gutter is half a texel at the last mip, which makes it a fixed fraction of the side, so one trilinear sample works at every mip.
  - `octa` sizes: 128/256/320/512 px for the 128 capture, and 256/512/640/1024 px for the 256 capture. 320 and 640 are the equal-memory points (`LayoutPrefilter` accepts any size divisible by 2^maxLod).
- **Prefilter**: `LayoutPrefilter`, three r187's plan through each layout's `dirForTexel`. For `cube2d-warp` and `cube2d-none` its output is **bit-identical** to the existing `ProbePrefilter` (0 of 2,096,640 half values differ at 256 px). This is checked in `pnpm check`.
- **Reference** (`packages/core/src/probes/reference.ts`): the GGX lobe (V = N = R) integrated over mip 0 of the capture, along 65,536 Fibonacci directions.
  - Narrow lobes (fewer than 32 mip-0 texels wide) use QMC with 65,536 samples and bilinear mip-0 lookups. Measured against 262,144 samples, its own noise is p99 0.6–1.0 / 255.
  - Broad lobes use an exhaustive weighted sum over every mip-0 texel. Against QMC it agrees to p99 0.06–0.17 / 255.
  - r = 0 is one bilinear sample.
- **Error metric**: per direction, the maximum over channels of |tone(test) − tone(ref)|, where tone is Reinhard per channel followed by the sRGB encode, in /255. It is reported as mean and p99, split into three groups:
  - **seam**: within 1 texel (at that mip) of a cube face edge, or for octa of its border or diamond fold;
  - **interior**: everything else;
  - **bright**: reference luminance > 2, the glow of the sun, the lamp and the windows. This is where small-float banding would show (D61).
- **Memory**: every mip and layer of one probe.
- **Bake**: GPU time of the prefilter, then of the prefilter plus format conversion. Each is a timestamp span over 8 back-to-back bakes, bracketed by one-texel passes that read the result, divided by 8. The figure is the minimum of 9.
- **Lookup**: a 1920×1080 render pass with one lookup per pixel, for 1, 3 and 16 probes (the probe chosen per screen region), plus two variants: 16 probes "scattered", and 3 probes with 8 lookups per pixel.
  - The figure is wall clock over bursts of 32 passes (4 when scattered), the minimum of 9, plus the **median ratio to `cube-hw` `rgba16float`** over 9 back-to-back burst pairs.
  - **Use the ratios.** Other agents ran GPU work on this machine during every run, so the absolute numbers carry some contention.
  - The loop is stopped: the page has no render loop at all.
- **Formats**:
  - `rgba16float` is copied directly.
  - `rg11b10ufloat` and `rgb9e5ufloat` are packed in compute (from f16 bits, rounded to nearest; rgb9e5 by the EXT_texture_shared_exponent reference encoder) into a buffer, then copied with `copyBufferToTexture`. This needs no optional feature.
  - BC6H goes through W2's encoder, in `fast` (mode 11) and `normal`.
  - The bench requests only `timestamp-query` and `texture-compression-bc`, at default limits. The encoder's 128 MiB storage-binding limit is not reached, because the encoder runs per probe (at most 1024² × 1 layer, or 256² × 6).

## Results

### Error, 128 px capture, `rgba16float` (mean / p99, /255)

| layout | KiB / probe | r 0 | r .134 | r .293 | r .5 | r 1 | seam p99 at r 0 |
|---|---|---|---|---|---|---|---|
| cube-hw@128 | 1023 | 0.00 / 0.0 | 1.03 / 3.9 | 0.63 / 3.0 | 0.48 / 1.6 | 0.50 / 2.0 | 0.0 |
| cube2d-warp@128 | 1023 | 0.41 / 12.7 | 1.03 / 4.0 | 0.63 / 3.0 | 0.50 / 1.6 | 0.55 / 2.4 | 19.2 |
| cube2d-none@128 | 1023 | 0.01 / 0.0 | 1.03 / 3.9 | 0.63 / 3.1 | 0.50 / 1.8 | 0.58 / 2.9 | 10.8 |
| octa@128 | 171 | 2.77 / 52.2 | 2.33 / 14.4 | 1.72 / 9.2 | 2.16 / 7.8 | 2.13 / 10.1 | 57.9 |
| octa@256 | 682 | 0.96 / 24.2 | 1.10 / 4.3 | 0.73 / 3.7 | 0.69 / 2.3 | 0.69 / 4.0 | 30.8 |
| **octa@320** | **1066** | 0.73 / 19.9 | 0.98 / 3.6 | 0.65 / 3.2 | 0.54 / 1.9 | 0.55 / 2.7 | 25.9 |
| octa@512 | 2728 | 0.35 / 10.3 | 0.90 / 3.5 | 0.58 / 2.9 | 0.40 / 1.7 | 0.41 / 1.5 | 13.6 |

- **Seams.** `cube2d-none`'s clamp at face edges shows only at seam texels (p99 10.8 at r = 0, 4.0 at r = 1, against 1.8 for `cube-hw`). `cube2d-warp` trades that for a resampled mirror mip everywhere (interior p99 12.4). `octa`'s seam and interior errors are the same, so the gutter works and no fold artefact shows. Octa's whole error is resampling and texel density.
- **r > 0.** At r ≥ 0.134 every cube layout and `octa@320` sit within the prefilter's own error, which is the same r187 plan for all of them (about 1 mean, 4 p99 at r = 0.134; that is filtered importance sampling with 256 samples, D63).

### Error, 256 px capture, `rgba16float`

| layout | KiB | r 0 | r .106 | r .225 | r .368 | r .553 | r 1 |
|---|---|---|---|---|---|---|---|
| cube-hw@256 | 4095 | 0.00 / 0.0 | 0.71 / 3.7 | 1.22 / 4.4 | 0.44 / 2.4 | 0.44 / 1.4 | 0.50 / 2.0 |
| cube2d-warp@256 | 4095 | 0.24 / 6.3 | 0.71 / 3.7 | 1.22 / 4.4 | 0.44 / 2.4 | 0.46 / 1.4 | 0.56 / 2.4 |
| octa@512 | 2730 | 0.57 / 18.5 | 0.75 / 3.8 | 1.25 / 4.5 | 0.52 / 2.6 | 0.60 / 2.0 | 0.70 / 4.0 |
| **octa@640** | **4266** | 0.44 / 13.9 | 0.70 / 3.6 | 1.23 / 4.4 | 0.46 / 2.5 | 0.49 / 1.5 | 0.55 / 2.8 |

**Resolution (D62 vs D23).** Going from 128 to 256 px halves `cube2d-warp`'s mirror error (p99 12.7 → 6.3). At r > 0 it changes nothing measurable, because there the prefilter's own error dominates. 256 px is worth it only for mirror-like materials, which supports D62's "resolution follows the smoothest material".

### r < 0.2 (lookups between mip 0 and mip 1)

| layout | r .05 | r .10 | r .15 |
|---|---|---|---|
| cube-hw@128 | 3.80 / 44.7 | 3.00 / 19.5 | 2.23 / 9.1 |
| cube2d-warp@128 | 3.95 / 45.9 | 3.00 / 19.9 | 2.25 / 9.2 |
| octa@320 | 3.93 / 45.7 | 2.91 / 20.4 | 2.24 / 9.1 |
| cube-hw@256 | 2.89 / 35.4 | 0.98 / 5.3 | 3.05 / 12.5 |

At 128 px, r = 0.05 maps to lod 0.39 under `lod = maxLod · r(2 − r)`. Trilinear filtering then blends the mirror with the r = 0.134 mip. That makes **p99 35–46 / 255, 10× the error at the mips themselves**, and it is the same for every layout. This is the D64 concern, measured: the r187 mapping with 8 px floors has too few mips below r = 0.2. It belongs to the prefilter plan (D3), not to the layout. A mapping that spends more mips below 0.2 (Lagarde's `sqrt(α)`-based lod) or an extra mip between 0 and 1 would address it. That is a separate experiment and is not done here. See D101.

### Formats (128 px, `cube-hw` unless noted; p99, with mean in brackets)

| format | B/texel | r 0 | r .134 | r .5 | r 1 | bright p99, r 0 / .134 |
|---|---|---|---|---|---|---|
| rgba16float | 8 | 0.0 (0.00) | 3.9 (1.03) | 1.6 (0.48) | 2.0 (0.50) | 0.0 / 2.1 |
| rgb9e5ufloat | 4 | 0.1 (0.05) | 3.9 (1.04) | 1.6 (0.50) | 2.0 (0.51) | 0.0 / 2.1 |
| rg11b10ufloat | 4 | 0.4 (0.19) | 4.0 (1.08) | 1.7 (0.56) | 2.1 (0.58) | 0.2 / 2.1 |
| bc6h `fast` | 1 | 1.2 (0.31) | 4.6 (1.28) | 3.1 (1.07) | 5.4 (1.52) | 1.5 / 2.7 |
| bc6h `normal` (run 9, after the anchor fix) | 1 | 1.3 (0.41) | 4.6 (1.29) | 2.8 (0.98) | 4.1 (1.22) | 1.4 / 2.7 |

- **rg11b10 (D61).** Under this tone map it shows no banding on bright sources: its bright p99 equals rgba16float's. What it does add is a uniform offset: +0.07 to +0.19 mean, which is its 5-bit blue mantissa (a slight colour shift). rgb9e5 costs the same 4 bytes and adds about a quarter of that. **Prefer rgb9e5 for baked probes.** rg11b10 is only worth it where a render pass must write the probe directly, which needs the `rg11b10ufloat-renderable` feature.
- **BC6H.** Fine at the sharp mips (≤ 1.3× at r ≤ 0.29). It degrades on the roughest mips, which are 8 px faces of 2×2 blocks holding smooth gradients. In absolute terms that is p99 4.1 (`normal`) / 5.4 (`fast`) / 255 at r = 1.
  - **Run 9 (G1, 2026-11-10, main at `89ed133` with F1's anchor clamp `ea4bfcd`, D203):** the full bench re-run reproduced every `normal` error cell of run 8 to the shown precision, at 128 and 256 px and for every layout. F1 predicted this: the overflow corrupted one texel in 128 of 7315 two-subset blocks, too little to move a mean or a p99. So the pre-fix `normal` numbers were already right, and the verdict now uses `normal` (the better preset at the rough end): 2.05× at r = 1, 128 px; 2.20× at 256 px. Still a fail, but only on the last mip.

#### BC6H split: sharp mips compressed, rough tail uncompressed (computed from run 9, nothing implemented)

One texture has one format, so this is two textures per probe set (BC6H for lods 0..n−k, `rgba16float` for the last k) and a lookup that picks the texture by lod and blends the two across the boundary. Error per mip is then BC6H `normal`'s above the split and `rgba16float`'s below it; memory per probe, every mip and face:

| capture | split | KiB / probe | vs all-BC6H / all-rgba16f | p99 per mip (r: BC6H `normal`, then rgba16f) | worst ratio to rgba16f |
|---|---|---|---|---|---|
| 128 (5 mips) | last mip (8 px, r = 1) rgba16f | 130.5 | 127.9 / 1023 | .13: 4.6 · .29: 3.7 · .5: 2.8 · 1: **2.0** | **1.71×** (r = 0.5): passes |
| 128 | last 2 mips (16 + 8 px) rgba16f | 141.0 | | .13: 4.6 · .29: 3.7 · .5: **1.6** · 1: **2.0** | 1.23× |
| 128 | last mip rgb9e5 | 129.0 | | as the rgba16f tail (rgb9e5 is within 1.01× of it) | 1.71× |
| 256 (6 mips) | last mip (8 px, r = 1) rgba16f | 514.5 | 511.9 / 4095 | .11: 4.0 · .23: 4.7 · .37: 2.9 · .55: 2.6 · 1: **2.0** | **1.81×** (r = 0.55): passes |
| 256 | last 2 mips rgba16f | 525.0 | | ... · .55: **1.4** · 1: **2.0** | 1.21× |

The rough tail is tiny (the 8 px mip is 384 texels of 130,944 at 128 px), so leaving it uncompressed costs 2.6 KiB per probe (+2 %) and brings every mip inside the 2× gate. The price is in the lookup, not the memory: a second texture binding, and two samples where the lod falls between the last BC6H mip and the first uncompressed one. Whether that is worth it next to `rgb9e5ufloat` (4 B/texel everywhere, ≤ 1.02× error, one texture) is a phase-2 follow-up, not decided here.

### Bake (GPU ms per probe, prefilter → + rgba16f / + rgb9e5 / + bc6h fast)

| layout | 128 px capture | 256 px capture |
|---|---|---|
| cube-hw / cube2d-none | 0.37 → 0.37 / 0.38 / 0.40 | 0.94 → 0.99 / 0.99 / 0.98 |
| cube2d-warp | 0.40 → 0.41 / 0.40 / 0.40 | 0.90 → 0.93 / 0.97 / 0.98 |
| octa@256 / @512 | 0.42 → 0.42 / 0.43 / 0.44 | 0.96 → 0.97 / 0.98 / 0.99 |
| octa@320 / @640 | 0.46 → 0.46 / 0.47 / 0.48 | 1.11 → 1.14 / 1.16 / 1.20 |

Format conversion is nearly free: the compute pack plus `copyBufferToTexture` adds about 0.01 ms. BC6H `fast` adds about 0.03 ms per probe. `normal` adds 0.24 ms at 128 px and 0.5 ms at 256 px (run 9, after the anchor fix: 0.25 / 0.48 ms). `octa` at equal memory bakes about 1.2× slower than the cube, because it has more texels at the sharp mips.

### Lookup (1920×1080, ms; ratio to `cube-hw` `rgba16float`)

| layout | 1 probe | 16 probes | 16, scattered | 3, 8 lookups/px |
|---|---|---|---|---|
| cube-hw@128 rgba16f | 0.087 (0.97) | 0.087 (0.97) | 1.03 (1.08) | 0.33 (1.01) |
| cube-hw@128 bc6h | 0.088 (1.07) | 0.091 (0.97) | 0.33 (0.35) | 0.30 (0.97) |
| cube2d-warp@128 rgba16f | 0.081 (1.29) | 0.094 (1.28) | 0.85 (1.06) | 0.34 (1.45) |
| cube2d-none@128 rgba16f | 0.112 (1.09) | 0.106 (1.09) | 1.03 (1.00) | 0.36 (0.98) |
| octa@256 rgba16f | 0.091 (1.07) | 0.094 (0.97) | 1.20 (1.23) | 0.28 (0.87) |
| octa@320 rgba16f | 0.097 (1.07) | 0.100 (1.03) | 1.28 (1.36) | 0.27 (0.87) |
| octa@320 bc6h | 0.091 (0.97) | 0.091 (1.00) | 0.35 (0.38) | 0.26 (0.86) |
| cube-hw@256 rgba16f | 0.075 (0.93) | 0.075 (0.96) | 0.88 (1.00) | 0.30 (1.00) |
| cube2d-warp@256 rgba16f | 0.106 (1.38) | 0.125 (1.28) | 1.00 (0.98) | 0.45 (1.43) |
| octa@512 rgba16f | 0.081 (1.08) | 0.084 (1.00) | 1.20 (1.32) | 0.26 (0.84) |
| octa@512 bc6h | 0.078 (1.04) | 0.081 (1.00) | 0.28 (0.36) | 0.25 (0.86) |

The probe count (1, 3 or 16) makes no difference in the coherent pattern. Each screen region reads one probe, so the cache footprint is per region. The full per-format table is in the appendix.

## Timing pitfalls on this machine (for whoever measures next)

- **Render-pass timestamps.** Begin/end timestamps on consecutive Metal render passes overlap their neighbours: identical passes timed 0.8× depending on order, and spans came out about 2× the wall clock. This is why the lookup uses wall clock over bursts, and ratios.
- **Out of memory with timestamps.** Begin-only or end-only timestamps on compute passes, with more than about 4 prefilters in one command buffer, failed with `kIOGPUCommandBufferCallbackErrorOutOfMemory` (the device was lost). Bracketing the span with one-texel passes that carry both timestamps works. So does pooling query sets.
- **Clocks and contention.** Clocks move with load, and other agents' GPU work shares the machine. Report the minimum and ratios from back-to-back pairs, not medians of isolated submits.

## Not done / next

- **A real capture** (bake in `examples/probes`, dump the faces). The procedural sky is harsher than most rooms at the folds and edges, and softer than a sunlit exterior.
- **`octa-hemi`.**
- ~~**BC6H after F1's anchor fix.**~~ Done (run 9, G1): `normal` unchanged, 2.05× at r = 1, still a fail; the split above passes. Still open: a 16 px floor for BC6H (whole 4×4 blocks per face at the last mip), and the split's two-texture lookup cost.
- **The r < 0.2 mapping experiment (D101).**
- **Phase 2.** Switch `ProbePrefilter` to wrap `LayoutPrefilter`. Parity is already proven bit for bit.

## Appendix: run 8, full tables

Generated by `node examples/probe-bench/report.mjs` from `out/probe-bench.json`. In it, "bc6h" means the encoder's `normal` preset, **pre-fix (anchor overflow)**, and "bc6h fast" means mode 11. Run 9 (after the fix, G1) reproduced every "bc6h" error cell below to the shown precision; its lookup and bake timings moved within run-to-run noise, so the tables are left as run 8.

Device: {"vendor":"apple","architecture":"metal-3","description":"","features":["timestamp-query","texture-compression-bc"],"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36"}
Directions: 65536. Run time 66 s.

Parity (LayoutPrefilter vs ProbePrefilter, half values differing):

| capture | layout | differing / total |
|---|---|---|
| 128 | cube2d-warp | 0 / 523776 |
| 128 | cube2d-none | 0 / 523776 |
| 256 | cube2d-warp | 0 / 2096640 |
| 256 | cube2d-none | 0 / 2096640 |

Reference self-check (the other estimator on the same lobe; /255 after tone map):

| capture | lod | r | used | vs | mean | p99 | max |
|---|---|---|---|---|---|---|---|
| 128 | 1 | 0.134 | qmc | qmc 262144 | 0.08 | 0.74 | 2.3 |
| 128 | 2 | 0.293 | qmc | qmc 262144 | 0.08 | 0.61 | 1.6 |
| 128 | 2 | 0.293 | qmc | exhaustive | 0.09 | 0.62 | 1.6 |
| 128 | 3 | 0.500 | exhaustive | qmc | 0.01 | 0.06 | 0.2 |
| 256 | 1 | 0.106 | qmc | qmc 262144 | 0.08 | 0.76 | 2.6 |
| 256 | 2 | 0.225 | qmc | qmc 262144 | 0.13 | 0.96 | 2.5 |
| 256 | 2 | 0.225 | qmc | exhaustive | 0.13 | 0.97 | 2.5 |
| 256 | 3 | 0.368 | exhaustive | qmc | 0.03 | 0.17 | 0.4 |

#### Capture 128 px: error per roughness mip, rgba16float

Each cell: mean / p99 over all directions, then p99 on seam directions (cube face edge, or octa fold, within one texel of that mip). /255 after the fixed tone map.

| layout | KiB / probe | lod 0 r 0.00 | lod 1 r 0.13 | lod 2 r 0.29 | lod 3 r 0.50 | lod 4 r 1.00 |
|---|---|---|---|---|---|---|
| cube2d-warp@128 | 1023 | 0.41 / 12.7 · seam 19.2 | 1.03 / 4.0 · seam 4.8 | 0.63 / 3.0 · seam 3.4 | 0.50 / 1.6 · seam 1.8 | 0.55 / 2.4 · seam 2.1 |
| cube2d-none@128 | 1023 | 0.01 / 0.0 · seam 10.8 | 1.03 / 3.9 · seam 5.5 | 0.63 / 3.1 · seam 3.5 | 0.50 / 1.8 · seam 2.7 | 0.58 / 2.9 · seam 4.0 |
| cube-hw@128 | 1023 | 0.00 / 0.0 · seam 0.0 | 1.03 / 3.9 · seam 4.9 | 0.63 / 3.0 · seam 3.1 | 0.48 / 1.6 · seam 1.7 | 0.50 / 2.0 · seam 1.8 |
| octa@128 | 171 | 2.77 / 52.2 · seam 57.9 | 2.33 / 14.4 · seam 16.2 | 1.72 / 9.2 · seam 8.4 | 2.16 / 7.8 · seam 7.9 | 2.13 / 10.1 · seam 10.3 |
| octa@256 | 682 | 0.96 / 24.2 · seam 30.8 | 1.10 / 4.3 · seam 4.0 | 0.73 / 3.7 · seam 3.7 | 0.69 / 2.3 · seam 3.3 | 0.69 / 4.0 · seam 2.9 |
| octa@320 | 1066 | 0.73 / 19.9 · seam 25.9 | 0.98 / 3.6 · seam 2.8 | 0.65 / 3.2 · seam 3.4 | 0.54 / 1.9 · seam 2.6 | 0.55 / 2.7 · seam 2.0 |
| octa@512 | 2728 | 0.35 / 10.3 · seam 13.6 | 0.90 / 3.5 · seam 2.0 | 0.58 / 2.9 · seam 3.1 | 0.40 / 1.7 · seam 1.6 | 0.41 / 1.5 · seam 1.1 |

#### Capture 128 px: interior vs seam p99, rgba16float

| layout | lod 0 interior / seam | lod 1 interior / seam | lod 2 interior / seam | lod 3 interior / seam | lod 4 interior / seam |
|---|---|---|---|---|---|
| cube2d-warp@128 | 12.4 / 19.2 (n 1124) | 4.0 / 4.8 (n 2275) | 3.0 / 3.4 (n 4612) | 1.6 / 1.8 (n 9391) | 2.5 / 2.1 (n 19436) |
| cube2d-none@128 | 0.0 / 10.8 (n 1124) | 3.9 / 5.5 (n 2275) | 3.0 / 3.5 (n 4612) | 1.6 / 2.7 (n 9391) | 2.0 / 4.0 (n 19436) |
| cube-hw@128 | 0.0 / 0.0 (n 1124) | 3.9 / 4.9 (n 2275) | 3.0 / 3.1 (n 4612) | 1.6 / 1.7 (n 9391) | 2.0 / 1.8 (n 19436) |
| octa@128 | 50.8 / 57.9 (n 3642) | 13.5 / 16.2 (n 7401) | 9.3 / 8.4 (n 15139) | 7.7 / 7.9 (n 30922) | 4.7 / 10.3 (n 54079) |
| octa@256 | 23.3 / 30.8 (n 1691) | 4.3 / 4.0 (n 3401) | 3.7 / 3.7 (n 6897) | 2.2 / 3.3 (n 14095) | 4.3 / 2.9 (n 28845) |
| octa@320 | 19.5 / 25.9 (n 1327) | 3.7 / 2.8 (n 2677) | 3.2 / 3.4 (n 5416) | 1.8 / 2.6 (n 11028) | 2.9 / 2.0 (n 22633) |
| octa@512 | 10.0 / 13.6 (n 810) | 3.5 / 2.0 (n 1628) | 2.9 / 3.1 (n 3295) | 1.7 / 1.6 (n 6666) | 1.6 / 1.1 (n 13617) |

#### Capture 128 px: r < 0.2 (lookups between mips 0 and 1 except at the mips), rgba16float

| layout | r 0.000 | r 0.050 | r 0.100 | r 0.134 | r 0.150 |
|---|---|---|---|---|---|
| cube2d-warp@128 | 0.41 / 12.7 | 3.95 / 45.8 | 2.99 / 19.9 | 1.03 / 4.0 | 2.22 / 9.1 |
| cube2d-none@128 | 0.01 / 0.0 | 3.81 / 44.5 | 2.99 / 19.5 | 1.03 / 3.9 | 2.21 / 9.1 |
| cube-hw@128 | 0.00 / 0.0 | 3.81 / 44.5 | 2.99 / 19.5 | 1.03 / 3.9 | 2.20 / 9.1 |
| octa@128 | 2.77 / 52.2 | 5.63 / 57.1 | 4.20 / 31.8 | 2.33 / 14.4 | 3.22 / 13.3 |
| octa@256 | 0.96 / 24.2 | 4.12 / 46.9 | 3.04 / 21.7 | 1.10 / 4.3 | 2.27 / 9.3 |
| octa@320 | 0.73 / 19.9 | 3.93 / 45.7 | 2.91 / 20.4 | 0.98 / 3.6 | 2.24 / 9.1 |
| octa@512 | 0.35 / 10.3 | 3.72 / 44.0 | 2.81 / 18.9 | 0.90 / 3.5 | 2.25 / 8.9 |

#### Capture 128 px: formats (mean / p99 per mip; bright = reference luminance > 2, p99)

| layout | format | KiB | lod 0 | lod 1 | lod 2 | lod 3 | lod 4 |
|---|---|---|---|---|---|---|---|
| cube2d-warp@128 | rgba16f | 1023 | 0.41 / 12.7 · br 5.6 | 1.03 / 4.0 · br 2.1 | 0.63 / 3.0 · br 3.4 | 0.50 / 1.6 · br 0.6 | 0.55 / 2.4 |
| cube2d-warp@128 | rg11b10 | 512 | 0.58 / 12.7 · br 5.6 | 1.08 / 4.0 · br 2.1 | 0.71 / 3.0 · br 3.3 | 0.58 / 1.7 · br 0.7 | 0.63 / 2.5 |
| cube2d-warp@128 | rgb9e5 | 512 | 0.44 / 12.7 · br 5.6 | 1.04 / 4.0 · br 2.1 | 0.65 / 3.0 · br 3.4 | 0.52 / 1.7 · br 0.6 | 0.57 / 2.4 |
| cube2d-warp@128 | bc6h | 128 | 0.78 / 12.7 · br 6.4 | 1.30 / 4.6 · br 2.8 | 1.00 / 3.6 · br 3.4 | 0.98 / 2.7 · br 1.3 | 1.33 / 5.0 |
| cube2d-warp@128 | bc6h fast | 128 | 0.68 / 12.7 · br 6.4 | 1.28 / 4.7 · br 2.8 | 1.00 / 3.7 · br 3.4 | 1.06 / 3.1 · br 1.3 | 1.56 / 6.0 |
| cube2d-none@128 | rgba16f | 1023 | 0.01 / 0.0 · br 0.0 | 1.03 / 3.9 · br 2.2 | 0.63 / 3.1 · br 3.4 | 0.50 / 1.8 · br 1.1 | 0.58 / 2.9 |
| cube2d-none@128 | rg11b10 | 512 | 0.19 / 0.4 · br 0.3 | 1.08 / 4.0 · br 2.1 | 0.70 / 3.1 · br 3.4 | 0.59 / 1.8 · br 1.1 | 0.66 / 3.0 |
| cube2d-none@128 | rgb9e5 | 512 | 0.05 / 0.1 · br 0.0 | 1.04 / 3.9 · br 2.2 | 0.65 / 3.1 · br 3.4 | 0.52 / 1.8 · br 1.1 | 0.60 / 2.9 |
| cube2d-none@128 | bc6h | 128 | 0.41 / 1.4 · br 1.7 | 1.29 / 4.6 · br 2.7 | 1.00 / 3.7 · br 3.5 | 1.01 / 2.9 · br 1.7 | 1.33 / 4.8 |
| cube2d-none@128 | bc6h fast | 128 | 0.31 / 1.3 · br 1.7 | 1.28 / 4.6 · br 2.7 | 1.00 / 3.8 · br 3.5 | 1.10 / 3.3 · br 1.7 | 1.66 / 6.0 |
| cube-hw@128 | rgba16f | 1023 | 0.00 / 0.0 · br 0.0 | 1.03 / 3.9 · br 2.1 | 0.63 / 3.0 · br 3.4 | 0.48 / 1.6 · br 0.9 | 0.50 / 2.0 |
| cube-hw@128 | rg11b10 | 512 | 0.19 / 0.4 · br 0.2 | 1.08 / 4.0 · br 2.1 | 0.70 / 3.0 · br 3.4 | 0.56 / 1.7 · br 0.9 | 0.58 / 2.1 |
| cube-hw@128 | rgb9e5 | 512 | 0.05 / 0.1 · br 0.0 | 1.04 / 3.9 · br 2.1 | 0.64 / 3.0 · br 3.4 | 0.50 / 1.6 · br 0.9 | 0.51 / 2.0 |
| cube-hw@128 | bc6h | 128 | 0.41 / 1.3 · br 1.4 | 1.29 / 4.6 · br 2.7 | 0.99 / 3.7 · br 3.4 | 0.98 / 2.8 · br 1.5 | 1.22 / 4.1 |
| cube-hw@128 | bc6h fast | 128 | 0.31 / 1.2 · br 1.5 | 1.28 / 4.6 · br 2.7 | 0.99 / 3.8 · br 3.5 | 1.07 / 3.1 · br 1.4 | 1.52 / 5.4 |
| octa@128 | rgba16f | 171 | 2.77 / 52.2 · br 19.4 | 2.33 / 14.4 · br 16.8 | 1.72 / 9.2 · br 7.5 | 2.16 / 7.8 · br 4.7 | 2.13 / 10.1 |
| octa@128 | rg11b10 | 85 | 2.90 / 52.3 · br 19.3 | 2.36 / 14.3 · br 16.8 | 1.78 / 9.3 · br 7.5 | 2.21 / 7.9 · br 4.7 | 2.18 / 10.1 |
| octa@128 | rgb9e5 | 85 | 2.80 / 52.2 · br 19.4 | 2.34 / 14.4 · br 16.8 | 1.73 / 9.2 · br 7.5 | 2.16 / 7.8 · br 4.7 | 2.13 / 10.1 |
| octa@128 | bc6h | 21 | 3.24 / 52.1 · br 19.4 | 2.73 / 14.8 · br 16.9 | 2.65 / 10.1 · br 7.9 | 3.40 / 9.1 · br 5.7 | 4.07 / 12.2 |
| octa@128 | bc6h fast | 21 | 3.19 / 52.1 · br 19.4 | 2.80 / 14.6 · br 16.9 | 2.92 / 10.3 · br 8.1 | 3.71 / 9.6 · br 5.7 | 4.64 / 15.7 |
| octa@256 | rgba16f | 682 | 0.96 / 24.2 · br 10.6 | 1.10 / 4.3 · br 6.4 | 0.73 / 3.7 · br 3.6 | 0.69 / 2.3 · br 1.2 | 0.69 / 4.0 |
| octa@256 | rg11b10 | 341 | 1.11 / 24.3 · br 10.6 | 1.15 / 4.3 · br 6.5 | 0.80 / 3.7 · br 3.6 | 0.76 / 2.4 · br 1.2 | 0.76 / 4.1 |
| octa@256 | rgb9e5 | 341 | 0.99 / 24.2 · br 10.6 | 1.12 / 4.3 · br 6.4 | 0.74 / 3.7 · br 3.6 | 0.70 / 2.4 · br 1.2 | 0.70 / 4.0 |
| octa@256 | bc6h | 85 | 1.32 / 24.1 · br 10.2 | 1.39 / 4.9 · br 6.5 | 1.18 / 4.5 · br 3.6 | 1.32 / 3.9 · br 2.3 | 1.59 / 5.6 |
| octa@256 | bc6h fast | 85 | 1.26 / 24.0 · br 10.2 | 1.42 / 4.9 · br 6.5 | 1.23 / 4.6 · br 3.7 | 1.46 / 4.6 · br 2.3 | 1.92 / 5.8 |
| octa@320 | rgba16f | 1066 | 0.73 / 19.9 · br 8.7 | 0.98 / 3.6 · br 4.2 | 0.65 / 3.2 · br 3.4 | 0.54 / 1.9 · br 0.9 | 0.55 / 2.7 |
| octa@320 | rg11b10 | 533 | 0.88 / 20.0 · br 8.7 | 1.04 / 3.7 · br 4.2 | 0.72 / 3.2 · br 3.5 | 0.62 / 1.9 · br 0.9 | 0.62 / 2.8 |
| octa@320 | rgb9e5 | 533 | 0.76 / 19.9 · br 8.7 | 1.00 / 3.7 · br 4.2 | 0.66 / 3.2 · br 3.5 | 0.56 / 1.9 · br 0.9 | 0.56 / 2.7 |
| octa@320 | bc6h | 133 | 1.10 / 19.9 · br 9.1 | 1.26 / 4.3 · br 4.8 | 1.05 / 4.0 · br 3.7 | 1.08 / 3.2 · br 1.6 | 1.25 / 4.4 |
| octa@320 | bc6h fast | 133 | 1.02 / 19.9 · br 9.1 | 1.26 / 4.4 · br 4.7 | 1.08 / 4.0 · br 3.7 | 1.19 / 3.6 · br 1.7 | 1.62 / 5.4 |
| octa@512 | rgba16f | 2728 | 0.35 / 10.3 · br 4.2 | 0.90 / 3.5 · br 2.3 | 0.58 / 2.9 · br 3.3 | 0.40 / 1.7 · br 0.7 | 0.41 / 1.5 |
| octa@512 | rg11b10 | 1364 | 0.51 / 10.2 · br 4.2 | 0.95 / 3.6 · br 2.4 | 0.65 / 3.0 · br 3.4 | 0.48 / 1.7 · br 0.7 | 0.49 / 1.6 |
| octa@512 | rgb9e5 | 1364 | 0.39 / 10.2 · br 4.2 | 0.91 / 3.5 · br 2.3 | 0.59 / 2.9 · br 3.3 | 0.41 / 1.7 · br 0.7 | 0.43 / 1.5 |
| octa@512 | bc6h | 341 | 0.73 / 10.5 · br 5.0 | 1.12 / 3.8 · br 2.8 | 0.88 / 3.2 · br 3.3 | 0.80 / 2.3 · br 1.2 | 0.90 / 2.5 |
| octa@512 | bc6h fast | 341 | 0.63 / 10.5 · br 5.0 | 1.10 / 3.9 · br 2.9 | 0.86 / 3.3 · br 3.3 | 0.83 / 2.5 · br 1.3 | 1.06 / 3.6 |

#### Capture 256 px: error per roughness mip, rgba16float

Each cell: mean / p99 over all directions, then p99 on seam directions (cube face edge, or octa fold, within one texel of that mip). /255 after the fixed tone map.

| layout | KiB / probe | lod 0 r 0.00 | lod 1 r 0.11 | lod 2 r 0.23 | lod 3 r 0.37 | lod 4 r 0.55 | lod 5 r 1.00 |
|---|---|---|---|---|---|---|---|
| cube2d-warp@256 | 4095 | 0.24 / 6.3 · seam 15.6 | 0.71 / 3.7 · seam 4.3 | 1.22 / 4.4 · seam 4.7 | 0.44 / 2.4 · seam 2.7 | 0.46 / 1.4 · seam 1.5 | 0.56 / 2.4 · seam 2.2 |
| cube2d-none@256 | 4095 | 0.00 / 0.0 · seam 7.5 | 0.71 / 3.7 · seam 4.4 | 1.22 / 4.4 · seam 4.8 | 0.44 / 2.4 · seam 2.8 | 0.46 / 1.5 · seam 2.5 | 0.59 / 2.9 · seam 4.1 |
| cube-hw@256 | 4095 | 0.00 / 0.0 · seam 0.0 | 0.71 / 3.7 · seam 4.2 | 1.22 / 4.4 · seam 4.7 | 0.44 / 2.4 · seam 2.5 | 0.44 / 1.4 · seam 1.5 | 0.50 / 2.0 · seam 1.9 |
| octa@256 | 683 | 1.65 / 48.8 · seam 76.7 | 1.31 / 8.8 · seam 11.8 | 1.54 / 5.5 · seam 5.0 | 1.20 / 5.3 · seam 5.3 | 1.76 / 6.5 · seam 7.3 | 2.16 / 10.3 · seam 10.5 |
| octa@512 | 2730 | 0.57 / 18.5 · seam 28.7 | 0.75 / 3.8 · seam 3.1 | 1.25 / 4.5 · seam 2.8 | 0.52 / 2.6 · seam 2.3 | 0.60 / 2.0 · seam 3.2 | 0.70 / 4.0 · seam 3.0 |
| octa@640 | 4266 | 0.44 / 13.9 · seam 23.3 | 0.70 / 3.6 · seam 2.4 | 1.23 / 4.4 · seam 2.6 | 0.46 / 2.5 · seam 2.1 | 0.49 / 1.5 · seam 2.5 | 0.55 / 2.8 · seam 2.1 |
| octa@1024 | 10920 | 0.21 / 5.5 · seam 14.0 | 0.67 / 3.6 · seam 2.2 | 1.22 / 4.4 · seam 2.4 | 0.41 / 2.4 · seam 1.9 | 0.38 / 1.5 · seam 1.6 | 0.41 / 1.5 · seam 1.1 |

#### Capture 256 px: interior vs seam p99, rgba16float

| layout | lod 0 interior / seam | lod 1 interior / seam | lod 2 interior / seam | lod 3 interior / seam | lod 4 interior / seam | lod 5 interior / seam |
|---|---|---|---|---|---|---|
| cube2d-warp@256 | 5.4 / 15.6 (n 565) | 3.7 / 4.3 (n 1124) | 4.4 / 4.7 (n 2275) | 2.4 / 2.7 (n 4612) | 1.4 / 1.5 (n 9391) | 2.5 / 2.2 (n 19436) |
| cube2d-none@256 | 0.0 / 7.5 (n 565) | 3.7 / 4.4 (n 1124) | 4.4 / 4.8 (n 2275) | 2.4 / 2.8 (n 4612) | 1.4 / 2.5 (n 9391) | 2.1 / 4.1 (n 19436) |
| cube-hw@256 | 0.0 / 0.0 (n 565) | 3.7 / 4.2 (n 1124) | 4.4 / 4.7 (n 2275) | 2.4 / 2.5 (n 4612) | 1.4 / 1.5 (n 9391) | 2.1 / 1.9 (n 19436) |
| octa@256 | 44.4 / 76.7 (n 1808) | 8.0 / 11.8 (n 3642) | 5.6 / 5.0 (n 7401) | 5.3 / 5.3 (n 15139) | 6.0 / 7.3 (n 30922) | 4.7 / 10.5 (n 54079) |
| octa@512 | 17.7 / 28.7 (n 843) | 3.8 / 3.1 (n 1691) | 4.5 / 2.8 (n 3401) | 2.6 / 2.3 (n 6897) | 1.8 / 3.2 (n 14095) | 4.3 / 3.0 (n 28845) |
| octa@640 | 13.0 / 23.3 (n 664) | 3.6 / 2.4 (n 1327) | 4.4 / 2.6 (n 2677) | 2.5 / 2.1 (n 5416) | 1.5 / 2.5 (n 11028) | 2.9 / 2.1 (n 22633) |
| octa@1024 | 5.3 / 14.0 (n 407) | 3.6 / 2.2 (n 810) | 4.4 / 2.4 (n 1628) | 2.4 / 1.9 (n 3295) | 1.5 / 1.6 (n 6666) | 1.6 / 1.1 (n 13617) |

#### Capture 256 px: r < 0.2 (lookups between mips 0 and 1 except at the mips), rgba16float

| layout | r 0.000 | r 0.050 | r 0.100 | r 0.106 | r 0.150 |
|---|---|---|---|---|---|
| cube2d-warp@256 | 0.24 / 6.3 | 2.86 / 35.2 | 0.99 / 5.1 | 0.71 / 3.7 | 3.14 / 13.2 |
| cube2d-none@256 | 0.00 / 0.0 | 2.90 / 35.4 | 0.96 / 5.0 | 0.71 / 3.7 | 3.02 / 12.4 |
| cube-hw@256 | 0.00 / 0.0 | 2.90 / 35.4 | 0.96 / 5.0 | 0.71 / 3.7 | 3.02 / 12.4 |
| octa@256 | 1.65 / 48.8 | 3.59 / 41.6 | 1.54 / 10.3 | 1.31 / 8.8 | 3.12 / 14.6 |
| octa@512 | 0.57 / 18.5 | 2.92 / 36.1 | 0.99 / 5.3 | 0.75 / 3.8 | 3.04 / 12.6 |
| octa@640 | 0.44 / 13.9 | 2.84 / 35.5 | 0.94 / 5.0 | 0.70 / 3.6 | 3.04 / 12.4 |
| octa@1024 | 0.21 / 5.5 | 2.80 / 34.8 | 0.91 / 4.9 | 0.67 / 3.6 | 3.05 / 12.3 |

#### Capture 256 px: formats (mean / p99 per mip; bright = reference luminance > 2, p99)

| layout | format | KiB | lod 0 | lod 1 | lod 2 | lod 3 | lod 4 | lod 5 |
|---|---|---|---|---|---|---|---|---|
| cube2d-warp@256 | rgba16f | 4095 | 0.24 / 6.3 · br 10.5 | 0.71 / 3.7 · br 2.0 | 1.22 / 4.4 · br 2.0 | 0.44 / 2.4 · br 1.8 | 0.46 / 1.4 · br 0.5 | 0.56 / 2.4 |
| cube2d-warp@256 | rg11b10 | 2048 | 0.42 / 6.2 · br 10.4 | 0.78 / 3.7 · br 2.1 | 1.27 / 4.4 · br 2.1 | 0.52 / 2.4 · br 1.9 | 0.54 / 1.5 · br 0.6 | 0.64 / 2.5 |
| cube2d-warp@256 | rgb9e5 | 2048 | 0.27 / 6.3 · br 10.4 | 0.72 / 3.7 · br 2.1 | 1.24 / 4.4 · br 2.0 | 0.46 / 2.4 · br 1.8 | 0.47 / 1.4 · br 0.5 | 0.57 / 2.5 |
| cube2d-warp@256 | bc6h | 512 | 0.59 / 6.7 · br 11.5 | 0.96 / 4.0 · br 2.5 | 1.40 / 4.7 · br 2.1 | 0.80 / 2.7 · br 2.2 | 0.97 / 2.9 · br 1.1 | 1.36 / 5.4 |
| cube2d-warp@256 | bc6h fast | 512 | 0.49 / 6.7 · br 11.5 | 0.91 / 4.0 · br 2.5 | 1.39 / 4.7 · br 2.1 | 0.82 / 2.9 · br 2.2 | 1.04 / 3.2 · br 1.1 | 1.61 / 6.2 |
| cube2d-none@256 | rgba16f | 4095 | 0.00 / 0.0 · br 0.0 | 0.71 / 3.7 · br 2.0 | 1.22 / 4.4 · br 2.0 | 0.44 / 2.4 · br 1.8 | 0.46 / 1.5 · br 1.0 | 0.59 / 2.9 |
| cube2d-none@256 | rg11b10 | 2048 | 0.20 / 0.4 · br 0.2 | 0.78 / 3.7 · br 2.0 | 1.27 / 4.5 · br 2.0 | 0.53 / 2.4 · br 1.9 | 0.55 / 1.6 · br 1.1 | 0.67 / 3.0 |
| cube2d-none@256 | rgb9e5 | 2048 | 0.05 / 0.1 · br 0.1 | 0.72 / 3.7 · br 2.0 | 1.24 / 4.4 · br 2.0 | 0.46 / 2.4 · br 1.8 | 0.48 / 1.6 · br 1.0 | 0.60 / 2.9 |
| cube2d-none@256 | bc6h | 512 | 0.39 / 1.1 · br 3.1 | 0.97 / 4.0 · br 2.2 | 1.40 / 4.7 · br 2.2 | 0.81 / 2.9 · br 2.0 | 0.97 / 2.7 · br 1.6 | 1.33 / 5.1 |
| cube2d-none@256 | bc6h fast | 512 | 0.29 / 0.9 · br 3.1 | 0.92 / 4.0 · br 2.2 | 1.38 / 4.7 · br 2.3 | 0.83 / 3.0 · br 2.0 | 1.05 / 3.1 · br 1.6 | 1.64 / 5.8 |
| cube-hw@256 | rgba16f | 4095 | 0.00 / 0.0 · br 0.0 | 0.71 / 3.7 · br 2.0 | 1.22 / 4.4 · br 2.0 | 0.44 / 2.4 · br 1.8 | 0.44 / 1.4 · br 0.7 | 0.50 / 2.0 |
| cube-hw@256 | rg11b10 | 2048 | 0.20 / 0.4 · br 0.2 | 0.78 / 3.7 · br 2.0 | 1.27 / 4.4 · br 2.0 | 0.52 / 2.4 · br 1.9 | 0.53 / 1.4 · br 0.8 | 0.58 / 2.1 |
| cube-hw@256 | rgb9e5 | 2048 | 0.05 / 0.1 · br 0.1 | 0.72 / 3.7 · br 2.0 | 1.24 / 4.4 · br 2.0 | 0.45 / 2.4 · br 1.8 | 0.46 / 1.4 · br 0.8 | 0.51 / 2.0 |
| cube-hw@256 | bc6h | 512 | 0.39 / 1.1 · br 2.6 | 0.96 / 4.0 · br 2.2 | 1.40 / 4.7 · br 2.2 | 0.80 / 2.9 · br 2.0 | 0.94 / 2.6 · br 1.4 | 1.21 / 4.4 |
| cube-hw@256 | bc6h fast | 512 | 0.29 / 0.9 · br 2.6 | 0.91 / 4.0 · br 2.2 | 1.38 / 4.7 · br 2.3 | 0.82 / 3.0 · br 2.0 | 1.01 / 2.9 · br 1.4 | 1.49 / 5.2 |
| octa@256 | rgba16f | 683 | 1.65 / 48.8 · br 69.2 | 1.31 / 8.8 · br 14.0 | 1.54 / 5.5 · br 5.3 | 1.20 / 5.3 · br 3.9 | 1.76 / 6.5 · br 3.1 | 2.16 / 10.3 |
| octa@256 | rg11b10 | 341 | 1.79 / 48.8 · br 69.3 | 1.37 / 8.8 · br 14.0 | 1.58 / 5.5 · br 5.3 | 1.25 / 5.2 · br 3.9 | 1.81 / 6.5 · br 3.0 | 2.21 / 10.4 |
| octa@256 | rgb9e5 | 341 | 1.68 / 48.8 · br 69.2 | 1.33 / 8.8 · br 14.0 | 1.56 / 5.5 · br 5.3 | 1.22 / 5.3 · br 3.9 | 1.77 / 6.5 · br 3.1 | 2.17 / 10.3 |
| octa@256 | bc6h | 85 | 2.00 / 48.7 · br 68.8 | 1.63 / 9.4 · br 13.8 | 1.99 / 6.9 · br 5.8 | 1.97 / 6.7 · br 4.5 | 2.86 / 7.5 · br 3.6 | 4.11 / 12.3 |
| octa@256 | bc6h fast | 85 | 1.92 / 48.7 · br 68.8 | 1.64 / 9.5 · br 13.8 | 2.12 / 7.0 · br 5.8 | 2.09 / 7.1 · br 4.8 | 3.15 / 8.2 · br 3.6 | 4.67 / 15.8 |
| octa@512 | rgba16f | 2730 | 0.57 / 18.5 · br 31.2 | 0.75 / 3.8 · br 4.1 | 1.25 / 4.5 · br 3.0 | 0.52 / 2.6 · br 1.8 | 0.60 / 2.0 · br 0.6 | 0.70 / 4.0 |
| octa@512 | rg11b10 | 1365 | 0.73 / 18.5 · br 31.2 | 0.82 / 3.8 · br 4.1 | 1.29 / 4.5 · br 3.0 | 0.60 / 2.6 · br 1.8 | 0.67 / 2.1 · br 0.7 | 0.78 / 4.0 |
| octa@512 | rgb9e5 | 1365 | 0.60 / 18.5 · br 31.1 | 0.76 / 3.8 · br 4.1 | 1.26 / 4.5 · br 3.0 | 0.54 / 2.6 · br 1.8 | 0.62 / 2.0 · br 0.6 | 0.71 / 4.1 |
| octa@512 | bc6h | 341 | 0.92 / 18.5 · br 34.7 | 1.01 / 4.2 · br 4.4 | 1.45 / 4.9 · br 3.2 | 0.94 / 3.3 · br 2.3 | 1.23 / 3.7 · br 1.7 | 1.61 / 5.4 |
| octa@512 | bc6h fast | 341 | 0.82 / 18.5 · br 34.7 | 0.98 / 4.2 · br 4.5 | 1.45 / 4.9 · br 3.2 | 1.00 / 3.5 · br 2.3 | 1.36 / 4.4 · br 1.7 | 1.94 / 6.3 |
| octa@640 | rgba16f | 4266 | 0.44 / 13.9 · br 22.1 | 0.70 / 3.6 · br 3.1 | 1.23 / 4.4 · br 2.4 | 0.46 / 2.5 · br 1.8 | 0.49 / 1.5 · br 0.5 | 0.55 / 2.8 |
| octa@640 | rg11b10 | 2133 | 0.60 / 13.8 · br 22.1 | 0.77 / 3.7 · br 3.0 | 1.27 / 4.4 · br 2.5 | 0.54 / 2.5 · br 1.8 | 0.57 / 1.6 · br 0.6 | 0.62 / 2.8 |
| octa@640 | rgb9e5 | 2133 | 0.47 / 13.9 · br 22.1 | 0.72 / 3.6 · br 3.1 | 1.24 / 4.4 · br 2.5 | 0.47 / 2.5 · br 1.8 | 0.50 / 1.6 · br 0.6 | 0.57 / 2.8 |
| octa@640 | bc6h | 533 | 0.81 / 14.1 · br 23.1 | 0.95 / 3.9 · br 3.3 | 1.41 / 4.7 · br 2.6 | 0.83 / 2.9 · br 2.2 | 1.00 / 2.8 · br 1.2 | 1.30 / 4.9 |
| octa@640 | bc6h fast | 533 | 0.69 / 14.0 · br 23.1 | 0.91 / 3.9 · br 3.3 | 1.39 / 4.7 · br 2.6 | 0.85 / 3.0 · br 2.2 | 1.11 / 3.3 · br 1.4 | 1.61 / 5.5 |
| octa@1024 | rgba16f | 10920 | 0.21 / 5.5 · br 10.9 | 0.67 / 3.6 · br 2.2 | 1.22 / 4.4 · br 2.0 | 0.41 / 2.4 · br 1.9 | 0.38 / 1.5 · br 0.5 | 0.41 / 1.5 |
| octa@1024 | rg11b10 | 5460 | 0.39 / 5.5 · br 10.9 | 0.74 / 3.7 · br 2.2 | 1.26 / 4.5 · br 2.0 | 0.49 / 2.4 · br 1.9 | 0.47 / 1.5 · br 0.6 | 0.51 / 1.6 |
| octa@1024 | rgb9e5 | 5460 | 0.24 / 5.5 · br 10.9 | 0.68 / 3.6 · br 2.2 | 1.23 / 4.4 · br 2.0 | 0.42 / 2.4 · br 1.9 | 0.40 / 1.5 · br 0.5 | 0.43 / 1.6 |
| octa@1024 | bc6h | 1365 | 0.58 / 5.9 · br 11.7 | 0.90 / 3.8 · br 2.6 | 1.36 / 4.7 · br 2.2 | 0.70 / 2.5 · br 2.0 | 0.76 / 2.2 · br 1.1 | 0.87 / 2.5 |
| octa@1024 | bc6h fast | 1365 | 0.46 / 6.0 · br 12.0 | 0.85 / 3.8 · br 2.6 | 1.33 / 4.6 · br 2.2 | 0.69 / 2.7 · br 2.1 | 0.79 / 2.4 · br 1.1 | 1.07 / 3.6 |

#### Bake (GPU ms per probe, min of 9 spans of 8 back-to-back bakes): prefilter pass; prefilter + format conversion

| capture | layout | prefilter | + rgba16f | + rg11b10 | + rgb9e5 | + bc6h | + bc6h fast |
|---|---|---|---|---|---|---|---|
| 128 | cube2d-warp@128 | 0.402 | 0.408 | 0.398 | 0.398 | 0.621 | 0.401 |
| 128 | cube2d-none@128 | 0.367 | 0.372 | 0.382 | 0.383 | 0.613 | 0.398 |
| 128 | cube-hw@128 | 0.368 | 0.372 | 0.382 | 0.383 | 0.613 | 0.398 |
| 128 | octa@128 | 0.275 | 0.275 | 0.286 | 0.284 | 0.483 | 0.298 |
| 128 | octa@256 | 0.423 | 0.424 | 0.435 | 0.434 | 0.641 | 0.444 |
| 128 | octa@320 | 0.456 | 0.458 | 0.470 | 0.470 | 0.697 | 0.482 |
| 128 | octa@512 | 0.645 | 0.650 | 0.664 | 0.664 | 0.976 | 0.672 |
| 256 | cube2d-warp@256 | 0.902 | 0.928 | 0.951 | 0.971 | 1.437 | 0.981 |
| 256 | cube2d-none@256 | 0.936 | 0.977 | 0.999 | 1.002 | 1.479 | 0.996 |
| 256 | cube-hw@256 | 0.943 | 0.986 | 1.000 | 0.985 | 1.454 | 0.984 |
| 256 | octa@256 | 0.643 | 0.645 | 0.641 | 0.633 | 0.882 | 0.647 |
| 256 | octa@512 | 0.961 | 0.966 | 0.983 | 0.980 | 1.336 | 0.988 |
| 256 | octa@640 | 1.112 | 1.135 | 1.169 | 1.159 | 1.635 | 1.198 |
| 256 | octa@1024 | 1.804 | 1.911 | 2.069 | 2.163 | 3.376 | 2.397 |

#### Lookup (ms per 1920×1080 pass: wall clock over bursts of 32 passes, 4 for scattered, min of 9; in brackets the median ratio to cube-hw rgba16float over 9 back-to-back burst pairs)

| capture | layout | format | 1 probe | 3 probes | 16 probes | 16, scattered | 3, 8 lookups/px |
|---|---|---|---|---|---|---|---|
| 128 | cube2d-warp@128 | rgba16f | 0.081 (1.29) | 0.081 (1.24) | 0.094 (1.28) | 0.850 (1.06) | 0.341 (1.45) |
| 128 | cube2d-warp@128 | rg11b10 | 0.097 (1.27) | 0.100 (1.23) | 0.147 (1.33) | 1.025 (0.80) | 0.466 (1.45) |
| 128 | cube2d-warp@128 | rgb9e5 | 0.147 (1.30) | 0.150 (1.31) | 0.184 (1.30) | 1.600 (1.08) | 0.747 (1.49) |
| 128 | cube2d-warp@128 | bc6h | 0.163 (1.35) | 0.156 (1.29) | 0.156 (1.34) | 0.375 (0.35) | 0.675 (1.49) |
| 128 | cube2d-none@128 | rgba16f | 0.112 (1.09) | 0.106 (1.16) | 0.106 (1.09) | 1.025 (1.00) | 0.362 (0.98) |
| 128 | cube2d-none@128 | rg11b10 | 0.103 (1.17) | 0.097 (1.07) | 0.103 (1.06) | 0.775 (0.80) | 0.334 (0.99) |
| 128 | cube2d-none@128 | rgb9e5 | 0.097 (1.13) | 0.097 (1.07) | 0.103 (1.06) | 1.000 (1.05) | 0.322 (0.98) |
| 128 | cube2d-none@128 | bc6h | 0.094 (1.07) | 0.097 (1.07) | 0.103 (1.13) | 0.325 (0.35) | 0.316 (0.99) |
| 128 | cube-hw@128 | rgba16f | 0.087 (0.97) | 0.091 (1.03) | 0.087 (0.97) | 1.025 (1.08) | 0.328 (1.01) |
| 128 | cube-hw@128 | rg11b10 | 0.081 (1.00) | 0.084 (0.97) | 0.094 (1.00) | 0.800 (0.82) | 0.309 (0.97) |
| 128 | cube-hw@128 | rgb9e5 | 0.084 (1.00) | 0.087 (1.00) | 0.091 (0.97) | 1.025 (1.05) | 0.309 (0.98) |
| 128 | cube-hw@128 | bc6h | 0.088 (1.07) | 0.087 (1.00) | 0.091 (0.97) | 0.325 (0.35) | 0.300 (0.97) |
| 128 | octa@256 | rgba16f | 0.091 (1.07) | 0.087 (1.00) | 0.094 (0.97) | 1.200 (1.23) | 0.275 (0.87) |
| 128 | octa@256 | rg11b10 | 0.094 (1.07) | 0.087 (1.07) | 0.094 (0.97) | 0.975 (1.02) | 0.278 (0.86) |
| 128 | octa@256 | rgb9e5 | 0.097 (1.11) | 0.094 (1.07) | 0.100 (1.00) | 1.250 (1.28) | 0.272 (0.85) |
| 128 | octa@256 | bc6h | 0.087 (1.03) | 0.091 (1.07) | 0.097 (0.97) | 0.350 (0.38) | 0.263 (0.88) |
| 128 | octa@320 | rgba16f | 0.097 (1.07) | 0.097 (1.03) | 0.100 (1.03) | 1.275 (1.36) | 0.266 (0.87) |
| 128 | octa@320 | rg11b10 | 0.094 (1.00) | 0.088 (1.00) | 0.097 (1.07) | 0.900 (0.97) | 0.262 (0.89) |
| 128 | octa@320 | rgb9e5 | 0.091 (1.03) | 0.091 (1.03) | 0.087 (0.97) | 1.175 (1.32) | 0.256 (0.87) |
| 128 | octa@320 | bc6h | 0.091 (0.97) | 0.091 (1.00) | 0.091 (1.00) | 0.350 (0.38) | 0.256 (0.86) |
| 256 | cube2d-warp@256 | rgba16f | 0.106 (1.38) | 0.103 (1.21) | 0.125 (1.28) | 1.000 (0.98) | 0.447 (1.43) |
| 256 | cube2d-warp@256 | rg11b10 | 0.116 (1.33) | 0.116 (1.26) | 0.128 (1.27) | 0.875 (0.80) | 0.503 (1.43) |
| 256 | cube2d-warp@256 | rgb9e5 | 0.122 (1.30) | 0.119 (1.33) | 0.125 (1.29) | 1.050 (1.00) | 0.509 (1.45) |
| 256 | cube2d-warp@256 | bc6h | 0.116 (1.34) | 0.112 (1.28) | 0.119 (1.30) | 0.325 (0.40) | 0.487 (1.44) |
| 256 | cube2d-none@256 | rgba16f | 0.088 (1.07) | 0.091 (1.11) | 0.094 (1.11) | 0.900 (0.97) | 0.309 (0.95) |
| 256 | cube2d-none@256 | rg11b10 | 0.087 (1.12) | 0.087 (1.07) | 0.091 (1.11) | 0.725 (0.81) | 0.291 (0.95) |
| 256 | cube2d-none@256 | rgb9e5 | 0.084 (1.08) | 0.081 (1.12) | 0.084 (1.08) | 0.900 (1.00) | 0.281 (0.97) |
| 256 | cube2d-none@256 | bc6h | 0.081 (1.08) | 0.078 (1.08) | 0.087 (1.12) | 0.325 (0.38) | 0.284 (0.97) |
| 256 | cube-hw@256 | rgba16f | 0.075 (0.93) | 0.075 (1.00) | 0.075 (0.96) | 0.875 (1.00) | 0.300 (1.00) |
| 256 | cube-hw@256 | rg11b10 | 0.072 (1.00) | 0.072 (0.96) | 0.081 (1.04) | 0.750 (0.83) | 0.281 (0.96) |
| 256 | cube-hw@256 | rgb9e5 | 0.075 (1.00) | 0.072 (1.00) | 0.081 (1.04) | 0.925 (1.05) | 0.284 (0.96) |
| 256 | cube-hw@256 | bc6h | 0.078 (1.04) | 0.075 (1.00) | 0.081 (1.00) | 0.325 (0.41) | 0.281 (0.93) |
| 256 | octa@512 | rgba16f | 0.081 (1.08) | 0.081 (1.04) | 0.084 (1.00) | 1.200 (1.32) | 0.259 (0.84) |
| 256 | octa@512 | rg11b10 | 0.078 (1.04) | 0.078 (1.00) | 0.081 (1.04) | 0.925 (1.00) | 0.253 (0.85) |
| 256 | octa@512 | rgb9e5 | 0.078 (1.04) | 0.078 (1.04) | 0.081 (1.04) | 1.225 (1.32) | 0.253 (0.84) |
| 256 | octa@512 | bc6h | 0.078 (1.04) | 0.075 (1.04) | 0.081 (1.00) | 0.275 (0.36) | 0.250 (0.86) |

