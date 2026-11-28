# W107: lobe occlusion for traced hits' specular (T14)

T14, decision 20: a traced hit's own specular lobe took at most one visibility ray, along its mirror direction R (D3513, D3640). Inside closed spaces the rest of the lobe read the probe as if nothing blocked it. That made the floor under carConcept too bright, the hub too bright and the reflected wheels too bright (D3681, W54, W56).

**Result:** the lobe occlusion is built as an option, off by default. It moves every carConcept region toward the path tracer (PT), most of all the floor under the car (22.3 to 7.3, PT 3.4). It costs +0.54 ms at 1080p with 2 rays. It also raises the car's flicker metrics by about 5 %, and removing the hits' specular entirely raises them more, so the rise comes from the darkening itself. Under the flicker rule the default stays off. That is a call for the lead (below).

## The option

`traceSettings.hitLobeOcclusionRays` (core `TracedReflectionsSettings`; three passes its `traceSettings` through; Babylon and pixi have no traced pass) takes 0 (off, the default) up to 16. A value of 1 runs as 2. `traceSettings.hitLobeOcclusionLength` is the ray length as a multiple of the hit's camera distance, default 0.3 (`DEFAULT_HIT_LOBE_OCCLUSION_LENGTH`).

Ways to set it:

- the bench: `t.hitLobeOcclusionRays`, `t.hitLobeOcclusionLength`;
- the showcase: `?lobeOcc=<rays>`, `?lobeOccLen=<k>`.

How it works (`packages/core/src/trace/hitShading.ts`, `hitLobeVisibility`):

- **Rays.** It sends N any-hit rays over the hit's own GGX lobe and multiplies the lobe's radiance (the probe or environment along R) by the weighted share of rays that leave the hit unblocked. It goes through the pass's shadow query, `traceLightVisible`, with a finite length. A blocked ray adds nothing (no second bounce, as D3513).
- **The pattern.** The half vectors come from the GGX distribution at the hit's own alpha: u is stratified, (i + 0.5) / N, and phi steps by the golden angle. The pattern is fixed: every pixel and every frame uses the same one, so it adds no noise. Its frame is tied to the plane of incidence, with phi 0 toward R's tangent part, so the pattern follows the geometry smoothly. Directions below the surface are skipped.
- **Weights.** Each ray weighs G1(L) x VdotH / NdotH, its share of the split-sum integral under GGX sampling.
- **It only darkens.** The result is the minimum of this share and D3513's ray along R.
- **When it skips.** It is skipped when that ray already left nothing (a blocked lobe below roughness 0.3). It is also skipped for lobes narrower than perceptual roughness 0.25, where the ray along R stands in for the lobe. The clear coat takes the base lobe's share only when the coat is itself that wide.
- **Where it applies.** It runs wherever D3513's BVH ray does: hits shaded from the BVH's material (off-screen), and on-screen re-shades with `hitShadeVisibility: 'all'`. Screen-space hits have no BVH and are untouched. The trace pass sets two private variables (`hitLobeOcclusionRays` and `hitLobeOcclusionLength`, in `HIT_WGSL`) before it shades. Any other pass that compiles the same hit shading (the SSSR intersect pass, `examples/nrc`) leaves them at 0, so its shader is unchanged.
- **Parameters.** RT params words 67 and 79 were free; the size is unchanged.

### Why rays and not a cone

The providers only answer ray queries (`traceAny`, `traceFirstHit`). A cone or sphere test against the BVH would need a new traversal in every provider (@pmndrs/raytracer and the engines' wrappers), and it gives a binary overlap, not a visible fraction. The depth-buffer march (D3642) misses what the camera doesn't see, and the underside is exactly that.

A fixed pattern was chosen over per-pixel jitter for the maintainer's rule: blur or bias over flicker. Jitter turns a step into noise that the denoiser and AA must average while the camera moves.

## Numbers

All Measure numbers are from the bench: ours-rt against the PT (16 spp + OIDN), the mean of 8 frames after 48. Each cell is display luma / MAD. carConcept runs without wheel probes (W102's default) unless the row says so. Data is in `data/`.

**carConcept w50, 1280x1280** (W54's regions plus W50's band, the floor under the car):

| config | frame (PT 126.2) | band (3.4) | hub (27.1) | floorWheel (30.1) | wheel (39.7) | wheelFace (35.9) | car (101.3) |
|---|---|---|---|---|---|---|---|
| off | 125.0 / 13.2 | 22.3 / 19.0 | 41.5 / 25.4 | 47.5 / 28.1 | 46.2 / 28.2 | 41.2 / 19.4 | 99.7 / 19.2 |
| 2 rays | 123.7 / **12.5** | **7.3 / 9.4** | 39.6 / 24.1 | 42.1 / 24.3 | 42.7 / 25.8 | 38.3 / 17.1 | 97.4 / 17.5 |
| 4 rays | 123.4 / 12.5 | 6.6 / 9.1 | 39.1 / 23.8 | 42.0 / 24.2 | 42.5 / 25.9 | 37.6 / 16.8 | 97.0 / 17.5 |
| 2 rays + vis all | 123.4 / 12.3 | 6.5 / 8.7 | 38.9 / 23.8 | 40.3 / 23.0 | 40.9 / 24.5 | 37.8 / 16.9 | 96.7 / 17.1 |
| `t.hitSpecular=0` | 118.3 / 16.2 | 5.0 / 7.6 | 30.8 / 24.0 | 38.9 / 23.0 | 37.9 / 25.6 | 33.1 / 18.1 | 95.7 / 17.1 |
| wheels | 122.5 / 13.2 | 22.3 / 19.0 | 25.2 / 20.5 | 32.5 / 24.1 | 36.8 / 27.8 | 28.5 / 18.8 | 94.5 / 18.4 |
| wheels + 2 rays | 121.4 / 12.7 | 7.2 / 9.3 | 24.2 / 20.0 | 30.2 / 23.1 | 34.3 / 26.4 | 26.9 / 18.0 | 93.1 / 17.7 |

- 8 rays match 4 to within 0.5.
- Lengths 0.1 and 1 are within 1.7 of 0.3.
- The lip, the door and the cabin move 0.7 or less.
- 1 ray is the same as off, because its single direction lands below the surface on the car. That is why 1 runs as 2.

**carConcept w50, 960x540** (W50's regions):

| config | band (PT 3.9) | wheel (23.8) | car (106.2) | frame MAD |
|---|---|---|---|---|
| off | 40.1 / 36.3 | 43.8 / 31.4 | 107.3 / 17.3 | 9.6 |
| 2 rays | 17.0 / 18.1 | 36.1 / 25.6 | 104.6 / 15.2 | 8.9 |
| 4 rays | 15.9 / 17.8 | 36.3 / 25.6 | 104.3 / 14.9 | 8.9 |

**T53 scenes and Sponza, 960x540:**

- plateFloor: plateRefl (PT 174.0) 179.2 / 4.9 becomes 177.6 / 4.0 with 4 rays; underPlate (168.8) 177.4 / 8.1 becomes 176.5 / 7.1.
- cubeFloor: no change.
- edgesFloor: panelRefl 156.1 / 9.6 becomes 156.4 / 9.7.
- Sponza hero: the frame is unchanged; glossy MAD 17.2 becomes 17.1.

**What stays.** The hub keeps most of its excess without the wheel probes (39.6 vs 27.1). About half of its pixels are screen-space hits, and on-screen traced hits take no BVH ray by default (D3542), so the rays can't reach them. The wheel probes (T21, `?carProbes=wheels`) do that part, and the two add up.

## Flicker

`pnpm check -- --only flicker` (`scripts/flick.sh`) was run in this worktree with the loop stopped:

- 8 scenes: contact and mirrorWall with `rt=1`, the T53 scenes, carConcept w50 and hero, and Sponza hero, all as ours-rt;
- FLICKER_REPEAT 2;
- both orders (off then 2 rays, then 2 rays then off), plus two runs for 4 and 8 rays on the plate and the car;
- compared with `scripts/flicker-compare.py`. Bench repeats are deterministic: the spread is 0 on most metrics.

Rises above noise (off vs the option):

| metric | 2 rays | 4 rays | 8 rays | `t.hitSpecular=0` (control) |
|---|---|---|---|---|
| carConcept w50 wheel, orbit std (spread 2.1 %) | +5.2 % | +5.9 % | +5.1 % | +6.2 % |
| carConcept w50 car, 2x2 ratio | +4.5 % | +9.0 % | +6.9 % | (-) |
| carConcept hero reflection, 2x2 ratio | +15.3 % | +15.9 % | +14.2 % | +38.7 % |
| plateFloor underPlate, drift (spread 3.1 %) | +8.6 % | +7.9 % | +5.6 % | +33.8 % |
| plateFloor reflection, 2x2 ratio | +6.5 % | +4.6 % | +3.6 % | +10.6 % |

Falls: carConcept rest drift drops 4-18 % in every region with the option (hero reflection 0.285 to 0.245, w50 wheel -13 %), and w50 reflection 2x2 drops 16-18 %. The cube, the edges, Sponza, mirrorWall and contact stay within noise.

**Reading.** The rises don't depend on the ray count, so they are not the fixed pattern stepping. The control (`t.hitSpecular=0`, the same regions darker by removing the hits' specular) raises the same metrics as much or more. The rise comes from the darkening: a darker underside and tyre beside the lit floor make more contrast for the same motion. The PT's image has that contrast too.

## Cost

`rt trace` at 1920x1080 with AA off and the loop stopped, from pass timestamps. Each round is the median of 20 frames, rounds interleaved, on a quiet GPU (load average about 3, no other agent's Chrome running).

| scene | off | 2 rays | 4 rays | vis all | 2 rays + vis all |
|---|---|---|---|---|---|
| carConcept w50 (8 rounds) | 4.25 | 4.79 (+0.54) | 5.12 (+0.86) | 4.51 (+0.26) | 5.57 (+1.32) |
| Sponza hero (5 rounds) | 0.93-0.99 | 1.28 (+0.32) | 1.50 (+0.55) | | |

**Tried and dropped:** skipping the rays where the lobe is under 2 % of the hit's outgoing light (blended smoothly up to 6 %). It saved nothing: carConcept's paint has a clear coat and its tyres are dominated by specular, and Sponza measured 1.282 with the skip vs 1.277 without. The ray length (0.1 vs 0.3) didn't change the cost within noise.

## Recommendation

**Keep the default off.** The flicker rule forbids a default that raises a flicker metric, and 2 rays raise the car's wheel orbit std by 5 % and some 2x2 ratios. The quality case is strong, though:

- the floor under the car goes from 22.3 to 7.3 (PT 3.4);
- the frame MAD drops from 13.2 to 12.5;
- it is neutral elsewhere;
- it costs +0.54 ms at 1080p.

If the lead or the maintainer accepts darkening that is closer to the PT despite that rise (the PT itself has the contrast), the setting to use is **2 rays at length 0.3**. It is the cheapest that works; 4 rays gain at most 0.7 more. It could be on for carConcept in the examples, or a library default.

## Left over

- The hub's screen-space and on-screen traced hits have no BVH ray. That needs either the wheel probes or `hitShadeVisibility: 'all'`, which costs +1.32 ms with the lobe rays.
- A blocked lobe ray contributes black. A shade-the-blocker variant (D3513's revisit) would brighten the lip and car regions that now read slightly under the PT (car 97.4 vs 101.3).
- The SSSR re-shade could march its own lobe through the depth buffer (D3642's 8 steps per ray) for screen-space hits. This was not tried.
