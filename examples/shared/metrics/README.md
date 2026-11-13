# Experiment metrics (X0, W70)

The shared yardsticks of the SSR-sources experiment plan (`docs/plans/ssr-sources-experiments.md`, X0). Streams X1-X5 measure with these. Baseline numbers and noise floors: `docs/research/w70/`.

| File | What |
|---|---|
| `stats.ts` | Pure maths on frames (no DOM, no GPU): drift, temporal std, second difference, 2x2 energy, speckle, MAD, gradient energy, FWHM / line spread. Unit test: `test/metrics-stats.test.ts`. |
| `run.ts` | `createMetrics(host)`: the page metrics over any `MetricsHost` (render a frame, read it back, move the camera, reset history). |
| `three.ts` | The three-adapter side of a host: the glossy mask from our G-buffer, linear readbacks of `HybridReflections`' raw signal and denoised output. |
| `scenes.ts` | Two procedural bench scenes with a path-traced reference: `lineSpread` and `grazing`. |
| `bench.ts` | The PT metrics on the bench: `lineSpread()` (the double-blur gate) and `grazing()`. |

## Where to call them

- **examples/ssr**: `window.__p.metrics.<metric>(options)`. Load the page without `?manual` for today's defaults (upscaler AA, denoiser on), or pass `aa=off`, `upscale=quality`, `rt=1`, `denoise=0` and so on in the URL. The metrics stop the render loop.
- **examples/showcase/bench.html**: `window.__p.metrics.<metric>({ method: 'ours-denoised', ...options })` runs a page metric on one bench method (default: side A). `window.__p.metrics.of(id)` returns the same object bound to that method. `lineSpread()` and `grazing()` live only here (they need the PT). Use `?manual`.
- **From a script**: `pnpm check -- --only ssr-exp-run` with `SSR_EXP_URL='ssr/?scene=contact&upscale=quality'` and `SSR_EXP_EVAL='window.__p.metrics.restDrift({ heat: true })'`. It prints the JSON, writes `out/ssr-exp-run.json`, and saves any PNG in the result as `out/ssr-exp-run-<key>.png`.
- **Sections**: `--only ssr-exp-metrics` (smoke: every metric on examples/ssr contact and on the bench, finite numbers) and `--only ssr-exp-baseline` (the full baseline, `out/ssr-exp-baseline.json`; `SSR_EXP_SCENES=contact,carConcept` and `SSR_EXP_PARTS=ssr,showcase,lineSpread,grazing` narrow it).

Don't edit files under `examples/` while a check runs: vite reloads the page and the run fails with "Inspected target navigated or closed".

## Units and conventions

- Display metrics use 8-bit luma (Rec. 709 over the sRGB bytes, 0..255), as the bench's Measure and W36 / W39 did. Linear metrics (`energy`, `speckle` on the signal, `quadEnergy.signal`) use linear luminance.
- Every page metric resets the history (reflections, denoiser, AA), warms up, measures, and puts the camera back.
- **Regions.** Results are keyed by region:
  - `whole`: the frame.
  - `reflection`: glossy geometry, G-buffer perceptual roughness < 0.447 (examples/ssr), or the bench's glossy mask.
  - On the bench, the scene's named regions at the current pose. carConcept at `w50` has `lip`, `band`, `door`, `car` and `wheel`; lip, band and door need a Measure first, since their masks come from the PT image.
  - Pass `regions: { name: Uint8Array(w * h) }` to use your own (display size).
- Linear readbacks are at the render size (smaller under `?upscale=`). Masks are resampled to it (nearest).

## Page metrics (`createMetrics(host)`, both pages)

All return `Promise`s of plain JSON. Numbers are rounded to 4 decimals.

### `restDrift({ a = 120, b = 240, threshold = 8, restFrames = 8, alignPhase = true, heat = false, regions })`

Settling at rest. Two frames of a still camera after a reset, `a` and `b`.

- `a` moves down to the same jitter phase as `b` (`jitterPhases`: 8 frames at ratio 1, 18 at `?upscale=quality`). Otherwise it measures the jitter, not the settling. `alignPhase: false` keeps `a`.
- Returns `{ frames: [a, b], jitterPhases, threshold, regions: { <r>: { px, mean, pctOver, p99 } }, rest: { <r>: { mean, pctOver1 } } }`.
  - `mean`: mean |a − b| (8-bit).
  - `pctOver`: % px with |a − b| > `threshold`.
  - `rest`: W36's rest flicker over the `restFrames` frames after `b`: the mean |frame − previous|, and % px whose mean change is > 1/255. This is the per-frame jitter at rest.
- `heat: true` adds `heat` (|a − b| × `gain`, a PNG data URL) and `images` (both frames).

### `orbitFlicker({ warm = 60, deg = 0.1, half = 10, passes = 12, threshold = 4, regions })`

W39's pendulum orbit (`docs/research/w39/measure/inpage.js`, `biasStudy`). The camera swings about the view target: `half / 2` frames out at `deg` per frame, back through the start pose, out the other side and back, `passes` times.

- Returns `{ deg, half, passes, regions: { <r>: { px, std, d2, pctD2Over, mean } } }`.
  - `std`: the per-pixel temporal std of the frames sampled at the start pose while moving (one per pass), as the mean over the region.
  - `d2`: the second temporal difference |x_t − 2x_{t−1} + x_{t−2}| inside each monotonic quarter (it cancels the smooth motion). Mean, and % > `threshold`.
  - `mean`: the region's luma at the start pose.

### `quadEnergy({ warm = 60, frames = 8, regions })`

The quad-copy grid. Squared neighbour differences (x and y), split by whether the pair crosses a 2×2 quad boundary (`across`, pairs (2k+1, 2k+2)) or lies inside one (`within`). The difference is the image's power at the quad grid's frequency. This is the plan's "power at the half-Nyquist frequency".

- Returns `{ display: { <r>: { pairs, power, ratio } }, signal?: { ... } }`, the mean over `frames`.
  - `ratio` = (across − within) / (across + within). 0 means no grid, 1 means every quad is flat. Use it across scenes.
  - `power` = across − within, in 8-bit² for display.
  - `signal` is the same on the linear raw signal (the denoiser's input) at the render size. There the grid is FFX's quad copy itself (typically 0.35-0.65 raw vs < 0.05 displayed).
- Under `?upscale=` the display grid is resampled: compare like with like.

### `edgePan({ warm = 60, deg = 0.25, frames = 24, border = 0.1, threshold = 4, regions })`

Pops at the screen edges. The camera yaws in place (`deg` per frame, `frames` frames), so new content enters at the side.

- Returns `{ regions: { border, borderReflection, centre, centreReflection: { px, d1, d2, pctD2Over } } }`.
  - `border` is the outer 10 % of the screen on every side; `centre` is the rest, for scale.
  - `d1` = mean frame-to-frame |difference|. It includes the pan's own motion.
  - `d2` = the second difference, which cancels smooth motion and leaves pops. **Read `d2` and `pctD2Over` of `borderReflection`.**

### `speckle({ warm = 30, frames = 8, sigma = 3, source, regions })`

Raw speckle count: % of px more than `sigma` standard deviations above the mean of their 5×5 neighbours (the 24 others), and also above an absolute floor (2/255 display, 1e-3 linear) and 5 % relative. The value is the mean over `frames` frames.

- `source: 'signal'` (the default where the host reads it back) counts on the linear raw signal, the denoiser's input, whatever the denoiser does. `'display'` counts on the displayed frame with the denoiser switched off for the run.
- Returns `{ source, sigma, frames, regions: { <r>: { px, pct } } }`.

### `energy({ warm = 60, frames = 64, regions })`

W45's metric: the `frames`-frame linear mean of the raw signal and of the denoised output, per region.

- Returns `{ frames, size, regions: { <r>: { px, raw, denoised, loss } } }`, where `loss` = 1 − denoised / raw.
- Null without a running denoiser (`?denoise=0`, `ours-raw`).

### `all({ regions, restDrift, orbitFlicker, quadEnergy, edgePan, speckle, energy })`

Every metric above. Pass options per metric, or `false` to skip one. Returns `{ host, size, restDrift, orbitFlicker, ... }`, where `host` describes the page (scene, AA mode and ratio, render size, denoiser, RT, hit colour / bench settings).

## PT metrics (bench only)

They drive the bench's Measure: the PT reference to `samples` spp + OIDN, then each method from a reset, `warmup` frames, the mean of `frames`. They switch scene and settings as needed (a Rebuild when one is creation-time).

### `lineSpread({ roughness = [0.05, 0.15, 0.3, 0.5], pose = 'e15', methods = ['ours-denoised'], samples = 256, warmup = 48, frames = 16, tolerance = 0.1 })`

The double-blur gate. The `lineSpread` scene: a 1.5 cm emissive strip 30 cm above a white metal floor, 4 m ahead, black environment.

- It runs with `tone=neutral`, and the display is decoded from sRGB, so half maximum is half the radiance (the peaks stay under Neutral's knee).
- For each column of the middle 60 % of the screen, it takes the vertical FWHM of the reflected strip, in a window from halfway between the strip and its mirror point down to the bottom. The result is the median over the columns.
- Returns `{ rows: [{ roughness, pt, ptPeak, ptColumns, window, methods: { <id>: { width, ratio, pass, columns, peak } } }] }`.
  - `width` is in px.
  - `ratio` = ours / PT.
  - `pass` = |ratio − 1| ≤ `tolerance`.
  - `width: null` means the line ran off the window or didn't clear the floor.

### `grazing({ elevations = [5, 15, 30, 60], methods = ['ours-denoised'], samples = 256, warmup = 48, frames = 16, floorRoughness })`

The `grazing` scene: an emissive checker wall (25 cm squares) behind a r 0.15 metal floor, in the studio HDRI. The camera sits 4 m from the target at each elevation.

- Over the glossy px it reports MAD and signed bias vs the PT (8-bit RGB, as Measure), and the gradient energy (mean squared neighbour difference of luma) of the method and of the PT.
- Returns `{ rows: [{ elevation, px, ptGradient, methods: { <id>: { mad, bias, gradient, gradientRatio } } }] }`.
  - `gradientRatio` < 1 means blurrier than the PT; > 1 means sharper or noisier (read it with the MAD).

## Bench Measure columns

Measure (the button, or `__p.measure()`) now also reports these per region and method:

- `std`: the per-pixel temporal std of luma over the measured frames.
- `quad`: the 2×2 ratio of the mean frame. `refQuad` is the PT's.
- `speckle`: % px > 3σ on the display, the mean over frames.

`__p.metrics.lastImages` holds the last Measure's PT image, each method's mean (RGB floats) and the region masks.

## Adding a host

Implement `MetricsHost` (`run.ts`):

- `width`, `height`, `step(n)`, `grab()`, `reset()`.
- `reflectionMask()`.
- `getView()`, `setView(pos, target)`.
- Optional: `readSignal()`, `readDenoised()`, `setDenoise(on)`, `jitterPhases()`, `extraRegions()`, `describe()`.

For a three page, `three.ts` gives the mask and the readbacks, and `canvasReader(w, h)` reads a WebGPU canvas in the same task as the frame.
