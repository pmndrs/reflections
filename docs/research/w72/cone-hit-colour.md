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

(see below)
