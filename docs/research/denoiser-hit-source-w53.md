# W53: the denoiser keeps hit sources apart (an option for the bench)

The halo under carConcept's door (W50, D3610) appears when the FFX reflection denoiser blends bright screen-space hits on the floor beside the car into the dark ray-traced hits on the underside. This work gives the denoiser an optional per-pixel **hit source**, plus an optional **hit-distance weight**, so it can keep the two apart. Everything is off by default, and with it off the output is unchanged.

**Short answer:**
- **Hit distance alone does separate the two populations on the lip.** With `hitDistanceWeight` 8, the lip goes from 80.0 to 50.6 (PT 48.1). No seam change is needed for that. It boils most of the options, though, because the hit distance also varies *within* one population (the reflected door, the wheel), so the weight splits those too.
- **The hit-source input is the better tool.** `hitSource=hits` keeps screen-space hits and traced hits apart; a miss blends with either. On carConcept it takes the lip from 80 to 59 and the band from 26 to 22. It barely boils, costs 0.35 ms at 1080p, and regresses nothing on chess, toyCar or Sponza.
- `hitSource=all` keeps misses apart too. That brings the lip down to 52, but it boils wherever rays flip between hit and miss from frame to frame (Measure std p99 ×4–10 on every scene).
- **At 1920x1080 the halo mostly goes away even with the option off** (lip 48.1 vs PT 46.1, as W52 found), so the option matters most at 960x540-class resolutions. At 1080p the options take the lip slightly *under* the PT (40–43 vs 46), while MAD improves (20.6 → 16.5–17.6).

## What the denoiser had, and where the bleed is

`FfxReflectionDenoiser` receives radiance and a hit distance. The hit distance is used only to **reproject** history: it finds where the reflected point was last frame. It never weights neighbours. The weights are normal, depth and roughness (prefilter) plus a radiance term relative to the 8x8 tile average. The temporal resolve blends with that 8x8 average and clips history to a 9x9 neighbourhood's mean ± σ.

Per-pixel readback of the denoiser's inputs (`scripts/probe.js`, main showcase page, AA off, 960x540, 32 still frames; `scripts/classes.py`):

| skirt lip (1440 px) | share of pixel-frames | hit distance p10 / p50 / p90 | signal luminance (one frame, linear) |
|---|---|---|---|
| screen-space hit | 0.22 | 0.21 / 0.40 / 0.76 m | 2.38 |
| traced hit, off screen | 0.63 | 0.18 / 0.22 / 5.6 m | 0.07 (median 0.013) |
| traced hit, shaded from the screen | 0.04 | 0.05 / 0.93 / 1.57 m | 1.61 |
| miss (probe fallback) | 0.11 | (miss distance) | 1.90 |

- **The split is spatial, not temporal.** On average, a lip pixel is in its dominant source 89% of the frames. So keeping sources apart doesn't fight the temporal integration of the lobe.
- **The denoiser doesn't add energy.** Over the lip, its linear mean is 0.69, against 0.81 for the raw signal (it loses some, as in #28). The halo is a spread: dark pixels come up, bright ones go down, and in display space (AgX, sRGB) that reads as a light band.
- **Traced hits shaded from the screen behave like screen-space hits.** In the band they are 10x brighter than the off-screen traced hits. So the seam calls them `screen`.
- **Most of the bleed is in the temporal resolve, not the prefilter.** Separating sources in the prefilter only took the lip from 80 to 77. The resolve's 8x8 average and its wide, mixed clip box carry the bright samples into the dark pixels' history.
- **The first resolve variant boiled.** It built the clip box from the centre's own source only: lip 51, but whole-frame boiling ×9 (std 0.12 → 1.13). The built version centres the box on the centre's own source but keeps FFX's box width, from the whole neighbourhood.

## What was built

**Denoiser repo** (branch `w53-hit-source`):
- `SpecularInputs.hitSource?` with `HIT_SOURCE` codes: miss 0, screen 1, traced 2.
- `FfxReflectionDenoiser` options, all off by default:
  - `separateHitSources`: needs `hitSource`.
    - In the prefilter, a neighbour of another source gets weight 0.
    - In the resolve, where the 9x9 neighbourhood mixes sources, the history clip box and the stand-in for the 8x8 average are centred on the mean of the centre's own source, with FFX's box width.
  - `missesMatchAnySource`: a miss blends with either hit source.
  - `hitDistanceWeight` k: exp(−k |t_p − t_q| / (t_p + t_q)), in the same places.
  - `setOptions()` changes them between frames.
- A workgroup whose 16x16 neighbourhood holds a single source takes FFX's own code path, so the cost is paid only along source boundaries.
- Test bed: `&hitSource=split` and `&hitDistW=<k>`.

**This repo:**
- **Core seam:** `SpecularInputs.hitSource` and `HIT_SOURCE` (structural copies of denoiser-core's), and `DenoiseHitSources`.
  - `seam.dispatch(frame, signal, { confidence, traceSource })` builds the r32float source in one small compute pass:
    - RT_SOURCE 1 → traced;
    - 4 (traced, shaded from the screen) → screen;
    - 2 → miss;
    - otherwise screen if confidence > 0, else miss.
  - It reuses `TracedReflections.source` as W52 left it. No new target, and no lines shared with W52.
- **three:** `HybridReflections.denoiserHitSource` (default false).
- **Examples:**
  - Compare page and showcase: `?hitSource=hits|all` (`1` = `all`), `?hitMissAny=1`, `?hitDistW=<k>`.
  - Showcase: a "Denoiser: keep hit sources apart" select (off / screen vs traced hits / hits and misses) and `__p.setHitSource()`.
  - `pnpm check -- --only hit-source`.

## Numbers: carConcept, W50's view, compare `ours-rt`

Each setting is a fresh instance with 90 warm-up frames. Region values are the mean of 16 frames, as luma / MAD against the PT (64 spp + OIDN). Boiling is the per-pixel temporal std of luma over 32 still frames; orbit is the compare page's orbit flicker (0.05°/frame). All in 8-bit display units. 11-11 is `82b2095`, the same pipeline before W44 / W45.

**960x540**

| | lip | band (floor under the car) | reflected wheel | reflected door | lip std / orbit | frame std / orbit |
|---|---|---|---|---|---|---|
| path traced | 48.1 | 4.2 | 25.7 | 118.0 | | |
| 11-11 `82b2095` | 36.9 / 35.9 | 21.5 / 17.7 | 34.6 / 28.7 | 48.0 / 72.8 | | |
| off (today, unchanged) | 80.0 / 47.0 | 26.3 / 22.5 | 43.2 / 27.9 | 110.2 / 13.6 | 0.63 / 0.79 | 0.12 / 0.35 |
| `hitSource=hits` | 58.6 / 29.0 | 22.0 / 18.3 | 41.9 / 27.5 | 110.2 / 13.6 | 1.30 / 0.92 | 0.18 / 0.37 |
| `hitSource=all` | 51.8 / 25.3 | 21.2 / 17.5 | 41.9 / 27.5 | 110.1 / 13.7 | 1.50 / 0.99 | 0.44 / 0.47 |
| `hitDistW=8` | 50.6 / 24.1 | 18.8 / 15.1 | 41.9 / 27.8 | 109.7 / 13.9 | 1.82 / 1.23 | 0.55 / 0.52 |
| `hitDistW=4` | 52.9 / 25.1 | 19.1 / 15.4 | 42.1 / 27.8 | 109.7 / 13.9 | 1.33 / 1.02 | 0.38 / 0.44 |
| `hitSource=all&hitDistW=4` | 46.3 / 22.6 | 17.5 / 13.8 | 41.5 / 27.7 | 109.7 / 13.9 | 1.39 / 1.03 | 0.53 / 0.51 |

After merging W51, which made `@pmndrs/bvh` the examples' ray-tracing default (these runs used three-mesh-bvh), a rerun at 960x540 gave: off lip 80.1, band 26.7; `hits` 58.8 / 22.5; `all` 52.1 / 21.7. That is within 0.5 of the table.

The `hitDistW=4` rows come from a run before the main merge and the denoiser's single-source shortcut. The other rows were identical in both runs (within 0.01).

**1920x1080**

| | lip | band | reflected wheel | reflected door | lip std / orbit | frame std / orbit |
|---|---|---|---|---|---|---|
| path traced | 46.1 | 4.0 | 23.3 | 117.9 | | |
| 11-11 `82b2095` | 27.4 / 25.3 | 19.7 / 16.2 | 32.6 / 30.2 | 47.9 / 72.8 | | |
| off | 48.1 / 20.6 | 19.7 / 16.2 | 41.9 / 28.2 | 110.2 / 12.3 | 0.47 / 0.55 | 0.13 / 0.39 |
| `hitSource=hits` | 42.6 / 16.8 | 18.9 / 15.4 | 41.3 / 27.8 | 110.2 / 12.3 | 0.90 / 0.71 | 0.18 / 0.42 |
| `hitSource=all` | 40.3 / 16.5 | 18.7 / 15.2 | 41.3 / 27.8 | 110.1 / 12.4 | 1.16 / 0.90 | 0.48 / 0.54 |
| `hitDistW=8` | 40.3 / 17.6 | 18.7 / 15.2 | 41.0 / 27.8 | 109.8 / 12.5 | 1.51 / 1.09 | 0.59 / 0.59 |

- **None of the options touches the reflected door or wheel.** They are within 1.3 of off; the wheel is W44 / D3542, not the denoiser.
- **The band (the floor's reflection of the underside) improves only a little.** It is 98% traced hits; its brightness is the traced hits' own (raw 15.6 vs PT 4.1, W50), not a bleed.

## Regressions: compare Measure

Measure is the compare page's own: glossy mask, 64 spp reference, each scene's first pose, 960x540. Each cell is MAD / std / p99 / orbit.

| scene | off | `hits` | `all` | `hitDistW=8` |
|---|---|---|---|---|
| carConcept | 11.07 / 0.14 / 1.8 / 0.27 | 10.88 / 0.18 / 2.4 / 0.29 | 10.86 / 0.44 / 7.4 / 0.39 | 10.93 / 0.56 / 9.7 / 0.46 |
| chess | 9.50 / 0.05 / 0.6 / 0.19 | 9.50 / 0.06 / 0.7 / 0.19 | 9.62 / 0.30 / 5.8 / 0.32 | 9.63 / 0.30 / 5.8 / 0.33 |
| toyCar | 11.28 / 0.06 / 1.0 / 0.13 | 11.27 / 0.06 / 1.1 / 0.14 | 11.28 / 0.24 / 5.6 / 0.21 | 11.28 / 0.26 / 5.7 / 0.22 |
| Sponza | 28.49 / 0.07 / 0.5 / 2.57 | 28.47 / 0.10 / 0.8 / 2.57 | 28.29 / 0.14 / 1.8 / 2.61 | 28.34 / 0.18 / 2.4 / 2.62 |

`hits` is flat everywhere, and slightly better on carConcept. `all` and the hit-distance weight boil on every scene. Where rays flip between hit and miss from frame to frame, a pixel's neighbourhood changes membership every frame.

## GPU cost

The denoiser's own timestamps, showcase carConcept with RT on, loop stopped, median of 40 frames, Apple M-series:

| | 960x540 | 1920x1080 |
|---|---|---|
| off | 0.72 ms | 2.08 ms |
| `hits` | 0.75 ms | 2.43 ms (+0.35) |
| `all` | 0.74 ms | 2.59 ms (+0.51) |
| `hitDistW=8` | 0.89 ms | 3.37 ms (+1.29) |

- The seam's source pass is one 8x8 compute dispatch with two loads per pixel. It is not timed separately.
- In the Denoiser repo's test bed (1920x1080), off runs 1.83 ms and is identical frame by frame to main. `split` runs 2.04 ms and `hitDistW 8` 2.94 ms.

## Shots

| file | what |
|---|---|
| `w53/halo-960.jpg`, `w53/halo-1080.jpg` | The lip and band at 2x: PT, 11-11, off, `hits`, `all`, `hitDistW=8` (16-frame means). |
| `w53/wheel-960.jpg`, `w53/wheel-1080.jpg` | The reflected front wheel, same columns. |
| `w53/boiling-960.jpg`, `w53/boiling-1080.jpg` | Temporal std of luma, still camera (grey = std x 8): off, `hits`, `all`, `hitDistW=8`. |
| `w53/orbit-960.jpg`, `w53/orbit-1080.jpg` | The compare page's orbit-flicker heat maps (scale 32): same columns. |

**By eye:**
- With an option on, the lip's lower edge is dark where the PT's is, and the light band is gone. The edge between the two populations is now hard and **stair-stepped in 2x2 blocks**: one ray per quad (`samplesPerQuad` 1) copies its source to the quad, and the denoiser no longer blurs across it.
- At 1080p the stair steps are half the size and the options look much like off.

## Scripts (`w53/scripts/`)

| script | what |
|---|---|
| `drive.mjs` | W50's CDP driver, plus chunked binary dumps. |
| `toggles.js`, `metrics.py` | W50's, with the lip / band search scaled for 1080p. |
| `measure.sh` | Region means plus stability per set. |
| `stability.js`, `stab.py` | Per-region boiling and orbit flicker. |
| `probe.js`, `classes.py` | Per-pixel denoiser inputs by source. |
| `regress.js` | Compare Measure per set. |
| `cost.js` | Denoiser timestamps per setting. |
| `crops.py` | Montages. |

## Recommendation

- **For the bench,** offer `hitSource` as off / hits / all, plus `hitDistW` 0–16.
- **Don't make an option the default yet.** `hits` is the candidate: no regression, small cost, and about two thirds of the halo gone at 960x540. But at 1080p the halo is mostly gone already, and the 2x2 stair steps at the source edge are new.
- **What would finish it:** an edge-aware upsample of the per-quad source, or a source mask taken at full resolution. Both are fine-tune items.
