# W110: material textures at traced hits (T18)

Since W97 a traced hit read its base colour texture. Everything else was one value per mesh: alpha-tested leaves and cards
traced as solid blockers (in reflections and in hit shadow rays), and roughness, metalness and emission were each map's
mean (D902).

**Result.** Three things can now be read per hit. The alpha test and the roughness / metalness maps are on by default
(the flicker runs found no rise on the existing scenes); emissive maps are opt-in (they raise carConcept's wheel-region
flicker 13 %, a maintainer call below):

- **Alpha test** (three's `alphaTest`, glTF MASK): rays pass where opacity x the base colour alpha (x three's `alphaMap`)
  is below the cutoff, in closest hits, hit shadow rays and every other ray of the walk. It uses @pmndrs/bvh's own hook,
  so @pmndrs/raytracer needed no change (below).
- **Roughness / metalness maps** (glTF metallic-roughness; three's two maps are combined into one texture when they differ).
- **Emissive maps** (`textures.emissive: true`).

Each has a switch (`textures.alphaTest`, `textures.roughnessMetalness`, `textures.emissive`); a switched-off texture
folds its mean into the factor, as before. Normal maps stay off (left in T18).

## How the alpha test works

@pmndrs/bvh's walk has a DXR-style any-hit hook: a triangle whose flags word has bit 0 set asks
`fn bvhTrianglePasses(candidate: BvhCandidate) -> bool` before it counts as a hit; `true` lets the ray through and leaves
the closest distance alone, so what lies behind is still found. The closest-hit and the any-hit walk both call it, and
unflagged triangles never do, so a scene pays only on the triangles that need it. @pmndrs/raytracer passes it through
(`rtModuleWgsl({ triangleFilter: null })`: the kernel declares its own).

`packages/core/src/trace/raytracer.ts`:

- `alphaTestPlan(scene, alphaTested)`: which triangles cut out. The candidate names the instance and the triangle, not
  the material, so the plan is a table of **runs**: an instance range x a triangle range -> the alpha-tested material
  (per-triangle materials of a multi-material mesh included). Consecutive instances of one mesh and material share a run
  (an InstancedMesh is one run). `flags`: per mesh tree, bit 0 on every triangle some instance draws alpha-tested
  (`triangleFlags`, given to the builders).
- `alphaFilterWgsl`: the lookup (up to 16 runs an if-chain of literals; more, two WGSL `const` arrays and a binary
  search: the arrays cost Sponza +0.35 ms, see Cost), the material record (`rtMaterial`; `alphaMode` must still be
  MASK, so `setMaterials` can turn it off or move the cutoff), the candidate's uv (`rtSurface` with `RT_SURF_UV`) and
  the base colour alpha at the finest level (`textures.alphaCone` > 0 reads a level from a fixed cone over the
  candidate's distance instead, through the texture frame).
- At most 1024 runs (`ALPHA_TEST_MAX_RUNS`, ~30 bytes of WGSL each); past that the rest trace solid, with a warning.

three (`hitMaterial.ts`, `traceSceneFromObjects.ts`): `defaultHitMaterial` passes `alphaTest`, `opacity` and a readable
`alphaMap`; `bvhTraceSceneFromObjects` multiplies the alphaMap's green into the base colour texture's alpha (or a white
texture's, without a map) on the CPU, as three's shader does per pixel.

## What @pmndrs/raytracer / @pmndrs/bvh would need (nothing blocks; for a cleaner version)

1. **The material in `BvhCandidate`.** The walk has it (`triangle.flags >> 16`, else the instance's); with it the run
   table and its 1024 cap go, and a material could become alpha-tested after creation (with
   `writeTriangleFilterFlags` on the scene's triangle buffer instead of a rebuild).
2. **A stock alpha-mask filter in @pmndrs/raytracer** (`rtAlphaPasses(candidate)` over the scene copy's MASK materials),
   so each engine adapter doesn't write one; the path tracer's `alphaMask` uses a closest-hit loop instead.
3. **Textured emitters as lights.** @pmndrs/raytracer leaves an emitter with an emission texture out of next-event
   estimation (found by BSDF sampling only), so with `textures.emissive` on, `raytracerHitShading` (opt-in) no longer
   samples carConcept's / toyCar's textured lights directly. A mean-weighted light record would keep them.
4. **A per-ray cone at the seam** (D5540, still): the level of detail comes from a fixed spread.

## Numbers

Measure (the bench): ours-rt against the path tracer (16 spp + OIDN), the mean of 8 frames after 48, 960x540, 8-bit
display, MAD over RGB. The frame barely moves (the options touch few pixels), so each row is also given over the pixels
the option changes (|on - off| > 2 in any channel: `scripts/changed-mad.py`). Data in `data/`.

### Alpha test

| scene / pose | changed px | PT luma | off luma / MAD | on luma / MAD | frame MAD off -> on |
|---|---|---|---|---|---|
| fenceFloor down (new scene) | 62175 | 137.6 | 149.3 / 20.40 | 151.3 / **15.49** | 19.64 -> 19.04 |
| fenceFloor hero | 11602 | 155.1 | 155.3 / 19.25 | 158.4 / **4.98** | 24.63 -> 24.31 |
| Sponza low | 3994 | 34.9 | 50.6 / 16.91 | 53.7 / 19.44 | 16.07 -> 16.11 |
| Sponza courtyard | 181 | 32.9 | 54.9 / 28.42 | 57.2 / 30.31 | 17.45 -> 17.45 |

- **fenceFloor** (`examples/shared/metrics/scenes.ts`, new): slats 1.2 m over the glossy floor (`alphaTest` 0.5, half
  the card cut out), an orange wall behind. At pose `down` both are above the frame, so their floor reflection is traced
  rays only. Off, the reflection shows a solid green card; on, the slats with the wall between them, as the PT
  (`data/fence/down-pt-off-on.png`, `hero-pt-off-on.png`).
- **Sponza**: its three MASK materials are the ivy, the flowers in the planters and the torch flames (no chains: they
  are opaque geometry). The polished floor sees them mostly through SSR (on screen), so few traced pixels change. Those
  that do (the ivy's reflection at `low`) get brighter through the gaps, while ours is already 16 luma above the PT on
  those pixels with the cards solid (the whole area under the ivy reads darker in the PT, not only its reflection), so
  their MAD rises. The alpha test is right there; the bias it adds to is not its own.
- The alpha cone barely matters at these distances: 0 and 0.005 give the same pixels, 0.05 is within 0.15 MAD. Default 0
  (the cheapest).

### Roughness / metalness and emissive maps

| scene / pose | option | changed px | off MAD | on MAD | notes |
|---|---|---|---|---|---|
| carConcept hero | rough / metal | 3086 | 32.59 | 31.12 | |
| carConcept w50 | rough / metal | 3479 | 27.89 | 25.81 | band 38.91 -> 37.72 |
| toyCar hero | rough / metal | 2912 | 42.55 | 35.91 | |
| chess hero | rough / metal | 258 | 32.17 | 31.38 | |
| Sponza courtyard | rough / metal | 153 | 24.56 | 23.12 | |
| Sponza low | rough / metal | 797 | 21.53 | 22.67 | the one rise |
| carConcept w50 | emissive | 8847 | 39.27 | **27.35** | wheel region 31.18 -> 24.03 (luma 43.5 -> 35.6, PT 23.8); car 17.45 -> 16.31; frame 9.70 -> 9.48 |
| carConcept hero | emissive | 3523 | 44.74 | 35.63 | |
| toyCar hero | emissive | 978 | 41.53 | 39.00 | |

Sponza and chess have no emissive maps.

## Flicker

`scripts/flick.sh` (`pnpm check -- --only flicker`, repeat 2, loop stopped), two runs: `ab1` (base = the W110 maps off,
then all on, emissive included; 8 scenes) and `ba1` (reverse order, plus emissive-only-off and roughness-metalness-only-off;
4 scenes). Bench repeats are deterministic (spread 0), so a change on a bench scene is the option's; the ssr page's
scenes move run to run. `scripts/flicker-compare.py`, `scripts/flicker-attr.py`; data `data/flicker-w110-*.json`.

| scene / region / metric | change from base | from what |
|---|---|---|
| carConcept w50 wheel orbitStd | +13.0 % (d2 +8.9 %, rest +6 %) | the emissive map alone: roughness / metalness + alpha -0.1 % |
| carConcept w50 car orbitStd | +3.5 % | emissive (+3.1 % with it, +0.3 % without) |
| toyCar hero reflection 2x2 ratio | +5.4 % | only with all three; without emissive -0.6 % |
| ssr contact reflection drift / 2x2 | run 1 +9 % / +6 %, run 2 -11 % / -6 % | page noise (configs that don't touch the scene move it as much) |
| ssr moving reflection 2x2 | run 1 +11 %, run 2 0 % (rmOff -20 %) | page noise |
| Sponza low / hero, chess hero | within 2.3 % | none |
| fenceFloor down reflection | +7-11 % (drift, orbit, d2, 2x2) | the alpha test: the slats' edges in the reflection (the solid card it replaces has none); content |

So the emissive map goes off by default, and the alpha test and the roughness / metalness maps stay on.

**Maintainer call (emissive maps).** On carConcept they move the traced pixels a long way toward the PT (changed px 39.3
-> 27.4 MAD at w50, 44.7 -> 35.6 at hero; the wheel region 31.2 -> 24.0, luma 43.5 -> 35.6 vs the PT's 23.8) at +13 %
wheel-region orbit flicker and +0.25 ms. Opt in with `textures: { emissive: true }` (bench `rtEmissiveMap`, pages
`?rtEmissiveMap=1`).

**The alpha test on fenceFloor** rises because the right image has edges the wrong one lacks. It is the only scene where
the alpha test changes the flicker metrics; it stays on (it removes visible wrong blockers). Revert with
`textures.alphaTest: false` if the maintainer reads that rise differently.

## Cost

GPU ms of 'rt trace' at 1920x1080, AA off, loop stopped, pass timestamps, median of 30 steps, 3 interleaved rounds
(`scripts/timing.js`; `data/timing-*.txt`). The base of one scene varies by up to 0.2 ms between runs.

| scene / pose | base (W97) | defaults (alpha + roughness / metalness) | + emissive |
|---|---|---|---|
| Sponza low | 1.465 | 2.032 (+0.57) | 2.041 |
| Sponza low, split (earlier run) | 1.649 | alpha alone 2.100 (+0.45), roughness / metalness alone 1.682 (+0.03) | |
| fenceFloor down | 1.196 | 1.231 (+0.04) | 1.444 |
| carConcept w50 (no alpha-tested material) | 4.982 | 5.029 (+0.05) | 5.277 (+0.30) |

The alpha test's cost is in the rays that reach flagged triangles: Sponza flags 34916 triangles (ivy, flowers, torch
flames; 6 runs), and the ivy is dense. The first version looked the runs up in two `const` arrays: +0.83 ms on Sponza;
the if-chain of literals took it to +0.44 (Tint may materialize a dynamically indexed `const` array per call).

**Memory** of the texture arrays with mips (GPU; `info.textureBytes`; `data/memory.txt`):

| scene | W97 (base colour) | defaults | + emissive |
|---|---|---|---|
| Sponza | 25 textures, 100.7 MB | 44, 180.4 MB (+79.7) | 44, 180.4 MB |
| carConcept | 2, 4.5 MB | 3, 5.5 MB | 4, 6.6 MB |
| toyCar | 1, 4.2 MB | 2, 8.4 MB | 3, 12.6 MB |

Sponza's +80 MB is its 20 metallic-roughness maps at 1024 (the base colour's cap; the task asked for the same arrays).
Their reads go through the 0.05 cone, so a 512 cap for data textures would cut that to ~20 MB at little visible cost:
left in T18.

## Left

- Normal maps at traced hits (D2901): `rtApplyNormalMap` with the texture frame's tangent would do it, at one more
  texture per material (Sponza: 20 more, ~80 MB) and more detail to flicker.
- A smaller cap for the data textures (memory, above).
- Blend transparency (`transparent` + opacity): still opaque at hits.
- The @pmndrs/bvh / @pmndrs/raytracer items above (material in `BvhCandidate`, a stock alpha filter, textured emitters
  as lights, a per-ray cone).
- Undrawn triangles (D3600) and the hit normal's side (D2901) are untouched.
