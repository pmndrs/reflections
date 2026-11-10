# @pmndrs/reflections — spec

Status: draft 4, 2026-11-10 (source claims corrected against `docs/research/sources.md`). Phase 0 (this repo's first commit) is done. Everything after it is a plan.

## What this is

One library for specular reflections on WebGPU. It covers the three sources real-time engines combine:

- **Reflection probes:** baked or live captures, prefiltered by roughness, box-projected, blended by volume.
- **Screen-space reflections:** a hierarchical-depth stochastic tracer, a port of FidelityFX SSSR.
- **Ray-traced fallback:** BVH rays for what screen space can't see.

A **hybrid resolve** picks among these sources per pixel. It also hands the noisy part to a temporal denoiser and composites the result into the frame.

The core is engine-agnostic: WGSL passes on a bare `GPUDevice`. Engines plug in through adapters. three.js `WebGPURenderer` is the first adapter, as it was in the sibling libraries `denoiser` and `@pmndrs/upscaler`.

### Why a separate project

Until now, the reflection work lived in the denoiser repo. The FFX reflection denoiser was in the package, and the probes, SSR wiring and ray-traced reflections were inside its `three-temporal` examples. Ben Houston's probe work was split between those examples and a three.js fork.

Apart from the denoiser itself, none of that was denoiser work. The probes were example code that nobody could import.

This repo gives the reflection sources a home. The siblings keep their own jobs:

| Library | Job here |
|---|---|
| `denoiser` | Denoises the noisy reflection signal (`ffxReflections` / `FfxReflectionDenoiser`). It plugs in through the denoise seam (below). Its examples become consumers of this package. |
| `@pmndrs/upscaler` | Runs after composition, as it does for any frame. Reflection passes can run at a reduced resolution and are upscaled by their own resolve, not by the upscaler. |
| three.js | The first vendor. The probes keep the API of three.js #35046 (Ben Houston's `ReflectionProbes`), so code can move between this repo and three. |
| `@pmndrs/bvh` | The BVH for the ray-traced source: engine-free WebGPU builders and a WGSL ray walk, behind the trace seam (below). Still WIP. three-mesh-bvh covers three until it is ready. |
| `@pmndrs/ddgi` | A diffuse GI sibling, and the first user of `@pmndrs/bvh`. One source of the irradiance that the probe re-fit consumes. |

### Non-goals

- **No WebGL.** WebGPU only, like the siblings. The octahedral probe layout below does happen to be WebGL2-friendly, which keeps a door open.
- **No diffuse GI.** Irradiance volumes, DDGI, SSGI and VXGI are out of scope. Reflections *consume* irradiance from those tools; see "Probe re-fit".
- **No denoiser implementation.** Denoising stays in `denoiser`. This repo defines the inputs and outputs the denoiser sees.
- **No scene management.** The engine owns meshes, materials and the capture render. The core owns textures, passes and lookups.

## Package layout

This is the same shape as `@pmndrs/upscaler`: pnpm workspaces, private engine packages, and one published package that bundles them.

```
@pmndrs/reflections            published; root package.json, src/{index,core,three,babylon,pixi}.ts, built by vite + rollup-plugin-dts
  .                            the three.js surface (same as ./three)
  ./three                      three.js WebGPURenderer adapter
  ./core                       engine-agnostic, bare GPUDevice
  ./babylon                    Babylon.js WebGPUEngine adapter (experimental, W15)
  ./pixi                       pixi.js v8 WebGPURenderer adapter for pixi-3d scenes (experimental, W18, W19)
packages/core   @pmndrs/reflections-core    private: WGSL passes, layouts, math, contracts
packages/three  @pmndrs/reflections-three   private: ReflectionProbes, TSL nodes, three-mesh-bvh trace provider
packages/babylon @pmndrs/reflections-babylon private: frame contract from a Babylon frame graph, core SSR + ProbeSet on Babylon's device, composite task
packages/pixi   @pmndrs/reflections-pixi    private: the frame contract from a pixi-3d View3D (structural, never imports the @pixi/3d beta), core SSR + ProbeSet, composite as a pixi Filter;
                                              the beta-dependent pieces (G-buffer Pass3D, probe cameras) live in examples/pixi3d/shared
examples/<name>/index.html                  `pnpm examples` -> http://127.0.0.1:5370/<name>/
scripts/run-headless.mjs                    `pnpm check`: Chrome + WebGPU over CDP, no puppeteer
```

**Rules:**

- `core` never imports an engine.
- An adapter never re-implements core math. It gets textures and a device from its engine, calls core, and wraps the core lookups in the engine's shading system (TSL nodes for three).
- The public API carries no AMD product marks, as in the upscaler. Attribution stays in `NOTICE` and in file headers.

## Frame contract

Every screen-space and hybrid pass reads the same inputs. Adapters fill them; core never guesses at conventions, so each choice is an explicit flag.

| Input | Format / convention | Notes |
|---|---|---|
| depth | the engine's depth texture, or r32f linear | `depthInverted` flag (reverse-Z) |
| normal | world space, rgba16f or packed | unpack mul/add like FFX's `normalUnPackMul/Add` |
| roughness | a channel of a material texture | `roughnessIsPerceptual` (three: true) |
| metalness / F0 / albedo | material texture | used for the lobe weight and composition |
| motion | uv-space velocity | `motionVectorScale` maps engine conventions |
| scene color | HDR, direct + diffuse lighting only | SSSR's hit radiance; last frame's color is allowed (reprojected) |
| camera | view, projection, previous view-projection, jitter | the same struct the denoiser's `FrameCamera` uses |

**Output:**

- specular radiance (rgba16f) plus hit distance (r16f), at full or half resolution;
- per-pixel source and confidence (debug and resolve);
- the denoised result once the denoise seam has run.

### Denoise seam

The resolve takes any object shaped like `denoiser-core`'s `TemporalDenoiser<SpecularInputs>`. That covers radiance, hit distance, guides (depth, normal, roughness, motion) and the camera.

`FfxReflectionDenoiser` from `denoiser/ffx` fits it as is. On three, `ffxReflections()` from `denoiser/three` is the matching node.

`denoiser` is an optional peer, never a dependency. With no denoiser, the resolve falls back to the probe term for rough pixels and to the raw trace for mirrors.

### Trace seam

A trace provider is a WGSL snippet plus a bind group. The snippet provides `fn traceFirstHit(origin, dir, tMax) -> Hit`, where `Hit` holds distance, triangle id, barycentrics and a material index.

As built (W8, `packages/core/src/trace/`): the provider has the shape of @pmndrs/ddgi's `WgslModule` (`code(slot)`, `entries`, `resources()`, `version`, `storageBufferCount`), so the pass places its bindings and the @pmndrs/bvh trace module wraps without changes. `Hit` also carries an optional world normal and the instance. The exact interface and what @pmndrs/bvh still lacks are in `docs/HANDOFF.md`, "Trace seam".

Hit shading belongs to the resolve, not the provider. It looks up the probes at the hit point, plus whatever cheap material evaluation the engine exposes.

- **Core provider: `@pmndrs/bvh`** (pmndrs/bvh, WIP; split out of webgpu-ddgi on 2026-11-10). This is ours, and it is the target.
  - It is engine-free.
  - It builds with tinybvh in WebAssembly on the CPU, or with H-PLOC or LBVH on the GPU, and refits on the GPU (instance top level, skinned meshes).
  - Every builder writes one GPU layout, versioned by `GPU_LAYOUT_VERSION`, currently 1. Its WGSL walk is `giTraceClosest` / `giTraceAny`, with a CPU port and a ray oracle.
  - The provider wraps that walk as `traceFirstHit`, and checks `GPU_LAYOUT_VERSION` at start-up.
  - The GPU builders need the `subgroups` feature. Without it, `createMeshLayoutBuilder` falls back to tinybvh on its own.
  - Because it lives in core, babylon, pixi and raw WebGPU all get rays, not only three.
  - It is an optional peer: the pixel paths that don't trace never load it.
  - As built (W14): `createPmndrsBvhTraceProvider` in `packages/core/src/trace/pmndrsBvh.ts`, linked as `link:` to `../bvh-worktrees/reflections-integration` (bvh's `reflections-integration` branch in a worktree next to this repo, which adds `GiHit.normal` and a per-instance `GiHit.material`); three builds it with `createPmndrsBvhTraceProviderFromObjects`. Opt-in in `examples/ssr` (`&bvh=pmndrs`); the gate numbers are in `docs/HANDOFF.md`, W14.
- **three stopgap:** wraps `three-mesh-bvh/webgpu` (`BVHComputeData`, `raycastFirstHit`), which the explainer pages already use. It stays until `@pmndrs/bvh` passes its own oracle on our scenes. After that, it remains only for apps that already have a three-mesh-bvh tree.

## Sources

### 1. Probes (moved here in phase 0)

**State today.** Phase 0 moved this code from the denoiser repo, unchanged except for imports:

- `ReflectionProbe` / `ReflectionProbes` / `ReflectionProbesHelper`
- `reflectionProbes()` and `sampleReflectionProbes(probes, P, dir, roughness)`
- the GGX prefilter

It works as follows:

- It uses the API of three.js #35046. The three floor is r187 (raised from r186 on 2026-11-10).
- r187 still can't bind `texture_cube_array` (#35045 was merged then reverted; #35053 is open; r187's `wgslFn` accepts the type, but no texture creates a cube-array view), so the cubes live in a 2D array of 6 × N layers, and the node picks the face itself.
- The prefilter is a raw-WebGPU compute pass, now in core (`probes/prefilter.ts`). It implements r187's cube-PMREM plan: lod 0 copy, 256-sample filtered importance sampling, and the last three levels as full 16 px integrals. Roughness maps to lod by `lod = maxLod · r · (2 − r)`.
- `seamFix: 'warp'` centres the edge texels on the cube edges. Measured against the hardware cube sampler on the same bake, it differs by a mean of 0.05 / 255 and at most 3 / 255. It costs about 0.06 ms per 1080p frame for 3 probes.

**Measured numbers (denoiser repo, M-series):**

| Case | Time |
|---|---|
| Bake, 3 probes at 128 px | 2.2 ms (loop stopped, ~1.8 ms of it CPU encoding) |
| Bake, one 256 px probe | ~1.8 ms timed, ~1.05 ms in bursts |
| Frame at 960×540, probes only | ~2.9 ms |
| Frame at 960×540, probes with live capture | ~4.7 ms |

**Extensions over #35046:**

- `sampleReflectionProbes`: any shader can look up the probes, such as a traced ray's miss, a composite or a hit point.
- `originOffset`
- `bake({ environment: false })`
- `seamFix`

**Where it goes:**

- **Layout-generic atlas in core.** The probe texture, the volume table (influence, projection, blend, priority) and the lookup become core.
  - The lookup is a WGSL function plus a bind group layout.
  - The three node becomes a thin TSL wrapper over it.
  - The layout is a parameter (next section).
- **Capture stays in the adapter.** Rendering six faces is engine work. Core takes the six face textures and does everything after: prefilter, atlas write, environment slot.
- **three upstream.** When three ships `CubeArrayTexture` sampling (#35053) and #35046, the three adapter can bake into three's texture for a `cube-array` layout. The API stays the same either way.
- **Probe re-fit.** Normalize the probe radiance by irradiance, as idTech 8 does: `reflection × frameIrradiance / probeIrradiance`. Lazarov 2013 describes the same normalization (Hobson 2019 is cited for it too, but unverified: the slides are gated).
  - `probeIrradiance` is the probe's L1 SH, taken from the same capture and evaluated at the shading normal, with the ratio clamped. Lazarov uses SH9 here; L1 is our cheaper choice and gets measured against SH9 (DIVERGES D60).
  - `frameIrradiance` comes from whatever GI the app has: three r187's `LightProbeGrid` (L2 SH), `@pmndrs/ddgi`'s irradiance volumes, VXGI, SSGI or a lightmap.
  - This is the main way reflections "work with GI tools". It removes glowing corners and picks up bounce colour that the probe's single capture point missed.

### 2. Octahedral probes vs PMREM (phase 1 research)

**Correcting the premise.** idTech 8 (Sousa, Advances in Real-Time Rendering, SIGGRAPH 2025) uses octahedral maps for its *irradiance* volumes, not for its reflection probes:

- The irradiance volumes are a DDGI-style atlas: 8×8 octahedral tiles with 10×10 borders, RGB9E5 colour plus RG16F visibility, 2560×1585 for 6 cascades plus up to 100 local volumes, about 0.08 ms to update.
- Its reflection probes are still BC6H cube-map arrays: box-projected, GGX-prefiltered by their own baker, and re-fit as above.
- Its specular order is "SSR when possible, then RT, with fallback to probes based on smoothness" (p28). RT only runs on very smooth surfaces, at ½ or ¼ resolution, and shipped disabled on consoles (~2 ms). Probes are the baseline, not the last resort.

Octahedral *reflection* probes are still worth testing. Our case differs from idTech's in three ways:

- three (r187) can't bind cube arrays yet.
- We have no BC6H on every platform.
- We want one layout that babylon, pixi and raw WebGPU can all sample.

**PMREM and octahedral are different axes**, so they can work together:

- PMREM is a *prefilter plan*: which roughness goes in which mip, and how each mip is integrated.
- Octahedral is a *parameterization*: how directions map to texels.

The core prefilter will take the layout as two functions, `dirForTexel(layout, texel)` and `texelForDir(layout, dir)`. That way the same GGX plan (r187's, with the same roughness-to-lod mapping) writes any layout. Three's own PMREM output for `scene.environment` can then be resampled into the probe atlas's environment slot.

**Layouts to compare:**

| id | Layout | Lookup |
|---|---|---|
| `cube2d-warp` | today: 6 layers per probe, edge-centred texels | face pick + 2 bilinear samples |
| `cube2d-none` | 6 layers per probe, plain texels | face pick + 1 trilinear sample (edge creases) |
| `cube-hw` | one cube texture per probe (stands in for a cube array) | 1 hardware sample, seamless |
| `octa` | 1 layer per probe, full-sphere octahedral, a gutter at each mip | 1 trilinear sample |
| `octa-hemi` (maybe) | hemi-octahedral for probes on a wall | 1 sample, half the texels |

**Storage format, a second axis.** Format is independent of layout, so every layout above is also measured in each format that can hold it:

| Format | Bytes / texel | Notes |
|---|---|---|
| `rgba16float` | 8 | Today's format and the default everywhere. Compute can write it directly. |
| `rg11b10ufloat` | 4 | No alpha and no storage binding. Written by a render pass or a copy. Renderable only with the optional `rg11b10ufloat-renderable` feature. |
| BC6H (`bc6h-rgb-ufloat`) | 1 | Optional `texture-compression-bc` feature, so desktop only (Apple Silicon included); mobile WebGPU has no compressed HDR format. Compute can't write it, so a GPU encoder writes 16-byte blocks to a buffer, then `copyBufferToTexture`. Every mip has to be at least one 4×4 block, which an 8 px floor satisfies. Gutters have to be wide enough not to bleed across blocks. |

BC6H is a format for baked probes. For a live capture, the encode time counts against the frame, so it is measured as part of the bake. For BC6H, the metrics add the encode error on top of the layout error.

idTech 8 ships BC6H cube arrays. For us, a layout that wins on `rgba16float` and also compresses well is the goal.

**Metrics.** Each is measured per roughness level, on the same captures, on two scenes: the two rooms and the explainer room.

- **Error** against a brute-force GGX reference: a compute pass integrating mip 0 with thousands of samples per texel direction. Reported as mean and p99, split into face-edge or fold texels versus the rest.
- **Seam visibility** after tone mapping.
- **Memory per probe** at equal p99 error, per format.
- **Bake time** (prefilter only, then full).
- **Lookup cost**: ms per 1080p frame for 1, 3 and 16 probes.
- **Engine fit**: what babylon, pixi and raw WebGPU need in order to sample it.

**Gate.** `octa` becomes the default if both of these hold:

- it matches `cube2d-warp` error at less than or equal memory;
- it costs no more per frame.

Otherwise it stays an option. The format default stays `rgba16float`. BC6H becomes an opt-in for baked probes if two things hold: at 128 px and up its p99 error stays within twice the layout's own error, and sampling is no slower.

The `cube-hw` path remains the reference for "what a cube array would give".

### 3. Screen-space: SSSR port (phase 3)

Three's `SSRNode` is tightly bound to three. Its stochastic march was also the root cause of the boiling we chased in Ben's scenes; see the denoiser repo's `REFLECT-BENCH.md`.

The port follows FidelityFX SSSR (SSSR 1.5 in the current GPUOpen manual). It keeps the host order of the SDK v1.1.4 sources that our denoiser port already follows:

1. **Hierarchical depth:** an SPD-style downsample of depth to a 7-level pyramid (r32f; mip 0 a copy, 6 reduced levels): min for forward Z, max for reverse Z. Built by the maintainer's `downsampler` since W13 (odd footprints include the extra row/column, D1600; up to six levels per dispatch, D1601).
2. **Tile classification.** This pass *reads* roughness; it doesn't compute it. Roughness is the frame contract's input: a G-buffer channel in a deferred engine, or an MRT output in three (`materialRoughness`, as our three-temporal pages already do). The pass exists for the GPU budget. It turns per-pixel decisions into compact work lists, so later passes launch threads only for pixels that trace.
   - Pixels rougher than `roughnessThreshold` trace no ray and take the probe term. FFX compares in alpha (perceptual²): its default 0.2 is about 0.447 perceptual. We take thresholds in perceptual units and square them at the pass boundary (DIVERGES D43). The mirror test (always trace, start at mip 0, ignore the occupancy exit) is alpha < 0.0001.
   - `samplesPerQuad` sets the minimum rays per 2×2 quad (1, 2 or 4).
   - With variance-guided tracing, a quad gets more rays when last frame's variance is high.
   - The pass writes the ray list (one entry per tracing pixel, appended with an atomic counter), the denoiser tile list (8×8 tiles with at least one reflective pixel) and the ray counter.
   - Mirror-smooth pixels are flagged so the denoiser skips them.
3. **Blue noise:** a 128×128 texture per frame from the frame index (Sobol + scrambling tables, or our own).
4. **Indirect arguments** from the ray counter.
5. **Intersection:**
   - Hi-Z traversal, which uses coarser mips when that is safe and goes full-rate for mirrors and quarter-rate for glossy.
   - A hit writes radiance and hit distance.
   - A hit is not binary. FFX computes a **confidence**: a screen-border vignette times a squared falloff of the distance to the surface over the thickness, and zero for rays that leave the frustum, self-hit within 2 px, hit the background, or hit a back face. Radiance is `lerp(fallback, sceneColor, confidence)`.
     - With a trace provider, a pixel with `confidence < ssrConfidenceThreshold` (FFX's hybrid sample: 0.9) is appended to the **miss list** (see "Work lists and indirect dispatch").
     - Without one, the fallback is the probe lookup inline, at the pixel's position and the ray's direction.
6. **Denoise** through the seam (`FfxReflectionDenoiser`).

#### Work lists and indirect dispatch

Every pass after classification runs over a list, not over the screen. Each list is a storage buffer plus an atomic counter. A one-workgroup pass turns each counter into `dispatchWorkgroupsIndirect` arguments.

| List | Written by | Entry | Read by |
|---|---|---|---|
| ray list | classify | packed pixel coordinate plus quad-copy flags (u32: FFX's 15-bit x, 14-bit y, 3 copy flags) | intersect |
| denoiser tile list | classify | packed 8×8 tile coordinate | denoiser passes |
| **miss list** (after FFX's `hybridreflections` sample; we add the direction and the per-tile cap) | intersect | pixel coordinate + ray direction, octahedral-packed as 2 × 16-bit snorm (8 bytes) | ray-traced pass |

**The miss list is the second compaction.** Plain SSSR only needs the first, because its miss blends to the environment map. In a hybrid, whether screen space failed is only known after the intersect pass, so intersect appends its low-confidence pixels. FFX SDK v1.1.4's `samples/hybridreflections` does the same with one wave-level atomic and its own indirect-args pass; we follow it. The ray-traced pass then dispatches indirectly over exactly those pixels.

- **Same sample, same direction.** The traced ray reuses the direction the intersect pass marched, stored in the entry. Regenerating it from the blue-noise index would also work, but storing it keeps one source of truth.
- **The traced ray starts at the surface**, offset along the normal. It does not start where the march left the screen: the march's free-space assumption is only valid where it found a hit.
- **A traced miss**, where the ray leaves the scene, takes the probe or environment lookup inline in the ray-traced pass. There is no third list.
- **Output.** Traced hits write the same radiance and hit-distance targets as screen-space hits, so the denoiser sees one signal whichever source filled each pixel.
- **Ray cap.** `maxTracedRaysPerFrame` caps the miss list's length.
  - Entries past the cap take the probe lookup inline.
  - Atomic append order isn't spatially fair, so a capped frame could starve the same region every frame. To avoid that, the cap is applied per 8×8 tile (an atomic counter per tile in a storage buffer, since intersect runs over the ray list and its workgroups don't line up with tiles), not globally.
  - Overflow counts go to a debug readback.

#### Subgroups and the fallback

FFX leans on wave intrinsics in three places:

| Place | What FFX does |
|---|---|
| classify | a wave-wide ballot and prefix count, so each wave does one atomic add instead of one per pixel |
| quad ray sharing | quad reads, so a pixel that shoots no ray copies a neighbour's |
| Hi-Z downsample (SPD) | wave reductions |

WGSL's `subgroups` feature covers all three: `subgroupBallot`, `subgroupExclusiveAdd`, `subgroupBroadcast`, and the quad operations (`quadBroadcast`, `quadSwapX` / `Y` / `Diagonal`).

- **With `subgroups`:** the subgroup variant of each pass.
- **Without it:** the same passes with workgroup memory.
  - Compaction does a workgroup prefix sum, then one `atomicAdd` per workgroup.
  - Quad sharing maps each 2×2 quad into an 8×8 workgroup tile and exchanges through workgroup memory.
  - The Hi-Z downsample reduces in workgroup memory, as SPD's non-wave path does.

**Rules:**

- Never assume a subgroup size. It is 32 on Apple and NVIDIA, 32 or 64 on AMD, and 8 to 32 on Intel. Read it from the device or the builtin.
- The variant is picked once, at init, from `device.features.has('subgroups')`. The `@pmndrs/bvh` GPU builders need the same feature, so the adapter requests it once for both.
- **Parity.** Both variants must produce the same lists, compared after sorting, since append order differs. A test page runs both on one frame and diffs them. The images must match bit for bit.

**Inputs:** the frame contract. SSSR wants scene colour without specular, so the adapter renders specular off, or composites probe specular after.

**Verification:**

- Pass-level parity with the SDK's HLSL is checked through WGSL text review plus image parity on scenes where screen space sees everything (a mirror floor facing a lit wall).
- The scene images are checked against an accumulated reference.
- It is compared against three's `SSRNode` on the same scenes: flicker, bias, GPU ms.

### 4. Ray-traced fallback (phase 4)

- Rays go only to pixels that screen space failed: off-screen, behind an occluder, or past the thickness test. They are dispatched indirectly from the miss list, capped per tile (see "Work lists and indirect dispatch").
- The ray origin and direction reuse the SSSR sample, so the denoiser sees one lobe sample per pixel whichever source produced it. `ggxLobeSample` (moved in phase 0) already keeps SSR hits, traced hits and probe lookups on the same weights.
- **Hit shading:** probes at the hit point (`sampleReflectionProbes(probes, hitP, dir, 1)`) plus the engine's cheap direct-light term. A radiance cache is out of scope until the hybrid is measured.

The explainer page in the denoiser repo already does this one-off for one room: rays at 4.5 ms against SSR's 3.9 and the hybrid's 4.2 per 960×540 frame. Phase 4 turns that into the package.

### 5. Hybrid resolve (phase 5)

**Per pixel:**

- roughness above the SSSR threshold → probe;
- otherwise → SSSR hit; where its confidence is low, a traced hit (only if a trace provider is set and roughness is below the RT threshold; FFX's hybrid sample uses 0.22 alpha for both); then probe, then environment.

The ray-traced layer is optional and off by default, as in what shipped: idTech 8 runs it only on very smooth surfaces and disabled it on consoles (DIVERGES D51).

Edge cases:

- **Screen-edge fade:** confidence goes to the next source down.
- **Specular occlusion:** the re-fit doesn't provide it. Apply Lagarde's term to the probe contribution from the app's AO, `saturate(pow(NdotV + AO, exp2(−16r − 1)) − 1 + AO)`; SSR and RT hits carry their own occlusion (DIVERGES D66).

The composite uses the split-sum DFG term (`radiance × (F0 · A + B)`), the same one three's PBR uses, so a material looks the same lit by probes alone or by the hybrid.

Debug views:

- source per pixel;
- confidence;
- ray budget;
- hit distance;
- probe volume weights (a version of `ReflectionProbesHelper` for each layout).

## Benches and verification

- **`pnpm check`** loads every example in headless Chrome with WebGPU and fails on validation errors or exceptions. Phase 0 checks:
  - the probes example bakes 3 probes;
  - it renders lit;
  - `warp` matches the hardware cube sampler (mean 0.05, max 3 / 255);
  - with `--compare <url>`, it is pixel-identical (max 0 / 255) to the denoiser repo's `reflection-probes.html`. That held on r186; on r187 the denoiser page (still r186) differs slightly (mean luminance 33.8 → 33.7), so the comparison is now informational.
- **Scenes:**
  - Ben's two rooms (probes, live capture, a mirror ball);
  - the explainer room, with its scenarios: mirror, off-screen, moving, contact, rough;
  - the reflection bench's G1 steampunk scene (the denoiser cleanroom branch) for the screen-space and denoise stages.
- **Metrics:** the five-number style of the denoiser scorecard: bias and RMSE against an accumulated reference, still and orbit flicker, and GPU ms per pass from timestamp queries.
- **Measurement rules carried over from the siblings:**
  - Measure with the loop stopped (`?manual`).
  - Never compare worktree absolutes against repo-run absolutes.
  - Never trust "it builds".

## Roadmap

| Phase | What | Gate |
|---|---|---|
| 0 ✅ | Repo, monorepo layout, probes + prefilter + sampling moved, probes example, headless check, this spec | Typecheck, tests, build; example pixel-identical to the source |
| 1 ✅ | Layout bench: `octa` / `cube2d-warp` / `cube2d-none` / `cube-hw`, brute-force reference | Decided 2026-11-10 (`docs/research/probe-layouts.md`): core path → `cube-hw` (raw cube array); three stays `cube2d-warp` until TSL binds cube arrays; `octa` an option (fails at the mirror mip at equal memory); format default `rgba16float`, `rgb9e5ufloat` the half-memory option; BC6H off (2.7× p99 on the roughest mip), re-run after the anchor fix. Open: r < 0.2 lookups (D101). |
| 2 ✅ | Probe core: layout-generic prefilter, atlas, WGSL lookup in core, three node on top, re-fit with an irradiance input | Rooms example on the core path, identical or better; lookup ms not worse. Result: core WGSL lookup pixel-identical to the TSL node (max 0/255, rooms with grid and mirror sphere); lookup 0.127 vs 0.117-0.123 ms at 1080p (noise level); core `ProbeSet` on `cube-hw` checked in `examples/probe-core` (HANDOFF W7, D800-D806) |
| 3 | SSSR port in core (subgroup and workgroup-memory variants) + three adapter node | Subgroup and fallback variants produce identical lists and images; no boiling on the rooms and G1; flicker and GPU ms at or below three `SSRNode` + its denoise **Status 2026-11-10 (`docs/research/ssr-gate.md`):** built; GPU ms passes raw (0.56–1.1 ms vs three SSR+denoise 2.2–5.0 ms); flicker fails raw on 3 of 4 scenes; verdict pending the denoise seam. **W10 re-run with `FfxReflectionDenoiser` through the seam: passes.** Flicker is below three + denoise on 4 / 4 scenes (rooms still p99 0.0004 vs 0.0037). GPU ms is below on 3 / 4 (1.6–2.3 vs 3.0–4.7 ms); mirrorWall is at parity (2.45 vs 2.30 ms). G1's own scene is not run. |
| 4 | Trace seam; `@pmndrs/bvh` provider in core (three-mesh-bvh as the three stopgap); hit shading through probes | Off-screen scenario matches the reference; rays dispatched from the miss list only, with the GPU ms scaling with the miss count; the `@pmndrs/bvh` walk agrees with three-mesh-bvh on the same rays |
| 5 | Hybrid resolve + denoise seam; the denoiser repo's reflection pages switch to the package | Explainer and rooms pages run on `@pmndrs/reflections` with no local copies **Status 2026-11-10 (W10):** denoise seam in core (`createReflectionDenoiseSeam`), three `HybridReflections` (SSR → RT → probes → environment by confidence and coverage, split-sum DFG swap, Lagarde SO from an optional AO input, denoised where the denoiser ran), `examples/ssr?denoise=1`. The denoiser repo's pages are not switched yet. |
| 6 | babylon / pixi adapters; publish 0.1 | Packed-subpath checks like the upscaler's `verify:packed-subpaths` **Status 2026-11-10 (W15):** babylon adapter first pass (`@pmndrs/reflections/babylon`, `examples/babylon`, `pnpm check -- --only babylon`): core SSR and probes on Babylon's device with no core changes; the conventions the contract can't express are worked around in the adapter and listed in HANDOFF W15 / D1800-D1807. **W18:** pixi adapter first pass (`@pmndrs/reflections/pixi`, `examples/pixi`, `pnpm check -- --only pixi`): pixi has no G-buffer and `@pixi/3d` is a closed beta without normal / roughness outputs, so the adapter owns a minimal 3-D layer whose materials take pixi Textures (RenderTextures of pixi content); core SSR, probes and the denoise seam on pixi's device with no core changes; composite as a pixi `Filter`. Gaps in HANDOFF W18 / D2000-D2006. **W19:** the 3-D layer is gone: the adapter runs on pixi-3d (`examples/pixi3d/arcade`, `pnpm check -- --only pixi3d`; the beta from gitignored `examples/pixi3d/vendor/`, a setup notice without it). pixi-3d provides colour, depth, motion and camera; normals / material values come from one extra pass that reads pixi-3d's material store (constants only), the specular-free colour from a material `extraBits` entry. Gaps in HANDOFF W19 / D2100-D2104 / `docs/research/pixi3d-needs.md`. Packed-subpath check not yet. |

## Moving from the denoiser repo

**Copied here in phase 0** from denoiser@`0ff604c`, with the denoiser untouched:

| Denoiser path | Here |
|---|---|
| `examples/three-temporal/src/probes/prefilter.ts` | `packages/core/src/probes/prefilter.ts` |
| `examples/three-temporal/src/probes/ReflectionProbes{,Node,Helper}.ts` | `packages/three/src/probes/` |
| `examples/three-temporal/src/reflections/common.ts` | `packages/three/src/sampling.ts` |
| `examples/three-temporal/{reflection-probes.html,src/reflection-probes.ts}` | `examples/probes/` |

**Stays in the denoiser repo:**

- the FFX reflection denoiser (`denoiser-ffx/src/reflections.ts`, its shaders, `ffxReflections`);
- the track R / reflection-bench / scorecard research, which measures denoisers;
- the explainer, rooms and SSR pages, which are examples.

From now on, the denoiser's copies are frozen and changes land here. Once this package is installable (published, or linked through the workspace), the denoiser's `three-temporal` swaps its imports to `@pmndrs/reflections/three` and deletes `src/probes/` and `src/reflections/common.ts`.

**The three.js fork work** stays the user's call to upstream:

- compute `PMREMGenerator`;
- `CubeArrayTexture` probes, target reuse and live-capture fixes on `pmrem-compute-probes`.

This repo stays API-compatible with #35046 either way.

## Provenance and licences

See `NOTICE`:

- the probes port three.js #35046 (MIT, three.js authors; Ben Houston);
- the prefilter kernels come from `@pmndrs/sky` 0.6.0 (MIT, Dennis Smolek), implementing three r187's PMREM plan;
- the SSSR port, when it lands, is from the FidelityFX SDK (MIT, AMD), with its notice carried as in `denoiser-ffx`.

## Open questions

1. ~~Which BVH?~~ Decided 2026-11-10: `@pmndrs/bvh` (pmndrs/bvh, WIP) in core, with three-mesh-bvh as the three stopgap. Still open: what this repo needs from it before phase 4.
   - A published package, or a workspace link?
   - Does the subgroups-only GPU build cover the devices we target?
2. **When does the repo go public, and is `@pmndrs/reflections` the npm name?**
3. ~~pnpm or yarn?~~ pnpm, matching the upscaler and pmndrs/bvh.
4. **Should SSSR's intersect pass trace at half resolution by default** (idTech's RT runs at ½ or ¼), or follow FFX's full-rate mirrors and quarter-rate glossy?

## References

- Sousa, *idTech 8 Global Illumination*, Advances in Real-Time Rendering, SIGGRAPH 2025.
- AMD GPUOpen, *FidelityFX Stochastic Screen-Space Reflections 1.5* manual; FidelityFX SDK v1.1.4 sources (`ffx_sssr`, `ffx_denoiser`).
- Stachowiak, *Stochastic Screen-Space Reflections*, SIGGRAPH 2015.
- Engelhardt & Dachsbacher, *Octahedron Environment Maps*, 2008.
- Benthin et al., *H-PLOC: Hierarchical Parallel Locally-Ordered Clustering for Bounding Volume Hierarchy Construction*, HPG 2024 (one of `@pmndrs/bvh`'s GPU builders).
- Majercik et al., *Dynamic Diffuse Global Illumination with Ray-Traced Irradiance Fields*, JCGT 2019.
- Lazarov, *Getting More Physical in Call of Duty: Black Ops II*, 2013 (probe normalization).
- three.js PRs #35046 (ReflectionProbes), #35053 (CubeArrayTexture), #35045 (cube-array sampling).
