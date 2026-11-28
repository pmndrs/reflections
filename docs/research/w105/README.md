# W105 (T30): geometric specular AA in variance form, as a package option

## Verdict

**Built as a package option, default `'off'` (today's output). Recommendation: keep `'off'`.**

- At the papers' constants, `'variance'` makes the display calmer on curved glossy surfaces: carConcept reflection orbit std -6.6 %, rest flicker -22 %, Sponza orbit -5 %, rest -16 %.
- Several flicker metrics also rise, well above the bench's run-to-run noise (the bench is deterministic to 4 decimals between page loads):
  - carConcept `car` raw speckle +139 %;
  - the displayed 2x2 quad grid, +55 % on carConcept's reflection and +13 % on the car;
  - the wheel's rest drift +4 %.
- It moves the chrome star **away** from the path tracer: 96.4 -> 123.8, against the PT's 52.5.
- So it doesn't meet the default rule (no flicker metric above noise) or the star goal. It stays an option for stability-first scenes.

**Why the star gets worse, not better.** W56 expected the variance form to be gentler than three's term on small bevelled parts. It isn't, for two reasons.

1. **The roughness the reflection pass reads.** three's term never reached the G-buffer's `normalRoughness.w`, which the tracer samples and the denoiser filters at. The option's default `traceRoughness: 'filtered'` sends the filtered value there too, so the tracer's lobe and the denoiser's kernel widen on the star.
   - With `traceRoughness: 'material'`, the star reads 99.0 against 96.4.
   - So 25 of the 27.4 added luma come from this route.
2. **alpha^2 against perceptual roughness.** three adds the max derivative `g` to *perceptual* roughness. The variance form adds `2 sigma^2 |dn|^2` to *alpha^2* (= r^4).
   - On a near-mirror, a small derivative `d` then adds about `sqrt(0.8 d)` of perceptual roughness. That is far more than three's `+d`: at d = 0.05 the result is r 0.20, against three's 0.10.
   - On rough paint (r 0.3) it adds less than three's term: d = 0.05 gives r 0.31, against 0.35.
   - So the form blurs mirrors more and paint less. That is the wrong way round for both the star and paint sparkle.
   - A small sigma^2 brings the star down (sigma^2 0.0025: 83.2), but the AA goes with it. At sigma^2 0.01 the car's raw speckle is +213 % and Sponza's +7 %.

## The option

`applySpecularAA(root, options)` / `Reflections.create(..., { specularAA })` / `reflections.setSpecularAA()`. Source: `packages/three/src/frame/specularAA.ts`.

- **`mode`:**
  - `'off'` (default): materials are untouched, so three's own geometry roughness stays.
  - `'variance'`: replaces three's term.
- **Formula:** Tokuyoshi & Kaplanyan 2021 (JCGT 10(2), Listing 5, the isotropic form for deferred rendering), the same as the 2019 I3D paper's:
  `alpha'^2 = saturate(alpha^2 + min(2 sigma^2 (|dn/dx|^2 + |dn/dy|^2), kappa))`.
  - `sigma^2` = `variance`, default 1/(2 pi). Half of it is the 2021 paper's "less conservative" Eq. 14.
  - `kappa` = `threshold`, default 0.18.
  - `n` = three's `normalViewGeometry` (D5661).
  - Both values are shared uniforms, so changing them needs no rebuild.
- **`traceRoughness`** decides what the G-buffer's `normalRoughness.w` carries:
  - `'filtered'` (default): the filtered value;
  - `'material'`: the authored value, as with three's term.
  - `shadingRoughness`, the composite's probe term and weights, follows three's lit term either way.
- **The hook** (D5660):
  - An own `setupVariants` runs three's and then re-assigns `roughness`, `clearcoatRoughness` and anisotropy's `alphaT`. The floor of 0.045 stays.
  - A marker property, `reflectionsSpecularAA`, which three's material cache key includes. This is safer than taking `customProgramCacheKey`. Taking it would have dropped the examples' specAA map-id key (the D3572 trap). The first cut did that, and every number here is from after the fix.
  - The G-buffer reads the filtered value through a named property node, `reflectionsSpecularAARoughness`, assigned in `setupVariants`.
- **Examples:**
  - Bench Materials: `specularAA`, `specularAAVariance`, `specularAATrace`.
  - URL `?specularAA=variance` on `showcase/` and `ssr/`.
  - `__p.setSpecularAA()` on the showcase.
  - It is independent of the examples' `geometryRoughness` (W56 / W102). When both are set, the package's option wins, because it is applied after.

## Star (carConcept, W56's setup)

- **Setup:** `bench.html?manual&scene=carConcept&pose=w50&size=1280x1280`, ours-rt (bench defaults, no car probes), 48 frames; the PT at 48 steps.
- **Masks:** W54/W56's (`scripts/masks-a-1280.png`, `scripts/stats.py`).
- **Values:** 8-bit display luma / MAD vs the PT.
- **Order:** one page, off and variance run twice each (off, variance, material, off2, variance2, ...), and both reads are identical.
- Raw tables: `star-run1.txt`, from before the cache-key fix. Rim2 has no maps, and run 2 below repeats it exactly.

| config | star (PT 52.5) | starCore (31.3) | starEdge (59.6) | hubRect (26.1) | floorWheel (29.8) | frame (126.2) |
|---|---|---|---|---|---|---|
| **off** (three's term) | **96.4 / 54.8** | 62.0 / 31.7 | 107.8 / 62.4 | 45.0 / 27.8 | 50.5 / 29.4 | 127.3 / 13.1 |
| **variance** (sigma^2 0.159, filtered) | **123.8 / 75.6** | 90.7 / 59.0 | 134.9 / 81.1 | 54.5 / 33.5 | 53.1 / 31.1 | 127.9 / 13.2 |
| variance, `traceRoughness: 'material'` | 99.0 / 56.2 | 65.9 / 35.5 | 110.1 / 63.2 | 45.7 / 28.1 | 50.5 / 29.4 | 127.4 / 13.0 |
| variance sigma^2 0.0796 (less conservative) | 117.7 / 70.6 | 83.8 / 52.3 | 129.0 / 76.7 | 53.0 / 32.4 | 53.0 / 30.9 | 127.9 / 13.2 |
| variance sigma^2 0.04 | 111.3 / 65.5 | 77.9 / 46.5 | 122.4 / 71.9 | 51.2 / 31.2 | 52.8 / 30.8 | 127.8 / 13.2 |
| variance sigma^2 0.04, material | 91.2 / 51.0 | 59.6 / 29.5 | 101.7 / 58.2 | 44.0 / 27.0 | 50.5 / 29.4 | 127.4 / 13.0 |
| variance sigma^2 0.01 | 94.0 / 53.2 | 64.8 / 34.0 | 103.7 / 59.5 | 46.0 / 28.0 | 52.3 / 30.4 | 127.5 / 13.1 |
| variance sigma^2 0.0025 | 83.2 / 46.2 | 58.4 / 28.1 | 91.5 / 52.2 | 42.3 / 26.1 | 51.6 / 29.9 | 127.3 / 13.1 |
| `geometryRoughness=off` (W56, examples) | 73.7 / 41.6 | 53.0 / 23.6 | 80.6 / 47.6 | 40.2 / 25.1 | 50.3 / 29.3 | 127.2 / 13.0 |
| probes only, off | 108.7 / 66.0 | 75.2 / 47.4 | 119.8 / 72.2 | 57.5 / 38.4 | 169.0 / 139.0 | 149.2 / 33.6 |
| probes only, variance | 117.9 / 71.1 | 85.8 / 56.8 | 128.6 / 75.9 | 59.4 / 39.7 | 169.0 / 139.0 | 149.2 / 33.6 |

**Star excess over the PT:**

| config | excess |
|---|---|
| off | +43.9 |
| variance | +71.3 |
| variance, material | +46.5 |
| sigma^2 0.0025 | +30.7 |
| geometry roughness off | +21.2 |

Probes only (no tracer, three's lit term and probe lookup alone) shows the lit term is blurrier too: 108.7 -> 117.9.

## Flicker (`pnpm check -- --only flicker`)

- **Runs:** four (`flicker/flicker-w105-{a,a2,b,b2}.json`), in alternating config order:
  - a: off, variance;
  - a2: material, sigma^2 0.01;
  - b: sigma^2 0.01, material, variance (off cut by the runner's 600 s cap);
  - b2: variance, off.
- **Repeats:** b and b2 ran with `FLICKER_REPEAT=2`.
- **Determinism:** bench scenes are deterministic across page loads. Off in a and in b2 read the same to 4 decimals. The in-page second pass (drift2 / orbitStd2) gives the noise floor, about 0.2-2 %.
- **Flat scenes:** cubeFloor, edgesFloor and plateFloor read bit-identical in every config. Their faces are flat, so the normal derivative is 0, and three's term was 0 there too.

Numbers below: reflection region unless named. % against off.

| scene / region | metric | off | variance (0.159, filtered) | material | sigma^2 0.01 |
|---|---|---|---|---|---|
| contact | drift / orbit std / d2 | 0.368 / 0.453 / 0.570 | 0.364-0.368 (0 %) / 0.451-0.453 (0 %) / 0.571 (0 %) | 0 % / 0 % / 0 % | 0 % / 0 % / 0 % |
| contact | speckle / raw quad | 0.0161 / 0.654 | 0.0139-0.0149 (-11 %) / 0.53-0.55 (-17 %) | -9 % / -14 % | -9 % / -15 % |
| mirrorWall | all | (off itself 0.298-0.305 drift between loads) | within the off spread | within | within |
| carConcept@w50 reflection | px | 458,630 | 451,700 (the glossy mask is drawn from G-buffer roughness < 0.447) | 458,630 | 456,187 |
| carConcept reflection | drift / rest | 0.267 / 0.0074 | 0.259 (-3 %) / 0.0058 (-22 %) | 0.403 / 0.266 (+51 % / 0 %: bimodal) / +1 % | +1 % / -9 % |
| carConcept reflection | orbit std / d2 | 0.382 / 0.325 | 0.357 (**-6.6 %**) / 0.310 (-4.5 %) | -1 % / -1 % | 0 % / -2 % |
| carConcept reflection | quad (display) / raw / speckle | 0.049 / 0.896 / 0.056 | **0.076 (+55 %)** / 0.856 (-4 %) / 0.042 (-25 %) | +9 % / -3 % / **+36 %** | -2 % / -10 % / **+27 %** |
| carConcept wheel | drift / rest / orbit std | 1.229 / 0.0242 / 1.915 | **1.278 (+4 %)** / 0.0247 (+2 %) / 1.845 (-3.7 %) | +7 % / 0 % / 0 % | +3 % / +5 % / +1 % |
| carConcept car | orbit std / d2 / quad | 0.726 / 0.629 / 0.115 | 0.697 (-4 %) / 0.616 (-2 %) / **0.130 (+13 %)** | -1 % / -1 % / +5 % | +1 % / 0 % / -3 % |
| carConcept car | raw speckle | 0.0119 | **0.0284 (+139 %)** | **+102 %** | **+213 %** |
| sponza@hero | drift / rest / orbit std | 0.300 / 0.0112 / 0.554 | 0.291-0.297 (-2 %) / 0.0095 (-16 %) / 0.524 (-5 %) | +3 % / -2 % / 0 % | +4 % / -1 % / +1 % |
| sponza | speckle / raw quad / pan d2 | 0.334 / 0.275 / 7.08 | 0.290 (-13 %) / 0.232 (-15 %) / 6.75 (-5 %) | +4 % / -23 % / -1 % | +7 % / -34 % / -2 % |

**Reading:**

- `'variance'` at the papers' constants is the calmest config on the display metrics (orbit, rest, d2) on carConcept and Sponza.
- Its rises are where the car's paint px get a filtered, rougher lobe:
  - the raw signal's speckle on the car;
  - the displayed quad grid. Rougher px are traced with FFX's quad copy, and the bench's glossy mask shrinks by 1.5 %.
- `'material'` gets neither benefit and keeps the speckle rise.
- sigma^2 0.01 is less AA than three's term at bevels: speckle up on the car (+213 %) and on Sponza (+7 %).

## GPU cost

- **Setup:** showcase `?gpuTime` at 1920 x 1080, three's render passes (G-buffer + lit + composite + display). Render loop stopped, 6 rounds alternating off / variance in one page (order flipped each round), median of 40 frames each (`scripts/timing.js`).
- **Contention:** the GPU was shared with other worktrees (load average 18-60).
- **carConcept:**
  - off 7.8-11.4 ms, variance 9.1-11.9 ms;
  - paired differences -2.3 to +1.6 ms, median +0.32;
  - inside the noise.
- **Sponza:**
  - off 14.1-16.6 ms, variance 14.2-17.0 ms;
  - paired differences -0.11, +0.02, +0.04, +0.07, +0.09, +0.46, median **+0.05 ms**.
- **Expected cost:**
  - The term replaces three's, which already takes the same two derivatives.
  - It adds a dot product per derivative and, with `traceRoughness: 'filtered'`, one property read in the G-buffer.
  - A clear coat evaluates the term twice.
  - Re-time on a quiet machine before quoting it.

## Files

- `scripts/`: `drive.mjs`, `shots.js`, `stats.py` (copies of W56's), `timing.js`, `flicker-table.py` (merges the flicker JSONs), `masks-a-1280.png`.
- `flicker/`: the four flicker JSONs.
- `star-run1.txt`: run 1's raw table.
