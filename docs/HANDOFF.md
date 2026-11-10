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
| W3 | SSSR core port (phase 3) | code | `packages/core/src/sssr/`, `examples/sssr-core/` | 5373 | running | |
| W5 | Probe parity with #35046 head + fork features (shadow reuse in bake, `projectionOffset`, coverage node, cache key, time-sliced bake, env versioning, world-space helper) | code | `packages/three/src/probes/` (not `prefilter.ts`) | 5375 | running | |
| W4 | Frame contract G-buffer (three) + scene kit for demos | code | `packages/three/src/frame/`, `examples/shared/`, `examples/scenes/`, `scripts/fetch-assets.mjs` | 5374 | running | |

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

W3 ships a default implementation (a single `texture_cube<f32>` environment, or a constant colour) and takes any other snippet + bind group layout at pipeline creation.

### Frame contract inputs (W4 → W3's three adapter, later)

W3 develops on synthetic, analytic inputs written by compute (exact depth/normal for a plane and boxes), so it never waits on W4. W4 produces the same textures from a three scene, matching SPEC's frame-contract table. The three SSSR node joins the two after both merge.

## Log

- 2026-11-10: three floor raised to r187 (maintainer's call). `pnpm check` all green after one fix (cube render-target mip count in examples/probes).
- 2026-11-10: R1–R3 done. SPEC draft 4: miss list credited to FFX `hybridreflections`, ray-list packing 15+14+3, confidence instead of binary miss, thresholds in alpha, RT optional/off by default, Lagarde specular occlusion, L1-vs-SH9 re-fit noted. W3 told of the hybrid sample. W5 opened for probe parity.
- 2026-11-10: Phase 0 done (`622985c`). SPEC drafts 2 and 3. Workstreams R1–R3, W1–W4 started in parallel. `REFLECTIONS_PORT` added so worktrees don't collide on 5370. `DIVERGES.md` seeded with D1–D11 from the SPEC.
