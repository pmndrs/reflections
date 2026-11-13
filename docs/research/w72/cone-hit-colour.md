# W72 (X2): cone-footprint hit colour (#5) and coupled mirror bias (#6)

Status: phase 1 (build, default-identical, checks, first numbers). Phase 2 (line-spread gate, grazing sweep, energy, f sweep) waits for X0's metrics. Spec: `docs/plans/ssr-sources-experiments.md` X2; sources: `docs/research/ssr-external-sources.md` #5, #6, SSSR15.

## What was built

Core settings (`ScreenSpaceReflectionsSettings`), all default off:

| setting | values | what it does |
|---|---|---|
| `hitColorFilter` | `'off'` (default, FFX) \| `'cone'` | A screen-space hit reads its screen colour (with `hitShading: 'reshade'`: the hit's diffuse part) from a pre-filtered pyramid at the lobe cone's footprint, not the hit's texel. Needs the option `hitColorPyramid` (three and pixi rebuild the tracer on a flip). |
| `hitColorConeScale` | default 1 | Scales the cone's width. |
| `mirrorBiasCompensate` | default false; needs `'cone'` | `mirrorBias` f narrows the sampled lobe to alpha sqrt(1 - f) (no truncation) and the cone and `hitLobeFilter` supply alpha sqrt(f). |

- **Pyramid.** rgba16float, `HIT_COLOR_PYRAMID_LEVELS` = 6 levels (mip 0 is a converting copy, then five 2x2 averages), built once per frame by the shared `downsampler` (`encodePass` with `source`, reduction 'average') in its own compute pass ('hit colour pyramid' in the timer). Source: this frame's scene colour without specular, or last frame's colour where hits read it (`hitColor: 'history'` with `hitShading: 'off'`; the re-shade always takes this frame's diffuse). Off-screen-last-frame history hits keep the unfiltered current texel (rare; not filtered).
- **Mip at a hit** (`hitColorConeMip`, intersect): the cone's full angle is the reflected GGX lobe's full width at half maximum. For small alpha the half vector's half width at half max is tan = 0.6436 alpha (D ∝ (alpha² + t²)⁻², half at t² = (√2 - 1) alpha²); the reflection doubles it, so the full angle is 2.574 alpha. Width at the hit = 2 x rayLength x tan(1.287 x alpha_f x scale), projected at the hit's depth (`0.5 x H x P[1][1] / clip.w`; orthographic too), mip = log2(px), trilinear. Below mip 0 (short rays, mirrors) the hit loads its texel exactly as before. Contacts stay sharp by construction.
- **Bindings.** Intersect gains binding 19 (the pyramid, `texture_2d<f32>`, filterable) and 20 (a linear sampler) only with the option: +1 sampled texture, counted in `checkStageLimits` (D4900): 10 → 11 (12 with `hitSource`).
- **Params.** SSSR words 145-149 (`hitColorFilterCone`, `hitColorConeScale`, `mirrorBiasCompensate`, `sampleAlphaScale`, `filterAlphaScale`), `PARAMS_SIZE` 640 (141-144 and 150-159 padded for the other streams). RT word 76 (`lobeFilterShare`), `RT_PARAMS_SIZE` 320 (67-75, 77-79 padded).
- **Adapters.** three: the tracer is rebuilt when `hitColorFilter` flips to or from 'cone'; the RT pass gets the tracer's `mirrorBias` / `mirrorBiasCompensate` / `hitColorFilter` (new `TracedReflectionsSettings` fields) so its lobe filter follows the split. pixi: the tracer is rebuilt in `dispatch` on a flip, the pixi targets are kept. Babylon: not wired (no pyramid option passed; 'cone' throws there).
- **Bench.** `s.hitColorFilter`, `s.hitColorConeScale`, `s.mirrorBiasCompensate` (schema + `SSSR_FIELDS`), `docs/SETTINGS.md` regenerated.

## The double-blur budget (derivation)

Four things blur a reflection: (1) the ray's sampling spread over frames, (2) the cone mip, (3) `hitLobeFilter` at re-shaded and traced lookups (k x alpha, D3550), (4) the denoiser's spatial pass. This stream budgets (1)-(3); (4) is what the line-spread gate measures on top.

1. **Widths add in squares.** Treat each source as an independent random angular perturbation of the reflected direction. Independent perturbations add in variance, and a GGX lobe's angular width is linear in alpha for small alpha, so in alpha units `alpha_total² = Σ alpha_i²`. This is the rule `hitLookupRoughness` already uses (`sqrt(alpha_hit² + (k alpha)²)`, D3550). GGX isn't Gaussian (heavy tails; the FWHM of a convolution is not exactly the root sum of squares), so the gate is measured, not assumed.
2. **The honest split.** The surface's lobe is alpha. If the sample covers alpha_s, the filters may add only `alpha_f² = alpha² - alpha_s²`. With `mirrorBiasCompensate` and bias f: `alpha_s = alpha sqrt(1 - f)`, `alpha_f = alpha sqrt(f)`, so `alpha_s² + alpha_f² = alpha²` for every f. Narrowing the lobe (alpha x sqrt(1 - f) into the VNDF) keeps its GGX shape; D49's truncation (U1 x (1 - f)) cuts its tail instead, and the cut tail can't be put back by a blur of the same shape, which is why compensation narrows rather than truncates.
3. **The cone and the lobe filter don't stack, they split the hit.** A re-shaded screen-space hit is diffuse (screen colour) + specular (a directional lookup along R). The cone filters the screen-colour part; `hitLobeFilter` filters the specular part; no part of the hit sees both. So "not stacking" means each part gets the same filter share: both use alpha_f, the cone as a footprint (x ray length, projected) and the lobe filter as a roughness add (distance-free, a probe is at infinity). With compensation the lobe filter's widening is `k x alpha x sqrt(f)` in the SSSR re-shade and in the RT pass (the traced directions come from the same narrowed lobe through the miss list): "reduced by the same share" (`mirrorBiasSplit().filter`).
4. **Without compensation** the sample is the full lobe (alpha_s = alpha, or D49's truncation), so any filter is extra: the cone at scale 1 gives sqrt(2) alpha on the screen-colour part, the same x1.41 double blur the lobe filter has at k = 1 (D3550). Plain 'cone' is therefore SSSR15's / Colbert & Krivanek's filtered importance sampling trade (variance for bias). It should fail the ±10 % line-spread gate at scale 1 unless the denoiser or the sample's actual width says otherwise; the scale that passes is a phase 2 number.
5. **Why the lobe filter must shrink too.** With compensation but the lobe filter left at k alpha, the specular part would get `sqrt(1 - f + k²) alpha`: at f 0.7, k 1 that is 1.14 alpha (less than today's 1.41, still over). With the share: `sqrt(1 - f + k² f) alpha` = alpha at k 1.

Known limits (phase 2 measures them):
- 6 levels cap the cone at ~32 px. At 960x540 a floor reflecting a wall 5 m away at alpha 0.1 wants ~60 px. Capped cones under-blur, which leaves variance in, never over-blurs.
- A plain pyramid averages across silhouettes, so a hit near a depth edge takes some of the colour behind or in front of it (leakage). A depth-aware pyramid only if the measurement shows it.
- No grazing shrink (#3, X1) yet: at grazing views the cone uses the normal-view width.
- The cone isn't applied to the RT pass's on-screen reused hits (RT_SOURCE 4); they keep the texel.

## Default-identical (max 0/255)

Hashes on main `0abd154` vs this branch with the settings unset (`parity-main-0abd154.txt`, scripts `parity.js`, `parity-showcase.js`):
- examples/ssr, all 9 scenes, rt=1, raw (`denoise=0&hit=current`) and denoised: the tracer's radiance hash at frameIndex 7 and the final image's hash, every one equal.
- showcase carConcept at W50's view, rt=1, denoised, 2 frames after 20: equal.
- These need `minTraversalOccupancy: 0`: with FFX's occupancy exit, two consecutive frames at a fixed frameIndex differ in ~0.15 % of px (771 of 518k on mirrorWall), because the ray list's atomic order decides which rays share a subgroup (`repro.js`).

## Phase 1 numbers

No GPU timings (shared GPU, per the lead). Configurations: `default`; `cone` (scale 1); `cone x2`; D49's truncation at 0.5 (reference); `comp f` = cone + `mirrorBiasCompensate` at mirrorBias f.

### Raw speckle (`speckle.js`)

The tracer's radiance before denoise and composite, 32 frames with the frame index advancing, per mask px: temporal mean m_p and std s_p of luminance. relStd = mean s_p / mean m_p; fireflies = samples with L > m_p + 2 x the region's mean; p999 = 99.9th percentile of (L - m_p) / mean. (The plan's "> 3 sigma" with sigma = the median s_p is in the JSON as `speckle`; it degenerates where the median px is static, sigma 0 on the arcade floor.) X0's speckle count replaces this in phase 2.

| region | metric | default | cone | cone x2 | trunc 0.5 | comp 0.3 | comp 0.5 | comp 0.7 |
|---|---|---|---|---|---|---|---|---|
| mirrorWall r 0.35 sphere (4834 px, raw, rt off) | relStd | 0.79 | 0.56 | 0.55 | 0.50 | 0.51 | 0.45 | 0.38 |
| | fireflies | 2.38 % | 1.72 % | 1.67 % | 1.01 % | 1.52 % | 1.14 % | 0.88 % |
| | p999 | 23.9 | 4.0 | 4.0 | 21.1 | 4.0 | 3.7 | 3.7 |
| | mean | 0.136 | 0.132 | 0.134 | 0.147 | 0.136 | 0.139 | 0.142 |
| pixi3d arcade floor r 0.06 (209k px) | relStd | 0.43 | 0.31 | 0.23 | 0.22 | 0.35 | 0.28 | 0.22 |
| | fireflies | 2.70 % | 1.25 % | 0.52 % | 1.56 % | 1.75 % | 1.22 % | 0.78 % |
| | p999 | 7.9 | 5.3 | 3.7 | 6.3 | 6.4 | 5.7 | 4.8 |
| | mean | 0.195 | 0.196 | 0.198 | 0.196 | 0.196 | 0.197 | 0.197 |
| carConcept paint r 0.33-0.42 (40k px, hero, rt off) | relStd | 1.36 | 1.36 | 1.36 | 0.79 | 1.58 | 1.33 | 1.08 |
| | fireflies | 7.27 % | 7.26 % | 7.24 % | 5.41 % | 5.60 % | 5.75 % | 5.43 % |
| | p999 | 17.2 | 17.1 | 17.2 | 10.9 | 28.3 | 23.6 | 19.6 |
| | mean | 0.276 | 0.277 | 0.276 | 0.264 | 0.270 | 0.266 | 0.261 |

Reading:
- **Screen-colour fireflies go.** On the sphere the worst outliers drop 6x (p999 23.9 -> 4.0 x mean) and relStd 0.79 -> 0.56 at the same mean (-3 %); on the arcade floor fireflies halve (2.7 -> 1.25 %), mean +0.6 %. D49's truncation cuts relStd as much but keeps the outliers (p999 21) and adds +8 % mean on the sphere.
- **cone x2 = cone on the sphere**: its cone is already at the 6-level cap (~39 px wanted at 960x540, 32 max). On the arcade (longer rays, smaller alpha) x2 still helps (fireflies 0.52 %).
- **carConcept paint: the cone does nothing.** Paint rays hit the mirror floor, whose screen colour is dark; the variance is the re-shaded specular (the studio softboxes through the floor, W45). That part is `hitLobeFilter`'s, and compensation shrinks it by sqrt(f) while the sample narrows only by sqrt(1 - f): at f 0.3 the specular part gets 0.55 alpha of filter on a 0.84 alpha sample, so outliers rise (p999 17 -> 28) and fall again with f (19.6 at 0.7). That is the honest budget at work: today's k 1 over-filters (x1.41) and hides those samples.

### Energy (W45's metric, `energy.js`)

Showcase carConcept, hero, 1280x720, rt off, denoised; 64-frame linear means of the denoiser's input (`hybrid.signalTarget`) and output (`hybrid.denoised`) over W45's rows (x 560-720; door paint y 345-388, skirt y 396-438; `energy-regions.jpg`). loss = 1 - denoised / raw. (The absolute values are not W45's 0.35 / 0.027: different signal and many changes since; compare losses.)

| config | door raw | door loss | skirt raw | skirt loss |
|---|---|---|---|---|
| default | 1.039 | 15.0 % | 1.045 | 18.5 % |
| cone | 1.038 | 15.0 % | 1.045 | 18.5 % |
| cone x2 | 1.038 | 15.0 % | 1.046 | 18.6 % |
| trunc 0.5 | 0.954 | 5.5 % | 1.026 | 8.8 % |
| comp 0.3 | 1.010 | 17.1 % | 0.948 | 26.4 % |
| comp 0.5 | 0.991 | 13.3 % | 0.958 | 19.7 % |
| comp 0.7 | 0.971 | 9.8 % | 0.956 | 13.8 % |

### Bench Measure vs PT (`measure.js` + `measure-configs.js`)

carConcept at W50's pose, 960x540, PT 16 spp, 48 warm-up + 8 measured frames; luma / MAD of the 8-frame mean vs the PT.

**The stage's mirror floor (r 0.03)** (`measure-carConcept-w50-960.txt`): raw and denoised are unchanged by every config (frame 12.1 / 12.8, car 29.8 / 32.4, door 14.4 / 14.7, within 0.2): the floor's alpha 0.0009 puts every cone below one pixel, and the paint's variance is the specular part. ours-rt: 8.4 -> 7.7-7.9 (frame), door 11.8 -> 14.1, but that first row is an artefact: re-run alone (`-rt-order.txt`), default / cone / default / default give door 109.8 / 109.8 / 109.8 / 109.9 and lip 41.7 / 41.5 / 41.6 / 41.7, so ours-rt measured in the first config of a page with raw and denoised also live reads differently (not chased; noted for the lead).

**A glossy floor, `floorRoughness=0.3`** (`measure-carConcept-w50-960-floor03.txt`; a discarded warm-up config first), MAD raw / denoised:

| config | frame | car | wheel (PT 68.3) luma, MAD | door (PT 140.9) luma, MAD |
|---|---|---|---|---|
| default | 10.3 / 10.0 | 18.8 / 17.2 | 69.2 / 89.5 lum, 13.8 / 21.6 | 129.3 / 131.7 lum, 26.6 / 16.6 |
| cone | 10.4 / 10.0 | 18.9 / 17.3 | 69.8 / 89.9, 14.0 / 22.0 | 129.2 / 131.6, 26.7 / 16.6 |
| comp 0.5 | 10.4 / 9.8 | 19.2 / 15.7 | 62.1 / 78.7, 14.3 / 12.5 | 124.3 / 127.5, 26.3 / 16.9 |
| comp 0.7 | 10.5 / 9.9 | 19.8 / 16.5 | 59.0 / 75.2, 15.8 / 12.3 | 123.8 / 126.3, 25.0 / 18.0 |
| trunc 0.5 (D49) | 10.3 / 9.8 | 19.1 / 16.2 | 55.3 / 69.6, 16.4 / 11.8 | 125.3 / 127.3, 22.0 / 16.5 |

Measure scores the mean, and the cone mostly moves variance, so 'cone' alone is within noise of the default (wheel 13.8 -> 14.0 raw). With the bias (either form) the denoised wheel reflection, too bright by 21 levels at the default, comes down (89.5 -> 78.7 comp 0.5, 69.6 trunc 0.5; PT 68.3) and the denoised car region improves 17.2 -> 15.7; the door darkens 4-5 levels away from the PT. Truncation and compensation are close on these means; they should differ in width, which is what the line-spread gate measures.

The cone leaves the denoiser's loss where it is (that loss is the specular part's). Compensation at 0.7 lowers it (15 -> 10 %, 18.5 -> 14 %) but the raw mean drops 7-9 %, so the denoised value barely moves (door 0.882 -> 0.875, skirt 0.852 -> 0.824). Whether the drop is bias or truth needs the PT (phase 2 / the Measure below).
