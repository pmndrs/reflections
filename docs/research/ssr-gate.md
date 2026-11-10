# Phase 3 gate: our screen-space reflections vs three r187's `SSRNode`

G1, 2026-11-10. The bench is `examples/ssr-bench/`. Reproduce with
`REFLECTIONS_PORT=<port> pnpm check -- --only ssr-bench --ssr-bench` (writes `out/ssr-bench.json` and
`out/ssr-bench-<scene>-<method>.png`), and `--ssr-timing-only` to repeat the 1080p timing. The data
behind every number here is `docs/research/ssr-bench.json` (run 1: metrics and timing) and
`docs/research/ssr-bench-timing.json` (run 2: timing only). `pnpm check --only ssr-bench` is the smoke
(every method renders, finite, no validation error), not a numbers gate.

Machine: Apple Silicon (`metal-3`), Chrome 157 headless, WebGPU through Dawn/Metal, branch
`worktree-agent-ab9e09d544fc6b2c9` at main `89ed133`. **16 other headless Chromes from other
worktrees shared the GPU during both runs**, so the absolute ms carry contention. Don't compare them
with numbers from the main checkout (CLAUDE.md rule 3).

## Verdict: pending the denoise seam

| SPEC phase 3 gate | Result | Verdict |
|---|---|---|
| Subgroup and fallback variants produce identical lists and images | Checked by W3/W6 in `pnpm check` (`sssr-core`, `ssr`): lists equal after sort, 0 px differ at occupancy 0. Not re-measured here. | passes (W3, W6) |
| No boiling on the rooms and G1 | Ours has no denoiser yet (phase 5, rule 7), and raw it boils: one ray per 2×2 quad on glossy pixels. Rooms still flicker p99 0.018 against 0.0037 for three + its denoise. With the bench's trivial temporal stand-in it's 0.0020. G1 (the denoiser cleanroom scene) isn't in this repo's kit, so it wasn't run. | **not decidable without the denoiser** |
| Flicker at or below three `SSRNode` + its denoise | Raw: above it on 3 of 4 scenes (still std mean 2.6–46× higher; below it only on mirrorWall, where most glossy pixels are mirrors). With the stand-in, still: below it on rooms and mirrorWall, above it on explainer and roughnessRamp. Orbit `|Δe|`: below on rooms, about equal on explainer, above on mirrorWall and roughnessRamp. | **not decidable without the denoiser** |
| GPU ms at or below three `SSRNode` + its denoise | Ours raw adds **0.56–1.13 ms** at 1080p. Three's SSR + TemporalReproject + RecurrentDenoise adds **2.24–5.04 ms**. That leaves 1.1–4.3 ms per scene for our denoiser. | passes raw; **the budget for the denoiser is the open question** |

**Why "pending" and not "fail":** the gate compares SSR plus its denoiser with SSR plus its denoiser. Ours has no denoiser in this repo by design. The FFX reflection denoiser plugs in through the denoise seam in phase 5, from the denoiser repo. What the raw numbers do show:

- **Accuracy.** Ours, raw or with the stand-in, has the lowest RMSE on every scene: raw 0.010–0.039 against 0.029–0.092 for three + denoise. The reference shares our composite, though, which favours us; see "Reference".
- **Cost.** It is the cheapest per frame of the methods worth shipping.
- **Noise.** The remaining gap is plain noise, which is exactly what a denoiser removes. A simple exponential history (not a product feature) already beats three's denoised flicker on two scenes.

**What decides it.** Re-run this bench with `FfxReflectionDenoiser` behind the seam. Ours plus FFX has to stay at or under three + denoise in both flicker and ms.

- **Flicker** is likely to pass: FFX halves flicker over its own spatial-only output in the denoiser repo, and spatial reuse also fixes the per-pixel blue-noise line (below).
- **Milliseconds are the risk.** The denoiser repo measured FFX reflections at 3.7 ms minimum at 1080p, processing every tile, with no subgroup paths, in another checkout on another day (`denoiser/docs/specs/temporal.md`). That's not comparable to these numbers, but it sits at the top of our 1.1–4.3 ms headroom. If that holds, the denoiser needs our denoiser tile list (it skips non-reflective tiles) to pass on mirrorWall and explainer.

## Results (960×540 metrics; GPU ms at 1920×1080)

Five numbers per scene and method, in the denoiser scorecard's style. Values are luminance after a per-channel Reinhard tone map `x/(1+x)`, in [0, 1], over the scene's **glossy pixels**: geometry with perceptual roughness < 0.447, our tracer's threshold.

- **Bias**: mean signed error against the reference, over the 32 still frames.
- **RMSE**: per-frame error, so noise counts.
- **Still flicker**: per-pixel temporal standard deviation over 32 frames with a fixed camera, after 64 warm-up frames (temporal methods converged). Mean / p99 over the pixels.
- **Orbit flicker**: 32 frames along a 0.3°/frame orbit about the view's target (9.6° in all), continuing from the still pose. The error is **motion-compensated**: e_t = output_t − reference_t, with a reference rendered at every orbit pose.
  - `|Δe|` is the scorecard's mean |e_t − e_t−1|.
  - `std` is the per-pixel temporal std of e_t. It includes slow drift of the error along the path, which is why deterministic `three-blur` has non-zero orbit std.
- **GPU ms**: the method's frame minus its own pipeline's baseline (G-buffer plus lit image), at 1080p, loop stopped, median of 30 frames from timestamps. The ranges cover two runs; the total frame is in brackets.

| scene / method | bias | RMSE | still std mean / p99 | orbit \|Δe\| | orbit std mean / p99 | GPU ms (frame) |
|---|---|---|---|---|---|---|
| **rooms** (146k glossy px; orbit 107k) | | | | | | |
| ours (raw) | −0.0022 | 0.0099 | 0.0029 / 0.0182 | 0.0037 | 0.0053 / 0.0212 | 0.74–0.76 (2.24–2.28) |
| ours + stand-in accumulation | −0.0022 | **0.0084** | 0.0004 / 0.0020 | 0.0011 | 0.0041 / 0.0237 | 0.87–0.90 (2.35–2.44) |
| three `SSRNode` (blur) | −0.0072 | 0.0162 | 0.0000 / 0.0000 | 0.0013 | 0.0062 / 0.0331 | 0.97 (2.61–2.67) |
| three `SSRNode` stochastic, raw | −0.0147 | 0.0293 | 0.0055 / 0.0220 | 0.0049 | 0.0091 / 0.0451 | 1.26–1.47 (2.78–2.86) |
| three stochastic + denoise | −0.0149 | 0.0287 | 0.0011 / 0.0037 | 0.0018 | 0.0057 / 0.0425 | 4.57–5.04 (6.09–6.43) |
| **explainer** (255k; orbit 224k) | | | | | | |
| ours (raw) | −0.0053 | 0.0321 | 0.0053 / 0.0562 | 0.0063 | 0.0093 / 0.1267 | 0.89–1.10 (1.68–1.82) |
| ours + stand-in accumulation | −0.0051 | **0.0287** | 0.0007 / 0.0069 | 0.0033 | 0.0093 / 0.1118 | 1.14–1.19 (1.91–1.93) |
| three `SSRNode` (blur) | −0.0243 | 0.0607 | 0.0000 / 0.0001 | 0.0020 | 0.0073 / 0.1279 | 1.38–1.81 (2.63–2.73) |
| three `SSRNode` stochastic, raw | −0.0092 | 0.0555 | 0.0131 / 0.0701 | 0.0145 | 0.0222 / 0.1424 | 0.85–1.17 (2.02–2.24) |
| three stochastic + denoise | −0.0098 | 0.0513 | 0.0003 / 0.0024 | 0.0030 | 0.0121 / 0.1335 | 3.02–3.10 (4.17–4.19) |
| **mirrorWall** (202k; orbit 196k) | | | | | | |
| ours (raw) | −0.0048 | 0.0168 | 0.0004 / 0.0142 | 0.0020 | 0.0060 / 0.0556 | 1.03–1.13 (1.53–1.63) |
| ours + stand-in accumulation | −0.0048 | **0.0166** | 0.0001 / 0.0024 | 0.0042 | 0.0185 / 0.0858 | 1.18–1.29 (1.68–1.79) |
| three `SSRNode` (blur) | +0.0050 | 0.0368 | 0.0000 / 0.0001 | 0.0026 | 0.0090 / 0.0607 | 2.77–2.88 (3.56) |
| three `SSRNode` stochastic, raw | −0.0507 | 0.0921 | 0.0251 / 0.0900 | 0.0192 | 0.0333 / 0.1010 | 0.78–0.84 (1.25–1.30) |
| three stochastic + denoise | −0.0550 | 0.0918 | 0.0010 / 0.0047 | 0.0028 | 0.0160 / 0.0914 | 2.24–2.29 (2.72–2.75) |
| **roughnessRamp** (55k; orbit 27k) | | | | | | |
| ours (raw) | −0.0075 | 0.0389 | 0.0232 / 0.0672 | 0.0229 | 0.0210 / 0.0672 | 0.56–0.82 (1.27–1.58) |
| ours + stand-in accumulation | −0.0062 | **0.0200** | 0.0029 / 0.0095 | 0.0041 | 0.0077 / 0.0525 | 0.88–0.98 (1.64–1.69) |
| three `SSRNode` (blur) | +0.0329 | 0.0522 | 0.0000 / 0.0001 | 0.0038 | 0.0126 / 0.0831 | 1.32–1.36 (2.42–2.51) |
| three `SSRNode` stochastic, raw | −0.0190 | 0.0524 | 0.0207 / 0.0710 | 0.0176 | 0.0233 / 0.1003 | 1.11–1.56 (2.10–2.17) |
| three stochastic + denoise | −0.0205 | 0.0464 | 0.0005 / 0.0026 | 0.0029 | 0.0097 / 0.0792 | 2.97–3.37 (3.96–3.99) |

Baselines (G-buffer plus lit, 1080p, two runs):

| scene | ours (`FrameGBuffer`, 5 targets) | three blur (`pass()` MRT, 3 targets) | three stochastic (`pass()` MRT, 4 targets incl. velocity; env specular off) |
|---|---|---|---|
| rooms | 1.48–1.54 | 1.64–1.70 | 1.39–1.52 |
| explainer | 0.72–0.79 | 0.92–1.25 | 1.07–1.17 |
| mirrorWall | 0.50 | 0.68–0.79 | 0.46–0.48 |
| roughnessRamp | 0.72–0.76 | 1.06–1.18 | 0.61–0.99 |

### Reading the numbers

- **Accuracy.** The stand-in has the lowest RMSE on every scene (bold), and ours raw the lowest of the rest.
  - Our bias is small and negative everywhere (−0.002 to −0.008). Some of that is Jensen's inequality: the tone map is concave, so a noisy estimate reads darker.
  - three's stochastic path is darker: −0.015 to −0.055. Its misses fall back to the equirect environment only, and its composite (the example's) turns the probes' specular off. In rooms, which has probes and no environment, a miss is black: the mirror ball in `out/ssr-bench-rooms-three-denoise.png`. On mirrorWall and explainer, misses take the dim gradient sky where the probes see the room.
  - three's blur mode adds SSR on top of a lit image that already holds the probe or environment specular (the basic example's composite). It is brighter where it hits (+0.033 on roughnessRamp's metal spheres) and reflects metals only (`reflectNonMetals` false by default). Rooms' glossy floor is a dielectric, so its blur-mode error there is the probe term alone.
- **Still flicker.** Raw, our noise is the one-ray-per-quad noise of FFX SSSR. It's low where most glossy pixels are mirrors (mirrorWall: 0.0004 mean) and high on glossy roughness (roughnessRamp: 0.023). Three's raw stochastic is in the same range (0.005–0.025). Its denoise brings it to 0.0003–0.0011. The stand-in brings ours to 0.0001–0.0029.
- **Orbit flicker.** `|Δe|`: three + denoise 0.0018–0.0030, the stand-in 0.0011–0.0042, ours raw 0.0020–0.0229.
  - The stand-in is worse than raw on mirrorWall (0.0042 vs 0.0020). It reprojects with the surface motion, so a mirror floor's reflection lags and smears in motion. three's TemporalReprojectNode has hit-point reprojection for that, and so does FFX's denoiser.
  - Orbit std is dominated by error drift along the path: every method sits at 0.004–0.033 mean, and the p99 is set by edges.
- **GPU ms.** Ours raw is cheaper than three's blur mode on every scene. Three's blur renders 5 blur mips per frame, and mirrorWall's metal floor costs it 2.8 ms.
  - Ours is close to three's raw stochastic: cheaper on rooms and roughnessRamp, about equal on explainer, dearer on mirrorWall.
  - Ours is 2–6× cheaper than three + denoise. That comparison is not like for like: three's number includes its denoiser, ours has none.
  - The stand-in costs 0.1–0.4 ms (one full-screen pass and one copy).

## Method

### Scene, camera, inputs

- **Scenes** from `examples/shared`: `rooms` (Ben's two rooms; the gate names them), `explainer`, `mirrorWall`, `roughnessRamp`, each at its `default` view.
  - Probes are baked as in `examples/ssr` (128 px) and lit with `scene.environmentNode = reflectionProbes(probes)` for every method, three's included.
  - Animation is frozen at t = 0, because the metrics need a static scene.
- **One method per page load.** three's SSR + denoise example disables the environment specular on `PhysicalLightingModel.prototype` (verbatim in the bench), and that can't be scoped to one render.
  - The reference goes from page to page through IndexedDB: one browser profile, navigated.
  - Every method renders the same scene and camera at the same size, without jitter.
  - Ours renders the frame-contract G-buffer (`FrameGBuffer`). three's methods render the MRT its own example uses (`pass()`), as its users would.
- **Output.** Each method writes linear HDR into one `rgba16float` target. The metrics read that target on the GPU (a compute pass), so nothing goes through 8-bit.

### The methods

| id | what | settings |
|---|---|---|
| `ours` | `ScreenSpaceReflectionsPass` + `screenSpaceComposite(final)` | product defaults (perceptual threshold 0.447, 1 ray per quad, hybrid thickness, `hitColor: 'current'`), subgroup variant, probes then environment for misses |
| `ours-accum` | **bench stand-in, not a product feature**: `ours` + an exponential history of the composite's specular radiance | α = 0.1, reprojected by the G-buffer's motion (surface motion), reset when the reprojected uv leaves the screen or the view depth differs by > 5 %; `final = lit + weight × (history − probe term)` |
| `three-blur` | `ssr()` added to the lit pass, as `webgpu_postprocessing_ssr.html` | example params (quality 0.5, blurQuality 1, intensity 1, thickness 0.03), packed 8-bit normal and metal/rough MRT; **SMAA omitted** |
| `three-stoch` | `ssr({ stochastic: true })` on a lit pass with environment specular off, as `webgpu_postprocessing_ssr_denoise.html` "SSR (Raw)" | example params (quality 0.25, stepExponent 3, mirrorBias 0, thickness 0.1, maxLuminance 35, screenEdgeFade 0.2, `screenEdgeFadeBlack` on for the indoor scenes as its comment says), equirect environment for misses where the scene has one |
| `three-denoise` | the same + `temporalReproject` (specular, hit-point reprojection) + `recurrentDenoise`, history fed back to SSR (`setHistory`) as the example does | the example's denoise and reprojection params verbatim; **TRAA, sharpen and grading omitted** |

Three r187 does ship a denoiser for SSR. It is `RecurrentDenoiseNode` + `TemporalReprojectNode`, paired with `SSRNode` in `webgpu_postprocessing_ssr_denoise.html`. `DenoiseNode` exists too, but no SSR example uses it. Both examples were fetched at tag r187; `node_modules/three` doesn't ship example HTML.

Where the bench departs from three's examples (DIVERGES D1200):

- **`maxDistance` is 10 view-space units**, not the examples' 1 (basic) or 0.4 (denoise, on a model scaled to 0.1). The examples are tuned for 1–4 m scenes; at 1 m, three would barely reach the walls our scenes reflect.
- **`environmentIntensity` is the scene's own**: 0.28–0.5, or none for rooms. The denoise example uses 3.14, "not too sure why exactly", against its HDR, and the default is π, kept from an older hard-coded multiplier. The scene's own value is the one three's lighting uses for the same environment.
- **SMAA, TRAA, sharpen and grading are left out.** They're anti-aliasing and display, not reflections. TRAA in particular would also lower flicker, and ours could equally run under a TAA.

Nothing was tuned per method beyond these. In particular, our settings are the product defaults.

### Reference

There's no path tracer in this repo, so the reference is the **ideal screen-space answer, by brute force** (`REF_WGSL` in the bench). For every glossy pixel of the G-buffer:

- **Rays.** It shoots GGX VNDF rays (Heitz 2018) through the BVH: three-mesh-bvh's WGSL walk behind our trace seam.
  - Samples come from its own R2 low-discrepancy sequence with a per-pixel rotation.
  - Each ray is weighted by Smith G1(L), with a self-normalised mean, and rays below the horizon get weight 0.
  - The still pose gets 1024 rays per pixel, each orbit pose 256.
- **Hits.** A hit the camera also sees (it projects on screen within 2 % of the depth there) takes three's lit colour at that pixel. Anything else contributes the probe or environment term. The mean radiance and the visible fraction then replace our tracer's radiance and confidence in the same `screenSpaceComposite`.
- **Noise floor.** The reference's own noise (RMS of the difference between two independent 1024-ray references, over √2) is 0.00003–0.0018, and 0.00006–0.0036 at 256 rays. That's under the flicker numbers above on rooms, explainer and mirrorWall (orbit references: RMS 0.0004 / 0.0006 / 0.00006). On roughnessRamp the 256-ray orbit reference's RMS noise is 0.0036, the same order as the best orbit `|Δe|` there (0.0029–0.0041), so roughnessRamp's orbit differences below about 0.004 aren't resolved. RMS is outlier-heavy; the mean absolute noise is lower. The still reference (1024 rays, 0.0018) doesn't touch the still std, which has no reference in it.

**Its weaknesses, in order of weight:**

1. **It is not ground truth.** Rays that leave the screen or hit something hidden take the probe term, which is the answer an SSR + probe hybrid aims for. A path tracer would give the true radiance there.
   - This favours ours, whose misses use the same probes. three's misses use the environment only, or black.
   - It also means off-screen and occluded content isn't scored at all, and that's exactly what phase 4's rays are for.
2. **It shares our composite.** That covers the split-sum DFG weight, three's specular estimate that the composite subtracts (D603–D606), and the probe lookup. three's stochastic path weights each sample with its own BRDF (`sampleWeight`) instead, and some of its bias here is that difference.
3. **Hit radiance is three's lit image.** This includes the reflected surface's own specular as seen from the camera, with no multi-bounce.
   - Ours by default reflects the specular-free scene colour (FFX, `hitColor: 'current'`).
   - Three reflects the lit image, with or without the environment specular depending on the mode.
   - All three choices are approximations. This one is the most complete radiance either pipeline has.
4. **Screen-space visibility is decided with a 2 % depth tolerance,** the same tolerance as the RT pass's on-screen reuse (D55).

**Why not "average many frames of our own SSR":** that was the brief's first suggestion, and it would be biased per pixel. FFX's blue noise (and our port, `BLUE_NOISE_WGSL`) shifts both sample dimensions by the same golden-ratio offset each frame. So over frames, one pixel's 2-D sample walks a diagonal line through the unit square. A per-pixel temporal average then converges to the lobe integral along that line, not over the lobe, and leaves a frozen blue-noise pattern. The full lobe is only covered across neighbouring pixels.

- **The denoiser.** This is fine for FFX's design, because its denoiser does spatial reuse. It's a trap for anything that accumulates per pixel in time.
- **The stand-in.** `ours-accum` has this bias. It shows in its RMSE, not in its flicker.

### Timing

- **What's timed.** One frame per submit, with the loop stopped and the GPU idle before the frame starts.
  - A one-texel compute pass with a beginning-of-pass timestamp is submitted just before the frame.
  - Another, which reads a texel of the method's output and so waits for the whole frame, writes the end timestamp. Chrome runs with `--enable-webgpu-developer-features`, so the timestamps aren't quantized.
  - The span is the frame's GPU wall time. That includes real overlap between passes, and any gap where the GPU waited for the CPU's next submit. The gap is bounded by the frame's JS time, 0.2–0.9 ms here, against spans of 0.46–6.4 ms.
- **Increments.** The method's span minus the span of its own pipeline's baseline, which renders the same G-buffer and outputs the lit image. Ours and `three-blur` each have their own baseline. The two stochastic methods share theirs, since they use the same MRT with velocity and the same patched lighting.
- **Things tried that don't work on Metal** (for whoever times next):
  - **Per-pass timestamps on render passes overlap their neighbours** (D104). That rules out summing three's pass timestamps.
  - **A long single-thread "spin" pass before the begin bracket**, meant to hide the CPU gaps. The frame's passes ran concurrently with the spin and finished before the begin timestamp: a span of 0.007 ms. Dawn/Metal overlaps independent work across command buffers.
- **Contention.** Run 1 and run 2 agree within 0.5 ms per increment (most within 0.1 ms). The baselines move the most: three-stochastic's on roughnessRamp went from 0.61 to 0.99 ms.

## Not done

- **G1** (the denoiser cleanroom branch's steampunk scene) isn't in the kit.
- **The denoised comparison.** The verdict waits for it: ours + `FfxReflectionDenoiser` through the seam (phase 5), in this bench, as a sixth method.
- **A path-traced reference** for off-screen and occluded content (phase 4 brings the rays).
- **`hitColor: 'history'`** (D1002) isn't measured. The reference reflects the lit image, so it would likely lower our bias.
- **Asset scenes** and higher orbit speeds.
