# W55: probes inside carConcept (wheel wells, cabin)

W54 found that carConcept's wheel interiors, chrome hub and cabin come out too bright against the path tracer because the car's only probe captures the open studio from above the car (D3680, D3681). Three's base lighting (`scene.environmentNode = reflectionProbes(probes)`) and our hit shading both read that capture, so they treat enclosed spaces as open.

W55 adds small probes inside the car, one per wheel well and one for the cabin, beside the stage probe. It is an example-side bench setting, default `off`. It is also a small-scene test of a mixed-size probe set.

## Verdict

- **Wheels: yes.** On W54's 1:1 regions the four wheel probes bring the problem regions to the path tracer:
  - hub 44.0 -> 27.0 (PT 28.1);
  - floor-reflected wheel 47.5 -> 32.7 (PT 32.1);
  - W50's 16:9 `wheel` region 44.0 -> 24.6 (PT 24.6).

  On the material masks, the disc and caliper go 53.1 -> 26.6 (PT 18.0) and the chrome star 100 -> 74.8 (PT 50.5). The cost at 1080p is about +0.8 ms a frame, +14 ms of bake and +1-4 MB.
- **Cabin: no.** A box that stays inside the glass keeps the glass reflection exact (121.9 / MAD 0.8, unchanged). But it covers the seats, not the dashboard the windshield shows, so the cabin moves only 136.0 -> 134.7 (PT 123.7). A box that takes in the glass costs the glass reflection (MAD 0.8 -> 2.8) and still reaches only 133.0. The cabin's remaining brightness is not a probe-placement problem.
- **Size doesn't matter.** 64, 128 and 256 px give the same numbers to 0.1, because every surface that reads these probes is rough (the disc is r 0.73) or sees them only through a hit's lobe.
- **Recommendation for carConcept:** `carProbes=wheels` at `carProbeRes=64` could be the scene's default. It fixes what W54 flagged on the wheels, at 1 MB, +0.8 ms and +14 ms of bake. The cabin probe is not worth a slot. That is the maintainer's call. **No default is changed here**, and nothing in the package changed.

## The setting

- **`carProbes`**: `off` | `wheels` | `cabin` | `both` | `cabinGlass`.
  - Default `off`, which changes nothing.
  - `cabinGlass` is the experiment that grows the cabin to the paint, so it takes in the glass.
  - Probes group, `apply: 'rebuild'`, ours only. In `docs/SETTINGS.md`.
- **`carProbeRes`**: 64 | 128 | 256 (page default 128). It sets the face size of the car probes; the stage probe keeps `probeRes` (256). Any value other than the stage's makes a second atlas.
- **`?carProbeCapture=noWheels`**: URL-only experiment. It leaves the wheels out of every capture (`bake({ exclude })`).

The code is in `examples/showcase/src/carProbes.ts`. It is called from `compare/ours.ts` next to the scene's own probes.

## Placement: from the geometry

Every box is computed when the scene is built (about 440 ms of CPU, once), from the car as `stage()` places it: scaled to 4.6 m and turned by -1.0 rad.

- **Wheels.** Start from each wheel group's world bounds (`WheelFrontL` etc.: rim, tyre, disc, caliper). Lift the bottom by 2% of the wheel's height, so the floor stays on the stage probe. Then shrink face by face until no exterior-body point is inside. Exterior-body points are every vertex and triangle centroid of the paint, mirror and glass materials.
  - The arches' paint is never in a wheel box.
  - The wheel well (`BodyUnderside`, metal r 1.0), the tyre, disc and caliper are inside it.
- **Cabin.** Grow from the seats' centre, one face at a time in 1 cm steps, until the next step would take in a glass or paint point. The bottom never goes below the floor mats.
  - The glass is matched by transmission or by material name, so `?glass=black` doesn't move the box.
  - `cabinGlass` grows against the paint only.
- **Capture point.** Of a grid of candidates in the box, take the one farthest from every vertex of the car. For a wheel, the candidates must also lie within 0.85 R of the axle (in the wheel's own frame), so the capture sits inside the wheel, not in the air beside it.
- **Blend distance:** 10% of the box's shortest side (3-6 cm).

Resulting boxes (world, m):

| probe | size | blend |
|---|---|---|
| WheelFrontL | 0.72 x 0.72 x 0.32 | 0.032 |
| WheelFrontR | 0.70 x 0.73 x 0.33 | 0.032 |
| WheelRearL | 0.74 x 0.69 x 0.60 | 0.060 |
| WheelRearR | 0.70 x 0.71 x 0.59 | 0.059 |
| cabin | 1.15 x 0.98 x 1.22 | 0.098 |

**Rotation is the limit.** Probe volumes are world-axis-aligned boxes; #35046 and ours ignore rotation (D3701).

- The front wheels happen to be steered square to the world axes, so their boxes are nearly the tyre's bounds.
- The rear wheels and the cabin are turned 57 degrees. The rear wheels' boxes are the tyre's world bounds less the corners where the side skirt comes in.
- The front tyres' far edge falls outside the box (box x max -0.318 vs tyre -0.228): the skirt behind the wheel enters the wheel's world bounds there. So the outer 9 cm of each front tyre reads the stage probe, and a faint vertical step in the tyre's specular shows where the box ends. It is visible in probes-only (`arch-seams.jpg`, `wheel-interior.jpg`) and barely visible with SSR + RT.
- An oriented box (UE box captures, HDRP influence volumes) would fit both.

**Nesting with the stage probe works as is.** The lookup walks volumes smallest first, each taking `clamp(inside / blend)` of the weight left (D58). So every small box wins inside itself and fades to the stage probe over its blend distance. No priority or tuning was needed.

**Seams.** No seam shows on the body: the paint around the arches is outside every box by construction (`arch-seams.jpg`, front and rear). W50's `lip`, `band` and `door` are unchanged to 0.1 (92.9 / 35.3 / 109.8). The one seam is the tyre edge above. The floor is outside the boxes; its reflection of the wheel gets darker through the hits, as it should.

**Glass.** A probe set cannot keep a material on the outer probe: the smallest box containing P wins for every material at P, and there is no per-material or per-layer probe mask (D3702).

- So the cabin box has to sit inside the glass. It does: `glass=black` (the glass's own reflection) reads 121.9 / 0.8 with `cabin` or `both`, the same as off (PT 121.7).
- `cabinGlass` (the box takes in the glass) gives 119.8 / 2.8: the regression the maintainer expected.

**Wheels don't move.** The showcase and the bench don't spin or steer them; the scene is static, so one bake is right. A spinning wheel would only rotate geometry inside the box: the box (the wheel's bounds) and the capture point stay put. A re-bake per frame (the wheel probes alone, `bake({ probes })`, 1 bounce) would be needed only for the capture to follow the spokes, about 7 ms for the four wheel probes (from the bake times below: about 1.8 ms per probe per bounce). A steered wheel changes the box; with axis-aligned boxes that means re-placing it.

## Capture

The wheel probe sees, from inside the wheel:

- the back of the spokes and the rim barrel;
- the disc and caliper;
- the tyre's inside;
- the dark well above;
- the studio only through the gaps between the spokes.

That occlusion is what darkens the interior, so the wheel should be *in* its capture.

- **`bake({ exclude })` is not needed; it hurts.** With the wheels excluded (`?carProbeCapture=noWheels`, set-wide), the hub reads 40.8 (vs 27.0), `wheelFace` 43.4 (vs 30.0) and the floor-reflected wheel 47.3 (vs 32.7), back near off. The capture then sees the open side of the wheel.
- **Bounces don't matter.** `bounces=1` gives the same hub, `wheelFace` and `floorWheel` as 2 (27.0 / 30.0 / 32.8). The interior is rough, and what it sees is lit mostly by direct light and the environment.

## Numbers

### Bench Measure

Bench Measure: `bench.html?scene=carConcept&pose=w50`, ours-rt (the bench defaults: AA on, RT on @pmndrs/bvh, FFX denoiser), the PT at 16 spp + OIDN, the mean of 8 frames after 48. Values are luma / MAD vs the PT. `docs/research/w55/measure-*.json`.

**1280 x 1280, W54's regions**

| carProbes | frame (PT 123.7) | hub (28.1) | wheelFace (36.4) | cabin (123.7) | floorWheel (32.1) |
|---|---|---|---|---|---|
| **off** | 125.5 / 10.5 | 44.0 / 24.8 | 42.9 / 18.1 | 136.0 / 13.5 | 47.5 / 26.2 |
| wheels 128 | 123.1 / 10.7 | **27.0** / 19.8 | 30.0 / 17.6 | 135.9 / 13.5 | **32.7** / 23.3 |
| cabin 128 | 125.4 / 10.5 | 44.0 / 24.8 | 42.9 / 18.1 | 134.7 / 13.2 | 47.5 / 26.2 |
| both 128 | 122.9 / 10.6 | 27.0 / 19.8 | 30.0 / 17.6 | 134.7 / 13.2 | 32.7 / 23.3 |
| both 64 | 122.9 / 10.6 | 27.0 / 19.8 | 30.0 / 17.6 | 134.7 / 13.1 | 32.7 / 23.3 |
| both 256 | 122.9 / 10.6 | 27.1 / 19.8 | 30.1 / 17.6 | 134.7 / 13.2 | 32.8 / 23.2 |
| cabinGlass | 125.3 / 10.4 | 44.0 / 24.7 | 42.9 / 18.1 | 133.0 / 12.7 | 47.5 / 26.2 |
| both + `specOcc=1` | 122.7 / 10.5 | 26.2 / 20.1 | 28.5 / 17.5 | 134.7 / 13.2 | 32.7 / 23.3 |
| off, `t.hitSpecular=0` | 118.3 / 13.6 | 32.3 / 22.6 | 34.4 / 16.7 | 134.8 / 12.4 | 37.6 / 21.5 |
| both, `t.hitSpecular=0` | 116.4 / 14.0 | 16.2 / 21.1 | 23.0 / 18.7 | 133.6 / 12.3 | 28.0 / 22.8 |
| wheels, `bounces=1` | 123.1 / 10.7 | 27.0 / 19.8 | 30.0 / 17.6 | 135.9 / 13.5 | 32.8 / 23.3 |
| wheels, wheels excluded from captures | 125.7 / 10.8 | 40.8 / 23.8 | 43.4 / 19.5 | 136.0 / 13.5 | 47.3 / 28.2 |
| probes only, off | 149.1 / 31.8 | 57.5 / 36.2 | 60.6 / 34.4 | 136.0 / 13.6 | — |
| probes only, both | 147.4 / 32.0 | 21.8 / 28.8 | 40.1 / 34.0 | 134.8 / 13.2 | — |

**Glass isolation (1280 x 1280, ours-rt, `cabin` region)**

| | `glass=black`: the glass's reflection (PT 121.7) | `glass=hidden`: the cabin (PT 29.8) |
|---|---|---|
| off | 121.9 / 0.8 | 68.5 / 43.8 |
| cabin | 121.9 / 0.8 | 64.6 / 46.3 |
| both | 121.7 / 0.8 | — |
| cabinGlass | 119.8 / 2.8 | 63.1 / 47.7 |

**960 x 540, W50's regions** (they are defined at 16:9)

| carProbes | frame (PT 148.2) | lip (74.0) | band (5.1) | wheel (24.6) | door (118.8) | car (104.8) |
|---|---|---|---|---|---|---|
| **off** | 150.4 / 7.9 | 92.9 / 41.7 | 35.3 / 30.5 | 44.0 / 28.9 | 109.8 / 14.1 | 107.6 / 15.0 |
| wheels 128 | 149.0 / 8.0 | 92.9 / 41.7 | 35.3 / 30.5 | **24.6** / 25.4 | 109.8 / 14.1 | 104.3 / 14.6 |
| cabin 128 | 150.4 / 7.9 | 92.9 / 41.7 | 35.3 / 30.5 | 43.9 / 28.9 | 109.9 / 14.1 | 107.6 / 15.0 |
| both 128 / 64 / 256 | 148.9 / 8.0 (256: 7.9) | 92.9 / 41.7 | 35.3 / 30.5 | 24.6 / 24.5 / 24.7, MAD 25.4 | 109.8 / 14.1 | 104.3 / 14.6 |

### Material masks

From W54's masks (`masks.js`, the same camera); one 48-frame shot each, against the PT at 8 spp + OIDN.

| config | hub: Rim2 chrome (PT 50.5) | wheel: disc / caliper / mechanical (PT 18.0) | rim1: spokes, lip (PT 29.3) | glass (PT 103.8) |
|---|---|---|---|---|
| **off** | 100.0 / 58.1 | 53.1 / 36.3 | 32.4 / 16.5 | 120.5 / 17.6 |
| wheels 128 | 74.8 / 43.9 | 26.6 / 27.0 | 20.5 / 14.5 | 120.2 / 17.3 |
| cabin 128 | 100.0 / 58.1 | 53.1 / 36.4 | 32.4 / 16.5 | 118.6 / 16.3 |
| both 64 / 128 / 256 | 74.8-75.0 / 43.9 | 26.5-26.8 / 27.0 | 20.5 / 14.5 | 118.3 / 16.0 |
| off, `t.hitSpecular=0` | 80.7 / 52.2 | 58.9 / 41.8 | 25.6 / 14.8 | 122.7 / 19.7 |
| both, `t.hitSpecular=0` | 51.8 / 41.3 | 30.9 / 28.2 | 15.6 / 16.8 | 120.6 / 18.2 |
| probes only, off / both | 108.7 / 42.9 | 49.4 / 23.9 | 38.6 / 12.9 | 118.5 / 116.6 |

### How much of D3681 (the hub) the probes close

The probes reach the hits too.

- Traced hits are shaded from the set at the hit point (D3510, every atlas since W47).
- Screen-space hits are re-shaded the same way (D3540).

So a hit on a spoke now takes its specular from the wheel's own capture, not the studio.

| measure | off | wheels | PT | gap closed |
|---|---|---|---|---|
| hub rect | 44.0 | 27.0 | 28.1 | all of it (1 under) |
| floor-reflected wheel | 47.5 | 32.7 | 32.1 | 96% |
| chrome px (the star) | 100 | 74.8 | 50.5 | half |

- **What is left on the star.** It is mirror-smooth and still reflects the spokes' outward faces. Those really do face the open studio, and their wide lobe (r 0.4) is shaded from a capture that sees the studio through the gaps. With `t.hitSpecular=0` as well, the star reads 51.8 (PT 50.5) but the hub rect drops to 16.2. So the remainder is lobe-wide visibility at the hits, D3681's other half, and the probes don't replace it.
- **The rest of the wheel.** `wheelFace` goes from 6.5 over to 6.4 under the PT (30.0 vs 36.4), and rim1 from 32.4 to 20.5 (PT 29.3): the wheel probe is somewhat darker than the PT's wheel.

### Cost

1920 x 1080, ours-rt and probes only, the render loop stopped (`bench.html?manual`, one method on both sides). Frame = wall ms per GPU-synced frame (frame + `onSubmittedWorkDone`), the median of 60, configurations interleaved 3 times. Bake = a live re-bake, GPU-synced, 2 bounces, the median of 5. Memory is computed (rgba16f, 6 faces, full mips: 4.19 / 1.05 / 0.26 MB per cube at 256 / 128 / 64). `docs/research/w55/scripts/timing.js`.

| carProbes | volumes (lookup) | atlases | frame ours-rt | frame probes only | bake | probe memory |
|---|---|---|---|---|---|---|
| off | 1 (unrolled) | 256 | 12.6 | 5.3 | 5.3-5.9 ms | 8.4 MB |
| cabin 128 | 2 (unrolled) | 256 + 128 | 12.8 (+0.2) | 5.4 (+0.1) | 9.1-9.8 | +1.0 |
| wheels 128 | 5 (grid) | 256 + 128 | 13.4 (+0.8) | 5.8 (+0.5) | 19.2-19.6 | +4.2 |
| both 128 | 6 (grid) | 256 + 128 | 13.4 (+0.8) | 5.8 (+0.5) | 23.5-23.9 | +5.2 |
| both 64 | 6 (grid) | 256 + 64 | 13.3 (+0.7) | 5.8 (+0.5) | 21.9-22.0 | +1.3 |
| both 256 | 6 (grid) | 256 | 13.3 (+0.7) | 5.7 (+0.4) | 24.1-24.7 | +21.0 |

- **Frame.** The +0.5-0.8 ms is the lookup, which three runs in every lit material and in the composite. Past 4 volumes it switches from the unrolled walk to W63's grid walk (D4950): W63 measured 0.54-0.62 ms at 4 volumes and 0.70-0.72 ms at 8 on rooms. The atlas size makes no difference.
- **Bake.** It grows with the probe count, not the size: about 3.5 ms per probe for 2 bounces at 64-256 px.
- **Placement.** Example-side, about 440 ms of CPU once at build (the shell test and the clearance search, brute force over the car's vertices). A library helper would want a spatial index.

## Crops (`docs/research/w55/`)

- `hub.jpg`: off / wheels+cabin 128 / PT.
- `wheel-interior.jpg`: off / both / PT, probes only off / both (the worst case for seams), off with `t.hitSpecular=0`.
- `arch-seams.jpg`: the front arch and the tyre's far edge; `rear-wheel.jpg`: the rear arch.
- `cabin.jpg`: off / cabin / cabinGlass / PT, with the glass on and hidden.
- `full.jpg`: the frame, off / both / PT.

## What the small scene taught about mixed-size sets

- **Limits.** A 256 stage probe plus 128 (or 64) interior probes is two atlases. It drew with no validation error on the bench's limits; W62's shared atlas nodes mean the second size costs one sampled texture per lit material. At 256, the small probes share the stage's atlas and the set stays one binding. With 64 / 128 / 256 indistinguishable here, a single size would have done.
- **Blending.** Nesting needs nothing. The smallest-first walk (D58) gives each small box full weight inside its blend band and hands back to the outer probe at its faces, with no priority field. The hard part is the shape, not the weights:
  - axis-aligned boxes can't follow a turned car (D3701), so a box either reaches onto the body or leaves part of the tyre out;
  - nothing lets one material skip a probe (D3702), so the cabin box has to stay inside the glass.
- **Grid.** At 5-6 volumes the lookup takes W63's grid walk. The grid spans the union of the influence boxes, here the stage's 65 m floor box, so its at most 4096 cells are about 1.6 m wide: larger than the 0.3-1.2 m car boxes. Each cell near the car lists the stage plus one to three car boxes, so a pixel walks at most about 4 volumes. That is cheap, but it is D4950's "too large for 4096 cells" case in small form. Many small boxes inside one large outer box get no culling finer than the outer box allows; a two-level grid, or a grid over the small boxes alone, would fix that if it ever costs.

## Not done / next

- **Cabin.** Three's cabin lighting stays bright (68.5 -> 64.6 vs PT 29.8 with the glass hidden). A probe can't fix it while the box has to stay inside the glass, and even a box that takes in the glass reaches only 63.1. Next: what lights the seats in three (diffuse IBL through the probe's irradiance, the key light) vs the PT, and W54's other suggestion, AO on three's diffuse.
- **Lobe-wide visibility at hits** (D3681) is still the fix for the chrome star's remaining half.
- **Oriented probe volumes** (D3701) would remove the tyre seam and let the rear wheels and the cabin fit.
