# Examples plan

The plan for the public example set: one page for each key feature or combination, one for each engine, and the
showcase on top. Status: **approved** (maintainer, 2026-11-27): every page below; the existing procedural scenes to start with; **0.1.0
ships with the examples** (all of them ready is part of the 0.1.0 gate in `docs/RELEASING.md`).

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
| E1 (W92) | `catalog.ts`, the shared shell (info panel with brief, nav, source and docs links), the gallery from the catalog, Vite inputs and `pnpm check` from the catalog; existing pages listed where they are (their URLs do not change); `probes/box-projection` built as the reference page the others copy | Opus | `pnpm check` and `site:check` pass; every existing page in the gallery |
| E2 | Features, batch 1: `probes/*`, `ssr/*`, `rt/*`, `hybrid/explained` | Opus | Each page: check passes, brief written, compare switch visible |
| E3 | Features, batch 2: `denoise`, `materials`, `motion`, `perf/*`, `custom/tsl`, `setup/device-limits` | Opus, parallel to E2 | Same; `motion/animated` rest flicker within the quickstart bound |
| E4 | Engines: `engines/*` on `rooms` | Opus | Each loads; Babylon and core match the three page's probe + screen-space look within a stated bound |
| E5 | Thumbnails, generated docs examples page, README and docs links, copy edit of every brief | Sonnet | `docs:check`, `site:check`; full `pnpm check` before the merge |
| E6 | Denoiser PR: its rooms and explainer pages become links | Sonnet | Their CI |

E2 and E3 start once E1 is merged. Each wave logs in `docs/HANDOFF.md`; divergences from the denoiser's pages go in
`docs/DIVERGES.md`.

## Conventions (settled in E1, W92)

- **Catalog.** `examples/catalog.ts` holds every page above, built or not. A page not built yet has `planned: true`: the gallery
  hides it (the "Show planned pages" box shows it), the build and the check skip it. `devOnly: '<reason>'` keeps a page out of
  the public site (pixi3d/arcade: the closed beta; nrc: a private checkout). `check: { query, wait, image, thumbQuery }` tunes the
  headless load.
- **Paths.** Existing pages keep theirs; where the plan says `rebuild`, the entry points at the existing page until the rebuild
  (`probes/live` = `probes/`, `engines/babylon` = `babylon/`, `engines/pixi` = `pixi3d/arcade/`). A new page lives at
  `examples/<category>/<slug without its category prefix>/`: `probes/box-projection` is
  `examples/features/probes/box-projection/`, `engines/three` is `examples/engines/three/`. The catalog test enforces it for
  planned entries.
- **Shell.** `mountShell('<slug>', { placement? })` from `examples/shell`: the nav pill (gallery, breadcrumb, status, Info, Docs,
  Source, previous / next in the category) and the info panel with the brief, open on a first visit. A full-window canvas takes
  a corner (`'top-left'` default); a page that flows like a document takes `'inline'`. `?thumb` hides it.
- **`window.__p`.** Every page sets it once ready (the check waits for it). A feature page gives `stop()`, `shot(n)` (render n
  frames, return a PNG data URL) and `setCompare(on)` (on = the baseline of `brief.compare`); the catalog check then asserts
  the switch changes the image and switching back restores it.
- **Checks.** `pnpm check -- --only catalog` loads the gallery (a linked card per built page, the committed images) and every
  built page at 1280 x 720 (renders, no console error, no validation error). `--pages a,b` narrows it (`gallery` is a page).
  `--thumbs` writes the card images: `<path>thumb.webp` for a folder, `<name>.thumb.webp` beside an html file (640 x 360).
  `site:check` loads every page the site builds, from the catalog.

### Adding a page (E2 to E4)

1. Copy `examples/features/probes/box-projection/` (the reference page: `index.html` with a full-window canvas, a panel whose
   first control is the compare switch, and `main.ts` under 300 lines on the public API) to the page's path.
2. In `examples/catalog.ts`, drop `planned` from its entry and write `summary`, `description` and the `brief` (`compare` is
   required for feature, quality and performance pages).
3. In `main.ts`: `mountShell('<slug>')`, a scene from `examples/shared`, the feature as an app would set it up, the compare
   switch, the loop, `window.__p` (`stop`, `shot`, `setCompare`).
4. `REFLECTIONS_PORT=<port> pnpm check -- --only catalog --pages <slug>`, then `--thumbs --pages <slug>` and commit the webp.
   `pnpm test` (the catalog test) and `pnpm typecheck`.

## Decided

- **Scope:** every page above (maintainer, 2026-11-27).
- **Scenes:** the procedural scenes in `examples/shared` to start with; models stay in the showcase unless a page
  needs one.
- **Release:** 0.1.0 waits for the examples. All of them ready, checked and on the site is part of its gate.
- **Paths:** existing pages keep their folders and URLs (`quickstart/`, `showcase/`, ...); the catalog's slug and
  path are separate. New pages go in `examples/<category>/<name>/`.
