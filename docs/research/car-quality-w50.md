# W50: carConcept quality drop, 11-11 vs 12-11

The maintainer saw three things on carConcept, comparing today's compare-page shot (`ours-rt`, split slider) with the path tracer and with yesterday's main-page shot (1280x1280; probes, SSR, RT, denoiser and AA on; hit colour "last frame's image"; mirror floor at roughness 0.03; AgX at exposure 1):

1. **Halo:** a light band on the underside of the door and side skirt, just above the floor reflection. The path tracer has it dark.
2. **Lighter colour:** the reflected colour is lighter, and dark areas don't stay dark.
3. **Detail loss:** the reflection looks more pixelated and less detailed, most of all the front wheel reflected in the floor.

## Setup

- **Today:** main at `43a8627`. **11-11:** `82b2095` (17:19, the last main commit before W44 merged at 17:52), in a scratch worktree with the same assets, the same Denoiser checkout (no `denoiser-ffx` commit since 11-11), the same three r187 and the same three-mesh-bvh.
- **View:** the maintainer's camera, rebuilt by eye from the two shots: camera at (0.491, 2.302, 5.617), target (0, 0.25, 0), fov 40. `ours-rt` at this view reproduces the shot closely (`full-frame.jpg`).
- **Compare page** (`compare.html?manual`), 960x540, `ours-rt`. Each setting gets a fresh method instance, a 90-frame warm-up, then the mean of 16 frames. The reference is the path tracer at 64 spp + OIDN, which is identical on both commits (MAD 0.00).
- **Main page** with yesterday's settings at 1280x1280 (for the shots), plus 960x540 with and without AA (for the numbers). With AA off, the main page matches compare's `ours-rt` to within 0.1 in every region.
- **Regions** (`regions.jpg`; 8-bit sRGB luma after AgX, MAD over RGB vs the PT):
  - `lip`: the skirt's lower lip on the car, the 8 px above the PT's dark band in each column, 1440 px. This is where the maintainer's light band sits.
  - `band`: the floor's reflection of the car's underside, i.e. the PT's dark band (longest run of PT luma < 15 per column, x 460-640), 3663 px.
  - `wheel`: the front wheel reflected in the floor, x 290-400 by y 410-500.
  - `door`: the red door reflected in the floor (PT luma > 60).
  - `car`: the whole floor reflection of the car, x 170-780 by y 380-520.
  - "detail" is the mean absolute Laplacian of luma; "std" is the spatial standard deviation of luma.
- **Toggles** (all compare-page params): R = W44 re-shade (`?reshade=`), L = W45 `hitLobeFilter` 1 (`?lobeFilter=0` turns it off), S = W46 specAA (`?specAA=0` turns it off). "allOff" means R, L and S all off on today's main.

Scripts are in `docs/research/w50/scripts/` (`drive.mjs` runs headless Chrome over CDP; `toggles.js`, `main.js`, `views*.js`; `metrics.py`).

## Numbers (compare 960x540, `ours-rt`, luma / MAD vs PT)

| | lip | band | wheel (std, detail) | door | car |
|---|---|---|---|---|---|
| path traced | 48.1 | 4.2 | 25.7 (26.9, 13.2) | 118.0 | 104.9 |
| **11-11** `82b2095` | 36.9 / 35.9 | 21.5 / 17.7 | 34.6 / 28.7 (23.5, 10.8) | 48.1 / 72.8 | 92.7 / 28.8 |
| today, R L S off (allOff) | 36.9 / 35.9 | 21.5 / 17.7 | 34.6 / 28.7 (23.5, 10.8) | 48.0 / 72.8 | 92.7 / 28.8 |
| L only | 40.1 / 35.5 | 22.0 / 18.2 | 35.7 / 28.6 | 57.5 / 63.0 | 95.0 / 27.0 |
| S only | 37.7 / 35.7 | 18.4 / 14.6 | 34.7 / 28.4 | 52.8 / 68.0 | 93.9 / 28.1 |
| R only | 54.5 / 41.5 | 25.8 / 22.1 | 43.3 / 28.2 (20.3, 10.5) | 100.1 / 25.1 | 104.2 / 16.3 |
| R + L (`?specAA=0`) | 78.6 / 47.3 | 29.4 / 25.6 | 43.4 / 28.3 | 100.1 / 25.1 | 104.8 / 16.2 |
| R + S (`?lobeFilter=0`) | 53.3 / 39.6 | 22.4 / 18.7 | 43.1 / 27.9 | 110.2 / 13.6 | 106.5 / 14.0 |
| L + S (`?reshade=off`) | 41.4 / 35.7 | 18.9 / 15.2 | 35.9 / 28.4 | 63.4 / 59.0 | 96.5 / 26.3 |
| **today** `43a8627` (R + L + S) | 80.0 / 47.0 | 26.3 / 22.5 | 43.2 / 27.9 (21.0, 10.3) | 110.2 / 13.6 | 107.2 / 14.1 |
| today `?specAAHits=0` | 80.9 / 47.8 | 29.5 / 25.8 | 43.6 / 28.3 | 110.2 / 13.7 | 107.6 / 14.4 |
| today `?specOcc=1` | 78.2 / 45.4 | 26.0 / 22.2 | 43.0 / 27.8 | 110.2 / 13.6 | 107.0 / 14.0 |
| today, RT off (`ours-denoised`) | 142.9 / 108.2 | 165.0 / 160.9 | 73.2 / 55.1 | 110.4 / 13.6 | 125.2 / 30.9 |
| main page 960x540 with AA, 11-11 / today | 42.3 / 84.5 | 23.6 / 27.4 | 38.4 / 43.0 | 49.9 / 109.0 | 94.8 / 106.9 |

With R, L and S off, today's main renders this view exactly as 11-11 did (every region within 0.01). So nothing else that merged since then changes it: not W60 / W47 (probe sizes; the showcase has one probe), not W48 (bvh; the showcase and compare still use `MeshBVHTraceProvider`, three-mesh-bvh), and not W49.

**Raw vs denoised** (main page, no AA, RT on). In the raw columns `hitLobeFilter` was set through `__p.ssr.settings`, the denoiser off.

| lip | raw | denoised |
|---|---|---|
| today (k 1) | 47.0 | 80.1 |
| today, k 0 | 34.9 | 53.4 |
| path traced | 48.1 | |

In the lip, 63% of pixels are traced hits on the car's underside: raw 15.9 (PT 22.4), identical with re-shade on or off. Another 24% are screen-space hits on the floor: raw 107.8 with the re-shade and 39.8 without (PT 92.3). So in the raw signal the re-shade makes those floor hits *right*. The denoiser then mixes them into their dark traced neighbours: those pixels go from 15.9 raw to 72.1 denoised with the re-shade, and to 37.9 without it. The band behaves the same way: 98% traced hits, raw 15.6 either way, denoised 25.2 with the re-shade and 18.6 without it (PT 4.1).

## Symptom 1: halo, a regression from W44 x W45, showing through the denoiser

- **What changed:** the lip went from 36.9 to 80.0 (PT 48.1; MAD 35.9 -> 47.0), and the band went from 21.5 to 26.3 (PT 4.2).
  - W44's re-shade alone gives +17.6 on the lip (36.9 -> 54.5).
  - W45's `hitLobeFilter` 1 on top of it adds +24 (54.5 -> 78.6). Without the re-shade it adds +3.
  - W46's specAA moves the lip by about 1 and lowers the band by 3-4.
  - On the main page with yesterday's settings: lip 42.3 -> 84.5.
- **Mechanism:** the lip faces down and out, so its lobe sees two things: the car's underside (traced, dark, correct) and the floor beside the car (a screen-space hit). Before W44, the floor hit returned the floor's screen colour, which is the floor's own dark reflection: too dark (40 vs the PT's 92). W44 re-shades it with the floor's specular along the ray, read from the probe: about right raw (108 vs 92). W45 widens that lookup by the lip's alpha, which pulls in more of the studio's softboxes.
  - The raw lip is right (47 vs 48). The FFX denoiser then spreads the bright floor hits over the dark traced hits beside them, which share the lip's normal, depth and roughness. That is the light band (80).
  - The denoiser also loses bright samples elsewhere (D3550); here it raises dark ones.
- **Not the cause:**
  - D2402, the probe fallback under the car: it is the huge halo *without* RT (band 165, lip 143), and RT removes it.
  - Specular occlusion (`?specOcc=1`): lip 80.0 -> 78.2.
  - specAA on traced hits (`?specAAHits=0`): 80.9.
- **Maintainer can flip:**
  - `?lobeFilter=0` (compare page; the showcase has no knob yet, see the settings-guide tracked fix): lip 53, band 22.
  - `?reshade=off`: lip 41, band 19, but it brings back the dark reflected door (63 vs 118) that W44 fixed.
- **Fix:** not small, and it is not clearly this repo's alone (D3610). Options:
  - The denoiser keeps traced-hit and screen-hit radiance apart (a hit-distance or source term in the denoiser's weights; denoiser repo).
  - Scale `hitLobeFilter` down where a pixel's lobe mixes sources.
  - The re-shade occlusion the maintainer backlogged on 2026-11-12.

  Not built; reported first.

## Symptom 2: lighter colour, mostly a fix, but the dark areas regress (W44)

- **Overall:** the floor reflection of the car went from 92.7 to 107.2 (PT 104.9), and its MAD halved (28.8 -> 14.1). The reflected door went from 48 to 110 (PT 118; MAD 72.8 -> 13.6): W44 gives +52 and W46 +10. Yesterday's darker reflection was too dark, so "lighter" here is a correction.
- **Dark areas got lighter, which is real:**
  - The band: 21.5 -> 26.3 (PT 4.2). That is the denoiser bleed above.
  - The reflected wheel: 34.6 -> 43.2 (PT 25.7), from the re-shade alone (R only: 43.3). On-screen traced hits on the wheel went from 30.8 to 44.7 (PT 17.1): they are re-shaded without a visibility ray (D3542), so the rims' lobe reads the probe through the wheel well and the car body. Screen-space hits went from 29.6 to 37.3 (PT 34.7), which is closer.
  - The traced off-screen hits inside the wheel read about 55 against the PT's 10, both before and after. That is W41's traced-hit shading (probe lookups without occlusion), not a regression.

## Symptom 3: detail loss, mostly the page, partly W44

- **The page:**
  - Today's shot is the compare page: a 960x540 canvas that the stage scales up to the window (about 1.5x in the screenshot), with no AA, because the compare methods run without the showcase's AA.
  - Yesterday's shot is the main page at 1280x1280 with AA.
  - At this view the main page puts about 2.4x as many pixels across the car (5.7x the area) as 960x540 does.
  - The aliasing and most of the softness come from that.
  - The maintainer can get a sharper compare canvas with `?w=1920&h=1080`. AA is a main-page feature only.
- **At matched resolution and settings,** the reflected wheel loses some contrast and detail:
  - 960x540: std 23.5 -> 21.0 (PT 26.9), detail 10.8 -> 10.3 (PT 13.2).
  - Main page at 1280x1280: std 26.3 -> 23.3, detail 4.03 -> 3.73, luma 35.1 -> 41.2.
  - The cause is W44: a re-shaded rim's specular is the probe's (image-based light only). Last frame's image, which the hit used before, carried the key light's highlights on the spokes and the red caliper. Scene colour has no direct specular (D400), so those highlights don't come back.
  - W45 and W46 don't change the wheel (within 0.4).

## Shots

- `w50/full-frame.jpg`: PT / 11-11 / today, `ours-rt` at 960x540, whole frame.
- `w50/door-skirt-halo.jpg`: the lip and band, at 1.8x.
  - Top row: PT / 11-11 / today.
  - Bottom row: today `?lobeFilter=0` / `?reshade=off` / today raw (no denoiser). The raw lip is dark where the PT is.
- `w50/wheel-reflection-960.jpg`: the reflected front wheel: PT / 11-11 / today / today `?reshade=off`.
- `w50/wheel-reflection-main-1280.jpg` and `w50/underside-main-1280.jpg`: main page, 1280x1280 with AA, yesterday's settings, 11-11 vs today.
- `w50/regions.jpg`: the measurement regions on the PT. Magenta = lip, cyan = band, yellow = wheel, green = door, orange = car.
