# W52: options for the skirt halo, built as settings

W50 found the halo under carConcept's door (`car-quality-w50.md`, D3610). The lower lip of the skirt reads 80 against the path tracer's 48 at 960x540. The cause is W44's re-shade together with W45's `hitLobeFilter` 1. The re-shade correctly brightens the screen-space hits on the floor beside the car. The FFX denoiser then spreads them over the dark, correct ray-traced hits on the underside. The re-shade also lightens the reflected wheel, because on-screen traced hits are re-shaded without D3513's visibility ray (D3542).

The maintainer asked for each candidate fix as an option, so they can judge it by eye on W51's bench. This page has the three options, their combinations, the numbers against the path tracer, and the crops.

## The options

All three are off by default. With all three off, the output is the same as before W52.

| # | setting | where | URL flag (compare, showcase) | what it does | GPU at 1920x1080 |
|---|---|---|---|---|---|
| 1 | `hitShadeVisibility: 'offscreen' \| 'all'` (default 'offscreen') | traced pass: core `TracedReflectionsSettings`, three `ssr.traceSettings` | `?shadeVis=all` | On-screen re-shaded traced hits also take D3513's visibility ray along R. Where the ray is blocked, the lobe goes dark (D3640). Needs `hitShadows` and a BVH. This is also the documented mirror-in-mirror setting. | rt trace +0.30 ms (2.85 -> 3.15) |
| 2 | `hitLobeFilterMixed: number` (0..1, default 1) | core SSSR settings and RT settings; three `ssr.settings` (passed on to the RT pass) | `?lobeMix=<0..1>` | Scales `hitLobeFilter` where traced hits and screen-space hits mix. It applies when there is a traced hit within 3x3 samples, 5 px apart, around a re-shaded screen-space hit, or a screen-space hit near a traced hit. The signal is last frame's per-pixel hit source (D3641). | intersect +0.03, rt +0.04 ms |
| 3 | `hitShadeOcclusion: 'off' \| 'screen'` (default 'off') | core SSSR settings and RT settings; three `ssr.settings` (passed on) | `?shadeOcc=screen` | Re-shade occlusion without a BVH ray. Eight depth-buffer samples march along R from the hit. Where something the camera sees stands in front of the lobe, the lobe goes dark as D3513's does. It applies to screen-space hits, and to on-screen traced hits that take no ray (D3642). | intersect +0.04 ms |
| — | `hitLobeFilter` (number, default 1) | as before (D3550) | `?lobeFilter=<k>` (the showcase gets the flag too) | 0 is the "off" variant. Unchanged. | — |

The compare page also takes `?rtLobeFilter=<k>`, which sets the traced pass's own `hitLobeFilter`. It was used to split the lobe filter's effect between the two passes.

GPU cost is for carConcept on the showcase page (`?w=1920&h=1080&aa=off&rt=1`), loop stopped, median of 30 frames. Base: intersect 0.49 ms, rt trace 2.85 ms. The combinations add up: 1+2 +0.35, 1+3 +0.31, 2+3 +0.10 ms (`scripts/timing.js`).

### How option 2 got its shape

- **First form:** the share of traced hits among 3x3 samples 3 px apart, times 2. The lip only went from 80.0 to 73.3.
- **Split by pass:** `hitLobeFilter` 0 on the screen-space side alone gave 61.1. On both sides it gave 53.3.
- **Built form:** one traced hit anywhere in the 11x11 footprint triggers the scale, and the traced side is scaled too. That gives 55.6.
- **Why it had to widen:** the denoiser reaches further than 7 px.
- **The traced side's signal:** the traced pass keeps its own copy of last frame's source, because it cannot read the texture it writes.

## carConcept, W50's view

Setup:

- **View:** W50's camera, (0.491, 2.302, 5.617), target (0, 0.25, 0).
- **Method:** compare `ours-rt`, a fresh method instance per setting, a 90-frame warm-up, then the mean of 16 frames.
- **Reference:** the path tracer at 64 spp + OIDN.
- **Units:** sRGB luma after AgX, with MAD over RGB against the path tracer.
- **11-11:** today with the re-shade, the lobe filter and specAA off (`allOff`). W50 showed it renders this view exactly as `82b2095` did.

Regions (`scripts/metrics.py`):

- **W50's regions:**
  - **lip:** the 8 px above the path tracer's dark band.
  - **band:** the floor's reflection of the underside.
  - **wheel:** the front wheel reflected in the floor.
  - **door refl:** the red door reflected in the floor.
  - **car:** the whole floor reflection.
- **New, wider regions:**
  - **underside:** x 420-680, y 300-390. The black skirt, the sill, the lip, the gap and the band.
  - **skirt:** the black skirt panel on the car (PT luma 15-70 in x 480-680, y 265-345). This is where the glow W51 mentions sits.
  - **door under:** the red door's lower edge by the front arch, where it turns under (x 425-475, y 340-375).
  - **door paint:** the door on the car, where W45's filter helped (x 500-640, y 240-280).

### 960x540 (luma / MAD)

| | lip | band | underside | skirt | door under | door paint | wheel (std, detail) | door refl | car |
|---|---|---|---|---|---|---|---|---|---|
| path traced | 48.1 | 4.2 | 66.5 | 34.6 | 63.0 | 145.3 | 25.7 (26.9, 13.2) | 118.0 | 104.9 |
| 11-11 | 36.9 / 35.8 | 21.5 / 17.7 | 39.6 / 44.2 | 10.5 / 31.7 | 23.4 / 55.8 | 98.5 / 48.2 | 34.6 / 28.7 (23.5, 10.8) | 48.0 / 72.8 | 92.7 / 28.8 |
| **today** (defaults) | 80.0 / 47.0 | 26.3 / 22.5 | 69.0 / 22.0 | 50.2 / 17.5 | 70.6 / 24.2 | 143.7 / 7.7 | 43.2 / 27.9 (21.0, 10.3) | 110.2 / 13.6 | 107.2 / 14.1 |
| 1 visibility 'all' | 79.6 / 46.8 | 25.8 / 22.0 | 68.3 / 21.9 | 49.8 / 17.2 | 70.1 / 24.2 | 143.6 / 7.7 | 40.9 / 26.5 (20.8, 11.0) | 110.1 / 13.7 | 106.7 / 13.9 |
| 2 lobeMix 0 | 55.6 / 39.5 | 22.7 / 18.9 | 56.6 / 28.2 | 23.2 / 20.6 | 43.8 / 35.3 | 121.1 / 25.4 | 43.2 / 27.9 | 110.2 / 13.6 | 106.6 / 14.0 |
| 2 lobeMix 0.5 | 73.9 / 45.1 | 25.4 / 21.6 | 65.7 / 22.7 | 40.4 / 11.6 | 63.3 / 26.0 | 137.9 / 10.8 | 43.2 / 27.9 | 110.2 / 13.6 | 107.0 / 14.0 |
| 3 occlusion 'screen' | 79.3 / 46.5 | 25.7 / 21.9 | 68.2 / 21.7 | 49.6 / 17.1 | 69.8 / 23.9 | 143.7 / 7.7 | 36.8 / 25.6 (21.2, 10.6) | 110.0 / 13.7 | 106.0 / 13.7 |
| 1+2 | 55.3 / 39.4 | 22.2 / 18.4 | 56.0 / 28.1 | 23.0 / 20.7 | 43.9 / 35.0 | 121.1 / 25.4 | 40.9 / 26.5 | 110.1 / 13.7 | 106.1 / 13.8 |
| 1+3 | 79.2 / 46.5 | 25.7 / 21.9 | 68.0 / 21.7 | 49.6 / 17.0 | 69.7 / 23.9 | 143.6 / 7.7 | 36.4 / 25.5 (21.4, 10.6) | 110.0 / 13.7 | 105.9 / 13.7 |
| 2+3 | 54.9 / 39.2 | 22.1 / 18.3 | 56.1 / 27.7 | 23.3 / 20.4 | 43.9 / 34.4 | 120.9 / 25.6 | 36.8 / 25.6 | 110.0 / 13.7 | 105.4 / 13.6 |
| 1+2+3 | 54.8 / 39.2 | 22.1 / 18.3 | 55.7 / 28.0 | 22.5 / 21.1 | 43.6 / 34.6 | 121.1 / 25.4 | 36.4 / 25.5 | 110.0 / 13.7 | 105.3 / 13.6 |
| `hitLobeFilter` 0 | 53.3 / 39.6 | 22.4 / 18.7 | 52.7 / 31.9 | 12.5 / 31.1 | 31.0 / 48.1 | 111.0 / 35.3 | 43.2 / 27.9 | 110.2 / 13.6 | 106.5 / 14.0 |

### 1920x1080 (`?w=1920&h=1080`, the same regions scaled)

| | lip | band | underside | skirt | door under | door paint | wheel (std, detail) | door refl | car |
|---|---|---|---|---|---|---|---|---|---|
| path traced | 46.1 | 4.0 | 66.4 | 34.0 | 62.5 | 145.3 | 23.3 (28.0, 12.4) | 117.9 | 104.4 |
| 11-11 | 27.4 / 25.3 | 19.7 / 16.2 | 38.0 / 43.2 | 8.2 / 28.6 | 21.9 / 55.2 | 98.2 / 48.8 | 32.6 / 30.2 (26.8, 7.0) | 47.9 / 72.8 | 92.2 / 28.9 |
| **today** | 48.1 / 20.6 | 19.7 / 16.2 | 65.0 / 18.4 | 43.2 / 12.0 | 60.1 / 18.9 | 142.3 / 8.2 | 41.9 / 28.2 (23.4, 7.1) | 110.2 / 12.3 | 106.3 / 13.1 |
| 1 visibility 'all' | 47.7 / 20.5 | 19.1 / 15.6 | 64.4 / 18.1 | 42.8 / 11.7 | 59.7 / 19.0 | 142.2 / 8.2 | 39.8 / 26.6 (23.1, 7.5) | 110.1 / 12.4 | 105.8 / 12.8 |
| 2 lobeMix 0 | 34.5 / 22.8 | 19.2 / 15.7 | 55.9 / 24.7 | 24.2 / 13.3 | 42.8 / 31.6 | 117.3 / 29.6 | 41.9 / 28.2 | 110.2 / 12.3 | 105.9 / 13.1 |
| 2 lobeMix 0.5 | 44.7 / 20.9 | 19.6 / 16.1 | 62.5 / 19.4 | 35.6 / 8.3 | 55.0 / 21.9 | 135.8 / 12.4 | 41.9 / 28.2 | 110.2 / 12.3 | 106.1 / 13.1 |
| 3 occlusion 'screen' | 47.5 / 20.3 | 19.0 / 15.5 | 64.1 / 17.9 | 42.6 / 11.5 | 59.4 / 18.7 | 142.3 / 8.2 | 35.2 / 25.2 (23.8, 7.3) | 110.0 / 12.3 | 104.9 / 12.6 |
| 1+2 | 34.2 / 22.8 | 18.6 / 15.1 | 55.4 / 24.3 | 23.8 / 13.6 | 42.8 / 31.4 | 117.3 / 29.5 | 39.8 / 26.6 | 110.1 / 12.4 | 105.4 / 12.8 |
| 1+3 | 47.4 / 20.3 | 18.9 / 15.5 | 64.1 / 17.9 | 42.5 / 11.5 | 59.4 / 18.8 | 142.2 / 8.2 | 35.0 / 25.1 (23.9, 7.3) | 110.0 / 12.4 | 104.8 / 12.5 |
| 2+3 | 34.0 / 22.7 | 18.5 / 15.0 | 55.1 / 24.2 | 23.0 / 14.2 | 42.7 / 31.3 | 117.9 / 29.0 | 35.2 / 25.2 | 110.0 / 12.3 | 104.5 / 12.5 |
| 1+2+3 | 34.0 / 22.7 | 18.4 / 14.9 | 55.0 / 24.2 | 23.0 / 14.2 | 42.4 / 31.6 | 117.5 / 29.4 | 35.0 / 25.1 | 110.0 / 12.4 | 104.4 / 12.5 |
| `hitLobeFilter` 0 | 33.4 / 23.4 | 19.2 / 15.7 | 50.8 / 29.8 | 9.2 / 28.2 | 27.3 / 48.1 | 107.9 / 38.8 | 41.9 / 28.2 | 110.1 / 12.3 | 105.7 / 13.2 |

Raw numbers: `carConcept-960.json` and `carConcept-1080.json`.

## Reading

- **The halo is mostly a 960x540 effect (D3643).** At 1920x1080, today's lip is 48.1 against the path tracer's 46.1, and its MAD is the lowest of any row.
  - The denoiser's footprint is in pixels. At twice the resolution it spreads the floor hits over half the world distance.
  - What stays at 1080p is a black skirt panel lighter than the path tracer: 43 against 34. 11-11 had that panel at 8, too dark.
  - The glow on 11-11's skirt that W51 points to is probably the light streak along the grey sill's lower edge, which shows in the 11-11 panels of both crops. It sits inside the `underside` region, where 11-11 reads 39.6 against the path tracer's 66.5 (too dark on average). Every option keeps a softer form of that streak.
  - The reflected wheel also stays too light at 1080p: 42 against 23.
- **Option 2 is the only one that moves the halo.**
  - At 0 it takes the lip from 80 to 56 at 960x540 (PT 48), close to `hitLobeFilter` 0 everywhere (53).
  - It costs W45's gain wherever hits mix, and on a car over a mirror that is most of the lower half:
    - skirt: 50 to 23 (PT 35);
    - the door's lower edge: 71 to 44 (PT 63);
    - door paint: 144 to 121 (PT 145).
  - The underside's MAD gets worse, from 22.0 to 28.2. On Measure, carConcept's own hero pose goes from 11.06 to 11.67.
  - At 0.5 it is a milder trade: lip 74, skirt 40 (MAD 17.5 to 11.6), underside MAD 22.0 to 22.7.
  - At 1080p it overshoots, because there is no halo there to remove: the lip goes to 34.5.
- **Options 1 and 3 do not touch the halo.** Lip, band, skirt and door all stay within 1.
  - They work on the reflected wheel, the other complaint from W50.
  - Option 3 does more than option 1: wheel 43.2 to 36.8 at 960 and 41.9 to 35.2 at 1080.
  - Option 3 reaches the screen-space hits as well as the on-screen traced ones.
  - Together (1+3): 36.4 and 35.0.
  - The rest of the wheel's gap is the traced hits inside the wheel. W50 measured those at 55 against the path tracer's 10, from W41's shading without occlusion. These options do not reach them.
- **Option 1 and facingMirrors** (examples/ssr, RT on, `scripts/mirrors.js`, `facingMirrors-visibility.jpg`):
  - The mirror seen in a mirror goes from 0 % to 45.8 % black in the default pose, and from 35.5 % to 55.3 % in the left pose. The black stripes are where the facing mirror blocks R.
  - D4301's miss fill goes from 16.0 / 23.0 to 32.9 / 28.0. That repeats W44's measurement in D3542 (15.1 / 23.3 vs 33.7 / 30.7).
  - So 'all' is the setting for "a mirror in a mirror is dark", and 'offscreen' the one for "it shows the probe".

### Other scenes (compare Measure, `ours-rt` vs PT 64 spp, MAD over the glossy mask, 960x540)

| | today | 1 | 2 | 3 | 1+2+3 |
|---|---|---|---|---|---|
| chess hero | 9.50 | 9.49 | 9.50 | 9.47 | 9.47 |
| toyCar hero | 11.29 | 11.24 | 11.28 | 11.26 | 11.22 |
| Sponza courtyard | 28.61 | 28.49 | 28.59 | 28.46 | 28.38 |
| carConcept hero | 11.06 | 11.01 | 11.67 | 11.25 | 11.85 |

None of the options regresses chess, toyCar or Sponza. Option 2 costs carConcept's own hero pose 0.6, and option 3 costs it 0.2. Option 3's cost is likely false occlusion behind thin foreground parts; its constants are untuned.

## Recommendation (the maintainer decides on the bench; no default changed)

- **No option fixes the halo without a cost elsewhere.** The halo is the denoiser mixing two kinds of hit, so it belongs to W53's seam work (the denoiser keeps traced and screen hits apart). There, the existing per-pixel source below is the signal.
- **`hitShadeOcclusion: 'screen'` is the only candidate for a default.**
  - It brings the reflected wheel about a third of the way to the path tracer at both sizes.
  - It moves nothing else much, costs 0.04 ms at 1080p, and needs no BVH, so it works with RT off too.
  - First, tune its constants so it stops costing carConcept's hero pose 0.2.
- **`hitShadeVisibility: 'all'`** is a per-scene setting. It helps cars a little and darkens mirrors in mirrors, at 0.3 ms.
- **`hitLobeFilterMixed`** is a slider for 960x540-class canvases. If the maintainer wants it, 0.5 is the gentler setting.

## Hit source signal (for W53)

No new target. The traced pass already writes `TracedReflections.source` (core), copied to `ScreenSpaceReflectionsPass.source` (three). It is r32float, render size, holding RT_SOURCE codes:

| code | meaning |
|---|---|
| 0 | the screen-space result: a screen-space hit where `confidence` > 0, otherwise a rough pixel or the background |
| 1 | traced hit |
| 2 | traced miss |
| 3 | capped |
| 4 | traced hit shaded from the screen |

- This frame's codes are complete once the traced pass has run.
- Option 2 reads last frame's codes. Intersect reads them through the input `hitSource` (the traced pass's texture, before it clears it). The traced pass reads its own copy of them.

## Shots

- `halo-960.jpg`, `halo-1080.jpg`: the skirt and the lower door (x 430-690, y 270-400 in 960x540 coordinates), each a 16-frame mean. Rows:
  - path traced, 11-11, today;
  - option 1, option 2, option 3;
  - 1+2, 1+3, 2+3;
  - 1+2+3, option 2 at 0.5, `hitLobeFilter` 0.
- `wheel-960.jpg`, `wheel-1080.jpg`: the front wheel reflected in the floor. Panels: path traced, 11-11, today, option 1, option 3, 1+3.
- `facingMirrors-visibility.jpg`: facingMirrors with RT on. Left column 'offscreen', right column 'all'; top row the default pose, bottom row the left pose.

Scripts are in `docs/research/w52/scripts/`:

- `metrics.py`: the regions.
- `crops.py`: the crop sheets.
- `timing.js`: GPU ms on the showcase.
- `scenes.js`: compare Measure per option.
- `mirrors.js`: facingMirrors.

They run under W50's `docs/research/w50/scripts/drive.mjs` with W50's `toggles.js`.
