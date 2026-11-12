# W54: carConcept wheel centre, wheel interiors and cabin vs the path tracer

The maintainer, on the tuning bench (`bench.html?scene=carConcept&pose=w50&size=1280x1280&left=ours-rt&right=pathtraced`), saw three differences from the path tracer:

1. The front wheel's centre is a bright silver star in ours; in the path tracer it is dark and glossy.
2. The wheel interiors (brake disc, caliper, inner rim, well) are far brighter than in the path tracer.
3. The cabin is fully visible and bright through the glass; in the path tracer the glass reads dark and reflective.

## Verdicts

| # | What | Verdict | Deciding evidence |
|---|---|---|---|
| 1 | Chrome hub | **Ours** (reflections: hit shading + denoiser). Not the asset or a variant. | Its pixels are 46% screen-space hits, 40% traced hits, 15% traced misses. Hub (Measure) 44.0 vs PT 28.1; with the traced hits' specular lobe off (`t.hitSpecular=0`) 32.6, with that and the denoiser off 29.9. |
| 2 | Wheel interiors | **Base three render** (image-based specular with no occlusion but the glTF AO map). Our probes add a little. | 91% of the disc / caliper px are rough (probe only). Disc + caliper + mechanical: env-only three 44.8, ours 49.4, PT 18.0. With reflections off (no IBL specular) 21.0. |
| 3 | Cabin through glass | **Base three render** (the cabin's image-based lighting). Our glass reflection is right. | Glass made opaque black (its reflection only): ours 121.9 vs PT 121.7, MAD 0.8. Glass hidden (the cabin only): env-only three 64.1, ours 68.5, PT 29.8. |

No variant or material mismatch: the wheels and glass have no `KHR_materials_variants` mappings, and both methods build the same glTF through the same `entry.build()`, so both get the default material (`Rim2` chrome: metal 1, roughness 0.049, white). Neither three nor the path tracer applies a variant.

## Setup

- Bench at W50's pose, 1280 x 1280 (the maintainer's size), the bench defaults (AA on, RT on @pmndrs/bvh, FFX denoiser, one probe). Worktree on port 5423 with `DENOISER_REPO=Denoiser-w53-rebase`.
- **Measure** (the bench's own): the path tracer at 16 spp + OIDN as the reference, then each method's mean of 8 frames after 48 warm-up frames; 8-bit display luma and MAD over RGB. New regions for the W50 pose, at 1:1 only (`examples/showcase/src/bench/regions.ts`; the bench skips them at another aspect):
  - `hub`: the wheel centre (the star and the spokes around it, about 25% chrome);
  - `wheelFace`: inside the tyre;
  - `cabin`: the windshield, 99% glass;
  - `floorWheel`: the front wheel reflected in the floor.
- **Material masks** (`scripts/masks.js`): every mesh drawn unlit in a colour per material group, at the same camera. They give per-material numbers from single 48-frame shots, against the PT at 8 spp + OIDN:
  - `hub`: Rim2 px on the front wheel, 3100 px;
  - `wheel`: Disc, Brake and Mechanical px inside the front wheel, 11,730 px;
  - `glass`: every glass px.
- **New bench setting `glass`** (Materials group; example-side; rebuild; every method, the path tracer too):
  - `black`: the glass opaque and black, so only its own reflection shows;
  - `hidden`: no glass, the cabin as lit without it;
  - `noShadow`: the glass casts no shadow.

  The default is `authored`, which changes nothing.
- Scripts are in `docs/research/w54/scripts/` (`drive.mjs` is W50's driver; `bench-shots.js`, `views.js` for the main page's debug views, `masks.js`, `measure.js`, `stats.py`, `crops.py`).

## Numbers

Measure (luma / MAD vs PT; PT luma in the header):

| config | hub (PT 28.1) | wheelFace (36.4) | cabin (123.7) | floorWheel (32.1) | frame (123.7) |
|---|---|---|---|---|---|
| **ours-rt (default)** | 44.0 / 24.8 | 42.9 / 18.1 | 136.0 / 13.5 | 47.5 / 26.2 | 125.5 / 10.5 |
| ours denoised, no RT | 54.1 / 33.8 | 57.6 / 32.2 | 135.9 / 13.5 | 72.3 / 49.1 | 135.5 / 19.7 |
| probes only | 57.5 / 36.2 | 60.6 / 34.4 | 136.0 / 13.6 | 169.0 / 136.8 | 149.1 / 31.8 |
| env only (`probes=0`, no SSR / RT: three's own IBL) | 49.7 / 36.2 | 53.8 / 36.6 | 132.7 / 10.1 | 168.9 / 136.7 | 143.3 / 35.9 |
| three SSRNode raw | 35.2 / 34.2 | 36.5 / 37.7 | 125.3 / 5.6 | 110.0 / 89.9 | 118.1 / 35.4 |
| `specOcc=1` | 41.6 / 22.8 | 40.5 / 16.5 | 136.0 / 13.5 | 47.5 / 26.2 | 125.2 / 10.4 |
| `denoise=0` | 39.1 / 21.2 | 40.6 / 16.0 | 136.1 / 13.7 | 43.5 / 25.0 | 124.6 / 10.4 |
| `t.hitSpecular=0` | 32.6 / 22.7 | 34.5 / 16.7 | 135.0 / 12.6 | 37.7 / 21.5 | 118.4 / 13.6 |
| `denoise=0 t.hitSpecular=0` | 29.9 / 21.9 | 33.0 / 16.2 | 135.9 / 13.5 | 34.4 / 20.7 | 117.5 / 14.1 |
| `lobeFilter=0` | 34.4 / 25.1 | 35.5 / 21.4 | 135.9 / 13.4 | 47.4 / 26.1 | 121.5 / 13.2 |
| `hitSource=all hitDistW=4` | 42.8 / 22.9 | 42.6 / 17.1 | 136.1 / 13.6 | 46.6 / 25.7 | 125.2 / 10.4 |
| same + `lobeFilter=0` | 34.6 / 23.7 | 35.7 / 20.2 | 136.2 / 13.8 | 46.7 / 25.8 | 121.9 / 12.7 |
| `glass=black` (PT cabin 121.7) | | | **121.9 / 0.8** | | |
| `glass=hidden` (PT cabin 29.8) | | | ours-rt 68.5 / 43.8; probes 72.5; env only 64.1 | | |

Material masks (luma / MAD vs PT):

| config | hub: Rim2 (PT 50.5) | wheel: Disc, Brake, Mechanical (PT 18.0) | glass (PT 103.8) |
|---|---|---|---|
| **ours-rt** | 95.0 / 54.6 | 49.4 / 32.9 | 117.7 / 15.0 |
| denoiser off | 72.1 | 49.3 | 117.7 |
| `t.hitSpecular=0` | 69.0 | 48.4 | 116.8 |
| denoiser off + `t.hitSpecular=0` | 55.3 | 48.9 | 117.4 |
| `ssr=0` (every ray traced) / + `t.reuseOnScreenHits=0` | 93.9 / 94.7 | 49.4 | 117.8 |
| `reshade=off` | 100.0 | 55.3 | 121.6 |
| W52 `shadeVis=all` + `shadeOcc=screen` | 92.4 | 49.3 | 117.6 |
| `specOcc=1` | 99.8 | 39.2 | 120.4 |
| probes only / env only | 108.7 / 95.4 | 49.4 / 44.8 | 118.5 / 115.8 |
| three SSRNode raw | 59.3 | 30.6 | 102.7 |
| reflections off (main page `off`: no IBL specular) | 27.3 | 21.0 | 53.0 |
| ours-rt, the glTF AO maps off (`aoMapIntensity` 0) | 94.5 | 98.0 | 124.9 |
| `glass=black`: ours / PT | | | 100.7 / 97.7 (MAD 3.9) |
| `glass=hidden`: ours / env only / PT | | | 63.4 / 57.5 / 42.6 |

## 1. The chrome hub: ours

Crops: `w54/hub.jpg` (ours, PT, denoiser off, `t.hitSpecular=0`, both, `lobeFilter=0`, base three, three SSRNode) and `w54/floor-wheel.jpg`.

**What the star is.** It is `Rim2`, the chrome primitive of the rim mesh. A tint test confirms this, and so does the reflections-off view, where it goes dark like the spokes. So the bright star *is* our reflection term, not lit, emissive or three's base.

**Where its pixels come from.** Per the main page's source views, over the chrome px:

- 46% screen-space hits;
- 18% traced hits off screen;
- 22% traced hits on screen (screen colour);
- 15% traced misses.

The star mostly reflects other parts of the wheel: the spokes, the inner barrel, the lug nuts and the star itself.

**Why it is bright.** It is brighter than the PT in three ways:

- **The hits' specular.** Each hit is lit by the probe along its own reflected ray, with no occlusion inside the wheel: W41's traced-hit specular (D3510) and W44's re-shade of screen-space hits (D3540). With `t.hitSpecular=0`, the hub goes from 44.0 to 32.6 (PT 28.1), and the chrome px from 95 to 69.
  - Three's SSRNode reads its lit pass at hits, which has no environment specular, and lands at 35.2.
  - W52's occlusion options barely move the hub: 95 -> 92.4 on the chrome px. The BVH visibility ray and the depth march each test the one mirror ray. A hit on a spoke (roughness 0.4) has a wide lobe, whose occlusion one ray doesn't capture.
  - The hit material's glTF AO map doesn't explain it either. With every AO map off, the final hub is 94.5 (vs 95.0); the AO maps only take three's base IBL of the hub from 118.5 to 108.9.
- **The denoiser.** On the chrome px it goes 72 raw -> 95 denoised; on the `hub` rect, 39.1 -> 44.0. It spreads the bright neighbours' radiance (spokes, barrel) over the small chrome star. W53's hit-source split and hit-distance weight take the rect to 42.8.
- **The lobe filter** (W45 `hitLobeFilter` 1). It widens the hits' probe lookups; with `lobeFilter=0` the hub reads 34.4.

**The floor-reflected wheel** has the same root, as W50 measured: traced hits inside the wheel are shaded without occlusion. `floorWheel` is 47.5 vs 32.1; `t.hitSpecular=0` gives 37.7, and with the denoiser off as well, 34.4. The reflected star doesn't show bright: the floor sees it from below, edge-on.

**None of these is a default to flip.** `t.hitSpecular=0` costs the frame (MAD 10.5 -> 13.6) and the car's reflected door. `lobeFilter=0` costs W50's door, too.

**The fix** is occlusion for the hit's specular lobe that a closed wheel actually blocks. That is a cone or multi-ray visibility for wide lobes, or a probe inside the well (below). It is not small, so it isn't built. It is in the HANDOFF backlog.

## 2. Wheel interiors: base three

Crop: `w54/wheel-interior.jpg`.

**The disc and caliper get no reflection rays.** 91% of their px are rough: the disc is metal at roughness 0.73, above the tracer's threshold. So their brightness is the image-based specular: three's own, or the probe that replaces it.

**It is there without any of our passes.** Three's own environment lighting (env only, no SSR, RT or probes) gives 44.8 vs the PT's 18.0. With reflections off (no IBL specular) it is 21.0, about the PT. Three has no occlusion for it beyond the glTF AO maps. Those maps are strong here (AO maps off: 98.0), but not as dark as the real well.

**What our parts add.**

- **Our probe adds +4.6** (49.4). The scene's one probe captures from the stage centre, outside the well.
- **`specOcc=1`** (GTAO on the composite's probe part) takes the interior to 39.2 and `wheelFace` from 42.9 to 40.5. It is the existing option that helps.
- **RT helps the wheel as a whole.** With RT, `wheelFace` reads 42.9 against 57.6 without it.

A probe inside the well would darken the well's own lookups. The showcase has one probe per stage, and adding one per wheel is scene-side work. It is not built. It is in the backlog.

## 3. The cabin through the glass: base three; our glass reflection is right

Crop: `w54/cabin.jpg`.

**Our composite does reflect on the transmissive glass.** Reflections off: 53 on the glass px, 117.7 with them. The reflection matches the PT once the cabin is taken out (`glass=black`): 121.9 vs 121.7 (MAD 0.8) on the windshield, and 100.7 vs 97.7 over all the glass. The view is at glancing angles, so Fresnel is high on both.

**The cabin behind the glass is the difference.** With the glass hidden, PT 29.8 against:

- three's own lighting, 64.1;
- ours, 68.5: our probe and RT on the interior add about +4.

The interior is lit by unoccluded environment light. The roof is glass too, so some sky does reach the seats in the PT, just much less. Through the glass, three's transmission shows that over-bright `lit` image (D3520: the backdrop is the G-buffer's `lit` attachment, three's full lit image).

**Three's transmission is not the cause.** `noShadow` shows how it interacts:

- Three's shadow map treats the glass as opaque: the examples give every glTF mesh `castShadow`.
- The PT lets the key light through.
- Turning the glass's shadow off makes ours *brighter* (+4.6 on the glass px), while the PT is unchanged. So this difference runs the other way, and is small (D3682).

**Options for the cabin are scene-side, not in our pass:** a probe inside the cabin, or ambient occlusion on three's diffuse.

- `specOcc` doesn't help. It occludes the glass's own reflection (up to 120.4), not the cabin behind it.
- A cabin probe's volume would contain the glass, whose outer reflection must not read the interior capture. So it needs per-material probe exclusion first.

Not built. In the backlog.

## Options added

- **Bench setting `glass`** (`authored` | `noShadow` | `black` | `hidden`; example-side; every method alike, the PT too). It is an isolation tool, default `authored`, which changes nothing. Its effect is in the tables above. In `docs/SETTINGS.md`.
- **Measure regions** `hub`, `wheelFace`, `cabin`, `floorWheel` for carConcept at pose `w50`, 1:1 only (`Region.aspect`). W50's 16:9 regions are unchanged.

No package code changed, and no defaults. No bug was found in our output: the glass gets its reflection, and it matches the PT.
