# Probe sizes vs WebGPU's sampled-texture limit (W62)

2026-11-12. The question (D4804): one cube-array atlas per probe size means one sampled-texture binding per size wherever probes are looked up, and WebGPU guarantees only 16 per stage. W61 hit 18 on Sponza with three sizes. The maintainer asked us to test the options and compare them with what other engines do.

Machine: Apple M-series, Chrome 157 headless, Dawn/Metal, shared with other agents (load 5-7), so lookup ms are noisy. Reproduce:
- `REFLECTIONS_PORT=5428 pnpm check -- --only probe-bindings` for the checks;
- `--only probe-bindings-measure` for Sponza vs the path tracer and lookup ms (`out/w62-probe-bindings.json`);
- `--only probe-bench --probe-atlas` for the octahedral atlas (`out/w62-probe-atlas.json`).

Data is in `docs/research/w62/`. The per-pipeline count used `count-sampled-textures.preload.js` there, injected at document start: it wraps `createShaderModule` and `createRenderPipeline(Async)`.

## First, where the 18 came from

I counted Sponza's sampled textures per pipeline on examples/ssr: the WGSL of every render pipeline, and the texture bindings its entry point uses.

| | 1 size (shipped) | 2 sizes (few) | 3 sizes (mixed) |
|---|---|---|---|
| glTF mesh materials | 4-6 | 5-7 | 6-8 |
| three composite (full screen), before | 14 | 16 | **18** |
| three composite, after W62 | 13 | 14 | 15 |

The pipeline over the limit was the library's own composite, not Sponza's materials. It bound every atlas **twice**: `sampleReflectionProbes` (radiance with the environment) and `sampleReflectionProbesLocal` (coverage) each built their own texture node, and three binds each node separately.

The fix shares one texture node per atlas per set (`atlasNode` in ReflectionProbesNode.ts). The composite then costs 12 + 1 per size, so four sizes (`PROBE_MAX_ATLASES`) fit the default 16 exactly. Sponza's three-size set now draws at the default 16 with 0 errors. Its image against the adapter's 48 differs by mean 0.0181 / 255, the same as the page against itself.

## The options

PSNR (dB) and MAD (/255) are of the RT-off image ('ours-denoised': SSR + probes, denoised), measured against the path tracer (64 spp + OIDN) over the glossy pixels of the compare page at 960x540. Courtyard / low poses. Higher PSNR is better. Lookup ms is three's passes minus the probe-free frame at 1920x1080, RT off, loop stopped, the median of 3 runs (each the median of 30 frames, 3 repeats). On this loaded machine single runs moved by up to +-1.5 ms, so read only the split: 11 volumes cost 1.8-2.7 ms, 2-7 volumes 0.4-0.9 ms, and the size mix doesn't show (as W61 found, the volume count sets the cost). "Bindings" is the extra sampled textures per stage that probes add, in every lit material and in the composite.

| option | bindings | memory (Sponza) | PSNR courtyard / low | MAD courtyard / low | lookup ms (1080p, Sponza) | what it costs a user |
|---|---|---|---|---|---|---|
| shipped Sponza (7 x 256, one size) | 1 | 33.5 MB | 16.58 / 15.12 | 29.56 / 36.39 | 0.40 | nothing; boxes don't fit the rooms |
| **1. request the limit** (any set; here W61's mixed, 512 + 256 + 128) | 3 (fits 16 after the fix) | 34.6 MB | 20.47 / 18.26 | 17.49 / 23.50 | 2.65 | nothing; on a 16-limit device a 4-size set fills the composite exactly |
| **2. one size per set**: mixed's 11 volumes all at 128 | 1 | **12.6 MB** | **20.51 / 18.29** | **17.37 / 23.36** | 1.94 | sizing by the sharpest receiver across the whole set |
| 2. one size: all at 256 | 1 | 50.3 MB | 20.50 / 18.30 | 17.39 / 23.35 | 2.18 | memory |
| **4. two sizes**: 512 courtyard floor, the rest 256 | 2 | 62.9 MB | 20.47 / 18.27 | 17.48 / 23.48 | 2.32 | memory |
| 4. two sizes near the budget: 512 floor, 256 aisle slabs + 2 room volumes | 2 | 37.7 MB | 20.26 / 18.19 | 18.03 / 23.81 | 0.93 | fewer volumes, a little worse |
| 4. merge-down fallback: mixed with 256 -> 128 | 2 | 28.3 MB | 20.48 / 18.27 | 17.48 / 23.49 | 1.77 | none measurable here |
| **3. one 2D octahedral atlas** (HDRP), tiles at 2 x the face | 1 | tiles 0.67 x the cubes' bytes | bench only (below) | mirror mip p99 18.5-24 vs 0 / 255 | 0.92 x cube arrays (coherent), 1.14 x (scattered) | the mirror mip is resampled; new lookup and packer in core |
| 3. octa atlas, tiles at 4 x the face | 1 | 2.67 x the cubes' bytes | bench only | mirror p99 5.5-10.3; rough mips match or beat the cube | 0.92 x / 1.19 x | 2.7 x the memory for the same sizes |

**Sponza doesn't need the sizes.** Every variant of W61's mixed geometry (floor slabs per walkable region, plus the grid) lands within 0.1 dB, from 12.6 MB (all 128) to 62.9 MB (512 + 256). The geometry sets the result: the shipped 7 boxes give 16.58 dB, the same memory in better-fitted volumes about 20.5. W61's "mixed" won by its volumes, not its sizes. Sponza's polished floor is r 0.06 and the compare page renders at 960x540, so a 128 px probe already resolves what the lobe and SSR leave. offscreen's near-mirror floor and wall mirror (r 0.02 / 0) are where sizes matter (W60: floor + mirror 512, room 256, 41.9 MB matches all 512, 67.1 MB). There, one size per set means 67.1 MB instead of 41.9.

### 3. The octahedral atlas (bench prototype, `examples/probe-bench/src/atlas.ts`)

This prototype packs three probes, captured at 512 / 256 / 128 px, into one 2D texture with a hardware mip chain:
- each probe is the bench's `octa` layout (full sphere; the gutter is half a texel at the probe's own last mip), prefiltered at side k x capture;
- tiles are copied mip by mip to power-of-two-aligned spots (a buddy allocator, as HDRP's power-of-two atlas);
- each tile keeps its own maxLod (the roughness ladder, D4700) in a per-tile record;
- the lookup is octa encode, then tile scale / offset, then one trilinear `textureSampleLevel` with lod clamped to the tile's maxLod.

Results:
- **No bleed, and the mips line up.** Every tile, at every lod, between lods and past its maxLod, reads what the probe reads in its own texture. The atlas texels outside the tiles were cleared to 1000; bleed would read about 254 / 255. The 512 tile is bit-identical. The smaller tiles differ by up to 2.4 / 255, at lod 0 next to the 500-valued sun only. That is filtering precision: a small tile's bilinear weights are quantized against the atlas's width, not its own.
- **Quality is octa's, which the phase-1 bench measured** (docs/research/probe-layouts.md). The capture is resampled, so the mirror mip loses against the cube array's exact copy (p99 at r 0: 18.5 / 24.2 at 2x side, 5.5 / 10.3 at 4x, cube 0.0 for the 256 / 128 captures). Seams don't show: the octa seam band is no worse than its interior at r > 0, and the cube's seam band is the worse of the two at r 0.11 (4.2 vs atlas 3.2). At r >= 0.11 the 2x atlas is within 0.1-0.2 mean of the cube; the 4x atlas matches or beats it.
- **Memory.** Tiles at 2x: 14.0 MiB against the cube arrays' 21.0 MiB. As allocated, the power-of-two atlas is 21.3 MiB (2048 x 1024, 7 mips). A production atlas would be a fixed size with spare room, like HDRP's 4096² default (128 MiB at rgba16float with mips, 64 MiB at R11G11B10). At 4x: 56 / 85 MiB.
- **Lookup.** One full-screen lookup at 1920x1080, three probes of three sizes. The atlas costs 0.92 x three cube arrays when coherent (0.056 vs 0.059 ms), and 1.14-1.19 x when scattered (random probe per pixel; the cube-array version branches on the atlas). The lookup costs the same; the difference is bindings and quality.

## What other engines do

These were checked in source (GitHub, 2026-11-12) or in official docs. **[inferred]** marks my reading, not theirs.

| engine | reflection probe storage | sizes per set | bindings |
|---|---|---|---|
| Unreal Engine | one cube array: `FReflectionEnvironmentCubemapArray::InitRHI` (ReflectionEnvironment.cpp), `CubemapSize` x `MaxCubemaps`; `GMaxNumReflectionCaptures` 341 (mobile 100) | one: "All captures use the same cubemap resolution, set by Reflection Capture Resolution in the Project Settings" (docs, default 128) | 1 |
| Godot 4 | `reflection_atlas/reflection_size` (256, mobile 128) and `reflection_count` (64). Up to 4.5 a cube array. From 4.6 a 2D array of octahedral maps, `size * 2 + padding * 2`, padding `1 << (mipmaps - 1)` (PR #107902: "drops the requirement of needing cubemap array support") | one | 1 |
| id Tech 8 (Sousa, SIGGRAPH 2025) | BC6H cube-map array | one [inferred: a cube array has one face size] | 1 |
| Unity HDRP 14+ (2022.2) | "HDRP 14.x combines the planar and cube reflection probe textures into the same 2D texture atlas" (upgrade guide). `ReflectionProbeTextureCache.cs`: a `Tex2DArray` with one slice per BSDF filter (GGX, Charlie), `Texture2DAtlasDynamic`. The full hardware mip chain is filled by hand, with padding `(1 << m_CubeMipPadding) * 2` and "Every octahedral mip has at least one texel padding". Default 4096², R11G11B10 or RGBA16F (no BC6H). Shader: `GetReflectionAtlasCoordsCube(_CubeScaleOffset[index], dir, lod)`, octa encode, per-probe scale / offset, one trilinear sample. The lod (`UNITY_SPECCUBE_LOD_STEPS 6`) is the same for every probe | any: per-probe `cubeResolution` 128-4096. The tile is face x 4 below 512 and x 2 from 512. A full atlas retries the probe at half size | 1 |
| Unity URP Forward+ | "URP Reflection Probe Atlas" (`ReflectionProbeManager.cs`): one 2D texture without mips and a buddy allocator. Each mip of each probe is its own tile (`urp_ReflProbes_MipScaleOffset[probe * 7 + mip]`), and the shader lerps two bilinear taps | any | 1 |
| Unity URP / built-in forward | `unity_SpecCube0` / `unity_SpecCube1`, two cubemaps per object | any | 2 per draw |
| Blender EEVEE Next | sphere probes octahedral in a 2D array of 2048² layers. Each probe is a power of two, 64-2048, and mixed sizes are subdivided into one layer, with an 8 px border "enough to support 4 mipmap levels" (developer docs) | any | 1 |
| Bevy | a `texture_cube` binding array, `MAX_VIEW_LIGHT_PROBES = 8`, which "consequently aren't supported on WebGL2 or WebGPU" (`light_probe/environment_map.rs`) | any | binding array |
| three.js, Filament, Babylon | one environment cube per material or scene (three r187 PMREM, Filament `Scene::setIndirectLight`; Babylon inferred from its API) | n/a | 1 |

Engines with one size per set use one array (UE, Godot, id Tech 8). Engines with per-probe sizes behind one binding pack octahedral tiles into a 2D atlas (HDRP, URP Forward+, EEVEE), and they accept the resampling. HDRP spends 2-4 x the face per tile to pay for it, which is the 4x row above. We found nobody who binds one cube array per size, as we do; Bevy's binding array is the nearest, and it says it can't run on WebGPU.

## Recommendation

1. **Keep per-size cube arrays (D4700) and the fix.** The fix is the shared atlas nodes, plus `reflectionsRequiredLimits` asking for up to 32 and core counting sampled textures in the trace pass and the SSSR intersect. After the fix, every three-adapter shader fits the default 16 with all four sizes. Devices that can raise the limit get headroom for heavy materials and G-buffers. Landed.
2. **Don't build the octa atlas now.** It is what HDRP does, it removes the binding cost entirely, and the prototype shows the mips and gutters work. But at equal or lower memory it loses the mirror mip (p99 18-24 / 255 against 0), and the binding pressure it solves is gone after (1). Revisit if a set needs a 5th size, if a backend has no cube arrays (WebGL2, compat), or if many probe sets have to share one binding.
3. **Leave Sponza's layouts as they are.** Two sizes and three sizes measure the same against the path tracer (20.47 / 18.27 vs 20.47 / 18.26 dB), and so does one size at 128 (20.51 / 18.29). Nothing is clearly better, so nothing changes. What does change Sponza is the volume geometry, not the sizes. Whether the showcase's own Sponza should move to slabs and a grid at 128 is a showcase question (it buys 3.9 / 3.2 dB at 12.6 MB, but 11 volumes cost more lookup than 7).
4. **Sizing guidance.** Use mixed sizes only where a near-mirror receiver needs them (offscreen). Glossy floors around r 0.06 read the same at 128 as at 512 at 960x540.
