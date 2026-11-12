# W56: carConcept's chrome star vs the path tracer

The maintainer, on the bench at W50's pose (1280 x 1280): the chrome star at the front wheel's hub (`Rim2`: metal 1, roughness 0.049, white, no maps) reads as uniform bright brushed silver with bright outlines along its bevels. The path tracer shows a dark mirror with a few sharp highlights. It stays bright in every variant W54 tried, so W54's cause (unoccluded hit shading, measured over a hub rect that is 75% spokes and barrel) doesn't explain the star itself.

## Verdict

**Three blurs stack on a small mirror part. Each widens what the star reflects, and the tone mapper turns the smeared softboxes into mid-grey silver.**

| cause | what it does on the star | star luma (PT 50.5) |
|---|---|---|
| ours-rt default | | **100.1** / MAD 58.2 |
| **three's geometry roughness** (r187 `getRoughness`), confirmed | (1) Three's key-light specular spreads over the bevels. On the reflections-off view (direct light only), the star reads 27.3 with geometry roughness and 0.5 without it. The PT's key light makes a point glint on an r 0.049 mirror. (2) Three's environment / probe term, where SSR confidence < 1, is looked up blurred: the IBL view goes 108.9 -> 72.4. | -21.5 -> 78.6 / 44.4 |
| **the FFX denoiser** (with geometry roughness off) | Spreads the neighbours' radiance (spokes, r 0.4, and the bevels) over the 3100-px star. On the faces (`starCore`): 56.3 -> 24.1. | -35.7 -> 42.9 / 29.9 |
| **the hit lobe filter** (W45 `hitLobeFilter` 1, geo off) | The filter doesn't act on the star's own lookups. The star's alpha is 0.0024, so its spread is negligible. It acts on the spokes' hits next to it, through the denoiser and the AA. Without the denoiser it moves mostly the star's edge px (49.2 -> 33.9; the core 24.1 -> 21.4). | -24.0 -> 54.6 / 31.2 |
| all three off | A dark mirror with sharp highlights, as in the PT (`w56/star.jpg`). | 30.8 / **29.8** (20 under) |

- **The maintainer's floor lead is killed for the star.** A CPU ray cast of every star pixel at the bench camera (three-mesh-bvh over the scene's own meshes and vertex normals) gives:
  - **68%** of the star's mirror rays hit the **open floor in front of the wheel**. That floor point sees the key light, and its own mirror bounce goes to the sky.
  - 16% go to the sky directly.
  - 15% hit the spokes (Rim1).
  - **0.1%** (3 px) hit the floor under the car.
- **The floor under the car is too bright** (ours-rt 24.0 vs PT 8.0, its own region below), but that is a separate problem:
  - The floor is a metal mirror (metalness 1, r 0.03), so its look is entirely its reflection. The shadow map has nothing to darken: with reflections off, those px read 0.1 in ours (the PT's full render there is 8.0).
  - Its reflection hits the car's underside, and that hit's specular is unoccluded (D3681). `t.hitSpecular=0` gives 4.6.
  - So lead (b) explains the floor under the car, and lead (a) is moot on a metal floor. Neither explains the star.
- **Normals are not the cause.** Flat face normals give nearly the same ray split as the smooth vertex normals (floor 66.8 / sky 15.3 / wheel 17.5%, against 68.3 / 15.9 / 15.1%).
- **Probe resolution and the re-shade are not the cause.**
  - `probeRes=1024`: 78.6 -> 78.0.
  - `reshade=off`: no better (100.7; with geo off, 78.3).
- **Our composite is right.** The G-buffer's `shadingRoughness` is three's own (D403), so the subtraction of three's environment term is exact. The extra brightness is three's own direct specular plus what the denoiser and the AA blend in. **No bug in our output.** Nothing in the package changed, and no default changed.

## Setup

- Bench: `bench.html?scene=carConcept&pose=w50&size=1280x1280&left=ours-rt&right=pathtraced`, the bench defaults (AA on, RT on @pmndrs/bvh, FFX denoiser, one probe).
  - Worktree on port 5425 with `DENOISER_REPO=Denoiser-w53-rebase`.
  - Shots are 48 frames per configuration; the PT is at 8 spp + OIDN.
- **Masks** (`scripts/stats.py`):
  - `star`: Rim2 px on the front wheel. These come from W54's `masks-a` (copied to `w54/scripts/masks-a-1280.png`), 3100 px.
  - `starCore`: the star eroded by 2 px (the faces).
  - `starEdge`: the rest of the star (the bevels and the silhouette).
  - `hubRect`: W54's `hub`.
  - `star>floor`, `star>sky`, `star>wheel`: the star split by where its mirror ray goes (`scripts/rays.js` -> `rays.png`).
  - `floorUnder`: floor px under the car, 42,711 px. The camera ray hits the floor first, and a ray straight up from there hits the car (`rays.js` with `FLOOR_MASK` -> `floor.png`).
  - `floorOpen`: the rest of the floor.
- **Measure** (the bench's own: PT 16 spp + OIDN, the mean of 8 frames after 48): W54's 1:1 regions and W50's at 1280 x 1280, and W50's at 960 x 540. Data in `measure-1280.json` and `measure-960.json`.
- **Debug views** (main page `index.html?manual&scene=carConcept&w=1280&h=1280`, `scripts/views.js`, now with `&geometryRoughness=`): reflections off, IBL, source (rtSource), confidence, hit radiance, specular, probe specular.
- **Flicker** (`scripts/flicker.js` / `flicker.py`): 8 consecutive frames after 48, with the camera orbiting 0.0005 rad a frame. The camera is moved directly, so the AA history reprojects. Reported per pixel: the std of luma and the mean |frame-to-frame difference|.

## The option

**`geometryRoughness`**: `three` (default, changes nothing) | `off` | a scale (`0.5`, `0.25`, any number by URL).

- Bench Materials group, `apply: 'rebuild'`, every raster method (ours, probes, three's SSR); never the path tracer.
- On the main page it is URL-only (`?geometryRoughness=`).
- In `docs/SETTINGS.md`.

**How it works** (`examples/showcase/src/geometryRoughness.ts`):

- It installs an own `setupVariants` on each standard / physical material. That method calls three's and then re-assigns `roughness` (and the clear coat's) as three builds it, `min(1, max(r, 0.045) + g x scale)`, with g = three's normal-derivative term.
- Exact: at scale 1 it is three's expression.
- The override carries over to the node material because `NodeLibrary.fromMaterial` copies the material's enumerable properties.
- The cache key carries `|geoRough`.
- Three's lit term, the G-buffer's `shadingRoughness` (so the composite's probe term) and the probe bake all read it.
- The tracer's and the denoiser's roughness (`normalRoughness.w`) never had the term.
- Limit: physical anisotropy's `alphaT` keeps the unadjusted roughness. No showcase material uses anisotropy.

## Numbers

### The star, per method

8-bit display luma / MAD vs the PT (`scripts/stats.py`). Geo = `geometryRoughness`.

| config | star (PT 50.5) | starCore (29.3) | starEdge (57.5) | star>floor (44.0) | star>sky (68.3) | star>wheel (60.3) | hubRect (26.4) |
|---|---|---|---|---|---|---|---|
| **ours-rt** | 100.1 / 58.2 | 65.1 / 36.6 | 111.7 / 65.4 | 88.2 / 52.2 | 118.5 / 58.8 | 132.5 / 83.1 | 47.8 / 27.4 |
| geo 0.5 | 88.6 / 50.1 | 59.2 / 30.9 | 98.3 / 56.5 | 78.4 / 45.2 | 104.4 / 48.5 | 116.5 / 72.6 | 45.6 / 25.7 |
| geo 0.25 | 82.1 / 46.2 | 57.3 / 29.0 | 90.3 / 52.0 | 73.6 / 42.4 | 95.1 / 42.6 | 105.4 / 66.2 | 44.3 / 24.8 |
| geo off | 78.6 / 44.4 | 56.3 / 28.1 | 86.0 / 49.9 | 71.2 / 41.1 | 89.2 / 40.0 | 99.4 / 63.1 | 43.3 / 24.6 |
| `carProbes=wheels` | 74.9 / 44.0 | 43.6 / 24.7 | 85.4 / 50.4 | 66.2 / 36.7 | 84.3 / 52.6 | 102.6 / 66.3 | 29.0 / 19.8 |
| wheels + geo off | 59.2 / 38.1 | 39.2 / 22.0 | 65.8 / 43.5 | 55.7 / 32.9 | 58.8 / 43.4 | 73.7 / 54.8 | 25.7 / 18.8 |
| `denoise=0` | 72.4 / 40.8 | 31.3 / 15.0 | 86.1 / 49.4 | 55.6 / 31.8 | 99.3 / 46.7 | 117.7 / 73.2 | 39.2 / 21.7 |
| `lobeFilter=0` | 84.1 / 46.5 | 51.4 / 24.0 | 95.0 / 54.0 | 71.5 / 39.7 | 107.0 / 50.6 | 116.0 / 71.9 | 37.5 / 26.4 |
| `t.hitSpecular=0` | 69.5 / 45.9 | 38.3 / 20.2 | 79.9 / 54.5 | 55.7 / 40.7 | 99.7 / 47.4 | 99.4 / 67.0 | 32.7 / 22.7 |
| `reshade=off` | 100.7 / 63.0 | 74.2 / 46.9 | 109.5 / 68.3 | 91.8 / 60.2 | 116.1 / 56.9 | 123.6 / 81.1 | 42.9 / 27.5 |
| geo off + `denoise=0` | 42.9 / 29.9 | 24.1 / 10.7 | 49.2 / 36.3 | 32.1 / 24.7 | 62.4 / 30.1 | 68.9 / 51.9 | 34.3 / 20.1 |
| geo off + `lobeFilter=0` | 54.6 / 31.2 | 41.3 / 15.1 | 59.0 / 36.5 | 48.9 / 28.2 | 67.3 / 29.4 | 67.0 / 46.2 | 30.7 / 23.8 |
| geo off + lobe 0 + denoise 0 | **30.8 / 29.8** | 21.4 / 11.9 | 33.9 / 35.8 | 23.6 / 26.5 | 51.2 / 29.1 | 42.0 / 44.8 | 23.9 / 23.0 |
| geo off + `probeRes=1024` | 78.0 / 44.1 | 55.3 / 27.2 | 85.5 / 49.7 | 70.4 / 40.6 | 88.9 / 40.2 | 99.1 / 63.0 | 43.2 / 24.5 |
| probes only / geo off | 108.7 / 66.0 -> 72.2 / 44.9 | 75.2 -> 57.2 | 119.8 -> 77.3 | 101.6 -> 71.6 | 103.9 -> 57.1 | 143.5 -> 90.0 | 57.5 -> 49.5 |
| env only (base three) / geo off | 95.4 / 67.1 -> 68.4 / 58.7 | 62.9 -> 54.5 | 106.2 -> 73.0 | 84.4 -> 64.6 | 98.4 -> 55.2 | 140.5 -> 99.2 | 49.7 -> 44.2 |
| three SSRNode / geo off | 59.3 / 46.6 -> 23.6 / 41.0 | 34.2 -> 25.5 | 67.6 -> 23.0 | 47.7 -> 20.9 | 82.7 -> 42.1 | 85.2 -> 15.6 | 35.2 -> 26.5 |

**Main page views on the star** (ours-rt, display luma; `w56/star-views.jpg`):

| view | geo three | geo off |
|---|---|---|
| final | 95.1 | 74.4 |
| reflections off (direct light only) | **27.3** | **0.5** |
| IBL (three's lit) | 108.9 | 72.4 |
| probe specular (subtracted) | 94.3 | 66.8 |
| specular (denoised) | 73.6 | 68.3 |
| specular, denoiser off | | 38.1 |
| hit radiance x confidence | 19.7 | 19.7 |

**Sources** (rtSource view, the star px):

- 42% screen-space hits;
- 19% traced hits;
- 7% traced on-screen hits;
- 11% traced misses.

Confidence is about 0.9. On `star>floor`, 56% are screen-space hits on the open floor in front of the car.

### Where the star's rays go

`scripts/rays.js`, every px at 1280 x 1280; the mirror ray from the smooth vertex normal.

| first hit of R | px | % | then |
|---|---|---|---|
| floor, open (in front of the wheel) | 2115 | 68.3 | the floor point sees the key light (2118 / 2118); its mirror bounce goes to the sky (2115) |
| sky | 492 | 15.9 | |
| Rim1 spokes / Rim2 / Mechanical | 467 | 15.1 | |
| body paint | 21 | 0.7 | |
| floor under the car | 3 | 0.1 | |

- With flat face normals: floor 66.8%, sky 15.3%, wheel 17.5%.
- Mean R = (-0.11, -0.28, 0.60): down and toward the camera.
- The star shows the studio's upper half twice mirrored, through the floor. In the PT that is dark with sharp softbox highlights.

### Floor under the car (the coordinator's region)

Floor px under the car (42,711), luma / MAD:

| method | luma / MAD |
|---|---|
| PT | 8.0 |
| **ours-rt** | 24.0 / 17.7 |
| geo off | 23.9 / 17.7 |
| `carProbes=wheels` | 20.8 / 16.3 |
| `denoise=0` | 18.7 / 13.4 |
| `t.hitSpecular=0` | **4.6 / 9.7** |
| `reshade=off` | 23.3 / 17.5 |
| probes only | 167.3 / 159.6 |
| env only (base three) | 167.0 / 159.4 |
| three SSRNode | 143.0 / 136.9 |
| reflections off (main page) | 0.1 |

On the open floor (485,786 px), the PT reads 111.2 and ours-rt 113.9 / 13.5.

**(a) Base raster.**

- The floor receives shadows (`receiveShadow`), and the car casts them.
- But the floor is a metal mirror: the key light adds nothing outside its glint, so reflections-off reads 0.1 under the car and 0.0 in the open.
- The 167 of base three is its unoccluded image-based specular: the probe or HDRI where the car's underside should be.

**(b) Our hits.** With SSR / RT, the floor's rays hit the underside, and that hit's specular is the probe along its own reflection with no occlusion (D3681, W50's `band`). `t.hitSpecular=0` takes it to 4.6. Neither half reaches the star.

### Elsewhere (Measure)

W54's 1:1 regions and W50's regions, ours-rt, luma / MAD.

**1280 x 1280:**

| config | frame (PT 123.7) | hub (28.1) | wheelFace (36.4) | cabin (123.7) | floorWheel (32.1) | lip (52.4) | band (2.6) | door (128.9) | car (99.8) |
|---|---|---|---|---|---|---|---|---|---|
| three | 125.5 / 10.5 | 44.0 / 24.8 | 42.9 / 18.1 | 136.0 / 13.5 | 47.5 / 26.2 | 55.6 / 28.2 | 19.5 / 17.0 | 122.1 / 12.1 | 99.9 / 16.7 |
| geo 0.5 | 125.4 / 10.4 | 41.8 / 23.1 | 42.7 / 17.6 | 136.2 / 13.7 | 47.5 / 26.2 | 56.0 / 28.2 | 19.5 / 17.1 | 122.1 / 12.1 | 100.0 / 16.7 |
| geo off | 125.4 / 10.4 | 39.7 / 22.4 | 42.3 / 17.6 | 136.5 / 14.0 | 47.4 / 26.2 | 56.5 / 28.5 | 19.5 / 17.1 | 122.2 / 12.1 | 99.9 / 16.7 |
| wheels | 123.1 / 10.7 | 27.0 / 19.8 | 30.0 / 17.6 | 135.9 / 13.5 | 32.7 / 23.3 | 55.6 / 28.2 | 19.5 / 17.0 | 122.0 / 12.1 | 94.9 / 16.3 |
| wheels + geo off | 122.9 / 10.6 | 24.0 / 19.1 | 29.5 / 17.5 | 136.5 / 14.0 | 32.7 / 23.3 | 56.5 / 28.4 | 19.5 / 17.1 | 122.1 / 12.1 | 94.8 / 16.4 |

**960 x 540:**

| config | frame (PT 148.2) | lip (74.0) | band (5.1) | wheel (24.6) | door (118.8) | car (104.8) |
|---|---|---|---|---|---|---|
| three | 150.4 / 7.9 | 92.9 / 41.7 | 35.4 / 30.5 | 43.9 / 28.9 | 109.9 / 14.1 | 107.6 / 15.0 |
| geo off | 150.3 / 7.7 | 94.3 / 41.6 | 35.3 / 30.5 | 43.8 / 28.9 | 109.8 / 14.1 | 107.5 / 14.9 |
| wheels + geo off | 148.8 / 7.8 | 94.3 / 41.6 | 35.4 / 30.5 | 24.6 / 25.4 | 109.8 / 14.1 | 104.2 / 14.6 |

**Other methods, 1280:** probes only, frame 149.1 -> 148.9 and hub 57.5 -> 49.5; three SSRNode, hub 35.2 -> 26.5 and door 68.1 -> 66.4.

**Where geo off loses.**

- The cabin through the glass: MAD 13.5 -> 14.0, luma 136.0 -> 136.5.
- The lip: 55.6 -> 56.5.

Both are small. Everything else is the same to 0.2, or better.

### Sparkle (frame to frame)

The std of luma over 8 frames, mean over each mask, while orbiting. `flicker.py` masks:

- paint: the car's red paint in the PT;
- floor: the open grey floor below y 1000.

| config | paint | paint in the floor | open floor | frame |
|---|---|---|---|---|
| ours-rt, three | 1.261 | 1.155 | 0.154 | 0.726 |
| ours-rt, geo off | 1.278 (+1.3%) | 1.151 | 0.154 | 0.724 |
| probes only, three | 1.690 | 0.026 | 0.030 | 0.641 |
| probes only, geo off | 1.761 (+4.2%) | 0.028 | 0.029 | 0.649 |
| probes only, AA off, three | 6.031 | 0.022 | 0.022 | 1.619 |
| probes only, AA off, geo off | 6.520 (+8.1%) | 0.022 | 0.022 | 1.730 (+6.9%) |

- With a static camera (TAA jitter only), the paint goes 0.140 -> 0.148 and the frame 0.119 -> 0.122.
- Geometry roughness does damp the paint's specular aliasing, as it is meant to. Through the default AA that is 1-4%, and 8% without AA.
- The floor is flat, so its derivative is zero: no change there.

## What would change it (not done; no defaults changed)

**1. `geometryRoughness` off (or 0.25) for ours.**

- It fixes the key light's bevel glow and a third of the star's excess.
- It costs the paint 1-4% more frame-to-frame flicker.
- In the PT the bevels do glint (`starEdge` 57.5), but sharply.
  - Three's derivative term is added linearly to perceptual roughness from the max abs derivative. Kaplanyan 2016 / Tokuyoshi 2019 add a clamped variance to alpha^2 instead.
  - So three's version is strong on small bevelled parts.
- A variance-form specular AA (the specAA module's sibling) is the principled replacement.
- The maintainer's call. In the backlog.

**2. The denoiser on a small near-mirror part next to rough ones.**

- It lifts the star's faces from 24 to 56.
- That is FFX's spatial filter taking radiance from neighbours with other normals or roughness. W53's hit-source split doesn't stop it: those px are all hits.
- It belongs to the denoiser repo (rule 9).

**3. The lobe filter.**

- It reaches the star only through its neighbours. The spokes' hits are looked up wider, then blended in by the denoiser and the AA.
- `lobeFilter=0` costs W50's lip (D3550), so it is no default either.

**With all three off, the star is 20 under the PT.**

- The raw screen-space hits on the floor (hit radiance 16 on `star>floor`, PT 44) reflect the stage probe's view of the studio from the floor point.
- That is a box-projected lookup through a mirror at a floor point far from the capture.
- Not chased further here (time-box).

## Files

- `examples/showcase/src/geometryRoughness.ts`: the option.
- Wiring: `compare/method.ts` (`applyGeometryRoughness`), `compare/ours.ts`, `compare/three-ssr.ts`, `main.ts`, `bench/schema.ts`.
- `docs/research/w56/`:
  - `star.jpg`: ours default, each variant, the PT;
  - `star-base.jpg`: env only, probes only and three's SSR, with geometry roughness on and off;
  - `star-views.jpg`: reflections off on / off, sources, the CPU ray classes;
  - `measure-1280.json`, `measure-960.json`;
  - `scripts/`.
