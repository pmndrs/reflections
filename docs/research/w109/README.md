# W109: probe lookup speed (T41, T43)

The maintainer's first priority is speed. Two TRIAGE rows on the probe lookup path, both with the output held fixed.
D5740 and D5741 hold the divergence entries.

## What was built

- **T41, one walk for two lookups.** r187's EnvironmentNode looks `scene.environmentNode` up twice per pixel: radiance
  (the bent reflection vector at the material's roughness) and irradiance (`normalWorld` at level 1). Each lookup walked
  the probe volumes on its own: the grid cell, each listed volume's 2-3 table rows, the box test and the weight.
  - Core `probeLookupPairFunctionWgsl` takes a second normal, direction and roughness and returns `mat4x4f`, where column
    k is lookup k's `vec4f`. The walk runs once. Each lookup does its own box projection, sample, re-fit and environment
    sample, in the arithmetic its own lookup uses. `lookupBody` takes a lookup count, and with one it emits the text it
    always did. Before committing, all 3840 combinations of layout, count, dominant direction, re-fit, seam options,
    orientation, atlases and bench modes were compared against HEAD's text: identical.
  - three's `ReflectionProbesNode` recognizes the two contexts: radiance has `getTextureLevel() === roughness`,
    irradiance has `getUV() === normalWorld` at level 1.
    - The radiance setup builds the pair as a var node marked `global`. The irradiance setup runs in EnvironmentNode's
      other isolate, finds that var in the global cache and reads column 1 from it.
    - This applies only to standard / physical materials without retro-reflection, and only to the environment form.
      Clear coat, explicit lookups and `reflectionProbesLocal` keep their own walks.
    - The builder holds the material as given, so a classic `MeshStandardMaterial` counts too. The first build checked
      only `isMeshStandardNodeMaterial`, so nothing paired. `--only probe-pair` caught that ("pair: 0").
    - `?lookupExp=nopair` turns the pairing off (bench only).
- **T43, the table only on change.**
  - `ReflectionProbes.updateVersion()` compares every input of the table with the previous call and bumps `version`. Per
    probe: the world matrix (brought up to date first), the sizes, both offsets, the fade, `oriented`, the atlas and the
    slot. Per set: `boxProjection`, `capturing`, `refitClamp`, the environment slot, the atlas ids and mip counts, and the
    baked probes themselves.
  - The probe nodes pack and upload only when `version` moves. They also write once into a buffer that three has just
    made, which needs the irradiance rows too.
  - `probeTableStats` counts checks, packs and bytes (bench only).
  - The RT hit shading's copy is unchanged, because `packages/three/src/trace` belonged to W110 (T77).

## Numbers

| what | result |
|---|---|
| One-lookup WGSL vs HEAD | byte-identical, 3840 option combinations |
| probe-core: pair columns vs their own lookups (8192 random points, 3 rooms) | environment form (what materials use) bit for bit: grid, unrolled (count 3), oriented + distance roughness + roughness lerp + dominant direction, r187 lod. Coverage form: max 4.1e-7 to 6.3e-7 (the shared `/ coverage` becomes one reciprocal), so coverage nodes don't pair |
| `--only probe-pair` (examples/ssr, pair vs `nopair` in one page) | rooms and Sponza oneSize128: views raw and final 0 differing px; each lit program calls the pair once and has no single lookup beside it |
| `--only probe-parity --parity-base main` (base shot on main's code in this worktree) | 32 / 33 shots 0 px. The 33rd moves between runs (run 1: Sponza many-probeSpecular 3 px at 1/255; run 2: that shot 0 px and few-probeSpecular 4 px). Both are the composite's own lookup, which W109 doesn't touch. Branch vs branch: 0 px. This is W108's known run-to-run noise (HANDOFF backlog) |
| core GPU, 1920 x 1080 random lookup pairs, wall ms per dispatch, median of 15 (`--only probe-pair-cost`) | 3 rooms, grid: 0.910 -> 0.780. 8 volumes: 0.880 -> 0.860. 32 volumes: 2.250 -> 2.080. 3 rooms unrolled: 0.890 -> 0.890 (the compiler already merges two unrolled walks) |
| examples/ssr 1080p, loop stopped, pair vs nopair alternating in one page (`--only probe-lookup-ab`, `W63_VARIANTS='\|nopair'`; JSON in `lookup-ab-1.json`, `lookup-ab-2.json`) | Below the noise: other projects shared the GPU, and the probe-free frame swung 4.9-12.6 ms (rooms) and 8.5-21 ms (Sponza) between rounds. Material part (frame minus composite-only), median of rounds, pair vs nopair: rooms 0.21 vs 0.32; Sponza oneSize128 0.41 vs 0.50 (9 rounds), 0.65 vs 0.80 (15); Sponza shipped 0.36 vs 0.39. Min of rounds: rooms 0.26 vs 0.29; Sponza oneSize128 0.39 vs 0.43 |
| T43 (`--only probe-table-cost`), 2 table checks per frame (G-buffer + composite renders) | rooms (3 probes, 65920 B table): 113 us CPU and 131840 B uploaded per frame -> 3.0 us and 0 B. Sponza oneSize128 (11 probes, 66688 B): 125 us and 133376 B -> 8.0 us and 0 B. Per call: check 1.5 / 4.0 us, pack 21.5 / 35.5 us, `writeBuffer` 35.0 / 27.0 us |

## Verdicts

- T41 is kept. It produces the same pixels with less work. The GPU gain is clear in the core bench on the grid walk
  (8-14 %). It can't be resolved in the lit frame on a shared GPU, and the material-part medians point to 0.03-0.15 ms.
  Rooms (3 volumes) uses the unrolled walk, where the compiler had already merged the two walks.
- T43 is kept. It saves about 0.11-0.12 ms of CPU and about 130 KB of uploads per frame for a static set.
- The hybrid composite's lookups stay as they are. Its probe term is looked up at P nudged off the surface (W87, D5420),
  and its proxy share at the raw P (D2400). One walk needs one position, which moves pixels at volume faces. That is
  T78, a decide. Its coverage lookup compiles only in a debug view.

## Left over

- T77: the RT hit shading (`packages/three/src/trace/hitShading.ts`) should pack and upload on `updateVersion()` only.
  It could then bind the node's table buffer instead of its own 64 KB copy, since the rows and packing are the same.
- T78: the composite's two walks (above).
- The frame-level timing on an idle machine, or with per-pass timestamps of the G-buffer alone (HANDOFF backlog).

## Reproduce

```bash
REFLECTIONS_PORT=5431 pnpm check -- --only probe-pair            # PAIR_CASES=rooms | all
REFLECTIONS_PORT=5431 pnpm check -- --only probe-core            # the pair checks
REFLECTIONS_PORT=5431 pnpm check -- --only probe-pair-cost       # PAIR_ROUNDS
W63_SCENES=showcaseSponza W63_VARIANTS='|nopair' W63_COUNTS=layout:oneSize128,shipped W63_ROUNDS=15 \
  REFLECTIONS_PORT=5431 pnpm check -- --only probe-lookup-ab
REFLECTIONS_PORT=5431 pnpm check -- --only probe-table-cost
```
