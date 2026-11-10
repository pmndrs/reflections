# Handoff board

The working state of the project: who is on what, which interfaces the workstreams agreed on, and where each one stopped. `docs/SPEC.md` is the plan; this is the log of executing it. Update your row when you stop, even mid-task.

## How we work (agents read this first)

- **Build features first.** Get a pass working end to end on a real GPU (`pnpm check`), commit, move on. Don't sink time into squeezing milliseconds or making a test match an expectation. If a number is off, write it down (row below, or `DIVERGES.md` if it's a divergence) and keep going. Measurement is for the **gates** in SPEC's roadmap and for big decisions, not for every step.
- **Time-box.** If something fights you for more than ~30 minutes of attempts, record what you tried in your row's "stuck on" and move to the next part of your scope.
- **Diverging from a source is fine. Hiding it isn't.** Every knowing difference from FFX, idTech, three, Lagarde, etc. goes in `docs/DIVERGES.md`.
- **Commit after every run** (CLAUDE.md rule 4): what was tried, numbers, verdict, failures included. Explicit paths, never `git add -A`.
- **Stay in your lane.** Each stream owns the paths in its row. Touching a shared file (`packages/*/src/index.ts`, `src/*.ts`, `package.json`, `scripts/run-headless.mjs`) is allowed but keep the edit to adding your exports or your check, so merges stay trivial.
- **Ports.** Each worktree runs its examples server on its own port: `REFLECTIONS_PORT=<port> pnpm examples` / `REFLECTIONS_PORT=<port> pnpm check`. The main checkout keeps 5370; 5310 belongs to another project.

## Workstreams (started 2026-11-10)

| id | stream | kind | owns | port | status | stuck on / next |
|---|---|---|---|---|---|---|
| R1 | Probe lineage: which of Ben's probe versions is latest, and what ours lacks | research | `docs/research/probe-lineage.md` | — | done | Latest is #35046 head `77bbaaaa05` (2026-11-09); the interior branch has more features but is older and needs r187-dev lighting hooks. Adoption → W5. |
| R2 | Source survey: SSSR 1.5, idTech 8, Lumen, Frostbite, Pica Pica, CoD, HDRP, Godot | research | `docs/research/sources.md` | — | done | 13 SPEC claims checked (S1–S13); fixes applied in SPEC draft 4. D40–D69 proposed. Gaps: Hobson 2019 (gated), UE mip mapping unverified. |
| R3 | Demo scenes: what to test reflections on | research | `docs/research/demo-scenes.md` | — | done | Procedural rooms first; Khronos Sponza; ToyCar/CarConcept/ABeautifulGame on a mirror floor; Bistro (converted) for phases 4–5. |
| W1 | Phase 1 layout × format bench | code | `packages/core/src/probes/layouts/`, `packages/core/src/probes/reference.ts`, `examples/probe-bench/`, `docs/research/probe-layouts.md` | 5371 | running | |
| W2 | BC6H GPU encoder | code | `packages/core/src/encode/` , `examples/bc6h/` | 5372 | landed (fast + normal) | Port of Narkowicz's GPURealTimeBC6H (MIT). `fast` = mode 11, `normal` = mode 11 + best of 32 two-subset partitions (modes 2/6). Verified through the hardware decoder in `examples/bc6h/` (in `pnpm check`). Procedural HDR cube, all mips, log2 RMSE (floor 2^-12) / tone-mapped PSNR: 128 px fast 0.156 / 36.6 dB, normal 0.141 / 40.1 dB; 256 px fast 0.098 / 40.8 dB, normal 0.093 / 43.9 dB. GPU encode incl. copies (M-series, Chrome, median of 5): 1×128 fast 0.045 ms, normal 0.38 ms; 1×256 fast 0.05 ms, normal 0.62 ms; 16×128 fast 0.18 ms, normal 1.4–1.9 ms; 16×256 fast 0.32 ms, normal 4.8 ms. Notes for W1: src needs TEXTURE_BINDING and mip 0 a multiple of 4 px; `encode()` returns TEXTURE_BINDING/COPY_DST/COPY_SRC; time it with a closing pass that *reads* dst, or Metal overlaps the bracket and reports ~0. Not done: no mode search beyond 11/2/6, no CPU reference decoder test, quality untuned. |
| W3 | SSSR core port (phase 3) | code | `packages/core/src/sssr/`, `examples/sssr-core/` | 5373 | done on branch `worktree-agent-aebb0fc97aa3cbbbc` (not merged) | WGSL port of FFX SSSR v1.1.4 in SDK host order, all passes verified in `pnpm check` (`--only sssr-core`): depth pyramid, classify (subgroup + workgroup variants), blue noise (FFX Sobol x scrambling, folded table), indirect args, intersect, miss list (hybrid-sample predicate) + its args. API: `createScreenSpaceReflections(device, opts).dispatch(cmd, inputs, settings)`; `screenSpaceInputsFromFrame(FrameInputs, tracer)` maps W4's contract (throws on `depthLinear`); `constantRadianceFallback()` / `environmentRadianceFallback(device)`. **Pyramid** (`sssr/depthPyramid.ts`, the one file to swap for `downsampler`): r32float, min(7, ceil(log2 max(w,h))) mips, mip 0 = copy of device depth, min (max for reverse-Z), floor-sized mips, 2 dispatches (4 storage textures). **Outputs** for the denoise seam: radiance rgba16float (rgb + ray length in w, FFX), hit distance r32float (0 = no hit; denoiser types say r16float, see D304), extracted roughness r32float (alpha), ray list (FFX 15+14+3 packing), denoiser tile list (x \| y<<16), ray counter [next, rays, next, tiles], indirect args (intersect @0, denoiser @12), tile flags (bit 1 = has non-mirror glossy; listed without it = mirror-only tile). **Parity** (960x540, M5 Pro, Chrome 157): occupancy 0 with spq 1/2/4 and reverse-Z: lists equal after sort, radiance/hit/roughness/pyramid 0 px differ. Occupancy 4: lists equal, ~3000 px radiance differ (per-subgroup vs per-64 count, D301). Mirror-floor hit fraction 81.9%. **GPU ms** 1080p, loop stopped, median of 30, subgroups: 0.97-1.24 total (pyramid ~0.29, classify ~0.19, intersect ~0.56); workgroup variant 1.35 (classify 0.27, intersect 0.79). Later runs alongside other worktrees ranged 0.68-1.57. `settings.roughnessThreshold` is alpha (FFX units, default 0.2); D43 proposes perceptual at the API: lead's call. **Not done / next:** per-tile miss cap (D9) and miss overflow readback; the three node (after merge with W4); a few 1 px rows of misses on the forward-Z mirror floor that reverse-Z doesn't show (5985 vs 4190 misses; Hi-Z tile-edge precision, not chased); 1D indirect dispatch caps at 65535 x 64 = 4.19M rays (4K at spq 4 would exceed, as in FFX); hybrid thickness terms (D42). |
| W4 | Frame contract G-buffer (three) + scene kit for demos | code | `packages/three/src/frame/`, `examples/shared/`, `examples/scenes/`, `scripts/fetch-assets.mjs` | 5374 | first pass done (`ff15973`): `FrameGBuffer` fills the contract in one MRT render; 8 procedural + 7 asset scenes pass `pnpm check`; on r187 after merging main, no code change needed (no cube targets in W4; the `totalDiffuse` shader property `sceneColorNoSpecular` reads is still in r187's LightsNode). r186 → r187 differences hit: none | Next: a `'direct'` scene-colour variant (needs a lighting-model hook, D400); transparent objects in the guides (D404); unjittered velocity under TAA/upscaler (D405); R3's final scene list into `scripts/fetch-assets.mjs` (Bistro needs FBX→glTF, TODO row). Explainer port lights with the spot stand-in, not the area light (D406). |
| W5 | Probe parity with #35046 head + fork features (shadow reuse in bake, `projectionOffset`, coverage node, cache key, time-sliced bake, env versioning, world-space helper) | code | `packages/three/src/probes/` (not `prefilter.ts`) | 5375 | done (worktree-agent-ae34e8fa779d78dea: `d1b5093`, `0316cbe`, `2fdb2a0`, docs) | All six adopted on r187, each with a pnpm check (15 probe checks green). Shadow reuse: draws per bake 538 -> 238; bake 128 px ~3.0 -> 2.7-3.0 ms (r186), 5.3-6.2 -> 3.9-4.6 ms A/B in one page (r187, GPU shared with other streams, noisy). Cache-key bug not real for us (child nodes aren't _-private), fixed anyway. Found + fixed: probe uniforms never reached static meshes (D500) and texture swaps bound a destroyed array (D501). Note for others: node_modules/.vite/deps kept serving r186 after the r187 install; delete it. Checks advance nodeFrame between bakes: with the loop stopped three renders each shadow map once per camera per frame. Next: bounces/usePrevious still need indirectSpecular()/indirectDiffuse(), absent in r187 (D25); resolution default/floor (D23); the hybrid resolve consumes reflectionProbesLocal(). |

## Platform

- **three floor: r187** (raised from r186 on 2026-11-10; `three@^0.187.0`, peer `>=0.187.0`). r187 still can't bind `texture_cube_array` in TSL. Its PMREMGenerator writes cube mips (#34585). In r187 a render target's cube texture lists every level in `mipmaps`, base included; r186 listed only the levels past 0.

## Agreed interfaces between streams

These are the seams the streams code against before the others land. Change one only by updating it here in the same commit.

### BC6H encoder (W2 → W1)

```ts
// packages/core/src/encode/bc6h.ts
export interface BC6HEncodeOptions { quality?: 'fast' | 'normal'; }
/** Encode every mip and layer of an rgba16float 2D-array (or cube) texture into a new bc6h-rgb-ufloat texture.
 *  Requires device.features.has('texture-compression-bc'). Mip extents below 4 px are padded to one block. */
export function createBC6HEncoder(device: GPUDevice): {
  encode(src: GPUTexture, opts?: BC6HEncodeOptions): GPUTexture; // records into its own command encoder and submits
  encodeInto(cmd: GPUCommandEncoder, src: GPUTexture, dst: GPUTexture, opts?: BC6HEncodeOptions): void;
  destroy(): void;
};
```

Until W2 lands, W1 leaves the `bc6h` column of the format axis as "pending encoder" and measures everything else.

### Probe layout functions (W1, consumed later by phase 2)

```ts
// packages/core/src/probes/layouts/types.ts
export type ProbeLayoutId = 'cube2d-warp' | 'cube2d-none' | 'cube-hw' | 'octa' | 'octa-hemi';
export interface ProbeLayout {
  id: ProbeLayoutId;
  /** WGSL defining dirForTexel(texel: vec2u, layer: u32, mip: u32, size: u32) -> vec3f
   *  and sampleLayout(tex, samp, probe: u32, dir: vec3f, lod: f32) -> vec4f for this layout. */
  wgsl: string;
  /** Texture shape for N probes at `size` px (mip 0 face or octa side). */
  textureDescriptor(size: number, probes: number, format: GPUTextureFormat): GPUTextureDescriptor;
  viewDimension: GPUTextureViewDimension;
}
```

### Radiance fallback (SSSR miss → probes/env), used by W3 now, filled by phase 2

A WGSL snippet plus a bind group, like the trace seam:

```wgsl
fn sampleRadianceFallback(P: vec3f, dir: vec3f, roughness: f32) -> vec3f
```

W3 ships a default implementation (a single `texture_cube<f32>` environment, or a constant colour) and takes any other snippet + bind group layout at pipeline creation. As built (W3): `P` and `dir` are world space; `roughness` is **perceptual** (0 for screen-space misses, which are lerped by hit confidence as in FFX; `sqrt(alpha)` for reflective pixels above the roughness threshold). The snippet's bindings live in `@group(1)`; pass its layout as `radianceFallback.layout` and the bind group as `inputs.fallbackBindGroup`. It may read the tracer's uniform block `P` (`P.iblFactor`, `P.fallbackColor`).

### Frame contract inputs (W4 → W3's three adapter, later)

W3 develops on synthetic, analytic inputs written by compute (exact depth/normal for a plane and boxes), so it never waits on W4. W4 produces the same textures from a three scene, matching SPEC's frame-contract table. The three SSSR node joins the two after both merge.

W4's side, as landed:

```ts
// packages/core/src/frame/contract.ts (exported from @pmndrs/reflections/core)
interface FrameInputs { width; height; textures: FrameTextures; conventions: FrameConventions; camera: FrameCamera; frameIndex }
interface FrameTextures { depth; normal; roughness: { texture, channel }; metalness: { texture, channel }; albedo; motion; sceneColor; lit? } // GPUTexture handles
interface FrameConventions { depthInverted; depthLinear; normalUnpackMul; normalUnpackAdd; roughnessIsPerceptual; motionVectorScale: [x, y]; sceneColorSpecular: 'none' | 'direct' }
// FrameCamera: denoiser-core's FrameCamera fields (view, projection, prevView, prevProjection, jitter, near, far, position, reversedDepth) + prevViewProjection

// packages/three/src/frame/FrameGBuffer.ts (exported from @pmndrs/reflections/three)
const gbuffer = new FrameGBuffer(renderer, { lit?: boolean | 'auto', motion?: 'uv' | 'ndc', width?, height? });
const frame: FrameInputs = gbuffer.render(scene, camera); // once per frame
gbuffer.textures.normalRoughness; // the three textures, for TSL sampling
```

Layout from three: depth32float; normal = rgba16float world normal (mul 1, add 0) with perceptual roughness in .a; albedo = rgba8unorm base colour with metalness in .a; motion = rg16float uv-space, current − previous, `motionVectorScale` [1, 1]; sceneColor = rgba16float emissive + direct + indirect diffuse (no specular).

## Log

- 2026-11-10: W4 first pass (`ff15973`): frame-contract types in core, `FrameGBuffer` (three MRT), scene kit (`examples/shared`), scenes viewer (`examples/scenes`), `pnpm assets`. Divergences D400–D406.
- 2026-11-10: W3 merged (SSSR core: pyramid, classify ×2 variants, FFX blue noise, intersect, miss list). Main check: variant parity exact at occupancy 0 (lists + images), mirror hit 81.9%, reverse-Z equal; 1080p ~1.0–1.2 ms. Opus reviews started on SSSR and on BC6H + G-buffer (read-only). W6 opened: three SSR adapter + first composite; roughnessThreshold becomes perceptual (D43).
- 2026-11-10: W4 merged (G-buffer + scene kit + viewer + `pnpm assets`). Main `pnpm check`: 17 PASS, all 8 procedural scenes fill every target, scene colour is 0 on mirrors (no specular leak). Open: one console 404 during the scenes check (unidentified resource; likely the skipped asset probe or a favicon).
- 2026-11-10: three floor raised to r187 (maintainer's call). `pnpm check` all green after one fix (cube render-target mip count in examples/probes).
- 2026-11-10: R1–R3 done. SPEC draft 4: miss list credited to FFX `hybridreflections`, ray-list packing 15+14+3, confidence instead of binary miss, thresholds in alpha, RT optional/off by default, Lagarde specular occlusion, L1-vs-SH9 re-fit noted. W3 told of the hybrid sample. W5 opened for probe parity.
- 2026-11-10: Phase 0 done (`622985c`). SPEC drafts 2 and 3. Workstreams R1–R3, W1–W4 started in parallel. `REFLECTIONS_PORT` added so worktrees don't collide on 5370. `DIVERGES.md` seeded with D1–D11 from the SPEC.
