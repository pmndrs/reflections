# Probe lineage: which of Ben Houston's reflection probes is latest, and what ours lacks

Research stream R1, 2026-11-10. Read-only against `/Users/dex/Developer/three.js` and `/Users/dex/Developer/Denoiser`. Items marked *(inferred)* come from reading code, not from running it. No GPU runs.

## 1. Lineage

Our copy (`packages/three/src/probes/*`, `packages/core/src/probes/prefilter.ts`) was copied from Denoiser `examples/three-temporal/src/probes/` (HEAD `0ff604c`, 2026-10-20). That port (`8175470`, 2026-10-19) followed the PR as it stood **on 2026-10-16 to 10-19** (`e7ca274039` / `707bbf3a92`: environment cube in the **last** slot, `reflectionProbes()` returns `vec3` with environment fallback, `environmentNode`). Nothing from Ben's 10-21 follow-ups or later is in it.

| Version | Where | Last commit | Author | Relation |
|---|---|---|---|---|
| A. PR #35046 `specular-probes` (OPEN, 31 files, +2125/-90) | `bhouston/specular-probes`, head `77bbaaaa05` | 2026-11-09 14:16 | Ben Houston | Latest published. A "simplified review surface" rewrite (`d70a99c7b0`, `246e6128e7`); also identical to branch `reflection-probes-coverage-review`. |
| B. PR #35053 CubeArrayTexture (OPEN, 13 files) | `bhouston/cube-array-texture`, 9 commits | 2026-11-09 | Ben Houston | Prerequisite of A. Replaces #35045, which was merged 10-16 then reverted by Mugen87 (#35058, 10-19) and folded into #35053. Review asks open (KTX2 support, Mugen87's API feedback). |
| C. Maintainer's local branch `webgpu_preview_interior` | `/Users/dex/Developer/three.js`, HEAD `af01a8bbcd`; last probe commit `22f082f750` | 2026-10-24 (probe files), 2026-10-25 (HEAD) | Ben Houston | **Not an ancestor or descendant of A.** Same author, same base (A at 10-21, `8fa1d98615`), then a different line: explicit indirect-lighting providers, environment slot at index 0, multi-bounce, `usePrevious`. A later took the other line (`cd9905d6fa`/`d035669b18`, 10-25, "local coverage" API). |
| D. Maintainer's fork, `pmrem-compute-probes` (`3cb8af5b6b`) | `/Users/dex/Developer/three.js`, remote `origin` | 2026-10-19 | Dennis Smolek (Claude co-authored) | A at 10-16 (`e7ca274039`) + compute PMREM (#35130) + target reuse + live capture + environment-version tracking. Ours inherits its target reuse. |
| E. `probes-timeslice-idea` (`37bf331235`) | same | 2026-10-19 15:34 | Dennis Smolek | D + one commit: `bake({ probes })` time slicing. |
| F. PMREM compute: `pmrem-compute`, `pmrem-compute-copy` (both `64248d0cc7`), `feat-pmrem-webgpu` (`c7afb22292`), `pmrem-wip` (`97a13a1717`) | same | 2026-10-18 to 10-22 | Dennis Smolek, plus Ben's lifecycle fixes (`710161f0d3`, `9689c8a716`) | PR #35130 (OPEN, head `pmrem-compute`, updated 11-05). `pmrem-compute-copy` = `pmrem-compute`. `feat-pmrem-webgpu` is an earlier snapshot, `pmrem-wip` the earliest. No probe code in F. |
| G. `/Users/dex/Developer/three.js-pmrem` | worktree of `/Users/dex/Developer/three.js` (`git worktree list`), on `pmrem-compute-copy` | 2026-10-22 | n/a | Same objects as F. Not a separate copy; don't count it. |

Not probe work, ignore: `fix-probe-camera-depth` and `fix-probe-capture-regressions` (LightProbeGrid, not ReflectionProbes). The worktrees under `~/Documents/Codex/` are mipmap work.

## 2. Verdict

- **Latest published: A (PR head `77bbaaaa05`, 2026-11-09).** It is what mrdoob/Mugen87 are reviewing and what will merge. Confidence: high.
- **Most features: C (interior), not latest.** The maintainer's hunch is half right. C has 72 more lines of `bake()` (bounces, `usePrevious`, capture-time lighting context) and an explicit-provider API, and A deliberately removed those for review size. But C is 16 days older than A, and it depends on `indirectSpecular()` / `indirectDiffuse()` / `LightingContextNode` provider chains that A adds to three core (`src/nodes/lighting/IndirectSpecularNode.js` is absent from `dev`). Nothing in C runs on r186. Confidence: high on the dates and the diff, medium on "depends on core changes" *(inferred from imports and from `IndirectSpecularNode.js` missing from dev)*.
- **Not in the PR or C but useful: D/E (maintainer's fork).** Time slicing and environment-only-when-changed exist only there. They are the maintainer's own work, so no licence or attribution question.
- API note: A's `reflectionProbes()` now returns `vec4` (rgb conditional radiance, a = coverage) with **no environment slot**, and the PR body tells apps to write `scene.environmentNode = local.rgb.mul(local.a)`. "Stay API-compatible with #35046" therefore means two different things depending on which snapshot is the target. See D20.

## 3. Feature and API diff against ours

A = PR head. C = interior. D/E = fork. "Ours" = `packages/three/src/probes`.

| Feature | A (PR head) | C (interior) | D/E (fork) | Ours |
|---|---|---|---|---|
| `ReflectionProbe(w, h, d)`, `influenceSize`, `projectionSize`, `blendDistance`, `copy()` | yes (`ReflectionProbes.js`; `copy()` `06f9bd8fd0`) | same | same | yes, all |
| `projectionOffset` (box centre offset from the capture point) | **yes** (`4a03e5d243`, 10-21) | yes | no | **no**. We have `originOffset` instead, see D21 |
| Constructor of `ReflectionProbes()` | none | none | none | none (matches) |
| `bake()` options | `resolution` (default 256, floored to pow2, min 256), `near`, `far` | + `bounces`, `usePrevious` | + `probes` (E) | `resolution` (default 128, throws unless pow2 >= 64), `near`, `far`, `environment` (ours) |
| Live capture / target reuse | no: new `RenderTarget` + `PMREMGenerator` per `bake()`, old one disposed at the end | no | **yes** (`0b60cc22dd`: reuses target and PMREM between same-layout bakes) | **yes** (render target, cube target, camera and prefilter reused) |
| Time slicing | no | no | **yes**, `bake({ probes: [...] })` (`37bf331235`) | no |
| Environment recapture only when changed | no | no | **yes** (`351167b7d1`: tracks `texture.version` / `pmremVersion`; clears the slot when the environment is removed) | partial: always recaptured unless `environment: false`; a reused array clears the slot when the environment goes away |
| Shadow-map reuse during capture | **yes** (`2b95820110`: `shadow.autoUpdate = false`, `needsUpdate = true` for the bake; Ben: "doubles performance") | yes | no | **no** *(inferred: `CubeCamera.update` renders six faces per probe, each re-rendering shadow maps)* |
| Multi-bounce (`bounces`) / sample previous bake (`usePrevious`) | no (removed) | **yes** (`441d41892b`, `22f082f750`; spare target ping-pong, `_captureBounce`) | no | no |
| Capture-time overrides (background = environment, `getAO` / `getSpecularOcclusion` nulled, restore in `finally`) | no | yes (`e818c92e50`) | no | partly: we clear and restore `autoClear*` and `scene.background` in `finally`; no AO overrides (we have no AO provider on r186) |
| Environment slot | **none**: `texture` holds `probes.length` cubes | slot **0**, probe `i` at `i + 1` | slot **last** (`probes.length`) | slot **last** |
| Node output | `vec4`: rgb conditional radiance, a coverage (`reflectionProbes`); `reflectionProbesSpecular(probes)` / `reflectionProbesDiffuse(probes)` provider functions for `indirectSpecular()` / `indirectDiffuse()` | `vec3` with fallback, plus `localOnly` / `environmentOnly` variants, `reflectionProbesEnvironment()` | `vec3` with fallback | `vec3` with fallback; `sampleReflectionProbes(probes, P, dir, roughness)` for any shader (ours; not upstream) |
| Query inputs (position / direction / roughness) | constructor options `{ position, direction, roughness }` | same | no | same idea via `ProbeLookupInputs` |
| Influence weights, priority (smallest volume first), blend fade | same maths | same | same | same |
| Box projection | `getParallaxCorrectNormal()` from three core, `+ projectionOffset`, one `_boxProjection` uniform (`6d00afb46e`) | same | older: `getParallaxCorrectNormal` | own `parallaxCorrect`, per-slot `project` uniform, equivalent guard for axis-aligned directions |
| Influence shapes | axis-aligned box only (rotation ignored) | same | same | same. **None of A/C/D has sphere or oriented-box influence.** |
| Storage | `CubeArrayTexture` (#35053), sampled with `cubeTexture(...).depth(i)` | same | same | 2D array, 6 layers per probe, face picked in shader (D1, D2) |
| PMREM / prefilter path | `PMREMGenerator.fromScene` (upstream, restored in `246e6128e7`) + `copyTextureToTexture` per mip | same | compute PMREM (F) | own compute prefilter (`core/probes/prefilter.ts`), r187 algorithm (D3) |
| Uniforms shared across material programs | **yes** (`c4e4833e17`: slots persist; mrdoob reported stale probes) | yes | no | **yes** (slots rebuilt only when the probe count changes) |
| Cache key includes node id | **yes** (`6837c32abc`: `NodeUtils.hash(super.customCacheKey(), count)`) | yes | no | **no**: returns `count * 2 + seam bit` only. Two probe sets with the same count and seam mode could share a compiled program with the first set's uniforms *(inferred, untested)* |
| Switch to new texture without recompile; recompile when the probe count changes | yes (`503c1f9810`) | yes | no | yes |
| Null-texture guard | node returns `vec4(0)` if `texture === null` | no | no | constructor throws if not baked |
| Zero probes | `bake()` disposes and returns | n/a | n/a | bakes an environment-only array |
| Helper (`ReflectionProbesHelper`) | **world-space** (ignores parent transform), draws projection volumes in a second colour (`projectionColor` default 0x00ffff) when `projectionSize` or `projectionOffset` is set (`706ccdf2b8`) | same | older | sphere at the capture point + influence box only; follows the parent transform |
| Rounding of resolution | floors to a power of two like PMREM (`2712ba1b23`) | same | no | throws |

Bug fixes in A/C that ours lacks: shadow reuse is a perf fix, not a bug. The two real gaps are the **cache key** and **helper in world space** (a helper parented under a moved group draws in the wrong place). Ours already has the stale-uniform fix, the box-projection toggle, near/far sync of the capture camera and the texture swap on re-bake.

## 4. Recommendations (priority order)

Adopt:

1. **Shadow-map reuse during `bake()`** (A, `2b95820110`). Around 10 lines, restore in `finally`. Ben measured 2x on bakes. Matters for live capture and time slicing.
2. **`projectionOffset`** (A, `4a03e5d243`). Needed for API compatibility with #35046 and for the helper. Keep `originOffset` as an extension (D21) and document how the two relate.
3. **Coverage output** (A's `vec4` form): add `reflectionProbesLocal(probes)` or a `coverage` option on `sampleReflectionProbes`, returning rgb = conditional radiance, a = coverage, no environment fallback. The SPEC's SSR to probes to environment resolve needs exactly this (SSR confidence, then probes by coverage, then environment). Keep the current `vec3` fallback node, which is what the 10-16 snapshot and the explainer use.
4. **Cache-key fix** (A, `6837c32abc`): `customCacheKey` includes the node's own key or id, so two `ReflectionProbes` sets don't share programs. Add a test with two sets of equal size (needs a GPU; `pnpm check`).
5. **Time slicing and environment-only-when-changed** (E `37bf331235`, D `351167b7d1`): `bake({ probes })` to refresh a subset, and recapture the environment slot only when `scene.environment` changed. Both are the maintainer's own; ours already has the reuse they build on.
6. **Helper**: world-space drawing and projection volumes (A, `706ccdf2b8`). Small.
7. **Resolution handling**: floor to a power of two instead of throwing, keep our floor of 64. Low value; do it with the next edit of `bake()`.

Skip, with reasons:

- **`CubeArrayTexture` (#35053) and cube-array sampling.** It needs renderer changes (`Textures.js`, `WebGPUBindingUtils.js`, `WGSLNodeBuilder.js`) that r186 doesn't have, and the PR is still under review (reverted once). Stays under D1. Revisit when the floor moves to a three release that ships it, or when the core path binds cube arrays directly (phase 1 `cube-hw`).
- **`bounces` / `usePrevious` (C only).** Real feature, but C's implementation swaps `renderer.contextNode` and uses `indirectSpecular` providers, none of which exist on r186, and A dropped it. If wanted later, do it on our own terms: our `capturing` flag already gates local probes, so a spare target plus `local = 1` on bounce > 0 would do it. Park until the rooms demo (R3) shows missing interreflection.
- **`indirectSpecular()` / `indirectDiffuse()` providers (A, C).** Core three changes in r187-dev. We can offer the same data through the `vec4` coverage node (item 3) without them.
- **A's SSR changes** (`SSRNode.js`, `SpecularHelpers.js`): three-internal, replaced by our own SSSR.
- **Compute PMREM (#35130, F).** Our prefilter already does this in core on r186. F is reference only. `64248d0cc7` (face directions from the major axis and sign) is a bit-identical refactor; no action. Worth one read of `710161f0d3` / `9689c8a716` only if we ever bind a PMREM render target's texture as storage.
- **Sphere or oriented influence volumes.** Nobody upstream has them. Out of scope for now.

## 5. Proposed DIVERGES entries

Format follows `docs/DIVERGES.md`: `id | area | source does | we do | why | revisit when | status`.

| id | area | source does | we do | why | revisit when | status |
|---|---|---|---|---|---|---|
| D20 | probes / node output | #35046 head (`77bbaaaa05`, 2026-11-09): `reflectionProbes()` returns `vec4` (conditional radiance, coverage), no environment slot; the app composes the fallback. | `reflectionProbes()` returns `vec3` with the environment fallback built in (the 2026-10-16 to 10-22 PR behaviour); coverage variant planned (recommendation 3). | r186 has no `indirectSpecular()` provider chain; `scene.environmentNode` is the only hook. | The coverage node lands, or #35046 merges and the floor moves to a release with providers. | planned |
| D21 | probes / offsets | #35046 `projectionOffset`: capture at the probe, projection box centred at probe + offset. | `originOffset`: projection box and influence stay on the probe, the capture point moves. We will also add `projectionOffset`. | Predates the PR's offset (10-19 vs 10-21); same goal, opposite choice of what moves. | `projectionOffset` is added; decide whether to keep `originOffset`. | planned |
| D22 | probes / layout | A (`77bbaaaa05`): `probes.length` cubes, no environment slot. C (interior): environment at slot 0, probe `i` at `i + 1`. Ben's 10-16 to 10-21 PR: environment last. | Environment last (`probes.length`), fixed so any layout code that hardcodes the slot index agrees with the fork. | Matches the version we ported and the maintainer's fork. | D20 resolves (the slot may go away). | open |
| D23 | probes / bake defaults | `resolution` default 256, floored to a power of two, minimum 256 (PMREM's minimum). | Default 128, power of two from 64, throws otherwise. | Our prefilter has no 256 floor; 128 is enough for the demos. | The phase 1 bench settles the right default; or rounding replaces the throw. | open |
| D24 | probes / capture path | `PMREMGenerator.fromScene` per probe, then `copyTextureToTexture` per mip, new target each bake. | `CubeCamera` + core `ProbePrefilter` straight into the array layers; target, cube target and prefilter reused between bakes. | r186's PMREM writes the CubeUV atlas (see D3); reuse avoids allocation in live capture. | Never for the reuse; the prefilter path follows D3. | open |
| D25 | probes / bounces | C (interior): `bake({ bounces, usePrevious })` re-captures with the previous pass's probes visible. | Not implemented; captures see the environment only (`capturing` gates local probes). | A dropped it; C's version needs r187-dev lighting-context hooks. | The rooms demo shows missing interreflection is the main error. | open |
| D26 | probes / helper | A: `ReflectionProbesHelper` draws in world space with projection volumes. | Draws sphere at the capture point and influence boxes, follows the parent transform. | Older port. | Recommendation 6 lands. | planned |
| D27 | probes / live capture | #35046 has no time slicing or environment version tracking; the fork has both (`37bf331235`, `351167b7d1`). | Neither yet; environment slot is recaptured every bake unless `environment: false`. | Recommendations 5. | Recommendation 5 lands. | planned |

Notes for the lead: D22 and D20 are linked. D21 and D26 close when recommendations 2 and 6 land; set them `resolved` then and keep the rows.
