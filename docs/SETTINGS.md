# Settings guide

<!-- Generated from examples/showcase/src/bench/schema.ts by `pnpm settings:doc`; edit the schema, not this file (test/settings-doc.test.ts checks they match). -->

Every tuning knob the package and the examples expose, with its default, what it trades and, where one was measured, its GPU cost. The same list drives the tuning bench, `examples/showcase/bench.html`: each row is a control there and a URL key (`bench.html?<key>=<value>`, booleans as 1 / 0), so a link reproduces a view.

- **Default:** the package's default (what you get without passing the option). "examples:" is what the showcase and the bench use where that differs.
- **Apply:** *live* changes without a reload; *rebuild* is taken at construction (on the bench: the Rebuild button).
- **Cost:** measured GPU time with its source (docs/HANDOFF.md, docs/DIVERGES.md). Blank: not measured on its own. Small costs add up; a later "fast" preset will need them.
- **Applies to:** the bench's methods (ours raw / denoised / + RT, probes only, three SSR raw / + denoise / + FFX, path traced).

## Anti-aliasing / upscaler

Display AA after the composite (examples/shared/antialias.ts, W36): @pmndrs/upscaler at ratio 1 acts as TAA and smooths the last fireflies. Same choice on ours and on three's SSR; the path tracer needs none.

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| AA mode | `aa` | examples DisplayAA (mode) | examples: `upscaler`; examples-side; bench and showcase upscaler, compare page off | `upscaler`, `taa`, `off` | live | The upscaler accumulates up to 128 jittered frames: edges, normal-mapped highlights and the denoised reflections' last 1-3/255 shimmer settle (W36, W40). Off shows the raw per-frame image (what compare.html showed: aliased). | the upscaler's own passes show under GPU time (its timer); not in HANDOFF | ours + three SSR |
| Upscale | `upscale` | examples DisplayAA (ratio) | examples: `native` | `native`, `quality`, `balanced`, `performance`, `ultra` | rebuild | G-buffer, reflections and the denoiser run at the render size and the upscaler rebuilds the display size: every reflection pass scales with the pixel count; softer at higher ratios. Ours only: three's SSR side keeps ratio 1 (D3620). |  | ours (incl. probes only) |
| Reactive mask | `reactive` | examples reflectionReactive (D4202) | examples: 0 | 0 .. 1 | live | Upscaler favours the current frame where reflections move with the pixel: less reflection ghosting on moving surfaces, more of their noise. 0 = off. |  | ours (incl. probes only) |
| RCAS sharpness | `sharpness` | @pmndrs/upscaler settings.sharpness | 0.8; examples: 0 | 0 .. 1 | live | RCAS after the upscale. The pages run 0 (D4201): 0.8 sharpened each jitter phase differently, mirror-edge flicker at rest 0.16% -> 4.2% of px. |  | ours + three SSR |
| Max accumulation | `accum` | @pmndrs/upscaler settings.maxAccumulation | 24; examples: 128 | 1 .. 256 | live | History length: longer is calmer at rest, ghosts longer in motion. 24 leaves the reflections' residual noise at rest (0.48% vs 0.02% px, W36). |  | ours + three SSR |
| RCAS denoise | `aa.rcasDenoise` | @pmndrs/upscaler settings.rcasDenoise | off | on / off | live | Damps sharpening on lone luma outliers (noisy inputs); only matters with sharpness > 0. |  | ours + three SSR |
| Auto pre-exposure | `aa.autoExposure` | @pmndrs/upscaler settings.autoExposure | on | on / off | live | Pre-exposure from the scene luminance for the invertible tonemap the history accumulates in; off uses the fixed pre-exposure below. |  | ours + three SSR |
| Pre-exposure | `aa.exposure` | @pmndrs/upscaler settings.exposure | 1 | 0.1 .. 8 | live | Fixed pre-exposure (ignored while auto is on); divided out again, so it only conditions the accumulation. |  | ours + three SSR |
| Lock thin features | `aa.lockThinFeatures` | @pmndrs/upscaler settings.lockThinFeatures | on | on / off | live | Protects stable sub-pixel features from history rectification (less shimmer on thin parts; can hold a stale value longer). |  | ours + three SSR |
| Detect shading changes | `aa.detectShadingChanges` | @pmndrs/upscaler settings.detectShadingChanges | on | on / off | live | Ages the history where shading really changed (a light, a bake) so it re-converges instead of ghosting. |  | ours + three SSR |

## Scene

What every method renders: scene, camera, floor, tone mapping, exposure, size.

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| Scene | `scene` |  | examples: `carConcept` | `carConcept`, `toyCar`, `chess`, `sponza` | rebuild | Reloads every method on the new scene (downloaded assets only). |  | page |
| Camera | `pose` |  | examples: `hero` | `hero`, `low`, `front`, `close`, `top`, `w50` | live | Camera preset (orbit freely after). The named Measure regions for carConcept are defined at `w50` (W50) and `hero` (W46). |  | page |
| Debug view (ours) | `view` | examples showcase/src/debugViews.ts (the showcase's Debug view) | examples: `final` | `final`, `split`, `off`, `ibl`, `reflections`, `source`, `rtSource`, `confidence`, `ssrWeight`, `hitDistance`, `hitRadiance`, `signal`, `specular`, `denoiseDelta`, `probeSpecular`, `ao`, `specularOcclusion`, `traced`, `depth`, `depthEdges`, `normals`, `roughness`, `shadingRoughness` | live | What ours draws: the showcase's debug views plus depth / normals / roughness. Source: green SSR hit, blue traced hit, orange probe, magenta environment, grey rough (untraced). rtSource: blue traced hit, cyan traced hit coloured from the screen, magenta traced miss, orange over budget. denoiseDelta: red where the denoiser added light, blue where it took light away (x4). Measure reads whatever is shown. |  | ours (incl. probes only) |
| Exposure | `exposure` | renderer.toneMappingExposure | per scene | 0.2 .. 3 | live | Display exposure, every method alike. |  | every method |
| Tone mapping | `tone` | renderOutput(..., toneMapping) | examples: `agx` | `agx`, `neutral`, `aces` | rebuild | Display transform, every method alike. Measure's numbers are in this display space. |  | every method |
| Render size | `size` |  | examples: `960x540` | `960x540`, `1280x720`, `1920x1080`, `1280x1280` | rebuild | Each method's canvas (`?w=&h=`). W52 (D3643): the skirt halo is mostly a 960x540 effect (lip 48 vs PT 46 at 1920x1080). W50: at 960x540 the car has 2.4x fewer px across than the showcase's 1280x1280 shots, most of the "detail loss" seen there. |  | page |
| Floor material | `floor` |  | examples: `mirror` | `mirror`, `lacquer` | live | The stages' floor disc (not Sponza). The path tracer rebuilds. |  | every method |
| Floor roughness | `floorRoughness` |  | per scene (stages 0.03) | 0 .. 0.6 | live | Floor roughness, every method; ours re-bakes its probes. The path tracer rebuilds. |  | every method |
| Polished floor (Sponza) | `floorPolish` |  | examples: on | on / off | live | Sponza's polished override of its `Floors` material; off = the asset's rough stone. |  | every method |
| Background blur | `bgBlur` |  | examples: 0 | 0 .. 1 | rebuild | Backdrop blur (display only; lighting unchanged). The compare / bench show it sharp so every method shows the same backdrop (the PT blurs differently); the showcase uses 0.35. |  | every method |
| Environment light scale | `envLight` |  | examples: 1 | 0 .. 3 | rebuild | W58: scales the image-based light (scene.environmentIntensity): three's IBL, the probe bake and the path tracer's environment. 0 leaves the key light alone (with keyLight: what share of a look is the HDRI). |  | every method |
| Background | `background` |  | examples: `hdri` | `hdri`, `black` | rebuild | W58: black hides the backdrop the camera sees (backgroundIntensity 0); lighting and reflections keep the environment. |  | every method |
| Key light scale | `keyLight` |  | examples: 1 | 0 .. 3 | rebuild | Scales every directional / spot / point light (W45: what share of a reference is the key light). |  | every method |

## Screen-space (SSSR)

`ScreenSpaceReflectionsPass.settings` (core `ScreenSpaceReflectionsSettings`), read every frame.

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| Screen-space march | `ssr` | settings.maxTraversalIntersections = 0 when off | examples: on | on / off | live | Off: no screen-space march, every ray goes to the miss list (RT traces all of them on ours + RT; the rest take the probe). Judges what SSR adds. |  | ours |
| Roughness threshold | `s.roughnessThreshold` | settings.roughnessThreshold | 0.447 | 0 .. 1 | live | Perceptual roughness above which a pixel skips the trace and takes the probe / environment only (D43). Higher traces rougher surfaces: more rays, more noise for the denoiser. The examples' denoiser gate follows it (W34). | SSR passes 0.81-0.91 ms at 1080p at the default (pyramid 0.17-0.21, classify 0.10-0.11, intersect 0.53-0.58; W6); scales with traced px | ours |
| Samples per quad | `spq` | settings.samplesPerQuad | 1 | `1`, `2`, `4` | live | Rays per 2x2 quad for glossy (non-mirror) pixels. More rays, less noise: spq 4 lowered denoised std 0.14 -> 0.10 on a 0.25 floor (W21). | intersect grows about linearly in glossy rays (0.53-0.58 ms at 1080p at 1, W6) | ours |
| Quad copy | `s.quadCopy` | settings.quadCopy | `always` | `always`, `sameSurface` | live | W58 (D3740): with samplesPerQuad < 4 a quad shares one ray. 'always' copies it to every glossy px of the quad, across a silhouette too: on carConcept the skirt's reflection lands on the mirror floor below it (bright 2x2 dashes, raw) and the floor's on the skirt, the stair-stepped raw edge the denoiser then spreads. 'sameSurface' gives px on another surface (depth > 5 %, normal > ~25 deg) their own ray. carConcept w50 960x540, lip / band MAD vs PT raw 18.6 / 14.0 -> 11.5 / 12.2, denoised 41.5 / 30.6 -> 34.4 / 26.9 (spq 4: 11.2 / 13.5, 34.3 / 27.7). | 1080p: classify +0.02, intersect +0.02, rt trace ~+0.2 ms (carConcept w50, W58) | ours |
| Quad base rotation | `s.quadBaseRotation` | settings.quadBaseRotation | `fixed` | `fixed`, `frame`, `pattern` | live | W71 (X1 #1, D5000): which px of a 2x2 quad traces when samplesPerQuad < 4. 'fixed' keeps the copy's 2x2 grid in place (it can show under TAA / the upscaler and drift in blocks at rest); 'frame' / 'pattern' move it every frame, so the history averages it out. Composes with Quad copy 'sameSurface'. | classify: one more lookup per px (not timed yet; X0) | ours |
| Max march steps | `s.maxTraversalIntersections` | settings.maxTraversalIntersections | 128 | 0 .. 256 | live | Hi-Z march steps per ray: fewer is cheaper and sends long rays to the miss list (probe or RT); 0 = SSR off. |  | ours |
| Min occupancy | `s.minTraversalOccupancy` | settings.minTraversalOccupancy | 4 | 0 .. 64 | live | Glossy rays stop once this few lanes of their subgroup still march (FFX): higher ends long tails earlier (cheaper, more misses). Mirrors ignore it. |  | ours |
| Thickness | `s.depthBufferThickness` | settings.depthBufferThickness (THICKNESS_HYBRID) | 0.2; showcase scenes set their own (kit.thickness) | 0 .. 0.5 | live | Hit acceptance thickness in view-space units. Thicker accepts rays that pass behind objects (streaks, the dark band under carConcept's sill, D2402); thinner cuts holes (FFX's 0.015 holes the sphere, D4303). Room scale 0.2 is too thick for a car (W11). |  | ours |
| Thickness per alpha | `s.thicknessRoughnessFactor` | settings.thicknessRoughnessFactor | 10; showcase scenes set their own | 0 .. 20 | live | Thickness added per unit of the pixel's alpha: rough rays need less precision (D1001). |  | ours |
| Thickness per ray length | `s.thicknessLengthFactor` | settings.thicknessLengthFactor | 0.01 | 0 .. 0.1 | live | Thickness added per world unit of ray length: far hits are coarser (D1001). |  | ours |
| Thickness per view depth | `s.thicknessDepthFactor` | settings.thicknessDepthFactor | 0 | 0 .. 0.1 | live | W71 (X1 #2, D5001): thickness += k x the hit's view depth, so one value scales from a toy car to a hall (with mode 'relative' it is the whole thickness: Diligent's distance / viewZ < 0.025 is k 0.025). 0 = off. |  | ours |
| Thickness depth mode | `s.thicknessDepthMode` | settings.thicknessDepthMode | `add` | `add`, `relative` | live | W71 (X1 #2, D5001): how Thickness per view depth combines. 'relative' drops the constant, per-alpha and per-length terms (0 thickness at k 0). |  | ours |
| Most detailed mip | `s.mostDetailedMip` | settings.mostDetailedMip | 0 | 0 .. 4 | live | Pyramid mip glossy rays start on: higher is cheaper and coarser. Mirrors always use 0. |  | ours |
| Hit colour | `hit` | settings.hitColor (+ historySource) | `current`; examples: `final` | `final`, `lit`, `current` | live | `current` (FFX, the package default) has no reflections in reflections: a mirror seen in a mirror is black (W9: 99.6% px). `final` reprojects last frame's final image (D69, D1002): mirror-in-mirror, one frame late, can ghost. |  | ours |
| History edge confidence | `s.historyEdgeConfidence` | settings.historyEdgeConfidence | off | on / off | live | W71 (X1 #4, D5003): with Hit colour from last frame and Hit specular 'off' (the only case a hit reads last frame's colour), the edge fade is min(now, previous) and a hit that was off screen last frame gets confidence 0 (probe / RT) instead of this frame's colour without specular: no lit / unlit pops at the screen edge while panning. More misses near the edges: more traced rays with RT. No effect with the re-shade (default). |  | ours |
| Hit specular (re-shade) | `reshade` | settings.hitShading | `reshade` | `reshade`, `off` | live | W44 (D3540): a hit keeps its screen diffuse and evaluates its specular along the ray. Fixes carConcept's reflected door (48 -> 100 vs PT 118, W50); with the lobe filter and the denoiser it is the halo under the door / skirt (lip 37 -> 80 vs PT 48, D3610). | intersect +0.003..0.017 ms at 1280x720 (D3540) | ours |
| Hit lobe filter | `lobeFilter` | settings.hitLobeFilter (DEFAULT_HIT_LOBE_FILTER) | 1 | 0 .. 2 | live | W45 (D3550): a hit's specular looked up wider by k x the pixel's alpha (filtered importance sampling): same mean, less variance, so the denoiser stops clipping rare softbox samples (RT door 111 -> 155). 0 = the hit's own roughness (W44); 1 default; 1.5 wider. W50, carConcept + RT: lip 53 at 0 vs 80 at 1 (PT 48), door 110 either way. Double-blurs the lobe (x1.41 alpha at 1). | part of the re-shade's +0.003..0.017 ms (one lookup at another lod) | ours |
| Lobe filter where hits mix | `s.hitLobeFilterMixed` | settings.hitLobeFilterMixed (+ traceSettings) | 1 | 0 .. 1 | live | W52 (D3641): the lobe filter x this where traced and screen-space hits mix (last frame's source around the pixel). W50's halo: lip 80 -> 56 at 0, but the skirt 50 -> 23 (PT 35), and it overshoots at 1080p (D3643: the halo is mostly a 960x540 effect). Below 1 the tracer is rebuilt once (one more sampled texture). | +0.07 ms (W52) | ours |
| Lobe filter grazing shrink | `s.hitLobeFilterGrazing` | settings.hitLobeFilterGrazing (+ traceSettings) | 0 | 0 .. 1 | live | W71 (X1 #3, D5002): the hit lobe filter's spread x mix(1, mix(sat(2 NdotV), 1, sqrt(roughness)), this) (SSSR 2015 slide 85 at 1): less widening on floors seen at a grazing angle, where the lobe filter over-blurs. Screen-space and traced hits. 0 = off. | one normal load + a few ALU per re-shaded hit (not timed yet) | ours |
| Re-shade occlusion | `s.hitShadeOcclusion` | settings.hitShadeOcclusion (+ traceSettings) | `off` | `off`, `screen` | live | W52 (D3642): a re-shaded hit marches the depth buffer along R and darkens where blocked (the re-shade had no occlusion, W44). Wheel 43 -> 37 (PT 26); works without RT. Untuned. | intersect +0.04 ms (W52) | ours |
| Mirror bias | `s.mirrorBias` | settings.mirrorBias | 0 | 0 .. 1 | live | D49: truncates the GGX lobe toward the mirror direction: less noise, a sharper (biased) reflection. W32 / W39: no gain with the denoiser on a still or orbiting camera; W40: 0.7 halves rest shimmer on the carConcept floor (0.31 -> 0.14/255). | free (one multiply in the sample) | ours |
| Miss fallback roughness | `s.fallbackRoughness` | settings.fallbackRoughness (+ traceSettings.fallbackRoughness) | `surface` | `surface`, `mirror` | live | D1806: where a ray misses, the probe at the pixel's own roughness (blurred, low noise) or at roughness 0 along the ray (FFX; the denoiser has to blur it). |  | ours |
| Variance-guided tracing | `s.temporalVarianceGuidedTracing` | settings.temporalVarianceGuidedTracing | on | on / off | live | Extra rays where last frame's variance is high. No effect here: the seam passes no variance back to the tracer (W21). |  | ours |
| Variance threshold | `s.varianceThreshold` | settings.varianceThreshold | 0 | 0 .. 1 | live | Variance above which variance-guided tracing adds rays (no effect without a variance input). |  | ours |
| IBL factor (tracer) | `s.iblFactor` | settings.iblFactor | 1 | 0 .. 2 | live | Scales the tracer's own radiance fallback. The three adapter forces that fallback black (the composite adds the probe), so no visible effect here. |  | ours |
| Temporal stability (tracer) | `s.temporalStabilityFactor` | settings.temporalStabilityFactor | 0.7 | 0 .. 1 | live | Carried in the tracer's uniform block for a denoiser; unused by these passes (the denoiser has its own, below). |  | ours |
| Frame index (freeze noise) | `s.frameIndex` | settings.frameIndex | increments per dispatch | 0 .. 1023 | live | Fixes the blue-noise rotation: a still noise pattern to judge structure without the temporal part (the denoiser then sees the same samples every frame). |  | ours |

## Ray tracing

The ray-traced fallback over the SSR miss list: provider, which misses are traced, and `ScreenSpaceReflectionsPass.traceSettings`.

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| Ray-traced fallback | `rt` | pass.rayTracing | on | on / off | live | On the ours + RT method: traced rays for the SSR misses. Off shows the same instance without them (= ours denoised). |  | ours-rt |
| Provider | `bvh` | PmndrsBvhTraceProvider \| MeshBVHTraceProvider | examples: `pmndrs`; the app picks one; the examples default to @pmndrs/bvh (W51, D1705) | `pmndrs`, `three-mesh-bvh` | rebuild | Same hits on the procedural scenes (100% hit / t agreement, W14 / W48); @pmndrs/bvh agrees with THREE.Raycaster on Sponza where three-mesh-bvh misses 2.4% (D1705), and is faster. | trace at 1080p: Sponza 0.771 vs 1.417 ms (default misses), 1.043 vs 1.867 (all traced) (D1705); offscreen mirror 0.459 vs 0.539 (W14) | ours-rt |
| Builder (@pmndrs/bvh) | `bvhBuilder` | createPmndrsBvhTraceProviderFromObjects({ builder }) | `auto` | `auto`, `gpu-hploc`, `gpu-lbvh`, `tinybvh` | rebuild | Tree builder: build time and tree quality (trace cost); same hits. |  | ours-rt |
| Interpolated hit normals | `rtShadingNormals` | provider option shadingNormals | on | on / off | rebuild | D1700: traced hits shade with the vertex normals (smooth, as three shades on screen) instead of the face normal (faceted). | three-mesh-bvh up to +0.07 ms at 1080p (D1700) | ours-rt |
| Glossy threshold (traced) | `s.missRoughnessThreshold` | settings.missRoughnessThreshold | 1 | 0 .. 1 | live | Only misses at perceptual roughness <= this go to the ray tracer (FFX hybrid sample: 0.469). Lower = fewer traced rays (cheaper); rougher misses keep the probe. | trace 0.357 ms at 174k misses -> 0.535 ms at 281k (1080p, W8) | ours-rt |
| Miss confidence | `s.missConfidenceThreshold` | settings.missConfidenceThreshold | 0.9 | 0 .. 1 | live | A ray goes to the miss list when its SSR confidence is below this: higher traces more edge-faded rays. |  | ours-rt |
| Ray budget per frame | `t.maxTracedRaysPerFrame` | traceSettings.maxTracedRaysPerFrame | unlimited | 0 .. 2000000 | live | Caps the traced rays (D9); entries past it keep the probe. A fair share per tile, rotating (D1100). |  | ours-rt |
| Rays per 8x8 tile | `t.maxRaysPerTile` | traceSettings.maxRaysPerTile | 64 | 1 .. 64 | live | Per-tile cap (D9, D56): spreads a capped budget over the screen. |  | ours-rt |
| Max ray length | `t.maxRayLength` | traceSettings.maxRayLength | 100 | 0 .. 200 | live | World-unit cap at roughness 0 (FFX hybrid sample); shorter is cheaper and misses far content. |  | ours-rt |
| Ray length falloff | `t.rayLengthRoughnessFalloff` | traceSettings.rayLengthRoughnessFalloff | 5 | 0 .. 20 | live | cap = maxRayLength x exp(-falloff x alpha): rough rays stay short. |  | ours-rt |
| Origin offset | `t.normalOffset` | traceSettings.normalOffset | 0.003 | 0 .. 0.02 | live | Origin pushed along N by this x view distance: too small self-hits (acne), too large skips contact. |  | ours-rt |
| Reuse on-screen hits | `t.reuseOnScreenHits` | traceSettings.reuseOnScreenHits | on | on / off | live | D55: a traced hit the camera sees takes the screen colour (re-shaded with the re-shade on, D3542) instead of the probe-lit hit shading. |  | ours-rt |
| Hit shadow rays | `t.hitShadows` | traceSettings.hitShadows | on | on / off | live | D903: one shadow ray per directional light from each traced off-screen hit; off lights every hit unoccluded. | <= 0.03 ms on 3 of 4 scenes (D903); 'moving' 1080p +0.169 ms three-mesh-bvh, +0.081 @pmndrs/bvh (D2601) | ours-rt |
| Hit specular lobe | `t.hitSpecular` | traceSettings.hitSpecular | on | on / off | live | D3510: traced hits shade their specular lobe and coat (with D3513's one visibility ray); off = diffuse + emissive only. |  | ours-rt |
| Hit lobe filter (traced) | `rtLobeFilter` | traceSettings.hitLobeFilter | the tracer's (Hit lobe filter) | 0 .. 2 | live | Overrides the lobe filter at traced hits only (the compare page's ?rtLobeFilter=): separates the W45 effect on RT hits from the screen-space ones. |  | ours-rt |
| On-screen depth tolerance | `t.onScreenDepthTolerance` | traceSettings.onScreenDepthTolerance | 0.02 | 0 .. 0.1 | live | Relative view-distance tolerance for "the camera sees this hit": looser reuses more screen colour (cheaper shading, can pick a neighbour). |  | ours-rt |
| IBL factor (traced) | `t.iblFactor` | traceSettings.iblFactor | 1 | 0 .. 2 | live | Scales the traced misses' fallback. |  | ours-rt |
| Visibility ray on re-shaded hits | `t.hitShadeVisibility` | traceSettings.hitShadeVisibility | `offscreen` | `offscreen`, `all` | live | W52 (D3640): D3513's visibility ray along R for on-screen re-shaded traced hits too. Wheel 43 -> 41 vs PT 26 (carConcept); mirrors seen in mirrors go black where blocked (facingMirrors, D3542). Needs Hit shadow rays on. | rt trace +0.30 ms (W52) | ours-rt |

## Hybrid / composite

`HybridReflections` and its composite.

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| Depth-aware blend | `h.depthAware` | hybrid.depthAware.value | 1 | 0 .. 1 | live | D2400: keeps the probe off hits it lies behind (1); 0 = FFX's confidence blend (the wall pattern showed through the reflected sphere, W22). |  | ours |
| SSR / RT amount | `h.amount` | composite().amount.value | 1 | 0 .. 1 | live | Share of the traced reflection in the composite: 0 = probes only, for an A/B on one instance. |  | ours |
| Specular occlusion (GTAO) | `specOcc` | HybridReflections({ ao }) (examples GTAO) | examples: off | on / off | rebuild | Lagarde's specular occlusion from screen-space AO on the probe / environment part (D66, D4510). Darkens probe-filled creases; traced misses skip it (D3551); grainy without a blur (backlog). | 960x540 2.1 -> 2.3 ms wall per frame (D4510; GTAO included) | ours (incl. probes only) |
| Denoiser motion convention | `h.denoiserMotion` | HybridReflections({ denoiserMotion }) | `ndc` | `ndc`, `uv` | rebuild | A convention, not a tuning knob: match your denoiser (the wrong one misreprojects and smears). |  | ours denoised, ours + RT |
| Denoiser roughness space | `h.denoiserRoughness` | HybridReflections({ denoiserRoughness }) | `perceptual` | `perceptual`, `alpha` | rebuild | A convention: match the denoiser's `roughnessIsPerceptual`. |  | ours denoised, ours + RT |

## Denoiser

`FfxReflectionDenoiser` (denoiser/ffx) behind the denoise seam. Its options are taken at construction: the bench rebuilds it on change (history drops).

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| Denoise | `denoise` | hybrid.denoise | on | on / off | live | Off shows the raw signal (ours raw). The FFX denoiser loses 26-46% of a heavy-tailed glossy signal's energy (D3550) and spreads bright screen hits over dark traced neighbours (the W50 halo). | denoised hybrid 0.9-1.4 ms over raw at 1080p (HANDOFF, Performance) | ours denoised, ours + RT |
| Temporal stability | `tsf` | new FfxReflectionDenoiser(device, { temporalStabilityFactor }) | 0.7 | 0 .. 1 | live | History clip box scale: higher is calmer, ghosts more. |  | ours denoised, ours + RT |
| Roughness gate (alpha) | `dn.roughnessThreshold` | FfxReflectionDenoiser({ roughnessThreshold }) | 1; the examples pass the tracer's threshold squared (0.1998) | 0 .. 1 | live | Pixels with alpha >= this pass through undenoised. The examples gate at the tracer's threshold (rougher px carry the probe only, no noise; D1402). |  | ours denoised, ours + RT |
| Current-frame statistics | `dn.currentFrameStatistics` | FfxReflectionDenoiser({ currentFrameStatistics }) | on | on / off | live | false reproduces FFX v1.1.4 exactly (its one-frame-off statistics: dark speckles on disocclusion, a black first frame). |  | ours denoised, ours + RT |
| Miss ray length | `dn.missDistance` | FfxReflectionDenoiser({ missDistance }) | camera far | 0 .. 200 | live | Ray length the reprojection assumes for misses (hit distance 0). |  | ours denoised, ours + RT |
| Keep hit sources apart | `hitSource` | hybrid.denoiserHitSource = true; FfxReflectionDenoiser({ separateHitSources, missesMatchAnySource }) | `0` | `0`, `hits`, `all` | live | The denoiser stops blending bright screen-space hits into dark traced ones (the W50 halo: carConcept lip 80 -> 59 with hits, 52 with all, PT 48, at 960x540; at 1080p the halo is mostly gone anyway). hits: no regression on chess / toyCar / Sponza. all: boils where rays flip between hit and miss (std p99 x4-10). Both show a 2x2 stair step at source edges (D3663). | +0.35 ms (hits) / +0.51 ms (all) at 1080p, ~0 at 960x540 (W53) | ours denoised, ours + RT |
| Hit-distance weight | `hitDistW` | FfxReflectionDenoiser({ hitDistanceWeight }) | 0 | 0 .. 16 | live | Neighbours weighted by relative hit distance, exp(-k \|t_p - t_q\| / (t_p + t_q)); no extra input. 8 separates the lip as well as the source (50.6) but boils everywhere the hit distance varies (std p99 x5-10). 0 = off. | +1.3 ms at 1080p for k 8 (W53) | ours denoised, ours + RT |

## Probes

`ReflectionProbes` and its `bake()` options. A change re-bakes (Rebuild).

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| Reflection probes | `probes` | scene.environmentNode = reflectionProbes(probes); HybridReflections({ probes }) | examples: on | on / off | rebuild | Off lights with the plain environment (three's PMREM): misses read the HDRI instead of the local capture. |  | ours (incl. probes only) |
| Resolution | `probeRes` | probes.bake(renderer, scene, { resolution }) | 256 | `64`, `128`, `256`, `512`, `1024` | rebuild | Face size (D23, D62): 256 for mirror-grade surfaces, 128 for many probes / mobile. Near-mirror floors read the HDRI blurred at small sizes (W21). | memory per probe ~1.0 / 4.2 / 16.8 MB at 128 / 256 / 512; bake 3 probes 2.0 -> 4.0 ms from 128 to 256 (D23) | ours (incl. probes only) |
| Bounces | `bounces` | probes.bake(renderer, scene, { bounces }) | 2 | 1 .. 4 | rebuild | D4300: captures that see other probes' reflections; 1 halves the bake where no mirror faces another. | bake mirrorWall 1 probe: 2.5-3.5 ms at 1, 3.6-4.9 at 2 (256 px, D4300) | ours (incl. probes only) |
| Storage | `probeStorage` | probes.layout | `auto` | `auto`, `cube-array`, `cube2d` | rebuild | Hardware cube arrays (W20 shim) vs the 2D-array layout with its seam fix: same look within 1/255. |  | ours (incl. probes only) |
| Probe layout (Sponza) | `probeLayout` | examples probeLayouts.ts (W61) | examples: `shipped` | `shipped`, `few`, `medium`, `many`, `manyCell`, `mixed`, `oneSize128`, `oneSize256`, `twoSize`, `twoSizeFew`, `mixedDown` | rebuild | W61: probe layouts at an equal memory budget (Sponza only): a few large or mixed sizes beat a grid of small ones. |  | ours (incl. probes only) |
| Car interior probes (carConcept) | `carProbes` | examples showcase/src/carProbes.ts (W55) | off | `off`, `wheels`, `cabin`, `both`, `cabinGlass` | rebuild | W55: small probes inside carConcept beside the stage probe, boxes from the car's geometry (wheel bounds less the body paint; the cabin grown from the seats to the glass). The wells and the cabin then reflect their own capture instead of the open studio (D3680, D3681). |  | ours (incl. probes only) |
| Car interior probe size | `carProbeRes` | ReflectionProbe.resolution (D4700) | examples: `128` | `64`, `128`, `256` | rebuild | W55: face size of the carProbes probes; the stage probe keeps Resolution. A size other than the stage's is a second atlas (a mixed-size set). |  | ours (incl. probes only) |
| Distance-based roughness | `pr.distanceRoughness` | probes.distanceRoughness | on | on / off | rebuild | Lagarde 2014 (D53): a glossy lookup is sharp near the projection box, as an SSR hit there would be. | lookup within the run's noise at 1080p (D53) | ours (incl. probes only) |
| Roughness lerp of the direction | `pr.roughnessLerp` | probes.roughnessLerp | off | on / off | rebuild | Lagarde 2014 (D53): rough lookups lose the box parallax. Narrowed the SSR-to-probe step but moved every showcase stage away from the PT (W26). |  | ours (incl. probes only) |
| Roughness to mip | `pr.lodMapping` | probes.lodMapping | `alpha` | `alpha`, `r187` | rebuild | D101: 'alpha' halves the error below r = 0.3 against a GGX reference (p99 at r .05: 35.4 -> 21.9 / 255 at 256 px). |  | ours (incl. probes only) |
| Box projection | `pr.boxProjection` | probes.boxProjection | on | on / off | rebuild | Off: infinite-distance lookups (no parallax); the stages project onto a far box anyway. |  | ours (incl. probes only) |

## Materials (examples)

Example-side material options, not package API: roughness from normal variance (specAA, W46) and the W45 experiments.

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| Roughness from normal variance | `specAA` | examples specAA.ts (strength; 0 = off) | examples: 1 | 0 .. 3 | live | W46 (D3570): raises each normal-mapped material's roughness by its normal map's lost variance (Toksvig, vMF), as the path tracer sees the flakes. carConcept door / skirt MAD 35.7 / 19.0 -> 8.0 / 9.4; it is also what makes the paint lighter: off reads darker. Ours re-bakes. | ~0.1-0.15 ms of three's render passes at 1280x720 (D3570) | ours + three SSR |
| specAA at traced hits | `specAAHits` | examples specAAHitMaterial | on | on / off | rebuild | Traced hits take the adjusted roughness too (one value per mesh, D3571); off keeps them at the authored roughness. |  | ours-rt |
| Glossy mask from adjusted roughness | `maskSpecAA` | Measure | off | on / off | live | Measure's glossy mask from the specAA roughness instead of the authored one (the default keeps specAA on / off comparable over the same px). |  | ours (incl. probes only) |
| Paint roughness override | `paintRoughness` |  | authored | 0 .. 1 | rebuild | W45: every clear-coated material at this roughness, normal map dropped (what a plain paint lobe sees). The path tracer too. |  | every method |
| Glass (isolation) | `glass` |  | authored | `authored`, `noShadow`, `black`, `hidden` | rebuild | W54: isolates what the eye sees through transmissive glass (carConcept's cabin): black keeps only the glass's own reflection, hidden only the cabin behind it, noShadow lets the key light through as the path tracer does. Every method alike, the path tracer too. |  | every method |
| Geometry roughness (three) | `geometryRoughness` | examples geometryRoughness.ts (W56) | three | `three`, `off`, `0.5`, `0.25` | rebuild | W56 (D3720): three r187 adds the screen-space derivative of the view normal to every standard material's roughness (getRoughness); off / scaled re-assigns three's roughness after its setupVariants. Reaches three's lit term, the G-buffer's shading roughness (the composite's probe term) and the bake; never the path tracer. Any other scale by URL (?geometryRoughness=0.75). |  | ours + three SSR |

## three SSRNode (reference)

three r187's stock SSRNode, its TemporalReproject + RecurrentDenoise, and denoiser/three's ffxReflections: the three SSR methods only.

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| SSR mirror bias | `mirrorBias` | SSRNode.mirrorBias | 0; examples: 0.5 | 0 .. 1 | live | three's lobe truncation (the example's 0.5): less noise, sharper. |  | three SSR |
| SSR max distance | `ssrMaxDistance` | SSRNode.maxDistance | 1; example: scene far / 4 (D2301) | 0 .. 50 | live | March length in world units; the example's 0.4 is for its 0.1-scaled dungeon. |  | three SSR |
| SSR thickness | `ssrThickness` | SSRNode.thickness | 0.1; example: our scene thickness x 3 (D2301) | 0 .. 1 | live | Hit acceptance thickness (three's units). |  | three SSR |
| SSR quality | `th.quality` | SSRNode.quality | 0.5; examples: 0.25 | 0 .. 1 | live | Step density: higher is finer and costlier. |  | three SSR |
| SSR intensity | `th.intensity` | SSRNode.intensity | 1 | 0 .. 3 | live | Scales the reflection. |  | three SSR |
| SSR max luminance | `th.maxLuminance` | SSRNode.maxLuminance | 10; examples: 35 | 0 .. 100 | live | Clamp against fireflies (biased dark on bright reflections). |  | three SSR |
| SSR edge fade | `th.screenEdgeFade` | SSRNode.screenEdgeFade | 0.2 | 0 .. 1 | live | Fades hits near the screen edge. |  | three SSR |
| SSR environment intensity | `th.environmentIntensity` | SSRNode.environmentIntensity | 3.1416; example: the scene's (D2300) | 0 .. 4 | live | Scales the environment its misses sample (the example's 3.14 is for its scene). |  | three SSR |
| SSR step exponent | `th.stepExponent` | SSRNode.stepExponent | 2; examples: 3 | 1 .. 5 | rebuild | Step distribution along the ray. |  | three SSR |
| SSR resolution scale | `th.resolutionScale` | SSRNode.resolutionScale | 1 | 0.25 .. 1 | rebuild | SSR at a fraction of the resolution: cheaper, blockier. |  | three SSR |
| SSR binary refine | `th.binaryRefine` | SSRNode.binaryRefine | off | on / off | rebuild | Binary search at the hit: sharper contact, more steps. |  | three SSR |
| SSR edge fade to black | `th.screenEdgeFadeBlack` | SSRNode.screenEdgeFadeBlack | off | on / off | rebuild | Fade to black instead of the environment at the edge (indoor scenes). |  | three SSR |
| Reproject max frames | `th.rp.maxFrames` | TemporalReprojectNode.maxFrames | 16; the example's | 1 .. 64 | live | History length of three's reprojection. |  | three-denoise |
| Reproject clamp | `th.rp.clampIntensity` | TemporalReprojectNode.clampIntensity | 0.25; the example's | 0 .. 1 | live | History clamp strength: higher ghosts less, flickers more. |  | three-denoise |
| Reproject flicker suppression | `th.rp.flickerSuppression` | TemporalReprojectNode.flickerSuppression | 1; the example's | 0 .. 2 | live | Damps temporal flicker. |  | three-denoise |
| Hit-point reprojection | `th.rp.hitPointReprojection` | TemporalReprojectNode.hitPointReprojection | on; the example's | on / off | live | Reprojects by the reflected hit's motion (reflections move unlike their surface). |  | three-denoise |
| Denoise lumaPhi | `th.dn.lumaPhi` | RecurrentDenoiseNode.lumaPhi | 0.75; the example's | 0 .. 4 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise depthPhi | `th.dn.depthPhi` | RecurrentDenoiseNode.depthPhi | 20; the example's | 0 .. 100 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise normalPhi | `th.dn.normalPhi` | RecurrentDenoiseNode.normalPhi | 0.3; the example's | 0 .. 2 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise roughnessPhi | `th.dn.roughnessPhi` | RecurrentDenoiseNode.roughnessPhi | 100; the example's | 0 .. 200 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise radius | `th.dn.radius` | RecurrentDenoiseNode.radius | 1.5; the example's | 0 .. 4 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise alphaPhi | `th.dn.alphaPhi` | RecurrentDenoiseNode.alphaPhi | 5; the example's | 0 .. 20 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise strength | `th.dn.strength` | RecurrentDenoiseNode.strength | 0.725; the example's | 0 .. 1 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise adapt | `th.dn.adapt` | RecurrentDenoiseNode.adapt | 0.5; the example's | 0 .. 1 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise flickerSuppression | `th.dn.flickerSuppression` | RecurrentDenoiseNode.flickerSuppression | 1; the example's | 0 .. 2 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise adaptiveTrust | `th.dn.adaptiveTrust` | RecurrentDenoiseNode.adaptiveTrust | 1; the example's | 0 .. 2 | live | three's recurrent denoiser weight (edge-stopping phi / filter radius / blend). |  | three-denoise |
| Denoise smooth disocclusions | `th.dn.smoothDisocclusions` | RecurrentDenoiseNode.smoothDisocclusions | on; the example's | on / off | live | Blurs freshly disoccluded px harder. |  | three-denoise |
| FFX temporal stability (three side) | `th.ffx.tsf` | ffxReflections(..., { denoiser: { temporalStabilityFactor } }) | 0.7 | 0 .. 1 | rebuild | As ours', on three's SSR + FFX. |  | three-ffx |
| FFX roughness gate (three side) | `th.ffx.roughnessThreshold` | ffxReflections(..., { denoiser: { roughnessThreshold } }) | 1 | 0 .. 1 | rebuild | As ours' (alpha); ffxReflections denoises every px by default. |  | three-ffx |

## Path tracer (reference)

three-gpu-pathtracer (WebGPU) + OIDN, the ground truth Measure compares against.

| Setting | URL key | API | Default | Range | Apply | Trade-off | GPU cost | Applies to |
|---|---|---|---|---|---|---|---|---|
| Max samples | `ptMax` | WebGPUPathTracer.maxSamples | 8 | 1 .. 512 | live | Traces to this many spp, then denoises once with OIDN and idles. Measure sets its own (Reference samples). OIDN biases sub-8-bit differences: raise it or show raw for those (D2305). |  | pathtraced |
| Show raw (no OIDN) | `ptRaw` |  | off | on / off | live | The noisy accumulation instead of the denoised frame. |  | pathtraced |
| Bounces | `ptBounces` | WebGPUPathTracer.maxBounces | 8 | 1 .. 16 | rebuild | Light bounces of the reference. |  | pathtraced |
| OIDN | `ptDenoise` |  | on | on / off | rebuild | Off: never load OIDN (raw accumulation only). |  | pathtraced |
| Clear coat | `ptClearcoat` |  | on | on / off | rebuild | Off drops the clear-coat layer (the old WebGL tracer rendered it black, D2303). |  | pathtraced |

## Not exposed

| Option | Why |
|---|---|
| `settings.fallbackColor` | The three adapter forces the tracer's constant fallback black (the composite adds the probe); a constant colour is meaningless there. |
| `traceSettings.fallbackColor, hitColor, hitShading` | The adapter passes black and the tracer's own `hitColor` / `hitShading` (Hit colour / Hit specular above). |
| `trace option `lights`` | Constructor-only (`ScreenSpaceReflectionsPass({ trace: { provider, lights } })`); the examples attach the provider later with `setTraceProvider`, so the default (on) stays. |
| `ReflectionProbes.refitClamp, frameIrradiance` | Only with a frame-irradiance re-fit, which the showcase scenes don't run. |
| `@pmndrs/upscaler debugView` | A debug overlay, not a tuning knob. |
