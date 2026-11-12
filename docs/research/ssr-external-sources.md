# External SSR sources: DiligentFX, JBU, Stochastic SSR

Status: 2026-11-12. The maintainer sent three resources; one research agent read each and compared it against SPEC §3/§5, DIVERGES, the HANDOFF backlog and the code at `36a9984`. Nothing below was run on a GPU. Every ms figure is an estimate unless it cites a measurement.

Sources:
- **Diligent**: DiligentFX ScreenSpaceReflection, https://diligentgraphics.github.io/docs/dc/dd9/DiligentFX_PostProcess_ScreenSpaceReflection_README.html. The agent read the README plus `master` shaders: `Shaders/PostProcess/ScreenSpaceReflection/private/SSR_*.fx`, `public/ScreenSpaceReflectionStructures.fxh`, `Shaders/Common/public/{PostFX,PBR}_Common.fxh`, `PostProcess/ScreenSpaceReflection/src/ScreenSpaceReflection.cpp`.
- **JBU**: Kopf, Cohen, Lischinski, Uyttendaele, "Joint Bilateral Upsampling", SIGGRAPH 2007, https://johanneskopf.de/publications/jbu/. The 35 MB PDF was over the fetch limit, so the filter's parameters are from memory and unverified.
- **SSSR15**: https://h3.gd/stochastic-ssr/ is only a short intro (its ReSTIR follow-up link is a 404). The substance comes from the linked SIGGRAPH 2015 deck, Stachowiak and Uludag, "Stochastic Screen-Space Reflections", read as text with its speaker notes.

## Summary

- **Diligent is the same lineage as ours, one step back.** It is FFX SSSR rewritten as full-screen pixel shaders for WebGL. It has no compaction, no environment fallback and no RT. Its roughness gate repeats the mistake D43 records. It adds a spatial ratio-estimator reconstruction, depth-relative thickness and an optional half-res trace.
- **SSSR15's sampling is behind ours** (GGX NDF with regeneration and Halton; we have VNDF and blue noise). Its resolve is ahead: BRDF/pdf-weighted neighbour reuse, a cone-footprint colour pyramid, and a bias knob paired with a matching blur.
- **JBU** is the basis of every depth- and normal-aware upsample in games. We have no upsample anywhere; everything runs at full render size.
- **The shared gap.** After a ray is traced, we copy one ray's colour across its 2×2 quad (always the top-left pixel) and leave the rest to the FFX denoiser. Both Diligent and SSSR15 reuse neighbours' rays weighted by each pixel's own BRDF over the ray's pdf. FFX's prefilter weights by luminance similarity (`denoiser-ffx/src/shaders/reflections.ts:506`), which is probably the mechanism behind D3550's 26-46 % glossy energy loss.

## Candidates, ranked

| # | Idea | From | Benefit | Cost | Touches |
|---|---|---|---|---|---|
| 1 | Change which quad pixel traces, each frame or by a 4×4 pattern | Diligent (`PostFX_Common.fxh:45`), SSSR15 slide 88 | Breaks the fixed 2×2 copy grid under TAA/upscaler; may relate to the "contact drifts in blocks" backlog line | S | classify `isBaseRay` (`sssr/shaders.ts:199-205`); DIVERGES row |
| 2 | Depth-relative thickness, `thickness += k·\|viewZ\|`, default 0 | Diligent (`SSR_Intersection.fx:238`, `distance/viewZ` vs 0.025) | Fewer per-scene thickness numbers, fewer far-field holes | S | core `finishRay` (`shaders.ts:719`) and settings; row next to D1001; already a backlog line |
| 3 | Shrink `hitLobeFilter`'s spread at grazing angles, `coneTan *= lerp(sat(NdotV*2), 1, sqrt(r))` | SSSR15 slide 85 | Less over-blur on grazing floors | S | `sssr/shaders.ts:726`, `trace/shaders.ts:317` |
| 4 | `hitColor:'history'`: edge fade = min(now, previous); drop confidence when the previous texel is off screen | Diligent (`SSR_Intersection.fx:231`) | No lit/unlit pops at screen edges while panning | S | core intersect (`shaders.ts:442`, D1002) |
| 5 | Cone-footprint colour pyramid for hit colour: mip from roughness × hit distance, so contacts stay sharp | SSSR15 | Fewer raw speckles (r 0.35 sphere, pixi arcade, showcase paint); less for the denoiser to clip | M | one colour downsample per frame plus a mip formula in intersect |
| 6 | Couple `mirrorBias` with #5: truncate the lobe, add the matching blur | SSSR15 (shipped bias 0.7) | Noise and cost down without over-sharpening; it is D3550's revisit and answers D49 | S after #5 | `hitLookupRoughness`'s alpha split |
| 7 | Ratio-estimator spatial reuse (BRDF/pdf weights, normalised) | Diligent (`SSR_SpatialReconstruction.fx:84`), SSSR15 | Largest quality-per-ray gain; makes sparse or half-res tracing viable (SSSR15: 1 ray + 4 reuse ≈ 4 rays) | L | an intersect direction/pdf output, a seam extension, the denoiser repo. Conflicts with D50 / rule 9; maintainer's call |
| 8 | Half-res glossy RT misses with a depth/normal/roughness-weighted fill | JBU | About 4× fewer BVH rays on glossy misses | S-M | miss-list append predicate plus a core fill pass. Answers SPEC open question 4 for the RT layer |
| 9 | Half-res trace + denoise, then joint bilateral upsample of the residual (`denoised − probeEnv_half`) | JBU | 0.6-1.0 ms of denoise back at 1080p (estimate) | L | SSSR sizing, the seam, a new upsample pass, three adapter composites, denoiser tuning. Mirrors must stay full res |

Also an option: an edge-aware quad copy (weight the FFX copy by a depth/normal test, fall back per pixel on failure), S. Polish only, since the denoiser hides most of it.

## Not to take

- **Diligent**: the perceptual 0.2 gate (alpha 0.04; D43); pixel-shader passes behind a depth mask instead of compaction (WebGL-only); black misses with alpha filtered separately (counts confidence twice, darkens partly covered pixels); bias 0.3 (W32/W39 measured 0 as right for us); its temporal pass (denoiser repo's domain; as read, `TemporalRadianceStabilityFactor` 1.0 lets new samples in only through the clamp, `SSR_TemporalAccumulation.fx:254`); fp16 `dir × length` and uint8 noise tables (D304/D305 cover these).
- **SSSR15**: GGX NDF with regeneration and Halton (VNDF + blue noise is better); the linear march for rough rays (skips thin objects); full MIS (dropped by the authors as "ALU and VGPR hell"); average-reflected-depth reprojection (FFX reprojects per hit); bias 0.7 as a default without #5.
- **JBU**: applying it to probes (they are prefiltered cube mips sampled per pixel, not a screen-space solution).

## 1. DiligentFX SSR

### Pipeline
1. **Hi-Z**: one pass per mip, 7 mips (max mip 6), r32f, min depth (max for reverse-Z). Includes the extra row and column on odd sizes (as our D1600).
2. **Mask + roughness extract**: a D16 depth-test mask replaces classify, compaction and indirect args. Roughness is converted to perceptual.
3. **Intersect**: one ray per masked pixel. Optional half resolution traces one pixel per 2×2, chosen by a fixed 4×4 Latin-square pattern (`PostFX_Common.fxh:45`, position only, not per frame). The FFX Hi-Z march as is, with no occupancy exit. Outputs `rgba16f(hit colour, confidence)` and `rgba16f(dirWS × length, pdf)`. Misses are black with confidence 0; no environment input.
4. **Spatial reconstruction**: 8 rotated Poisson taps over a radius of `4·sat(5r)`, ratio estimator (each neighbour's ray weighted by this pixel's BRDF / that ray's pdf, `SSR_SpatialReconstruction.fx:84`). Also writes variance and a virtual hit depth; upsamples from half res.
5. **Temporal**: history from two candidates, surface motion or the reprojected virtual hit point (`SSR_TemporalAccumulation.fx:236`), whichever is closer in luma. Depth disocclusion with a 3×3 bilinear search, then a clamp to mean ± 2.5σ.
6. **Bilateral cleanup**: SVGF depth and normal edge stops; radius 0-2 px by roughness and variance.

Defaults: thickness 0.025 (relative), roughness threshold 0.2 (perceptual), MaxTraversalIntersections 128, GGXImportanceSampleBias 0.3, spatial radius 4, radiance stability 1.0, variance stability 0.9. Inputs: depth, world normal, a material texture with `RoughnessChannel` / `IsRoughnessPerceptual`, NDC motion. `FEATURE_FLAG_PREVIOUS_FRAME` reads hit colour from last frame.

### Differences

| Item | Diligent | Ours | Better for us |
|---|---|---|---|
| Thickness | `distance / viewZ` vs 0.025, scales with depth | absolute view-space 0.2 + 10α + 0.01L (`shaders.ts:719`, D1001) | Theirs on scale robustness (#2) |
| Roughness gate | 0.2 vs perceptual (`SSR_StencilMask.fx:36`) = alpha 0.04 | perceptual 0.447 = FFX alpha 0.2 (D43) | Ours |
| Work distribution | full-screen pixel shaders, depth mask | compacted ray list, indirect dispatch, occupancy exit (D7, D301) | Ours |
| Ray economy | every pixel, or half-res one-of-4 plus reconstruction | `samplesPerQuad` 1, fixed top-left, copied (`shaders.ts:199`) | Mixed: their reconstruction beats our flat copy |
| Hit validation | background and distance at mip 0 | background at mip 1 (FFX), distance at the march's mip (D1000) | Equivalent at `mostDetailedMip` 0 |
| Miss | black, alpha 0; caller lerps env after filtering rgb and alpha separately | fallback blended in before denoising (D41, D1401, D3100) | Ours |
| History hit colour | samples `hit − motion(hit)`; vignette min(current, previous) | `hitColor:'history'`; previous off screen falls back to current colour (`shaders.ts:442`, D1002) | Theirs at screen edges (#4) |
| GGX bias | 0.3 on u2 of Dupuy's spherical-cap VNDF | `mirrorBias` 0 on Heitz's U1 (D49, D3300) | Same family; keep ours |
| Per-ray data | dir × len + pdf | radiance.w = length, `hitDistance`, `confidence` | Ours unless #7 |
| Denoise | own spatial → temporal → bilateral | FFX denoiser through the seam (D50) | Ours |
| Fallback, hybrid, RT, re-shade, lobe filter | none | all present | Ours |

Unverified: Diligent's sample-app composite (whether it divides rgb by alpha); any runtime behaviour.

## 2. Joint Bilateral Upsampling

### Method
- `S̃_p = (1/k_p) Σ_{q↓∈Ω} S_{q↓} · f(‖p↓ − q↓‖) · g(‖Ĩ_p − Ĩ_q‖)`: a low-res solution `S`, a spatial Gaussian `f` over low-res taps, a range Gaussian `g` on the full-res guide image. About a 5×5 low-res window (from memory).
- One gather per full-res pixel. Assumes the solution is piecewise smooth with edges matching the guide's.
- Failure modes: texture copying (guide detail printed into the solution), edge bleeding (solution edges the guide lacks), weight collapse at thin features (blocky nearest-tap fallback), and no detail above the low-res Nyquist limit (a mirror stays visibly low-res).
- Game variants swap the colour guide for geometric weights (view depth or plane distance, `pow(dot(n_p, n_q), k)`, often a roughness difference), mostly over the bilinear 2×2 footprint with a nearest-depth fallback. Used for half-res SSAO, volumetrics and SSR. idTech, ACS and PICA trace RT at ½ or ¼ res (`docs/research/sources.md` S11).

### Where we stand
- Everything is full render size; no bilateral or upsample exists in `packages/` or `docs/`.
- G-buffer at drawing-buffer size (`packages/three/src/frame/FrameGBuffer.ts:175`). SSSR textures and ray list W×H (`packages/core/src/sssr/sssr.ts:380-385`); inputs must match or it throws (`sssr.ts:524-534`). RT pass matches the tracer size (`packages/core/src/trace/pass.ts:292`); miss list per full-res pixel (`sssr.ts:395`).
- The only "upsample" is FFX's quad copy (`shaders.ts:199-205`, `:243-248`, `:640-645`): nearest, no depth/normal test; each copy has its own fallback since D1806 (`shaders.ts:734`). Mirrors trace every pixel.
- Denoise at frame size (`packages/core/src/denoise/seam.ts:151-167`, `packages/three/src/sssr/HybridReflections.ts:76-82`); the denoiser's FFX port has one `renderSize` (`denoiser-ffx/src/shaders/reflections.ts:58`, `:136`).
- Composite samples per pixel at one uv (`packages/three/src/sssr/composite.ts:226-228`).
- `@pmndrs/upscaler` (`?upscale=`, W36, D4200) is already a reduced-resolution path for the whole frame.

### Notes on #8 and #9
- **#8**: append to the miss list for one pixel per 2×2 (or checkerboard) of glossy misses only; mirrors stay full rate. A fill pass weights depth/plane, normal power, roughness difference and same-source; a near-zero weight sum takes the probe. W14's 1080p offscreen mirror ran 0.46 ms for 281k rays, mostly mirror rays, so the saving depends on the scene's glossy share.
- **#9**: half-res G-buffer point-sampled from one fixed pixel per quad, then trace, signal and denoise at half res, then upsample, then composite. The seam already writes motion, roughness and normal; it would downsample them and call `configure({w/2, h/2})`. No denoiser API change, but its spatial radii double in screen space. Hit distance is in world units. Confidence must be upsampled with the same weights (D2400 and `ssrWeight` read it). Upsample the residual, not `denoised`, because the signal already contains the probe term (D1401). The glossy trace is already quarter rate, so the trace saving is mostly mirrors (~75 % of intersect, ~0.56 ms at 1080p in W3); the real win is the denoise (0.9-1.4 ms over raw). Risks: mirrors visibly half-res (must stay full res, i.e. mixed-res denoising); normal-mapped car paint (D3552) texture-copies; thin silhouettes (D4303, W41's sill) get worse.
- Not now: phases first (rule 7), RT is off by default (D51), the cheaper denoise saving is the tile-list route (D1400/D1401), and the upscaler already covers reduced resolution.

## 3. Stochastic SSR (SSSR15)

### What it proposes
- **Sampling**: GGX importance sampling, 1 ray per half-res pixel, Halton. Rays below the surface are regenerated; VNDF named as future work.
- **Ray reuse (ratio estimator)**: a full-res resolve reuses about 4 neighbours' hits, each weighted `localBRDF(hit) / hitPdf`, normalised by their sum; the pre-integrated FG term is multiplied in after the temporal pass. Unnormalised reuse was worse than none ("spikes"). 1 ray + 4 resolve samples ≈ the variance of 4 rays. Allows sparse tracing that keeps per-pixel normal and roughness.
- **Bias knob**: `u.x = lerp(u.x, 1, bias)` truncates the lobe tail, paired with a blurrier colour mip. Shipped at 0.7.
- **Filtered importance sampling**: pre-blurred colour pyramid, mip from a cone footprint (roughness × hit distance). The cone shrinks at grazing angles: `coneTan *= lerp(saturate(NdotV*2), 1, sqrt(roughness))`.
- **Adaptive tracing**: 1/8-res probe rays estimate perceptual variance per tile and allocate between a min and max rays per pixel. Hi-Z for smooth, linear march for rough.
- **Temporal**: reprojection by the average reflected depth, loosened TAA-style clamp.
- **Multi-pixel resolve**: 4 pixels share rays; the pixel set is spread wider than the TAA window and re-picked each frame, because 2×2 noise reads as features to TAA.
- **Measured** (PS4, 1600×900, all pixels reflective, bias 0.7): 1 ray + 4 resolve 2.19 ms (resolve 0.81); 2 + 4 3.34 ms; 4 + 1 4.41 ms.

### Differences

| Item | SSSR15 | Ours | Better for us |
|---|---|---|---|
| Direction sampling | GGX NDF, regenerate below surface | Heitz VNDF (`sssr/shaders.ts:478-512`, D49) | Ours |
| Random numbers | Halton, CPU | FFX Sobol + scramble 128² blue noise, golden-ratio shift (`shaders.ts:315-330`) | Ours |
| Bias | truncation plus a matching blur | `mirrorBias` truncates only, default 0 (D49, D3300) | His: the compensating half is what we lack (#6) |
| Ray density | per-tile variance allocation | `samplesPerQuad` 1 (`sssr.ts:498`); variance guidance off (`sssr.ts:499`, backlog) | His needs no seam (backlog line) |
| Pixels that don't trace | ratio-estimator resolve with own BRDF | FFX quad copy (`shaders.ts:243-248`, `:639-645`), fixed top-left (`:199-205`) | His (#1, #7) |
| Spatial weights | BRDF/pdf, energy-preserving | FFX prefilter `radianceWeight` (luminance) | His (#7) |
| Hit colour | pre-blurred pyramid, cone × distance, grazing shrink | screen colour mip 0 (`shaders.ts:435-446`); `hitLobeFilter` widens only the probe-specular lookup by k·α, no distance term (D3550, `trace/provider.ts:169-172`) | His (#3, #5) |
| Tracers | Hi-Z smooth, linear rough | one Hi-Z with occupancy exit, `mostDetailedMip` 0 (`shaders.ts:696`) | Ours |
| Temporal | average reflected depth, loose clamp | FFX per-hit reprojection (`reflections.ts:242-248`), variance AABB clip | Ours |
| FG after temporal | yes | split-sum DFG after the denoiser (SPEC §5; D68) | Same |
| Per-ray pdf/direction | stored | not stored (`denoise/seam.ts:26-29`); direction only in the miss list | Needed for #7 |

Unverified: the deck's figures (text only), the dead ReSTIR follow-up, thickness details, whether FFX glossy rays start at a coarser mip (ours default 0).
