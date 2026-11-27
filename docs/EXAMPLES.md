# Examples plan

The plan for the public example set: one page for each key feature or combination, one for each engine, and the
showcase on top. Status: **proposed** (2026-11-27). Nothing below is built yet unless the table says "exists".

## What every example is

The structure follows `@pmndrs/pathtracer`'s `examples/catalog.ts`, so the sibling galleries look and work alike.

1. **One catalog.** `examples/catalog.ts` lists every example once: slug, path, title, one-line summary, category,
   status (`stable` / `experimental` / `research`), tags, docs page, source path, `requires` (WebGPU features, peers),
   `network` (streams models), `heavy`. The gallery (`/examples/`), each page's nav, the Vite inputs, the site build,
   `pnpm check` and a generated docs page (`docs/site/getting-started/examples.mdx`) all read it. Pure data, no imports.
2. **A brief on each page.** An info panel, open on a first visit, answers three things:
   - what the page shows and why it matters (`brief.shows`, one or two sentences);
   - what to try (`brief.tryThis`, one to three controls);
   - what to compare against (`brief.compare`): the switch that shows the cheaper, noisier or plainer way.
     Required on every feature, quality and performance page. A visitor should see the difference, not read about it.
3. **Small and copyable.** A feature page is one `main.ts` that uses the public API the way an app would
   (`Reflections.create` or the pieces), plus the shared shell (panel, nav, stats). Scenes come from
   `examples/shared` (`rooms`, `explainer`, `moving`, `mirrorWall`, `roughnessRamp`, ...). Target: under 300 lines
   of page code. The showcase and the lab pages are allowed to be big.
4. **Checked.** Every catalog entry gets a load check in `pnpm check` (renders, no validation errors, no console
   errors). Pages that animate also get a rest-flicker reading against a bound. `site:check` loads every one.
5. **A thumbnail.** `<path>thumb.webp`, 640 x 360, captured by a check run (`pnpm check -- --thumbs`), committed.

## Categories and the list

`exists` = there today (moved into the catalog and given a brief). `rebuild` = there today, rewritten to the rules
above. `new` = to build. Scenes in `code` are from `examples/shared`.

### Showcase

| Slug | What it shows | Compare | State |
| --- | --- | --- | --- |
| `showcase` | Everything on real models: car concept, toy car, chess set, Sponza. Each source and the denoiser switchable, debug views, GPU ms per pass | Each source off | exists |
| `showcase/compare` | Ours against a path-traced reference (`@pmndrs/pathtracer` + OIDN) on the same view | The reference | exists |

### Start

| Slug | What it shows | Compare | State |
| --- | --- | --- | --- |
| `start/hello` | `Reflections.create` in a few lines on a three.js scene | `?rt=1`, `?preset=performance` | exists (quickstart) |
| `start/probes-only` | One baked probe and your own `renderer.render`: the cheapest path | Without the probe (environment only) | exists (quickstart/probes.html) |
| `start/r3f` | The same in React Three Fiber with `useReflections` | | exists (r3f) |

### Features (three.js)

One page each. Each turns on one thing over a baseline the visitor can switch back to.

| Slug | Feature | Scene | Compare | State |
| --- | --- | --- | --- | --- |
| `probes/box-projection` | One baked, box-projected probe in a room | `boxRoom` | Box projection off (reflections at infinity) | new |
| `probes/two-rooms` | Several probes, blended by influence box; walk through the doorway | `rooms` (Ben's two rooms, from the denoiser's rooms page) | One probe for both rooms; influence boxes and weights as overlays | rebuild (denoiser `reflections-rooms`) |
| `probes/live` | Live, time-sliced capture: an animated object and a colour-cycling light | the probes page's room | Baked once | rebuild (probes) |
| `probes/exclude` | `bake({ exclude })`: a moving mirror kept out of its own captures | `moving` | Without exclude (the mirror paints itself in) | new |
| `ssr/mirror-floor` | Screen-space reflections on a polished floor, over probes | `mirrorWall` | Probes only | new |
| `ssr/what-it-misses` | What screen space cannot see: off-screen, behind, occluded. Leads into the next page | `offscreen` | Probe fill vs black | new |
| `rt/fallback` | The ray-traced fallback filling what screen space misses | `offscreen` | `rayTracing` off | new |
| `rt/animated` | Moving meshes: `trace.refit()` each frame | `moving` | Refit off (stale reflections) | new |
| `hybrid/explained` | The teaching page: probe, screen space, rays and the composite side by side, with the per-pixel source map | `explainer` | Each source alone | rebuild (denoiser `reflections-hybrid`, on our pipeline) |
| `denoise/glossy` | The denoiser on glossy surfaces, with a live flicker meter | `roughnessRamp` | Denoiser off | new |
| `materials/roughness` | Roughness, metalness, clearcoat; why basic / Lambert / Phong get none | `roughnessRamp` + `multiMaterial` | A basic material next to a standard one | new |
| `motion/animated` | A whole animated scene: camera path, moving objects, a camera cut with `resetHistory` | `moving` + `rooms` | History reset off at the cut (the smear) | new |
| `perf/presets` | `default` vs `performance` (half-resolution reflections), GPU ms per pass | `rooms` | The other preset | new |
| `perf/upscaler` | TAA / upscaling after the composite with `@pmndrs/upscaler`, jitter wired through | `rooms` | Upscaler off | new (from showcase's `DisplayAA`) |
| `custom/tsl` | `sampleReflectionProbes` in your own TSL material (a water or glass surface) | `boxRoom` | The stock material | new |
| `setup/device-limits` | A plain `new WebGPURenderer()`: the second lit pass, `traceError` when ray tracing does not fit | `mirrorWall` | `createReflectionsRenderer` | new |

### Engines

One per adapter, each on the **same scene** (`rooms`) so they can be put side by side, with only the features the
adapter has (see `docs/site/guides/adapters.mdx`).

| Slug | Engine | Features shown | State |
| --- | --- | --- | --- |
| `engines/three` | three.js `WebGPURenderer` | Everything (links to the feature pages) | new (thin; `start/hello` on `rooms`) |
| `engines/r3f` | React Three Fiber | Everything, through the hook; the two rooms as JSX | new |
| `engines/babylon` | Babylon.js `WebGPUEngine` | Probes + screen space as frame-graph tasks | rebuild (babylon) |
| `engines/pixi` | pixi.js v8 + pixi-3d | Probes + screen space + denoiser | exists (pixi3d/arcade; shows a notice without the closed beta) |
| `engines/core` | Raw WebGPU, no engine (`@pmndrs/reflections/core`) | The probe set and the screen-space tracer on a bare `GPUDevice` | new (user-facing, unlike `sssr-core`) |

### Lab (developer pages)

Kept, in the catalog with status `research` or `experimental`, grouped at the bottom of the gallery: `ssr` (every
test scene, every switch), `scenes` (G-buffer targets), `sssr-core`, `probe-core`, `bc6h`, `probe-bench`,
`ssr-bench`, `regressions`, `nrc`, `showcase/bench`. No brief rules beyond a one-line summary.

## The denoiser's pages

`reflection-probes` was copied in phase 0 (now `probes`). `reflections-rooms` and `reflections-hybrid` render with
three's `SSRNode` and inline `three-mesh-bvh` rays, and take only probes and sampling from this package, so they do
not show our pipeline. `probes/two-rooms` and `hybrid/explained` rebuild them here on `Reflections`. Their look will
differ (FFX-style tracer, `@pmndrs/raytracer` hits). Once those are live, a denoiser PR replaces its two pages with
links here, so they exist once. `reflect-bench` stays there (it compares denoisers).

## Waves

| Wave | Work | Who | Gate |
| --- | --- | --- | --- |
| E1 | `catalog.ts`, the shared shell (info panel with brief, nav, source and docs links), the gallery from the catalog, Vite inputs and `pnpm check` from the catalog; move the existing pages in under their slugs (old URLs redirect) | Opus | `pnpm check` and `site:check` pass; every existing page in the gallery |
| E2 | Features, batch 1: `probes/*`, `ssr/*`, `rt/*`, `hybrid/explained` | Opus | Each page: check passes, brief written, compare switch visible |
| E3 | Features, batch 2: `denoise`, `materials`, `motion`, `perf/*`, `custom/tsl`, `setup/device-limits` | Opus, parallel to E2 | Same; `motion/animated` rest flicker within the quickstart bound |
| E4 | Engines: `engines/*` on `rooms` | Opus | Each loads; Babylon and core match the three page's probe + screen-space look within a stated bound |
| E5 | Thumbnails, generated docs examples page, README and docs links, copy edit of every brief | Sonnet | `docs:check`, `site:check`; full `pnpm check` before the merge |
| E6 | Denoiser PR: its rooms and explainer pages become links | Sonnet | Their CI |

E2 and E3 start once E1 is merged. Each wave logs in `docs/HANDOFF.md`; divergences from the denoiser's pages go in
`docs/DIVERGES.md`.

## Open

- **Scope:** 16 feature pages may be more than needed. The minimum set that still covers every feature:
  `probes/two-rooms`, `probes/live`, `ssr/what-it-misses`, `rt/fallback`, `rt/animated`, `hybrid/explained`,
  `denoise/glossy`, `motion/animated`, `perf/presets`, plus the engines.
- **Models on feature pages:** procedural scenes only (fast, no network), or a model on some.
- **Before or after 0.1.0:** examples do not change the package, so they can ship after the release; the
  `hybrid/explained` rebuild may find API gaps worth fixing first.
