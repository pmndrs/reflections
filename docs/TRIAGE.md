# Triage

Everything left to do in this repo, as one ranked list with impact and effort. It's for the maintainer and for the next agent picking up work. Built on 2026-11-13.

**Sources.** The "Fine-tune backlog" in [HANDOFF.md](HANDOFF.md). The second lead's divergence triage page (its open fix / decide / wait rows, checked against today's [DIVERGES.md](DIVERGES.md) status). The DIVERGES entries added after it (D3500 and up). The calls in [DECISIONS.md](DECISIONS.md) that were accepted and not built yet. The X0-X5 streams in [plans/ssr-sources-experiments.md](plans/ssr-sources-experiments.md). The "next" notes in `docs/research/*-w5*.md`.

**How it's ranked.** By the maintainer's priorities (2026-11-13):

- Flicker and fireflies come first. Those rows carry `flicker`.
- Simple test scenes come before more car tuning. Bevel refinement on carConcept is low unless it also helps flicker.
- Lighting and GI gaps are out of scope, because this package is neither a GI system nor a path tracer. They stay listed so nobody investigates them again.
- Release-dependent work is `waiting`.

Impact is what a user would see, in this order: flicker, then visible artefacts, then accuracy vs the PT, then perf, then maintenance. Effort: `S` is under half a day of agent work, `M` is one workstream, `L` is several workstreams or another repo.

Status values:

- `ready`: the fix is known; it can be done now.
- `accepted`: the maintainer decided it; not built yet.
- `experiment`: needs measuring first.
- `decide`: needs a call.
- `waiting`: on another repo or a release (named in the row).
- `platform`.
- `out-of-scope`.

**Keeping it current.**

- When a row is done, delete it and add the W id to HANDOFF's log.
- New items go here with a rating. Their details go in HANDOFF or DIVERGES.
- Open questions go on the [Decisions page](https://claude.ai/artifact/E8qHQUAKxkGbW6wQ2F2sCX), not here.
- `refs` lists every W, D, X and decision id a row covers. Search for an id to find its row.

## Top 10, in order

1. **T1: flicker and firefly metrics.** Flicker is the #1 pain point, and none of the flicker experiments (T2-T7) can be judged without numbers per region (D3622, X0). First step: build X0's rest drift, orbit flicker, 2x2 energy, edge pan and raw speckle count as bench Measure columns, then baseline every scene.
2. **T53: simple test scenes.** The maintainer asked for these so the bevels stop deciding the tuning. T10 and T14 are queued behind them (decisions 20, 21). First step: as bench scenes with the PT reference, add a cube or slab on the mirror, sharp edges above it, and a thin plate over the floor. Build T1 and T53 in one worktree (they are X0).
3. **T10: quadCopy 'sameSurface' as the default.** It's accepted (decision 21) and cheap (+0.27 ms), and it removes the raw stair step that seeds the halo (W58). First step: run W58's Measure on chess, toyCar, Sponza and T53's scenes, then flip the default if they're flat or better.
4. **T2: rotate the quad's traced pixel (X1 #1).** It's the cheapest attack on static 2x2 patterns and on the contact rest drift under the upscaler (W39: 3 % of px > 8/255). First step: add `quadBaseRotation`, then measure it with T1.
5. **T29: no geometry roughness on the examples with AA on.** Accepted (decision 19), S. It cuts about 40 % of the chrome star's excess (W56). First step: flip it, and record the paint-flicker cost with T1 (W56: +1.3 % with AA).
6. **T21: wheel probes at 64 px as carConcept's default.** Accepted (decision 18), example-only, S. Hub 44 -> 27 (PT 28), W55. First step: change the showcase and bench defaults, then re-run Measure.
7. **T22: Sponza on oneSize128.** Accepted (decision 12), S. +3.5 dB vs the PT at a third of the memory (W62). First step: confirm that "fine" meant switch (DECISIONS asks this), then flip the layout.
8. **T30: specular AA as a package option.** Curved glossy edges still alias (W46). A variance-form term would replace three's geometry roughness without its sparkle cost (W56), so it serves both flicker and the star. First step: a Tokuyoshi 2019 term next to specAA, measured with T1.
9. **T3: cone-footprint hit colour + mirrorBias compensation (X2).** It goes after raw fireflies at the source and makes `mirrorBias` honest (D49, D3550). First step: `hitColorFilter: 'cone'` on a downsampler pyramid, gated on line spread.
10. **T14: lobe occlusion for traced hits.** Accepted (decision 20). It is the one fix for the hub, the floor under the car (24 vs PT 8) and the reflected wheels (D3681, W56). First step: build it as an option, off by default, and tune it on T53's scenes before the car.

Next in line: T4 (X3 ratio reuse: the biggest noise win on paper, but L, and it replaces the quad copy that T2 and T10 work on), T24 (silent texture-limit failure, S), T12 and T16 (X1, S each).

## Impact x effort

Row ids per cell. Out-of-scope rows are left out.

| impact \ effort | S | M | L |
|---|---|---|---|
| **high** | T1, T2, T53 | T3, T10, T30 | T4 |
| **med** | T5, T12, T16, T17, T21, T22, T24, T29 | T6, T11, T14, T15, T23, T25, T26, T27, T40, T41, T54, T58 | T7, T18, T35, T36, T37, T38, T42, T48, T52, T59 |
| **low** | T8, T9, T13, T19, T32, T33, T43, T45, T47, T49, T55, T56, T57, T60, T61, T62, T63, T64 | T20, T28, T44, T46, T50, T51 | T31, T34, T39 |

## The full table

Grouped by area. Within an area, rows are roughly in the order to do them.

### Flicker & noise

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T1 | Flicker and firefly metrics on the bench and in pnpm check: rest drift, orbit flicker, 2x2 energy, edge pan, raw speckle count `flicker` | high | S | ready | X0, D3622, W39, W40, W56 | Build X0's metrics in examples/shared/metrics/ as bench Measure columns; baseline every scene at today's defaults. |
| T2 | Rotate the quad's traced pixel (X1 #1); also the contact rest drift under the upscaler `flicker` | high | S | experiment | X1 #1, W39 (contact drift), D3663 | Add quadBaseRotation 'fixed' \| 'frame' \| 'pattern' (default fixed); measure rest drift, 2x2 energy and orbit flicker with T1. |
| T3 | Cone-footprint hit colour + mirrorBias compensation (X2): fewer raw fireflies, honest mirrorBias, the D3550 double blur `flicker` | high | M | experiment | X2 #5 #6, D49, D3550, W32, W39, W40 | Build hitColorFilter 'cone' on a downsampler pyramid; gate on line spread (±10 % of PT); count raw speckles with T1. |
| T4 | Ratio-estimator ray reuse (X3): 1 ray + reuse ≈ 4 rays of noise; replaces FFX's quad copy `flicker` | high | L | experiment | X3, decision 13, D50, D3550, D3663 | Phase A in core: rayReuse 'copy' \| 'ratio'; target denoised std at spq 1 ≈ copy at spq 4 on glossy floors. |
| T5 | History hit colour: confidence at screen edges (X1 #4), pops in pans `flicker` | med | S | experiment | X1 #4, D1002 | Add historyEdgeConfidence (default off); measure edge pan and the traced-ray count with ?rt=1. |
| T6 | Raw-signal fireflies with the denoiser off: r 0.35 sphere, car paint, offscreen floor at 512 px, pixi arcade `flicker` | med | M | experiment | W12, W17, W60, W18, W19, D50 | Track with T1's speckle count; re-measure after T3 / T4. W60's case is the SSR / probe blend against a sharper probe. |
| T7 | Reflection-aware motion for the upscaler and denoiser: reflected detail smears in motion; reactive mask; glass flag `flicker` | med | L | experiment | D4202, D3500, W36, decision 14 | Prototype the hit's reprojection (FFX reflection reprojection) as an upscaler input on facingMirrors; compare with a reactive mask. |
| T8 | Examples' GTAO grain reaches rough surfaces with ?specOcc=1 (no temporal filter or blur) `flicker` | low | S | ready | D4510, W39 | Add three's denoise node or a temporal pass in examples/shared/ao.ts; time it at 1080p. |
| T9 | Display sharpness: the AA softens the image; RCAS is off at ratio 1 | low | S | experiment | W40, D4201, D3500 | Try RCAS sharpness > 0 and with ?upscale=; keep it only if T1's flicker numbers don't rise. |

### Edges & silhouettes

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T10 | 2x2 quad copy at edges: quadCopy 'sameSurface' default after a scene check, then edge-aware upsample of the per-quad result | high | M | accepted | decision 21, D3740, D3663, D3661, D3610, W58, W53 | Run W58's Measure on chess, toyCar, Sponza and T53's scenes; flip the default if flat or better. Upsample after. |
| T11 | Back-face depth layer (RT off): sphere fringe, dark band under the sill, white gap under the car, contact crescent | med | M | experiment | D2402, D4303, W41, W44, W21, W22 | One back-face depth target + thickness test; measure fringe px (W44's metric) and the sill band with RT off. |
| T12 | Depth-scaled SSR thickness (X1 #2): one k for every scene scale; stripes and streaks behind objects | med | S | experiment | X1 #2, D1001, D1000, W9, W12, W17 | Add thicknessDepthFactor (default 0); sweep k on toyCar, rooms, carConcept, Sponza; streak % and stripe ratio. |
| T13 | hitLobeFilterMixed reads last frame's hit source without reprojection (one frame late in motion) | low | S | ready | D3641, W52 | Reproject the hit-source signal through motion before the lobe filter reads it. |

### Hit shading & occlusion

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T14 | Lobe occlusion for traced hits' specular (hub, floor under the car, reflected wheels), plus re-shade occlusion tuning | med | M | accepted | decision 20, D3681, D3513, D3510, D3540, D3542, D3640, D3642, W44, W52, W54, W55, W56 | A few BVH rays or a cone over the hit lobe (option, off); tune on T53's scenes first, then the floor under the car (24 vs PT 8). |
| T15 | Mirror-in-mirror under the re-shade shows the probe, not the other mirror's reflection | med | M | experiment | D3544, D4500, W44 | Blend last frame's specular where the camera's R and the ray's R agree; measure on facingMirrors. |
| T16 | Shrink the lobe filter at grazing angles (X1 #3) | med | S | experiment | X1 #3, D3641, D3550 | Add hitLobeFilterGrazing; run the grazing sweep at 0 / 0.5 / 1 (--only ssr-exp-grazing) and the line spread at 15°. |
| T17 | Hit weight ignores AO and envMapIntensity: dark-AO or env-0 materials still show SSR / traced hits at full Fresnel | med | S | decide | D2800, D4511 | Put it on the Decisions page: one multiply behind a setting, default today's output. |
| T18 | Textured materials at traced hits (one colour per mesh today), normal side, alpha-tested foliage, undrawn triangles | med | L | ready | D902, D2901, D3571, D3600, D3602, W11 | UVs in the BVH and texture bindings in the provider; start with base-colour maps on Sponza. |
| T19 | Traced hits read 1.10x on-screen brightness at 256 px probes; ssr-rt checks pin probeRes=128 | low | S | experiment | W31, HANDOFF quality experiments | Compare the hits' roughness-1 lookup at 128 vs 256 px on contact; unpin the checks once explained. |
| T20 | RT scene coverage: skinned meshes (GPU refit / setPoseCpu), hit shadow casters ignore castShadow | low | M | ready | D1703, D700, D2600, D3591, D2601 | Wire GpuMeshRefit and per-instance masks when a scene needs them (masks cost 1-6 %, D3591). No kit scene does today. |

### Probes

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T21 | Wheel-well probes at 64 px as carConcept's default | med | S | accepted | decision 18, D3700, W55 | Make carProbes=wheels&carProbeRes=64 the showcase and bench default; re-run the bench Measure. |
| T22 | Showcase Sponza: switch to oneSize128 (11 volumes at 128 px, +3.5 dB vs PT at a third of the memory) | med | S | accepted | decision 12, W61, W62, W63 | Confirm 'fine' meant switch (DECISIONS asks), then flip the showcase layout and re-run --only showcase. |
| T23 | Oriented probe boxes: a rotation per volume in core, three and the W63 grid | med | M | accepted | decision 18, D3701, D4950, W55 | Add 3 rotation rows per volume; box test and parallax in the local frame; check the front-tyre step goes. |
| T24 | Material-side texture-limit warning: a three material past maxSampledTexturesPerShaderStage fails with no message of ours | med | S | ready | W62, decision 16, D4900 | At bake / reflectionProbes() time, count each lit material's sampled textures plus the atlases; warn with the fix. |
| T25 | Near-mirror floors show the HDRI blurred: misses take the probe, the PT and three's SSR show it sharp | med | M | experiment | W21, W30, D1806 | Try a full-resolution environment past the probes for misses below the mirror threshold (three's path, not core). |
| T26 | SSR-to-probe step on glossy floors is radiance, not blur; our env-slot captures read ~8/255 darker than PMREM ones | med | M | experiment | W26, D3201, D903, D25 | Compare the two roughness-1 irradiances of mirrorWall's sky (env slot vs PMREM), then re-run --only seam. |
| T27 | Blended seams between neighbouring probes (hero in the RT-off floor, floor-quadrant probes) | med | M | decide | D4401, D4800, W38, W61 | Parked by the maintainer (2026-11-12); put it on the Decisions page after T21 / T23 land. |
| T28 | Probe research leftovers: r < 0.2 extra mip, BC6H split, SH9 vs L1, octa-hemi, prefilter, bake slices, 1024 px oddity | low | M | experiment | D3, D4, D57, D60, D63, D64, D101, D804, D806, D4300, W1, W37, W60 | Leave until a scene shows one; each is a run in examples/probe-bench or examples/probes. |

### Composite & materials

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T29 | Examples drop three's geometry roughness when the AA is on `flicker` | med | S | accepted | decision 19, D3720, W56 | Set geometryRoughness off under the upscaler / AA; record paint flicker with T1 (W56: +1.3 % with AA). |
| T30 | Specular AA as a package option: normal variance (specAA) + a geometric term, replacing three's geometry roughness `flicker` | high | M | experiment | D3570, D3552, D3571, D3720, W46, W56, decision 3 | Variance-form AA (Tokuyoshi 2019) next to specAA; measure curved-edge sparkle with T1 and the chrome star. Needs a node-material hook. |
| T31 | Clear coat: subtract the coat's IBL in the composite (grazing edge line), then SSR / RT for the coat layer | low | L | experiment | D3512, D3741, D3541, D603, W41, W44, W58, W11 | Start with the coat env term (F_Schlick(0.04) x DFG at the coat roughness, coat normal) on carConcept's skirt line. |
| T32 | Specular occlusion darkens near-mirror misses beside lit objects with RT off | low | S | ready | D4513, D3551, W39, W45, decision 7 | Fade SO toward 1 below the tracer's threshold, or weight it by hit distance / confidence. |
| T33 | Transmissive glass casts shadow-map shadows in the examples | low | S | ready | D3682, W54 | Skip castShadow for materials with transmission > 0 in examples/shared/gltf.ts. |
| T34 | Transparent objects in the G-buffer (glass is not split out of the pass) | low | L | experiment | D404, D3520, W42, W54 | No action: W54 found the glass reflection matches the PT (121.9 vs 121.7). Revisit on a scene where it doesn't. |

### Denoiser (other repo)

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T35 | Near-mirror rest shimmer: GGX lobe noise the denoiser leaves; try a longer history for near-mirrors `flicker` | med | L | experiment | W40, W32, W39 | Measure with T1 at rest and in W39's pendulum; then a denoiser branch (W53-style) with a longer near-mirror history. |
| T36 | Denoiser PRs #24-26 (motion scale, variance, tile list): variance-guided tracing, drop the guides pass `flicker` | med | L | waiting | D46, D1400, D307, D68, W21 | Waiting on the denoiser repo (#24-26). When #25 lands, turn on variance-guided tracing (W21: spq 4 std 0.14 -> 0.10). |
| T37 | The FFX denoiser loses 26-46 % of heavy-tailed glossy energy (luminance weight clips bright samples) `flicker` | med | L | experiment | D3550, W45, X3 phase B | Report to the denoiser repo now; try BRDF / pdf weights in the prefilter (X3 phase B) after T4's phase A. |
| T38 | Denoiser hit-source option (denoiser#29): review, land, pick a default; its +0.35-0.5 ms affinity cost | med | L | waiting | D3660, D3661, D3662, W53, decision 13 | Waiting on the denoiser agent's review of #29; then pick 'hits' or off on the bench. |
| T39 | FFX spatial filter spreads rough neighbours into small near-mirror parts (carConcept's chrome star) | low | L | experiment | D3721, W56 | On a denoiser branch: harder roughness / normal weights for near-mirror centres, or no spatial pass below an alpha. |

### Performance

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T40 | Half-rate glossy RT misses + bilateral fill (X4); the cheaper-RT roughness gate | med | M | experiment | X4, decision 14, SPEC open question 4 | Add tracedMissRate 'half' and the bilateralFill kernel; RT ms and error vs PT on offscreen, carConcept, moving. |
| T41 | One probe walk per lit material: three's radiance and irradiance contexts each walk the volumes at one P | med | M | ready | W63 | Return radiance and irradiance from one walk (and the composite's lookups); time at 1080p on Sponza. |
| T42 | Half-res trace and denoise with joint bilateral upsample (X5) | med | L | experiment | X5, D1400 | After T40: step 1 all half-res, step 2 mirrors at full res; target ≥ 0.5 ms saved at 1080p inside the line-spread gate. |
| T43 | Skip the probe-table re-pack and upload when volumes didn't change; share the hit shading's copy | low | S | ready | W63, D2900 | Add a version on ReflectionProbes; skip pack + upload (+64 KB per set, 13-41 us CPU) when unchanged. |
| T44 | Denoised hybrid's extra signal pass and second probe lookup | low | M | ready | D1401, W10 | Write probeEnv to a second MRT target; time the denoised hybrid (0.9-1.4 ms over raw at 1080p). |
| T45 | Shadow-ray traversal order (anyHitOrder) on our hit shadow rays | low | S | experiment | D2601, W25, D903 | Time 'far' / 'larger' / 'near' on moving and Sponza at 1080p; the hits never change, only the cost. |
| T46 | Time the three adapter's G-buffer, copies and composite (8th coat target); caller-allocated outputs; RT buffer headroom | low | M | ready | W6, D606, D2002, D3541, HANDOFF Performance | Timestamp each pass; then let core take caller-allocated outputs (33 MB of copies per 1080p frame). |
| T47 | Re-time on a quiet or discrete GPU: PROBE_UNROLL_MAX_VOLUMES, probe-count guidance, D4400 medians | low | S | ready | W63, W38, D4400 | One quiet-machine run with the render loop stopped (rule 3); update the constant and SPEC's guidance. |

### Adapters (babylon / pixi)

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T48 | Re-shade and denoiser on Babylon / pixi: diffuse albedo and F0 in their G-buffers, no denoiser hookup `flicker` | med | L | experiment | D55, D1803, W18, W19, D1802 | Hook the denoiser into examples/babylon first; check roughnessUnpack on the GPU there. |
| T49 | Distance-based roughness is off in core's ProbeSet (Babylon, pixi), on in three | low | S | ready | D2701, W26 | Turn it on and run --only babylon and --only pixi3d. |
| T50 | Babylon cleanup: SO on the fallback only, coat base layer, velocity.z, core conventions, capture transform | low | M | ready | D3000, D3002, D3003, D1800, D1801, D1805, W35 | D3000 first (its trigger has fired); the rest when a third engine needs them. |
| T51 | pixi composite: material occlusion on reflections, split-sum vs pixi-3d's own env, three submits a frame | low | M | ready | D4512, D2004, D2006, W34, W39 | An env-only compare like Babylon's iblCompare; fix D4512 when a pixi-3d scene has AO maps. |
| T52 | pixi-3d closed beta: G-buffer source, material values, no-env-specular switch, HDR filters, stale arcade probe | med | L | waiting | D2100, D2101, D2102, D2005, D2003, W19 | Waiting on pixi-3d going public with a G-buffer output and a no-environment-specular switch. |

### Test scenes & tooling

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T53 | Simple test scenes: a cube / slab on the mirror, sharp edges above it, a thin plate over the floor (+ X0's strip and grazing floor) | high | S | ready | maintainer 2026-11-13, X0, decisions 20 / 21 | Add them as bench scenes with the PT reference and named regions; baseline them before any more car tuning. |
| T54 | Path-traced ground truth for the ssr kits (moving, mirrors), then retune the hybrid thresholds against it | med | M | ready | HANDOFF tracked fixes (Q2), D52, D4301, D4402, D4802, D4701, D3513, D901, W37, W38 | Reuse the compare page's WebGPU tracer (W21 / W23) on the ssr kits; then sweep D52's cut-offs. |
| T55 | Check runner: a full run passes the 10-min limit, leaves Chromes behind; flakes; parity on full lit images | low | S | ready | W47, W48, W49, W63, W38, W7, F3 | Split the default run or raise the limit; close Chromes on timeout; compare atlas texels for probe parity. |
| T56 | Tooling odds: bvh dist age, grey out #29 controls, cube2d compile error, probe weight export, bench three-side upscale | low | S | ready | D3590, W48, W53, W35, D4801, D4803, D3620, D3621, D1502, W51 | One small tooling worktree; each item is under an hour. Also the shared Sponza view and the dts heap. |
| T57 | Re-run the W21 compare readouts against the WebGPU + OIDN reference (clear coat in) | low | S | ready | W23, W21, D2305, D2303 | Re-run docs/research/showcase-compare.md when its numbers next matter; raise samples for sub-8-bit calls. |

### Platform / waiting

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T58 | Releases: bvh + downsampler to npm, switch links, bvh as package default, publish 0.1, packed subpaths, denoiser PR #27 | med | M | waiting | SPEC follow-ups, decision 8, D3590, D3623, D905, D1705, W24 | Waiting on the maintainer's bvh and downsampler releases, then on a stable @pmndrs/reflections. |
| T59 | three lighting-model hook: direct highlights in scene colour; coat, sheen, iridescence in the specular swap | med | L | waiting | D400, D603, D3540, W50 | Waiting on a three hook; D1002's history mode covers the worst symptom meanwhile. |
| T60 | three cube arrays (#35053) and #35046's node output: drop the shim and the 2D fallback; converge the nodes | low | S | waiting | D1, D2, D2200, D2201, D2202, D20, D22, W20 | Waiting on three #35053 / #35046. Re-run --only probes on every three bump (the shim is version-gated). |
| T61 | three upstream issues: per-object uniforms, shadow maps across cameras, velocity reset, node props on stock materials | low | S | waiting | D500, D501, D802, D700, D3572 | File D500 / D802 with their repros; #35485 (D3572) is filed. Workarounds stay. |
| T62 | Compatibility-mode probe bake (the downsampler reads and writes mips of one texture in one dispatch) | low | S | waiting | D4100, W35 | Waiting on a compat path in the downsampler; then re-run probe-core's compat(). |
| T63 | @pmndrs/upscaler keeps presenting its first frame when its GPU timer can't allocate | low | S | waiting | D3624, W51, W48 | Report to the upscaler repo; then turn the bench's upscaler timings back on. |
| T64 | 75/255 point-light highlight flake on instanced lit spheres (likely Dawn / Metal) | low | S | platform | D1 (debug row), docs/research/d1/ | Send the drafted upstream report in the D1 row. |

### Out of scope

| id | item | impact | effort | status | refs | next step |
|---|---|---|---|---|---|---|
| T65 | carConcept cabin too bright through the glass; seat lighting; AO on three's diffuse; a per-material probe mask | low | L | out-of-scope | D3680, D3702, W54, W55 | Why: three's IBL / GI, not reflections. A cabin probe barely moves it (68.5 -> 64.6, PT 29.8; W55). |
| T66 | Wheel interiors (disc, caliper) brighter than the PT | low | L | out-of-scope | D3680, W54, W55 | Why: three's unoccluded IBL. T21's wheel probes take most of it (53.1 -> 26.6, PT 18); the rest is lighting. |
| T67 | Glass: pawn-orb refraction, and the cabin seen through the windows | low | M | out-of-scope | D3521, W42, W54 | Why: refraction and lighting. Our glass reflection matches the PT (121.9 vs 121.7, W54). |
| T68 | Sponza's shade bias vs the PT (and the missing raster AO) | low | L | out-of-scope | decision 4, W46, D2303 | Why: raster lighting without GI. Judge reflection changes on reflection-heavy px or vs reflections off. |

## Settled, don't reopen

Findings and calls a new worker might otherwise redo. Each has a pointer.

- **The skirt halo** comes from three things together: the quad copy across the silhouette, the re-shade x the lobe filter, and the denoiser spreading bright floor hits over dark traced ones. At 1080p it is mostly gone. W50, W52, W53, W58; D3610, D3643. What's left is T10 and T38.
- **The chrome star** comes from three's geometry roughness plus the denoiser's spatial spread; the lobe filter adds to it only through the star's neighbours. Normals, probe resolution and the re-shade are not the cause, and the floor-under-car lead is ruled out for the star (0.1 % of its rays). W56; D3720, D3721.
- **The thin line in `view=off`** is three's clear-coat env reflection on the grazing bevel. It doesn't seed the halo. W58, D3741.
- **The floor under the car is too bright** because the specular of the underside hit is unoccluded. That is T14, not a shadow problem: the floor is a metal mirror. W56, D3681.
- **Wheel interiors and the cabin** are base three's IBL, not our reflections. The glass reflection matches the PT (121.9 vs 121.7). W54. See T65-T67.
- **Sponza's gap to the PT** is raster lighting without GI. Judge reflections there on reflection-heavy pixels or against reflections off. Decision 4, W46.
- **carConcept's paint vs the PT** was three's mipmapped flake normal map. It is fixed in the examples by specAA (on by default). D3552, D3570, decision 3.
- **The "constantly vibrating" look** was SSSR's per-frame GGX sampling. The denoiser was running. W40.
- **`mirrorBias`** gives no gain with the denoiser, at rest (W32) or under the upscaler in motion (W39). The default stays 0. D49.
- **`hitLobeFilter`** stays at 1 (decision 2, W45). Setting it to 0 brings back W50's lip.
- **With RT, re-shaded on-screen hits skip the visibility ray** by default. `hitShadeVisibility: 'all'` is a per-scene setting for mirror-in-mirror scenes. Decision 5, D3542, D3640.
- **Not adopted:** sending glossy SSR hits to RT (D3543), and on-screen reuse of metals (D3511).
- **Sphere fringe:** RT already removes it (50 -> 0 px). The idea of a thinner test when RT is on was dropped. Only the RT-off back-face layer is left (T11). W44, D4303.
- **Basic, Lambert and Phong materials** get no reflections, by design. It's documented in the README. Decision 15, D2802.
- **The denoiser is on by default**, with an opt-out. D50.
- **Sponza's 18 sampled textures** came from three's composite binding every atlas twice. Fixed; four sizes fit the default 16. W62, D4804.
- **Probe lookup cost per volume** is fixed by W63's grid (32 volumes: 9.6 -> 0.85 ms at 1080p). D4950.
- **Probe placement matters more than probe size** at equal memory. W61, W62, SPEC "Choosing probe sizes".
- **Probe defaults:** the alpha lod mapping, 256 px and 2 bounces. W31, W37; D23, D101, D4300.
- **Lagarde's distance-based roughness** is on in three's lookup. The roughness lerp is off because it made scenes worse. W26, D53.
- **The facingMirrors translucent wedge** is a real shadow from the right mirror's frame. D4302.
- **@pmndrs/bvh** is the examples' RT provider. The package default waits for npm (T58). Decision 9, D3623.
- **The probe fallback behind objects** is the probe's parallax-shifted view from one capture point. `?rt=1` fills it. W12.
