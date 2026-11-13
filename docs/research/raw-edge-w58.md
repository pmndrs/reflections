# W58: the stair-stepped raw edge under carConcept's skirt

The maintainer found that the halo where carConcept meets the mirror floor (W50's `lip` / `band` at pose w50) is already in the **raw** image. With the denoiser off, the boundary between the skirt and the floor's reflection of the car's dark underside is hard, stair-stepped, and dotted with bright dashes. The denoiser only spreads it.

## Verdict

**The cause is FFX's quad copy across the silhouette.** With `samplesPerQuad` 1 (the default), classify traces one ray per 2x2 quad, from the even-even pixel. Intersect and the traced pass copy that ray's result (radiance, hit distance, confidence, RT source) to the other glossy pixels of the quad. They copy it even when those pixels are on another surface. FFX leaves the edge for its denoiser to clean up. Our composite weights each pixel by its own material, so a copied value shows wrong:

- **The bright dashes:** a skirt pixel's ray (a screen-space hit on the floor beside the car, re-shaded, bright) is copied onto floor pixels below the silhouette. Those floor pixels should show the dark underside. The metal floor's weight is about 1, so they come out at 114-209 where the PT is 1-11.
- **The stair step:** a floor pixel's ray (a traced hit on the underside, dark) is copied onto skirt pixels. Both effects follow the 2x2 grid.

Option built: **`s.quadCopy: 'always' | 'sameSurface'`** (core `ScreenSpaceReflectionsSettings.quadCopy`, default `'always'` = FFX = today).

- With `'sameSurface'`, a quad pixel traces its own ray when it differs from the quad's base pixel by more than 5 % in view depth or by more than about 25° in normal.
- That ray goes on to the miss list on its own, so the traced pass is per pixel along edges too.
- It takes the lip's raw MAD from 18.6 to 11.5 (spq 4: 11.2) for a few more rays along edges.

**The thin line in `view=off` is a separate thing, and it doesn't seed the halo.** It is three's clear-coat layer: its env reflection at the grazing lower bevel. The composite doesn't subtract it (D3512, the composite header). Removing the clear coat takes it from 64 / 93 to 2 / 1. The floor below the edge doesn't move (27.3 vs 26.7). The re-shade builds hit radiance from the specular-free scene colour plus its own lobe, so three's line never reaches the floor's hits.

## Per pixel along the lip (main page, 960x540, w50, RT on, denoiser off, AA off; `scripts/readback.js`, `scripts/columns.py`)

Column 501 crosses the silhouette between y 348 (skirt: roughness 0.37, normal y -0.16) and y 349 (floor: roughness 0.03, normal y 1).

| y | quad (x&1, y&1) | surface | source | conf | hit dist | radiance (lum) | final | PT |
|---|---|---|---|---|---|---|---|---|
| 347 | 11 | skirt | SSR hit | 0.999 | 0.41 | 3.56 | 31.0 | 120.4 |
| 348 | 10 | skirt | SSR hit | 0.996 | 0.27 | 1.35 | 89.9 | 71.1 |
| **349** | 11 | **floor** | SSR hit, **copied from (500, 348)** | 0.996 | 0.27 | 1.35 | **208.9** | **1.0** |
| 350 | 10 | floor | traced hit | 1.000 | 0.17 | 0.013 | 13.2 | 0.7 |
| 351-360 | | floor | traced hit (quad pairs identical) | 1.000 | 0.17-0.24 | 0.013 | 12-13 | 0.7-15 |

- Column 620: (620, 325) is a floor pixel that took the skirt pixel (620, 324)'s ray. It reads 114.3 against the PT's 11.2.
- Column 560: the floor's first row (336) is the even (base) row, so nothing crosses the edge and no dash appears. The skirt rows above alternate between screen-space hits, traced misses and screen-space hits in quad pairs.
- (500, 349) has roughness 0.8 (a rough strip at the edge). It takes the probe (25.4 vs 1.6) and is not traced.

**Over the regions** (`scripts/cross.py`; "quad base on another surface" means the G-buffer normal dot is < 0.9 or the roughness differs by > 0.1):

| region | px | ours raw | PT | mean \|diff\| | share of the region's \|diff\| |
|---|---|---|---|---|---|
| lip, quad base on another surface | 130 (9 %) | 132.8 | 34.8 | 112.8 | **0.43** |
| lip, same surface | 1310 | 54.6 | 63.3 | 14.6 | 0.57 |
| band, quad base on another surface | 30 | 169.5 | 3.3 | 166.1 | 0.10 |
| band, same surface | 4168 | 16.6 | 6.0 | 10.8 | 0.90 |

Nine per cent of the lip's pixels carry 43 % of its error.

**Which of the lead's candidates it is:**

- **Not SSR false hits from thickness.** The confidence across the edge is 0.996-1.000 on real hits. `s.depthBufferThickness` changes little (lead).
- **Not traced hits shaded too bright.** In the band they read 12-18 against the PT's 4-16. That is D3681's level (W56), not the edge.
- **Not the probe filling in where confidence fades.** Only the rough strip takes the probe.
- **Not a resolution mismatch in the composite.** Every input is full resolution. The 2x2 granularity enters at classify (one ray per quad) and travels with the quad-copy flags (bits 29-31 of the ray / miss-list entry) through intersect and the traced pass.

## Measure (bench, 960x540, w50, AA on, PT 16 spp + OIDN; `scripts/measure.js` + `scripts/configs.js`)

Each cell is luma / MAD against the PT.

| | lip raw | band raw | lip denoised | band denoised | frame denoised |
|---|---|---|---|---|---|
| path traced | 74.0 | 5.1 | 74.0 | 5.1 | 148.2 |
| default | 73.4 / 18.6 | 18.9 / 14.0 | 93.0 / 41.5 | 35.5 / 30.6 | 150.4 / 7.9 |
| **quadCopy sameSurface** | 65.5 / **11.5** | 17.1 / **12.2** | 84.8 / **34.4** | 31.8 / **26.9** | 150.3 / 7.7 |
| spq 2 | 66.1 / 11.8 | 18.4 / 13.5 | 84.8 / 34.7 | 32.6 / 27.8 | 150.4 / 7.7 |
| spq 4 | 65.5 / 11.2 | 18.4 / 13.5 | 84.1 / 34.3 | 32.5 / 27.7 | 150.3 / 7.7 |
| geometryRoughness off | 75.0 / 18.8 | 19.0 / 14.1 | 94.3 / 41.6 | 35.3 / 30.5 | 150.3 / 7.7 |
| sameSurface + geo off | 67.2 / 11.7 | 17.3 / 12.4 | 85.9 / 34.0 | 31.7 / 26.9 | 150.1 / 7.5 |
| missConfidenceThreshold 0.5 | 73.4 / 18.6 | 18.9 / 14.1 | 93.0 / 41.5 | 35.5 / 30.7 | 150.5 / 7.9 |
| missConfidenceThreshold 1 | 73.5 / 18.5 | 19.0 / 14.1 | 93.0 / 41.7 | 35.5 / 30.6 | 150.4 / 7.9 |
| h.depthAware 0 | 73.4 / 18.5 | 18.9 / 14.1 | 93.3 / 41.9 | 35.4 / 30.5 | 150.6 / 8.0 |
| reshade off | 50.6 / 28.0 | 17.6 / 12.7 | 57.3 / 36.0 | 26.1 / 21.2 | 148.5 / 11.1 |
| lobeFilter 0 | 57.6 / 23.8 | 17.9 / 13.0 | 64.1 / 41.2 | 28.7 / 23.9 | 148.0 / 9.0 |
| t.reuseOnScreenHits off | 72.9 / 18.3 | 18.2 / 13.4 | 92.9 / 41.6 | 35.0 / 30.1 | 150.4 / 7.9 |

**1920x1080** (the same regions scaled):

| | lip raw | band raw | lip denoised | band denoised |
|---|---|---|---|---|
| path traced | 48.8 | 4.4 | 48.8 | 4.4 |
| default | 46.4 / 14.0 | 18.6 / 14.5 | 56.7 / 24.6 | 21.0 / 16.8 |
| quadCopy sameSurface | 42.1 / 9.8 | 18.2 / 14.1 | 51.6 / 20.1 | 20.7 / 16.5 |
| spq 4 | 41.7 / 9.5 | 19.3 / 15.2 | 50.2 / 19.9 | 21.2 / 17.1 |

- **`sameSurface` gets the edge as clean as spq 4** (lip MAD raw 11.5 vs 11.2, denoised 34.4 vs 34.3), with rays added only along silhouettes. It is better than spq 4 on the band.
- At 1080p the lip's MAD drops by about a third raw (14.0 -> 9.8) and by 18 % denoised.
- **The lip's mean luma is right raw** (73.4 vs 74.0). The error is spatial: the copy moves energy across the edge without adding it. So MAD is the number that tracks the halo.
- **Thickness, `missConfidenceThreshold`, `depthAware` and `reuseOnScreenHits` don't touch the edge** (within 0.3).
- **`reshade off` and `lobeFilter 0` move the lip's level,** W50's mechanism, not the edge.
- The halo after the denoiser (lip 93 vs 74 at 960x540) is still mostly W50 / W53's spread: the band is 98 % traced hits next to bright screen-space hits. `sameSurface` removes the raw seed, about 7 MAD of the 41.

**Cost** (bench, 1920x1080, loop stopped, ours-rt, median of 5 rounds of 40 frames each, alternating; `scripts/timing.js`):

| pass | always | sameSurface |
|---|---|---|
| classify | 0.158 ms | 0.182 ms |
| intersect | 0.643 ms | 0.659 ms |
| rt trace | 6.08 ms | 6.28 ms |
| reflections total | 6.99 ms | 7.26 ms |

The rt trace figure is noisy at this level.

## What still steps

- **The lower boundary of the band** (where the floor's reflection of the underside meets the floor's reflection of the floor beyond it) still steps in 2x2 with `sameSurface` (`edge-960.jpg`, raw panels).
  - Every pixel there is on the floor, so the copy is legitimate. One ray per quad means the *reflected* silhouette is sampled at half resolution.
  - spq 4 smooths it at 4x the rays.
  - Edge-aware upsampling of the per-quad result would be the fine-tune (backlog).
- **The magenta dots along the skirt's upper trim seam** in `rtSource-ss` are seam pixels now tracing their own ray and missing.

## The thin line in view=off (coordinator's lead)

Main page, 1280x1280, w50, AA off, denoiser off (`scripts/coat.js`, `scripts/edgeline.py`, `offline-1280.jpg`). Column 860, the skirt's two last rows (y 788 / 789):

| | y 788 | y 789 | the skirt above (y 782-784) |
|---|---|---|---|
| view=off | 63.9 | 93.1 | 1-2 |
| view=off, keyLight 0 | 61.9 | 92.1 | 0 |
| view=off, clear coat 0 | **2.0** | **1.0** | 1 |
| ibl (three's lit) | 113.9 | 123.4 | 93-94 |
| ibl, clear coat 0 | 97.4 | 90.6 | 93-94 |
| three's shading roughness (view, x 255) | 119 | 121 | 95 |

- **Not the key light:** with it at 0 the line stays.
- **Not geometry roughness:** off dims the line in the coordinator's crops but doesn't remove it. The shading-roughness view does have a dashed white line along the silhouette, where the derivative term saturates. It doesn't explain the line in `view=off`.
- **Not a mismatch between the G-buffer and the lit target:** the base layer cancels to 1-2 everywhere, the edge included.
- **It is three's clear-coat env reflection** (the skirt is "Paint 2 Carmine", clear coat 0.25 at roughness 0), which rises with Fresnel where the bevel's normal turns away from the camera. The composite subtracts the base layer's IBL only (D3512: a coat's base attenuation is modelled, not the coat's own layer). So `view=off` keeps it, and so does `final`.
- **It doesn't seed the floor:** over the 12 floor rows below the car's edge (x 700-1150), raw final reads 27.3 with the coat and 26.7 without it (`sameSurface` 20.5, PT 14.3).
- Over the 6 car rows above the edge: 89.5 with the coat, 82.1 without it, PT 92.4. The coat makes the car's own edge brighter, but there the PT is brighter still.

## Bench additions

- `s.quadCopy` (Screen-space group).
- `envLight`: scales `scene.environmentIntensity`, so three's IBL, the probe bake and the PT's environment together.
- `background`: `hdri` | `black` (backgroundIntensity 0; camera rays only).

All three are in `docs/SETTINGS.md`. Checked at w50: with `envLight=0`, ours-rt and the PT show key light only. With `background=black`, the backdrop pixels read (0, 0, 0) on both methods and the floor is unchanged.

Side observation for later (not chased): at `envLight=0` the PT's floor shows the key-lit car's reflection brightly, and ours shows it nearly black. Our hit radiance has no direct specular (D400), and the paint is metal.

## Files

- Package: `packages/core/src/sssr/shaders.ts` (classify's `quadBase` / `sameSurfaceAsBase`, `Params.quadCopySameSurface`, PARAMS_SIZE 576) and `packages/core/src/sssr/sssr.ts` (the setting, u[140]). The three adapter passes `ssr.settings` through unchanged.
- Bench: `examples/showcase/src/bench/schema.ts`, `compare/ours.ts` (SSSR_FIELDS), `compare/method.ts` (`envLight`, `background`), and the rebuild key lists in `ours.ts`, `three-ssr.ts` and `pathtracer.ts`.
- Images:
  - `w58/edge-960.jpg`: x 470-630, y 300-380 at 4x. Raw: PT, always, sameSurface, spq 4. Then rtSource for always and sameSurface. Then denoised for always and sameSurface.
  - `w58/offline-1280.jpg`: x 760-960, y 770-850 at 3x. view=off with and without the coat, three's shading roughness, keyLight 0, raw final with and without the coat, sameSurface, PT.
- `w58/scripts/`:
  - `drive.mjs`: W56's driver plus `__append`.
  - `shots.js`, `readback.js`, `measure.js` + `configs.js`, `timing.js`, `coat.js`.
  - `load.py`, `columns.py`, `cross.py`, `edgeline.py`, `crops.py`.
