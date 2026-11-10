# Source survey: what the reference engines do (R2)

Status: 2026-11-10. Written against SPEC draft 3 and DIVERGES D1–D11. Facts are cited as `source, page/slide`. Local PDFs are cited by **PDF page**; Lagarde 2014 by printed page. "Verified" means read in the primary text or code; "unverified" means not found in an accessible primary source (said so inline). Nothing here is copied from the papers beyond short numbers and formulas.

Source keys: **idT8** = Sousa, idTech 8 GI, Advances 2025. **Lumen** = Wright et al., Advances 2022. **Snow** = Snowdrop RT, GDC 2024 (Avatar). **ACS** = AC Shadows RT GI, Advances 2025. **AMD-GR** = Eto et al., glossy reflections, SA 2023. **FFX** = FidelityFX SDK v1.1.4 (`sdk/include/FidelityFX/gpu/sssr/*`, `docs/techniques/stochastic-screen-space-reflections.md`, `samples/sssr`, `samples/hybridreflections`). **SSSR15** = Stachowiak and Uludag, SIGGRAPH 2015 notes. **Lag14** = Lagarde and de Rousiers, "Moving Frostbite to PBR", 2014. **Laz13** = Lazarov, Black Ops II, 2013. **Karis13** = Karis, UE4 PBR, 2013. **PICA** = Ray Tracing Gems ch. 25 (SEED PICA PICA). **RTG32** = Ray Tracing Gems ch. 32 (radiance caching reflections). **HDRP** = Unity HDRP 17 docs. **Godot** = Godot 4 docs/ProjectSettings.

## 0. SPEC claims that need fixing

| # | SPEC says | Finding | Verdict |
|---|---|---|---|
| S1 | idTech 8 uses octahedral maps only for irradiance volumes (§2) | idT8 PDF p21: octahedral atlas "similar to DDGI", RGB9E5 colour + RG16F visibility, 8x8 tiles (10x10 with borders), 2560x1585 for 6 cascades + max 100 local volumes, 64 MB (30 MB lower specs), 0.08 ms. Reflection probes are "BC6H cube map array" (p8, p27). | **Correct.** Add: 64 MB, and the 30 MB low-spec tier. |
| S2 | idTech 8 reflection probes are BC6H cube arrays, "box-projected, GGX-prefiltered by their own baker" | p8: "Box Projected Cube Map Env. Mapping [Czuba2010]… BC6H cube map array… cluster/tile binning" (that is the idTech 7 slide, "Past"). p27: still "BC6H cube map array + tile/clustered binning/light grid", "Dropped AMD's Cubemap Gen, re-implemented for baking performance (GGX filtering, multi-threaded, tile based)". Probe ids sit in the cascaded light grid (16^3 x 8 cascades, first cascade 32 m, 64 ids/cell, probes use 8-bit ids, p13). | **Correct**, but box projection is only shown on the idTech 7 slide; the idTech 8 slide says "similar to what we've been doing for the past decade". Cite it as inherited, not new. |
| S3 | idTech 8 specular order "SSR when possible, then RT, with fallback to probes based on smoothness" | p28: "Almost same as idTech7. SSR when possible then RT. Fallback to probes based on smoothness. RT uses own temporal upscale (1/2 res, 1/4 res). Ended up disabling on consoles for perf (~2 ms, ran out of time to optimize). Thresholded > min smoothness: only runs on very smooth surfaces. Ran out of time for more complex BRDFs." Notes: "SSR + Probes was always the fallback plan." | **Quote is accurate but misleading as a design target.** RT is the *optional, thresholded, shipped-off-on-consoles* layer, and only for very smooth surfaces. Rough pixels go straight to probes. SPEC's "SSSR, then traced, then probe" is right for smooth pixels; it must not read as "RT is the normal fallback for every glossy miss". |
| S4 | Probe re-fit uses `probeIrradiance` = "the probe's L1 SH" and cites Lazarov 2013 / Hobson 2019 as "the same normalization" (§1) | Laz13 uses **SH9 (L2, "tint + 9 scalars")** evaluated along the *surface normal* at the probe's capture point, divided out, then multiplied by the per-pixel irradiance (Laz13 "Improved environment map normalization"). The first Black Ops II scheme baked "divide by average irradiance" into the texels and failed on hemisphere-only encodings (lightmaps). idT8 p27 says only that it uses the frame irradiance "as a replacement term for the probe irradiance" and the formula; it gives no probe-side basis. Hobson 2019: GDC Vault is member-gated, slides not obtainable; **unverified**, so do not cite it for the formula. | **Fix**: L1 is our choice, not "the same as" Laz13. L1 irradiance in the normal direction is a coarse stand-in for SH9; measure. Drop or mark "unverified" the Hobson attribution. |
| S5 | Miss list is "ours; FFX has none" (§3, D7 "FFX SSSR has one compaction") | Plain `sssr` has one compaction. But FFX SDK v1.1.4 **`samples/hybridreflections`** does exactly the second compaction: `Intersect.hlsl` appends low-confidence pixels to `g_rw_hw_ray_list` with one wave-level atomic, `prepare_indirect_args_hybrid.hlsl` turns the counter into indirect args, and a deferred HW-RT pass consumes it. | **Wrong as stated.** The pattern is AMD's; our additions are the per-tile cap and the stored direction. Update D7 and the SPEC table. |
| S6 | Ray list entry is a "packed pixel coordinate (u32: 16 + 16 bits)" | FFX `UnpackRayCoords`: x = 15 bits, y = 14 bits, plus 3 flag bits (copy horizontal/vertical/diagonal) for quad ray sharing. The *denoiser tile list* is 16+16. | **Adjust**: we need the three copy flags (or an equivalent) for `samplesPerQuad < 4`. Supports 8k x 16k max only. |
| S7 | A miss "is any of: leaves screen, behind the depth buffer (thickness), runs out of steps" (§3 step 5) | FFX has no binary miss. `ValidateHit` returns a **continuous confidence** = screen-border vignette x (1 - smoothstep(0, thickness, view-space distance to surface))^2; zero for out-of-frustum, <2 px self-hit, background depth, and back-face hits. Radiance = lerp(env, scene colour, confidence). The hybrid sample turns this into a binary decision with `ssr_confidence_threshold = 0.9`. | **Add** back-face rejection, self-hit rejection, background rejection and the confidence blend; define the miss-list criterion as `confidence < threshold`. |
| S8 | "Hi-Z … goes full-rate for mirrors and quarter-rate for glossy" | FFX default `samplesPerQuad = 1` (a quarter of pixels trace, the rest copy), variance-guided tracing adds rays up to 4 per quad. Mirrors (alpha < 0.0001) always trace every pixel, always start at mip 0 and ignore the occupancy exit. Non-mirrors use `mostDetailedMip` (default 0). | **Roughly right**; state the 0.0001 test and that it runs on alpha (perceptual squared). |
| S9 | `roughnessThreshold` described without space (§3) | FFX compares against **alpha = perceptual^2** by default (`isRoughnessPerceptual` squares the input). Default 0.2 means perceptual ~0.447. Hybrid sample: 0.22 for both SSR and RT thresholds. | **Fix**: write threshold in the same space as our roughness input; 0.2 alpha = 0.447 perceptual. |
| S10 | "7-level min-depth pyramid (r32f)" | Verified: host makes `min(7, ceil(log2(max dim)))` mips, mip 0 is a copy and 6 are SPD-generated; traversal clamps to `DEPTH_HIERARCHY_MAX_MIP = 6`. **Reverse-Z uses max**, not min (`FFX_SSSR_OPTION_INVERTED_DEPTH`). | **Correct**; add the reverse-Z note. |
| S11 | Open question 4: "idTech's RT runs at 1/2 or 1/4" | Verified (idT8 p28). Same figure elsewhere: PICA half res (1/4 ray per pixel), Snow 1/4 on consoles, ACS half (width only), AMD-GR half. | **Correct.** |
| S12 | D3: "UE maps roughness to mip by `1 - 1.2*log2(r)` from the 1x1 mip" | UE source and docs not reachable from here; **unverified**. Lag14 eq. 63 and Laz13 are verified (below). | Mark unverified or verify against `ReflectionEnvironmentShared.ush` before the bench. |
| S13 | D3: Frostbite "by `sqrt(alpha)`-based lod" | Lag14 p68 eq. 63: `mip = sqrt(alpha_lin) * mipCount` (alpha_lin = perceptually linear roughness), first mip not pre-convolved. | **Correct.** |

## 1. Reflection probes

### 1.1 Capture, resolution, storage

| Source | What it does |
|---|---|
| idT8 | Hand-placed, baked after lightmaps in idTech 7; in idTech 8 "no need to wait for lightmap baking, just do it" (p27). BC6H cube-map array. Baker re-implemented for speed (tile-based, multi-threaded GGX). Binning: cascaded light grid, 16x16x16 x 8 cascades, probes get 8-bit ids, lights 16-bit (p13). |
| Lag14 §4.9.1, p61–68 | Distant probe (sky, refreshed on demand) plus local probes captured per volume; local probes baked, refreshed on demand, or per frame. 16-bit float cubes, 128^2 to 512^2, **256^2 minimum for smooth/mirror quality** (p68). Local capture stores an **alpha** (visibility of nearby surfaces) used to reject sky and drive blending (p74). Capture-point offset vector so artists can move it off geometry. |
| Laz13 | 256^2 on Black Ops, **128^2 on Black Ops II**, because max specular power 8192 blurs the top mips anyway. Resolution is tied to the maximum specular power. |
| Godot | Atlas `reflection_size` **256** (128 mobile), `reflection_count` **64**, `roughness_layers` **8**, `ggx_samples` **32** (16 mobile), `texture_array_reflections` true (array layers per roughness instead of mips; off on mobile). Probe default size 20 m cube, `update_mode` ONCE, `blend_distance` 1.0 m, `max_distance` 0, `interior` false, `box_projection` false, `origin_offset` (0,0,0). |
| HDRP | Resolution from quality mode (no default stated), "Range Compression Factor" divides the capture to avoid saturation, realtime modes: every frame / on enable / on demand / **time slicing over 7 frames**. |
| ACS | Dynamic *global* fallback cubemap **128x128, one face updated per frame** (terrain, sky, clouds, far entities), p73. Relightable local cubemaps are the low-end specular tier. |
| AMD-GR | Not cubes: 8x8 octahedral screen probes (radiance, not prefiltered), usable above roughness 0.2 (see §3). |
| idT8 irradiance (not reflection) | Octahedral atlas, RGB9E5. Slide aside (p26): "avoid R11G11B10F: colour shift/banding, no pure white"; "can every HW fully support RGB9E5 please". Relevant to the `rg11b10ufloat` row in the format axis. |

SPEC comparison: our `rgba16float` default (8 B/texel) matches Lag14's 16-bit float. A 128 px floor on the bench and 256 px for mirror-grade probes both have source support. WebGPU has no RGB9E5 storage format that is renderable or storage-writable (`rgb9e5ufloat` is sampled only), so idTech's irradiance-style format is unavailable to us; the idT8 warning argues against `rg11b10ufloat` for probes that carry bright lights. Add that to the bench's format notes.

### 1.2 Prefilter and roughness to mip

| Source | Samples | Mapping | Notes |
|---|---|---|---|
| Karis13 p5 | **1024** GGX importance samples per texel, weighted by NoL | not given | Assumes n = v = r (no stretch at grazing angles); split sum stores prefiltered colour in cubemap mips. |
| Lag14 p67–68 | **32**, with pre-filtered importance sampling (sample mip from `0.5*log2(omegaS/omegaP)`, clamped so mips never go below 8x8, to avoid cubemap filtering problems) | `mip = sqrt(alpha_lin) * mipCount` (eq. 63); first mip unfiltered; a linear mapping spreads mids better but blurs low roughness | Sample weights `NoL`; storage 128^2–512^2. Dominant-direction shift (below). |
| Laz13 | CubeMapGen cosine-power filter | `texCUBElod(R, nMips - gloss*nMips)`, i.e. **linear in gloss** | Blinn-Phong power divided by 4 for a Phong lookup. |
| FFX `SampleEnvironmentMap` | n/a (app supplies cube) | `mip = perceptualRoughness * log2(width)`, **linear in perceptual roughness**; classify passes `sqrt(alpha)`, intersect uses mip 0 | Env fallback at miss uses mip 0 (sharp), at rough pixels the roughness mip. |
| Godot | 32 (16 mobile) GGX samples | `roughness_layers` = 8 layers/mips | Sky and probes share the filter. |
| three r187 plan (SPEC/D3) | 256-sample filtered IS, last three levels 16 px full integrals | `lod = maxLod * r*(2 - r)` | |

Numbers for comparison, `lod/maxLod` at perceptual r = 0.1 / 0.25 / 0.5 / 0.75: Frostbite sqrt = 0.32 / 0.50 / 0.71 / 0.87; three `r(2-r)` = 0.19 / 0.44 / 0.75 / 0.94; linear (Laz13/FFX) = 0.1 / 0.25 / 0.5 / 0.75. Our mapping is closest to Frostbite in the middle, sharper at low roughness. The phase 1 brute-force reference should score all three on the same bake before D3 is closed.

Dominant direction (Lag14 p69, `getSpecularDominantDir`): `lerp(N, R, s*(sqrt(s)+r))`, `s = saturate(1 - r)`. Cheap, widely copied; SPEC does not mention it. Without it, rough lookups along `R` are too bright at grazing angles. Add it to the lookup.

### 1.3 Parallax / box projection, distance roughness

- **Lag14 §4.9.3, pp70–72 and Appendix F pp120–121:** two proxies, sphere and oriented box. Intersect the (dominant) ray with the proxy, use the far hit, subtract the capture offset, sample `localR - offset`. Because the cube was convolved from the centre, the corrected direction is **lerped back towards the original `R` as roughness rises** (`localR = lerp(localR, R, linearRoughness)`) to avoid discontinuities. Distance-based roughness: `alpha' = (distShadedToHit / distProbeCenterToHit) * alpha`, clamped to alpha, lerped back to alpha by roughness; exists so local probes match SSR at the seam (p72–73).
- **HDRP:** separate *Influence volume* (where the probe applies) and *Proxy volume* (parallax shape, must match shape type of the influence volume; "use influence as proxy" option). Distance Based Roughness reads the proxy (disable if the proxy does not match the room).
- **Godot:** box projection with `origin_offset`, `interior` flag drops sky.
- **idT8:** box-projected (Czuba 2010), p8.

SPEC comparison: our table has "influence, projection, blend, priority" but no distance-based roughness and no roughness-dependent projection blend. Both are cheap and are what makes the probe to SSR seam match. Add as lookup options.

### 1.4 Blending and priority

- **Lag14 pp73–74:** hierarchical, small volume to large. `RGB += probe.rgb * a; a = saturate(probe.a - Alpha)`; stops when accumulated alpha reaches 1; then the distant probe fills `(1 - Alpha)`. Per-probe fade: `smoothstep(saturate((extent - dist)/fadeDistance))` on the box boundary (App. F). Nesting gives artist-controlled refinement.
- **HDRP:** accumulates "until total weight is 1"; SSR has its own weight, probes have an editable *Weight*, sky is fixed weight 1; *Importance* sorts (higher draws on top); *Blend Distance* is an inward margin from box/sphere (per-face in advanced mode, deferred only).
- **Godot:** `blend_distance` 1 m, `max_distance`, intensity; probe count capped by the atlas (64).
- **idT8:** probes go in the world-space light grid; "decals/reflection probes pre-sorted" in the flat bit array (p13); "Re-fit environment probes on blended" for transparencies (p29).

SPEC comparison: our "blend & priority" should follow Lag14 front-to-back alpha accumulation (order-dependent, early out) rather than normalised weights; say which in the lookup spec. Weighted-average blending (Unity's older path, Godot) gives different seams.

### 1.5 Re-fit / normalisation

Formula in all sources: `reflection * irradianceAtShadedPoint / irradianceAtProbe`.
- **Laz13:** v1 baked `texel / averageIrradiance`; v2 keeps the map raw and evaluates SH9 at the *normal* in the vertex shader (about 8 VS instructions, 1 interpolator, 1 PS instruction, no measurable cost). Reason: hemisphere-only light encodings (lightmaps) cannot undo an average-irradiance bake.
- **idT8 p27 (and p29 for transparents):** `Reflections = (Reflections / Probe Irradiance) x Frame Irradiance`, frame irradiance from the irradiance volume (froxel SH-L1 volume for transparents: "2 band SH, 50 MB"). Purpose: no glowing corners, pick up bounce colour.
- **Hobson 2019:** unverified (see S4).
- Treat the relation as a clamp: the ratio is unbounded in dark probes; none of the sources gives a clamp, so we must choose one and log it.

### 1.6 Live vs baked, budgets

| Source | Budget |
|---|---|
| Lag14 | Static or dynamic per probe; capture-order dependency ("chicken and egg" when lit by other local probes). |
| HDRP | Time slicing over 7 frames; relative cost High (SSR), Medium-High (realtime probes), Low (baked, sky). |
| Godot | Once vs every frame (every frame is "costly"); 64 atlas slots. |
| ACS | 1 face per frame for the 128^2 global cube. |
| Our measured | 3 probes at 128 px bake 2.2 ms; frame at 960x540 probes only 2.9 ms (SPEC). |

## 2. Screen-space tracing

### 2.1 Hi-Z build and classification (FFX, verified in source)

- Depth hierarchy: mip 0 copy + 6 SPD mips = 7 levels, r32f, 64x64 texels per threadgroup (`depth_downsample.h`); min for forward-Z, max for reverse-Z. Traversal never goes past mip 6.
- Classify (`classify_tiles.h`), 8x8 groups, in order:
  1. `needs_ray = glossy (alpha < roughnessThreshold) && not background (depth < far)`.
  2. `needs_denoiser = needs_ray && !mirror (alpha >= 0.0001)`.
  3. `IsBaseRay` by `samplesPerQuad`: 1 keeps pixel (even x, even y); 2 keeps the diagonal; 4 keeps all. Mirrors always keep their ray.
  4. If variance-guided tracing is on, a non-base pixel also traces when last frame's luminance variance > `varianceThreshold` (sample default 0.0, so effectively any variance; documented range 0 to 0.01).
  5. Copy flags: lane^1 / ^2 / ^3 reads (quad ops) set `copy_horizontal/vertical/diagonal` so the base ray writes its result to the pixels that did not trace (1 spp: all three; 2 spp: horizontal).
  6. Wave ballot: `PrefixCountBits` + one atomic add per wave; 8x8 tile appended to the denoiser list if any pixel in it is glossy and reflective.
  7. Pixels with alpha >= threshold write `SampleEnvironmentMap(R, sqrt(alpha))` into the radiance target directly.
- Blue noise (verified): 128x128 R8G8, rebuilt per frame from a 256x256 Sobol and a 512x256 scrambling-tile table (Heitz et al.). Indexed by `pixel % 128`.
- Indirect args: `(rayCount + 31)/32` groups in the hybrid sample, 64-thread groups in sssr.

SSSR15 gives the older design: tile classification traces rays at **1/8 resolution** to estimate tile importance (hit anything, perceptual variance of hit values) and allocates between a user min and max rays per pixel; per-pixel switch between the **hierarchical tracer for smooth surfaces** and a **cheap linear marcher for rough ones** (may skip thin objects). FFX dropped the linear marcher and the per-tile ray allocation in favour of `samplesPerQuad` + variance feedback. SPEC follows FFX; OK.

### 2.2 Ray generation

- FFX: GGX **VNDF** sampling (Heitz 2018) in a TBN frame, `u` from the blue-noise texel, one sample per ray, no bias knob, no horizon re-generation; a `PERFECT_REFLECTIONS` define forces `n = (0,0,1)`.
- SSSR15: Halton (CPU-precomputed), re-generate rays below the horizon, optional **bias toward the mirror direction** `u.x = lerp(u.x, 1, bias)` (truncated distribution; PDF only changes by a constant, which the resolve re-normalises). PICA does the same ("bias our primary sample space… cancel some of this during filtering", p451) with Halton + Cranley-Patterson rotation, and picks the BRDF layer by approximate visibility.
- AMD-GR: GGX VNDF (Heitz 2018) too; also a diffuse fallback above roughness 0.6.
- ACS p64–66: GGX VNDF, ray length `maxDist*(1 - roughness^2 + 0.1)` (their notation), rays skipped (replaced by SH lookup) when roughness above a threshold or ray far from the mirror direction; 20–30 % saving on trace+light.

### 2.3 Traversal parameters (FFX)

| Parameter | Value | Source |
|---|---|---|
| `maxTraversalIntersections` | **128** (sample default; slider 0–256). Header: "most rays should terminate after about 20 lookups" | `ffx_sssr.h`, `sssrrendermodule.h` |
| `minTraversalOccupancy` | **4** (sample slider 0–32); hybrid sample 0. Exit when active lanes <= value; **mirrors ignore it** | `HierarchicalRaymarch` |
| `mostDetailedMip` | 0; mirrors forced to 0 | |
| `depthBufferThickness` | **0.015** (sample slider 0–0.03). Hybrid sample uses **0.2 + roughness*10 + rayLength*0.01** (`ssr_thickness_length_factor`) | `ValidateHit`, hybrid `Intersect.hlsl` |
| `roughnessThreshold` | **0.2** (on alpha); hybrid 0.22 | |
| `temporalStabilityFactor` | **0.7** (denoiser) | |
| `varianceThreshold` | 0.0 sample default, range 0–0.01 | |
| `samplesPerQuad` | 1 (sample), options 1/2/4; hybrid sample uses 4 | |
| ray offset | start `uv_offset = 0.005 * 2^mip / screenSize` past the cell edge to avoid self-hit | |

Traversal (verified): start with an initial advance to the first cell edge, then loop {read `surface_z` at current mip; intersect with x, y *and* the z plane (z only if the ray moves deeper); if the ray was above the surface and stopped at an xy edge, `skipped_tile` is true and mip +1, otherwise mip -1 }. It never descends below `mostDetailedMip` and the loop ends when the mip drops below it (hit) or iterations run out. Contrast with SSSR15's "stackless walk": same algorithm. Guard `valid_hit = (i <= max)`.

### 2.4 Hit validation and edge fades (FFX `ValidateHit`, verified)

1. Reject outside [0,1]^2.
2. Reject if |hit - uv| < 2 px in both axes (self reflection).
3. Reject background: depth at mip 1 equals far plane.
4. Reject back faces: `dot(normal at hit, worldRay) > 0`.
5. Confidence = `(1 - smoothstep(0, thickness, viewSpaceDistance(hit, surface)))^2`; thickness is a view-space *constant*, deliberately not distance-scaled ("avoid growing reflections towards the reflected objects"), though the hybrid sample adds length and roughness terms.
6. Edge fade: `fov = 0.05 * (h/w, 1)`, `border = smoothstep(0, fov, hit) * (1 - smoothstep(1 - fov, 1, hit))`; vignette = border.x*border.y. A 5 % screen fade.
7. Result `lerp(envMip0, sceneColor[hit], confidence)`; alpha channel stores world-space ray length (used by the denoiser for reprojection, matching PICA/SSSR15 reflection-depth reprojection).

SPEC delta: fade distance (5 %), squared confidence, 2 px self-hit and back-face tests need to be in the port; document `thickness` units (view space, 0.015). The SPEC's input "scene colour: last frame allowed" matches FFX docs ("current frame lit with direct lighting only") and PICA/AMD-GR/SSSR15 (previous frame, reprojected). Hybrid sample: `g_lit_scene_history` sampled at `hit - motion(hit)`, or an optional re-shade with the G-buffer (`HSR_FLAGS_SHADING_USE_SCREEN` off).

### 2.5 Resolution

- FFX sssr: full render size, `samplesPerQuad` reduces rays; the hybrid sample has `reflection_resolution_multiplier` 1.0 or 0.5 (half-res G-buffer) with a floor of 128 px.
- SSSR15: trace at half res, **resolve at full res** with 4 samples/pixel and BRDF-weighted ray reuse (`weight = localBRDF(hit)/hitPDF`, normalised), then temporal. PICA identical (1/4 ray per pixel, "similar to 16 rays/pixel"). AMD-GR: half res, 2x upscale in the à-trous filter; Lumen and others: see §3.
- Lumen p174: pipeline = generate rays by importance sampling the visible GGX lobe, trace, spatial reuse (BRDF reweighted), temporal accumulation, bilateral filter ("last-ditch", tonemapped weights, double strength on disocclusion).

SPEC comparison: FFX's resolve is the denoiser (spatial reuse inside it); our "denoise seam" matches. Open question 4 should be answered by FFX's own numbers: hybrid sample tests 0.5 res; AMD, PICA, ACS, idTech all ship half or quarter for the *RT* layer; screen-space tracing at full rate is cheap (Snow SS trace 0.22 ms on Series X for the reflection pass, p62).

## 3. RT fallback and the hybrid order

### 3.1 Who picks what, by which criterion

| Engine | Order | Criterion / threshold | Rays |
|---|---|---|---|
| **FFX hybrid sample** | SSR; RT if `confidence < 0.9` and not background; rougher than RT threshold goes to env | `ssr_confidence_threshold 0.9`, `rt_roughness_threshold 0.22`, `max_raytraced_distance 100 * exp(-roughness*5)`; ray origin = surface + normal * 3e-3 * |viewPos|, same direction as the march | Deferred HW ray list, hit-counter feedback per 8x8 tile for next frame's classify |
| **idT8** p28 | SSR, then RT, probes by smoothness | RT only above a min smoothness | 1/2 or 1/4 res + own temporal upscale; ~2 ms; off on consoles |
| **Lag14** pp73–74 | SSR (alpha) -> local probes small to large -> distant | SSR "failure heuristics: proximity to screen border, ray orientation, intersection type" | none |
| **HDRP** | SSR -> probe (in influence volume) -> sky -> black; RT: ray miss falls to probe -> sky | **Minimum Smoothness** (docs example 0.9): at or above, RT hierarchy; below, specular hierarchy only | |
| **Lumen** p183–186 | screen trace -> mesh SDF -> global SDF -> skylight (software); HWRT hit-lighting for reflections | rough 0.4–1.0 skip rays and resample the **screen radiance cache** (cost -50 to -70 %); glossy 0.3–0.4 shorten the ray and interpolate the **world radiance cache** on miss (-16 % on roads); 0–0.3 full trace | tile-based, z-order tile list; whole pipeline runs again for translucency/water |
| **Snow** pp41–46 | screen -> world RT -> light cache (probes) | `reflectionBlend = saturate((MaxReflectionRoughness - r) * InvFade)` weighs RT vs GI SH (>= 0.9 roughness = GI only; lerp from 0.7 per final composite notes); ray range from roughness: 50 m at r = 0.1 down to 5 m at 0.7, 0 above 0.9, min `2 x cacheSpacing` | quarter/half/full + **mixed-resolution per 16x16 tile**: quality < 0.02 -> 1/16, < 0.1 -> 1/4, < 0.2 -> 1/2 else full; quality from luma, variance, hit distance, roughness, specularity, blended 0.75 max/avg and 0.85 history; XSX 1440p total 2.9 ms (denoise 67 %) |
| **ACS** pp64–77 | screen march -> BVH (coarse, not all objects) -> radiance probe volume (nearest probe first) -> far cubemap | skip rays above a roughness threshold or far from the mirror direction (SH lookup instead) | half res (half width, full height), 3.8 ms PS5 Pro, 3.2 ms 4070 (1440p); 4 any-hit tests max |
| **AMD-GR** | rough > 0.2: screen-probe interpolation; <= 0.2: RT + hash-grid cache; > 0.6: diffuse | `r_rt = 0.2`, `r_diffuse = 0.6` | half res, 2x upscale; ~1 ms overhead at 1080p on 7900 XTX |
| **PICA** pp445–451 | RT only for reflections ("initial approach combined this with SSR, in the end we rely solely on ray traced reflections for simplicity and uniformity") | none | 1/4 ray per pixel, upsampled |
| **RTG32** | SSR matched by radiance cache probes; hits looked up in probe cubes with a depth/visibility test, proxy-intersection fallback | `RT_ROUGHNESS_THRESHOLD`: rough pixels sample the cache without tracing | |
| **SSSR15** | hierarchical vs cheap linear by roughness; SSR fallback is a cubemap | | |

Takeaways for SPEC §5 ("smoothness below threshold -> probe; otherwise SSSR -> traced -> probe -> env"):
- Every engine splits the roughness axis into at least three bands (mirror/smooth, glossy, rough). Their cut-offs, in the same (perceptual) space where known: FFX 0.447 perceptual (0.2 alpha), AMD-GR 0.2 / 0.6, Lumen 0.3 / 0.4, Snow 0.7–0.9 for RT to GI, HDRP min-smoothness 0.9 for RT. These are not comparable without checking whether each is alpha or perceptual; only FFX states it.
- The seam problem is documented: RTG32 ("mixing various techniques can lead to visible discontinuities"), Snow p64 ("SS and RT hits can differ vastly, low roughness surfaces need to be avoided"), Lag14 p72 (distance roughness exists to match SSR to probes), ACS p70–72 (reproject the hit onto the screen and use the G-buffer material when similar; do not reproject lighting). Our hit shading should take the G-buffer material when the hit is on screen.
- Ray budget policy in the sources is *tile-quality* driven (Snow 16x16, FFX 8x8 hit counters), not a global cap; ours is a per-tile atomic cap (D9). Reasonable; the hit-counter feedback (FFX) is a cheaper alternative to estimate how many rays to reserve.
- Hit shading: FFX re-shades with the G-buffer or reads the lit history; Lumen surface cache; ACS: direct light + one nearest radiance probe, **no reprojected lighting** (specular is view-dependent and differs on reuse, p77); AMD-GR previous frame colour when the hit was visible, else hash-grid cache with jittered lookup. SPEC's "probes at the hit + cheap direct" is consistent but should state the probe weight shortcut: ACS found that fetching the nearest probe only when its weight is high more than halves interpolation cost.

### 3.2 Ray origin and direction after the SSR miss

AMD hybrid sample (verified): origin = surface + `normal * 3.0e-3 * length(viewSpacePosition)`, direction = the sampled reflection vector from the SSR stage; i.e. matches D8. Snow p27: for GI, "if SS fails, start the ray from where the screen space left off"; its reflection pipeline is described as the same pipeline, but rays are generated fresh from the surface (p43, range per above), so treat Snow-reflections as unverified on this point. Lumen continues the *same ray* from the screen-trace end into the SDF traces (p46, "continue using short mesh distance field traces"). So D8's "vary" claim is true: Lumen and Snow-GI continue; FFX-hybrid and Snow-reflections restart.

## 4. Composition and specular occlusion

- **Split-sum:** all sources use `prefiltered * (F0*A + B)` (Karis13 p7 `IntegrateBRDF`, 1024 samples; Lag14 `DFG` texture 128^2; AMD-GR eq. split sum; Snow demodulates with `ColorMetalnessToDiffuseSpec` before denoising; ACS demodulates by the pre-integrated BRDF, p71). The Frostbite DFG texture is 2-channel (Gv(1-Fc), Gv*Fc) so f0 and f90 both enter: `preLD * (f0*dfg.x + f90*dfg.y)` (p70 Listing 24). SPEC's `F0*A + B` is the Karis form; same thing with f90 = 1.
- **Demodulate before denoising** (Snow p46–55, ACS p71, NRD): store radiance divided by the pre-integrated BRDF, multiply back after. Matches the `denoiser` repo's contract. Add to the frame contract: say whether the denoise seam receives demodulated or modulated radiance.
- **Compression for denoising:** ACS p72 uses `radiance * pow(maxChannel, 0.625 - 1)`; inverse with `1/0.625`; Reinhard x/(1+x) over-crushed highlights.
- **Specular occlusion:** Lag14 §4.10.2, p76: `SpecOcc = saturate(pow(NdotV + AO, exp2(-16*roughness - 1)) - 1 + AO)` (Gotanda/Lagarde), applied to probe light because AO is a cosine-lobe quantity and glossy lobes are narrower; motivation is probe light leaking (their Fig. 63). Frostbite also stores a micro-specular occlusion in the GBuffer. idT8 p29: **directional occlusion** (ray-marched average unoccluded direction, denoised) also feeds specular occlusion at composition. Lumen p89 names missing specular occlusion as the main flaw of the UE4 RT-reflection model with an unshadowed skylight. Godot: `specular_occlusion/enabled` true by default ("reduces reflections based on ambient light"). HDRP page: not covered by the fetched docs.
- Order of the composite per source: Lag14 sums SSR (alpha) + probes + distant by remaining alpha; HDRP weight-accumulates to 1 (SSR first); FFX writes a reflection target that the app composites over direct lighting ("SSSR takes care of indirect lighting, including environment fallback").

SPEC comparison: "Specular occlusion from the probe re-fit, or a cheap bent-normal / AO term" understates it. The re-fit (irradiance ratio) addresses *colour/intensity* mismatch, not occlusion of a glossy lobe. For probes the cheap, sourced option is Lag14's `SpecOcc(NdotV, AO, roughness)`; the better one is a bent-cone/directional term (idT8). Do not apply specular occlusion to SSR/RT hits (they already carry occlusion); Lag14 applies it to the IBL fallbacks only (inferred from §4.10.2's leaking motivation; not stated as a rule).

## 5. Proposed DIVERGES entries

Row format as in `docs/DIVERGES.md`. Ids are proposals; the lead may renumber. Status `open` unless the numbers already settle it.

| id | area | source does | we do | why | revisit when | status |
|---|---|---|---|---|---|---|
| D40 | SSSR / miss list | FFX `hybridreflections` v1.1.4 already appends low-confidence pixels (`confidence < 0.9`) to a deferred HW ray list with a wave atomic and indirect args. | Same pattern, plus a stored direction and a per-8x8-tile cap (D9). Corrects the "FFX has none" wording of D7 and SPEC. | We want the direction and cap; the structure is AMD's. | Phase 4 compares a stored direction against regenerating from the blue-noise index. | open |
| D41 | SSSR / hit validity | Continuous confidence: vignette x squared distance-to-surface falloff, with out-of-frustum, <2 px self-hit, background and back-face rejects; radiance = lerp(env, scene, confidence). | Port as is; the miss-list predicate is `confidence < threshold`. | Binary miss in SPEC loses the soft fade. | Visible popping at the SSR/RT seam. | planned |
| D42 | SSSR / thickness | `depthBufferThickness` 0.015 view-space; hybrid sample uses 0.2 + 10 r + 0.01 L. | Start at 0.015 constant, add the hybrid terms behind a flag. | Plain sssr has holes on rough surfaces with a fixed value. | Phase 3 scene tests (rough floors). | open |
| D43 | SSSR / roughness space | `roughnessThreshold` 0.2 and mirror test 0.0001 are on alpha (perceptual squared). | Our frame contract has `roughnessIsPerceptual` (three: true); thresholds are written in perceptual units and squared at the pass boundary. | Avoids the common mistake of applying 0.2 to perceptual roughness (0.2 alpha = 0.447). | A source we port from uses a different convention. | open |
| D44 | SSSR / ray list packing | 15-bit x, 14-bit y, 3 copy flags in a u32. | Same packing (or x,y 14+14 with flags) so `samplesPerQuad < 4` works; denoiser tile list 16+16. | SPEC's 16+16 has no room for quad-copy flags. | Render targets above 16383 px. | planned |
| D45 | SSSR / subgroup quad ops | `QuadReadAcrossX/Y/Diagonal` via `lane ^ 1/2/3`, assumes lanes map to 2x2 quads. | Use `quadSwapX/Y/Diagonal` when available; the workgroup-memory fallback uses explicit tile indexing, not lane arithmetic. | WGSL does not guarantee the lane-to-quad layout for `subgroupShuffleXor` in compute. | A device reports quad ops unsupported but subgroup ops available. | planned |
| D46 | SSSR / variance default | `temporalVarianceGuidedTracingEnabled` true with threshold 0.0 in the sample (range 0–0.01). | Default threshold from the denoiser's variance units; verify what 0.0 does there. | A threshold of 0 traces any pixel with non-zero variance, effectively `samplesPerQuad = 4`. | Phase 3 GPU-ms tests. | open |
| D47 | SSSR / traversal occupancy | `minTraversalOccupancy` 4 exits early when few lanes are alive (wave count); mirrors ignore. | With the workgroup fallback no wave count exists; use workgroup-level active count or drop the exit. | Cannot be ported without `subgroups`. | Measure the cost of dropping it on divergent scenes. | open |
| D48 | SSSR / depth pyramid | 7 levels (mip 0 + 6), r32f, min for forward-Z / max for reverse-Z. | Same; keep `depthInverted` choosing min/max. | | | planned |
| D49 | SSSR / ray sampling | GGX VNDF with blue noise; no mirror-bias knob. | Port VNDF. Add the SSSR15 bias knob (`u.x = lerp(u.x, 1, bias)`) as an option, default 0. | The knob is cheap and cuts noise (SSSR15 slide 68, PICA p451). | Noise vs bias measured on the rooms. | open |
| D50 | SSSR / resolve | SSSR15 resolves at full res from half-res rays with weight re-normalisation; FFX moved this into its denoiser. | Rely on the `denoiser` seam; no resolve pass in this repo. | Denoising belongs in `denoiser` (CLAUDE.md rule 7). | A resolve-less path (no denoiser) needs a minimal one. | open |
| D51 | hybrid / RT as default | idTech 8 ships RT only for very smooth surfaces and disables it on consoles; FFX's hybrid sample gates RT by confidence and an RT roughness threshold (0.22); probes are the baseline. | RT is optional, off by default, and gated by `rtRoughnessThreshold` + `confidence`. | Matches what shipped; SPEC §5 wording could be read as RT-first. | Phase 4 numbers show RT is cheap enough to default on. | planned |
| D52 | hybrid / thresholds | Bands: FFX 0.2 alpha; AMD-GR 0.2/0.6 (assumed perceptual); Lumen 0.3/0.4; HDRP min-smoothness 0.9. Spaces differ. | Three bands in perceptual roughness: mirror, glossy (SSSR + RT), rough (probe), with the cut-offs exposed. Defaults to be chosen at phase 5. | No source is directly comparable. | Phase 5 tuning on the explainer scenarios. | open |
| D53 | hybrid / seam | Lag14 `distance-based roughness` and the roughness-lerp of the corrected direction exist to match SSR and probes; AMD hybrid has none. | Implement both in the probe lookup as options (default on). | Seam visibility is the main hybrid failure (RTG32, Snow p64). | Seam metric in phase 5. | open |
| D54 | hybrid / ray origin | FFX hybrid and Snow-reflections restart at the surface; Lumen and Snow-GI continue the same ray. | Restart at the surface (D8). | See D8. | See D8. | open |
| D55 | hybrid / hit shading | FFX: G-buffer re-shade or lit-history lookup; ACS: reproject the *material* to the G-buffer, never the lighting; AMD-GR: previous frame colour if visible. | Probes at hit + direct light; if the hit is on screen, use the G-buffer material and last-frame colour. | Specular is view dependent; reprojected lighting mismatches (ACS p71). | Phase 4 hit-shading error. | open |
| D56 | hybrid / budget | Tile-quality feedback: Snow 16x16 (quality thresholds 0.02/0.1/0.2), FFX hit counter per 8x8. | Per-tile cap (D9) with FFX-style hit-counter feedback to size the next frame's reservation. | Cap alone wastes work when a tile has no misses. | Phase 4. | open |
| D57 | probes / dominant direction | Lag14: `lerp(N, R, s(sqrt(s)+r))`, `s = 1 - r`, used for IBL lookup and proxy intersection. | Add to `sampleReflectionProbes`; not in the current port. | Rough lookups along R are too bright at grazing angles. | Phase 1 reference shows no gain. | planned |
| D58 | probes / blend | Lag14: front-to-back alpha accumulation, small volume to large, early out at alpha 1, smoothstep fade by `influenceFadeDistance`. HDRP: weights summed to 1, `Importance` sort. | Priority-ordered alpha accumulation (Lag14), with the environment as the last slot. | Order-defined and early-out friendly. | Probe-overlap scenes look worse than weighted blend. | open |
| D59 | probes / proxy | HDRP: separate influence and proxy volumes (same shape type). Lag14: sphere and OBB proxies + capture offset. | Box and sphere proxies; influence = proxy by default with an optional separate influence box. | Three's #35046 uses box only. | An app needs an arbitrary proxy. | open |
| D60 | probes / re-fit basis | Laz13: SH9 (tinted scalar) at the normal; idT8: frame irradiance, no probe-side basis given. | L1 SH for `probeIrradiance`, evaluated at the shading normal; clamp the ratio (value TBD). | Cost and storage; L1 is exact for the cosine-lobe constant plus gradient. | Phase 2 re-fit compared against SH9 on the rooms. | open |
| D61 | probes / format | idT8 warns against R11G11B10F (colour shift, banding, no pure white) for irradiance; wants RGB9E5. WebGPU has no storage/renderable RGB9E5. | Bench `rg11b10ufloat` against `rgba16float` and judge by tone-mapped banding on bright sources. | Source evidence is against rg11b10 for bright HDR. | Phase 1 format axis. | open |
| D62 | probes / resolution | Lag14 256^2 minimum for mirror-grade, 128–512 range; Laz13 128^2 (max power 8192); Godot 256 default, 128 mobile; ACS global cube 128^2. | Default 256 px for reflection probes, 128 px option; our explainer uses 128 px for 3 probes. | Resolution should follow the smoothest material using the probe. | Phase 1 error per roughness. | open |
| D63 | probes / prefilter samples | Karis13 1024; Lag14 32 (filtered IS, mip clamp >= 8x8); Godot 32/16; Laz13 CubeMapGen. | 256-sample filtered IS (r187 plan, D3). | Matches three. | Phase 1 brute-force error per mip. | measured |
| D64 | probes / mip mapping | Lag14 `sqrt(alpha)*N`; Laz13 and FFX linear in perceptual roughness; Godot 8 layers (arrays) or mips. | `lod = N*r(2-r)` (D3). Numbers in §1.2 show it is within 0.1 of Frostbite for r >= 0.25 but lower at r < 0.2. | Same as three. | Reference test at r < 0.2. | open |
| D65 | probes / live update | HDRP time-slices realtime probes over 7 frames; ACS updates 1 cube face per frame; Godot once or every frame. | Whole-probe bake per call (2.2 ms for 3 probes at 128 px). | Simplicity. | Live capture budget exceeded in the rooms. | open |
| D66 | composite / specular occlusion | Lag14 `saturate(pow(NdotV+AO, exp2(-16 r - 1)) - 1 + AO)`; idT8 directional occlusion; Godot flag default on. | Apply the Lag14 term to the probe term only, from the app's AO; SSR/RT carry their own occlusion. | Cheapest sourced option; removes probe light leaking. | Phase 5 leaking in corners. | planned |
| D67 | composite / DFG form | Lag14 two-channel DFG (f0 and f90); Karis13 scale/bias on F0. | Karis form (f90 = 1) like three. | Matches three's PBR. | Materials with a non-1 f90. | measured |
| D68 | denoise seam / demodulation | Snow, ACS, NRD: radiance divided by the pre-integrated BRDF before denoising, multiplied back after; ACS also compresses `x^0.625`. | The seam carries demodulated radiance; compression left to the denoiser. | Keep contracts with `denoiser`. | Denoiser repo decides otherwise. | open |
| D69 | frame contract / scene colour | FFX: current frame, direct only; PICA, SSSR15, AMD-GR: previous frame reprojected; FFX hybrid: either via a flag. | Allow both, default to the current frame lit without specular. | Avoids ghosting and double specular. | The adapter cannot render specular-off. | open |

## 6. Source limitations

- UE reflection-capture docs returned no body text; UE's roughness-to-mip constant (S12) is unverified.
- Hobson, GDC 2019: GDC Vault is member-gated; only the abstract was reachable. Not cited for any claim.
- HDRP pages: hierarchy, importance, weight, blend distance, time slicing are verified from the 17.0 docs; no probe resolution or atlas size is given there.
- idTech slide numbers are PDF pages (slide number + 1). RTG ch. 25 pages are the printed pages (445–451). The FFX files cited are in tag `v1.1.4`; `main` has since moved the SSSR sources (v2 SDK), so the numbers above are the v1.1.4 values only.
