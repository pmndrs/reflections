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
| R1 | Probe lineage: which of Ben's probe versions is latest, and what ours lacks | research | `docs/research/probe-lineage.md` | — | running | |
| R2 | Source survey: SSSR 1.5, idTech 8, Lumen, Frostbite, Pica Pica, CoD, HDRP, Godot | research | `docs/research/sources.md` | — | running | |
| R3 | Demo scenes: what to test reflections on | research | `docs/research/demo-scenes.md` | — | running | |
| W1 | Phase 1 layout × format bench | code | `packages/core/src/probes/layouts/`, `packages/core/src/probes/reference.ts`, `examples/probe-bench/`, `docs/research/probe-layouts.md` | 5371 | running | |
| W2 | BC6H GPU encoder | code | `packages/core/src/encode/` , `examples/bc6h/` | 5372 | running | |
| W3 | SSSR core port (phase 3) | code | `packages/core/src/sssr/`, `examples/sssr-core/` | 5373 | running | |
| W4 | Frame contract G-buffer (three) + scene kit for demos | code | `packages/three/src/frame/`, `examples/shared/`, `examples/scenes/`, `scripts/fetch-assets.mjs` | 5374 | first pass done (`ff15973`): `FrameGBuffer` fills the contract in one MRT render; 8 procedural + 7 asset scenes pass `pnpm check` | Next: a `'direct'` scene-colour variant (needs a lighting-model hook, D400); transparent objects in the guides (D404); unjittered velocity under TAA/upscaler (D405); R3's final scene list into `scripts/fetch-assets.mjs` (Bistro needs FBX→glTF, TODO row). Explainer port lights with the spot stand-in, not the area light (D406). |

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

- 2026-11-10: Phase 0 done (`622985c`). SPEC drafts 2 and 3. Workstreams R1–R3, W1–W4 started in parallel. `REFLECTIONS_PORT` added so worktrees don't collide on 5370. `DIVERGES.md` seeded with D1–D11 from the SPEC.
- 2026-11-10: W4 first pass (`ff15973`): frame-contract types in core, `FrameGBuffer` (three MRT), scene kit (`examples/shared`), scenes viewer (`examples/scenes`), `pnpm assets`. Divergences D400–D406.
