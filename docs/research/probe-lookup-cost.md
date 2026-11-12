# Probe lookup cost per volume (W63)

W63, 2026-11-12. The question: the probe lookup walked every volume at every pixel, and W61 measured 33 volumes at about 10-13 ms more per frame at 1080p than a few probes. The maintainer wants "probes are cheap" to hold, so scenes can add probes to cover content. The ask was to test the options, compare them against what other engines do, and recommend one.

**Answer.** The cost was neither the box test nor the texture fetches. It came from **unrolling**: three compiles the walk once per volume into every lit material, and past ~8 volumes that shader's cost grows faster than the count (32 volumes: 9.6 ms unrolled, 1.7 ms as a runtime loop). The fix that landed is a **world-space volume grid in the probe table**. Each cell lists the volumes whose influence box touches it, so a pixel walks only the 1-4 volumes of its cell. The volumes are baked, so the grid is camera-independent. It costs nothing per frame on the GPU and works for every P (materials, the composite, traced hits) on every adapter. At 32 volumes the lookup drops from 9.6-12 ms to ~0.8 ms on rooms and from 13.7 ms to ~0.4-1.8 ms on Sponza, and its cost is flat in the volume count. Up to 4 volumes the old unrolled walk stays, since it is the cheapest there. Output is bit-identical in the probe term (below).

Machine: Apple M-series (`metal-3`), Chrome headless, WebGPU through Dawn/Metal, 1920x1080, `examples/ssr`, RT off, denoise off, render loop stopped. Lookup ms = three's passes minus the same frame with every probe lookup off (`__p.setProbeParts(false, false)`). The split: material = all minus composite-only, composite = composite-only minus free. **Shared GPU:** W62's checks and other agents' Chromes ran during most of this work. Only run 1 (and run 3, mostly) saw a quiet GPU (probe-free frame 5.0 ms on rooms, 8.75 on Sponza). Later runs saw 9-20 ms free frames, and below 8 volumes their differences are noise (±1 ms). The tables use the quiet runs. The loaded runs are in `w63/` and agree at 16 and 32 volumes.

## Where the cost goes (profile, run 1, quiet)

Bench-only variants of the walk (`?lookupExp=`, core's `PROBE_LOOKUP_EXPERIMENT`, not in the package index). Each runs on a fresh page with an n-cell 128 px grid over the scene's regions (`__p.probeGrid(n)`). Lookup ms at n = 4 / 8 / 16 / 32:

| variant | rooms | Sponza (showcase's) |
|---|---|---|
| shipped before W63 (unrolled, `legacy`) | 0.36 / 0.78 / 2.24 / **9.55** (material 8.50 + composite 1.05 at 32) | 0.36 / 0.79 / 2.86 / **13.65** (12.55 + 1.10) |
| unrolled, no atlas sample (`nosample`) | 0.34 / 0.70 / 2.07 / 9.03 | |
| unrolled, box test only (`boxonly`) | 0.16 / 0.22 / 0.39 / 1.07 | 0.09 / 0.12 / 0.31 / 1.21 |
| runtime loop (`loop`) | 0.53 / 0.77 / 1.30 / 1.71 | 0.58 / 0.81 / 1.41 / 2.58 |

- **Not the texture fetches.** Without the atlas sample, the unrolled walk costs nearly the same (9.0 vs 9.6 ms at 32).
- **Not the box math.** The box test alone, for every walk at every pixel, is 1.1-1.2 ms at 32 volumes. f16 or a two-level box test could save at most part of that.
- **The unrolled bodies.** The same body as a runtime loop is 5.6x cheaper at 32 (1.7 vs 9.6). Unrolled, the cost is superlinear: 0.1 ms per volume up to 8, then 0.5 ms per volume from 16 to 32, almost all of it in the materials. "0.3 ms per volume" is the average at 33. The likely cause is register pressure or instruction-cache misses. Each lit material holds two walks (three's radiance and irradiance contexts, a third with clear coat), and each unrolled volume adds a box-projected sample block. That is inferred: there is no shader profiler on this path.
- **Per pixel there are ~5 walks:** the material's radiance and irradiance lookups (times overdraw: no depth prepass), plus the composite's `sampleReflectionProbes`, its coverage lookup and the proxy share (D2400).

## Options compared

ms = lookup at 1080p for n = 4 / 8 / 16 / 32 volumes, rooms (Sponza where measured). "Reach" = the adapters where the option can work. Where the lookup runs:
- **three**: every lit material (`scene.environmentNode`), the full-screen composite, and traced hits (core `probeHitShading`).
- **Babylon and pixi**: only core's full-screen composite (`ProbeSet` + `fallback.ts`) and traced hits. Their materials keep their own IBL.

| option | ms (rooms) | ms (Sponza) | build cost | complexity | reach | verdict |
|---|---|---|---|---|---|---|
| shipped before W63: every volume, unrolled | 0.36 / 0.78 / 2.24 / 9.55 | 0.36 / 0.79 / 2.86 / 13.65 | none | - | all | superlinear |
| 1a. early-out at weight 1, unrolled (`legacy,skip`) | 0.38 / 0.87 / 1.99 / 10.24 | | none | trivial | all | no gain: the bodies are still compiled |
| 1b. runtime loop (no unroll) | 0.53 / 0.77 / 1.30 / 1.71 | 0.58 / 0.81 / 1.41 / 2.58 | none | trivial | all | 5.6x at 32, 1.5x dearer at 4, still linear (~0.05 ms per volume) |
| 1c. runtime loop + early-out (`loop,skip`) | 0.49 / 0.67 / 1.00 / 1.73 | 0.68 / 0.83 / 1.08 / 4.28 (loaded) | none | trivial | all | the early-out saves where the covering volume comes early (sorted smallest first); about half the walk on a grid |
| 2. per-object CPU culling (Unity built-in, Godot Mobile) | not built; estimate ~1.1-1.3 at 32 (materials at their own ≤ 4 volumes, ~0.2; the composite unchanged, 1.05 unrolled / 0.6 as a loop) | | CPU per object per frame (bounds vs boxes) | per-object shader variants (a compile per distinct list) or a per-object uniform list in every material; three only | **three materials only**: the composite is full screen, and Babylon / pixi only look up there | dominated by the grid; worth it only for many tiny objects with long lists |
| 3. screen-space clustered list (HDRP, UE, Godot Forward+, id Tech) | not built as a lookup; per pixel ≈ the grid's (same list lengths) | | GPU per view per frame: **0.01-0.04 ms** (64 px tiles x 32 slices, 4-32 volumes, p10-median), 0.07 at 128 volumes; 16 px tiles 0.03-0.17 at 4-32, 0.48 at 128 (`w63/cluster-build.json`) | a compute pass per view in each adapter, the camera's cluster mapping in every material, a second list for anything off screen (traced hits, captures) | materials + composite of the main view; **not** traced hits or probe captures | cheap to build, but more moving parts than the grid for no lookup gain while probes are static |
| 4. lower precision / two-level box test | not built | | - | f16 needs `shader-f16` | - | rejected by the profile: box math is ≤ 1.2 ms of 9.6 |
| **5. world-space volume grid (landed)** | **0.54-0.62 / 0.70-0.72 / 0.74-0.77 / 0.82-0.90** (run 3) | 0.92 / 0.53 / 0.72 / 0.35 (loaded, free +1-2 ms) | CPU with the table: 13-41 us for 8-64 volumes (packed every render by three, on `update()` by `ProbeSet`) | ~110 lines in core (`table.ts` pack, `lookup.ts` walk) and no adapter code | **all**: three materials, composites (three, Babylon, pixi), traced hits | flat in n; **shipped above 4 volumes, unrolled up to 4** |

An interleaved A/B in one page (`--only probe-lookup-ab`, 3 rounds, `w63/run4-ab-interleaved.txt`) ran on a loaded GPU (free 6-15 ms) and ranks the options the same at 16 and 32 volumes. At 32: rooms legacy 11.3 / loop + early-out 2.4 / grid 0.9-1.3 ms; Sponza 14.6 / 3.7 / 1.3-1.8.

**The threshold.** Run 1 measured the unrolled walk at 0.36 ms (4 volumes) and 0.78 (8). Run 3 measured the grid at 0.54-0.62 and 0.70-0.72. The two cross between 4 and 8. `PROBE_UNROLL_MAX_VOLUMES = 4` keeps every set of up to 4 volumes byte-identical to the shader it compiled before (the shipped scenes: rooms 2, offscreen 3), and 5-8 volumes are within ~0.1 ms either way. Re-time this on a quiet GPU and on a discrete GPU before tuning it (backlog).

## What the other engines do

| engine | how a pixel finds its probes | build | source; what is inferred |
|---|---|---|---|
| Unity built-in | Per renderer, on the CPU. The zone with the largest intersection with the object's bounding box wins (Importance first). With blending, each zone's weight is its intersection volume over the sum. The shader gets two cubes and one blend factor. | CPU, per renderer | [Using reflection probes](https://docs.unity.com/en-us/engine/current/manual/lighting-overview/reflections/using-reflection-probes), [Blend reflection probes (BiRP)](https://docs.unity.com/en-us/engine/current/manual/lighting-overview/lighting-birp/blend-reflection-probes-birp). The two-cube limit (`unity_SpecCube0/1`, `UNITY_SPECCUBE_BLENDING`) is from the built-in shader source as I recall it, not re-read here. |
| Unity HDRP | Env probes are a category of the light list. `GetCountAndStart(posInput, LIGHTCATEGORY_ENV, ...)` gives the pixel's tile range (opaque, FPTL) or cluster range (transparent). The loop evaluates a probe only `if (reflectionHierarchyWeight < 1.0)`. "Reflection probes are sorted by volume (in the increasing order)." | GPU compute, per view per frame | `Runtime/Lighting/LightLoop/LightLoop.hlsl`, Unity-Technologies/Graphics master (fetched 2026-11-12). The tile / cluster split is from the HDRP docs. Caps: "Max Cube Reflection On Screen" ([HDRP Asset](https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/HDRP-Asset.html)). |
| Unreal | "The Reflection Environment cost is only dependent on how many captures influence the pixels on the screen." Captures are "culled very efficiently" by their influence radius, smaller ones override larger, and at most 341 can be enabled. | GPU, per view | [Reflection captures](https://dev.epicgames.com/documentation/unreal-engine/reflections-captures-in-unreal-engine?lang=en-US). That the per-pixel list is the forward light grid (froxels with a reflection-capture count, read by the deferred reflection pass too) is from the engine source as I recall it, not re-read here. |
| Godot 4 | Forward+: probes are clustered elements beside lights and decals, 512 per view by default ("Max Clustered Elements"), and up to 4 blend at one point. Mobile: 8 per mesh. Compatibility: 2 per mesh. | GPU (Forward+); CPU per mesh (Mobile, Compatibility) | [Reflection probes](https://docs.godotengine.org/en/stable/tutorials/3d/global_illumination/reflection_probes.html) |
| Frostbite | Local probes sorted by size and accumulated front to back until the weight is spent (our walk, D58). Many lights through light tiling. | GPU, per view | Lag14 (appendix "Local light probe evaluation"); the tiling from Frostbite's SIGGRAPH 2015 mobile deck. That probes share the light tiles is inferred, not stated in what I read. |
| id Tech 6-8 | Clustered forward: lights, decals and environment probes in one froxel list. idT8 keeps probes as the fallback behind RT. | per view | Sousa & Geffroy, "The devil is in the details", SIGGRAPH 2016 Advances, as I recall it, not re-read here; idT8 = Sousa 2025. |

Every engine with many probes culls them into a short list before the pixel walks it. The engines that build per view also put lights and decals in the same structure, and their probes can move or stream. With only baked probes, one world-space list built at bake time does the same job without a per-frame pass or a camera. That is the knowing divergence, D4950. HDRP's early-out on the accumulated weight (`reflectionHierarchyWeight < 1`) is in the landed walk too.

## What landed (D4950)

- **Table** (`packages/core/src/probes/table.ts`). With `capacity` ≥ 2 (`PROBE_GRID_MIN_VOLUMES`), `packProbeTable` writes the grid right after the volumes, at `probeGridRow(capacity)`. Header row 1.z holds the grid row; 0 means no grid. The grid is:
  - at most 4096 cubic cells (`PROBE_GRID_MAX_CELLS`) over the union of the influence boxes;
  - per cell, 24 volumes per f32 lane (an exact integer), 4 lanes per row, `ceil(capacity / 96)` rows;
  - a volume is in every cell its box, grown by 1 % of a cell, touches;
  - masked-out volumes (an empty box) are in no cell.
  The irradiance block moves back by the grid's rows. `probeIrradianceRow` and `probeTableRows` include them, so every caller follows: 64 KB more per table up to 96 volumes. `ProbeSet` and three's `packReflectionProbesTable` pass `capacity`.
- **Lookup** (`packages/core/src/probes/lookup.ts`, the same for the proxy share):
  - Up to `PROBE_UNROLL_MAX_VOLUMES` (4) volumes known at compile time (`count`), the unrolled walk as before.
  - Otherwise, the grid walk: P's cell, its set bits in table order, `countTrailingZeros`, and a stop once `remaining` is 0.
  - P outside the grid walks nothing (the environment only). A table without a grid lists every volume.
  - Several atlases on the grid walk pick each volume's atlas by the table branch.
- **three** keys its lookup and proxy-share functions by the generated code, so variants never share a stale function.
- Adapters need no change: Babylon and pixi get it through `ProbeSet`, three through `packReflectionProbesTable`.

**Parity** (`--only probe-lookup-parity`, the walk before W63 (`legacy`) against the new one; rooms, offscreen and Sponza x shipped / few / many / mixed, 960x540; `w63/parity.json`):
- the probe term (view `probeSpecular`) is **0 / 255 max on every row**, bit-identical, the multi-atlas `mixed` sets included;
- `final` with RT off differs only by the SSR's frame-to-frame noise (mean 0.12-1.12; the identical-code rows give the floor, 0.14-0.83);
- `?rt=1` as two pages differs by mean 0.0024-0.0081 against the identical-code floor of 0.0026-0.0075;
- no validation errors.

The unit test `test/probe-grid.test.ts` checks that the grid lists every weighted volume, in order, at 28,000 random and box-face points for 2 to 120 volumes.

## Limits and what would change the call

- **Very large scenes.** 4096 cells over a 1 km world are 62 m wide, and a cell then lists every volume in it. A two-level grid or more cells would fix that, or per-view froxels, which adapt to the view.
- **Probes that move every frame.** three already repacks the table every render, so the grid follows them (CPU 13-41 us). A probe set with hundreds of moving volumes would want the GPU build of option 3.
- **Lights or decals in the same list.** If the lookup ever shares a list with lights or decals, the per-view cluster of option 3 is the standard answer.
- **Not done:**
  - the per-object list (option 2) and a clustered lookup (option 3) were not built; their per-pixel costs above are estimates from the measured walks;
  - a quiet-GPU re-time of 4-8 volumes and of the grid on Sponza;
  - a discrete GPU.

## Reproduce

```bash
REFLECTIONS_PORT=5429 pnpm check -- --only probe-lookup-cost     # one page per ?lookupExp= variant (W63_VARIANTS='legacy||loop,skip|grid', W63_COUNTS, W63_SCENES)
REFLECTIONS_PORT=5429 pnpm check -- --only probe-lookup-ab       # variants interleaved in one page (W63_ROUNDS, W63_STAT=p10|median)
REFLECTIONS_PORT=5429 pnpm check -- --only probe-lookup-parity   # W63_VARIANT (default legacy) vs the shipped walk, image for image
REFLECTIONS_PORT=5429 pnpm check -- --only probe-cluster-build   # option 3's build cost (compute, timestamp queries)
```

Data: `docs/research/w63/` (`run1-profile.json` is the quiet profile; `run3-*.txt` the grid; `run4..6` the loaded runs; `parity.json`; `cluster-build.json`).
