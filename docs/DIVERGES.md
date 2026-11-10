# Where we diverge from the sources

Every place this repo knowingly does something different from the work it follows (FidelityFX SSSR, idTech 8, three.js #35046, three r187 PMREM, Frostbite/Lagarde, Lumen, ...). Each entry records what the source does, what we do, why, and what would make us revisit. Nothing here is necessarily wrong. It is a list to come back to.

**Adding an entry:** take the next id. Keep it short: the source's behaviour, ours, the reason, and a trigger to revisit. If an entry is resolved (we converge, or a measurement settles it), set the status and link the commit or doc. Don't delete entries.

Status: `open` (diverges, unexamined) · `measured` (diverges, numbers justify it) · `planned` (we intend to converge) · `resolved` (converged or retired).

| id | area | source does | we do | why | revisit when | status |
|---|---|---|---|---|---|---|
| D1 | probes / storage | idTech 8 and three #35046 (Ben's fork) store probes as cube-map arrays (`texture_cube_array`). | A 2D array of 6 × N layers, with the face picked in the shader. | three r186 can't bind `texture_cube_array`. | three ships #35053 (CubeArrayTexture), or the core path binds cube arrays directly (raw WebGPU can). Phase 1 bench measures `cube-hw`. | open |
| D2 | probes / seams | Hardware cube sampling is seamless; no source warps texels. | `seamFix: 'warp'` centres edge texels on the cube edges, then does 2 bilinear samples. | Needed only because of D1: the 2D-array layout loses the hardware's seamless filtering. Measured at mean 0.05 / 255, max 3 / 255 vs `cube-hw`. | D1 resolves. | measured |
| D3 | probes / prefilter | idTech 8 uses its own GGX baker. UE maps roughness to mip by `1 − 1.2·log2(r)` from the 1×1 mip; Frostbite (Lagarde 2014) by `sqrt(α)`-based lod. | three r187's PMREM plan: lod 0 copy, 256-sample filtered importance sampling, last three levels as full 16 px integrals, `lod = maxLod · r · (2 − r)`. | Matches what three users already see from `scene.environment`, so probes and PMREM agree. | The phase 1 brute-force reference shows the r187 mapping's error at some roughness is clearly worse than another mapping. | open |
| D4 | probes / format | idTech 8 ships BC6H cube arrays. | `rgba16float` by default; BC6H opt-in for baked probes if the phase 1 gate passes. | No compressed HDR format on mobile WebGPU; compute can't write BC6H directly. | Phase 1 format axis results. | open |
| D5 | probes / layout | idTech 8 uses octahedral maps for *irradiance* volumes only; reflection probes are cubes. | We test octahedral *reflection* probes (`octa`, maybe `octa-hemi`). | One layout every engine can sample, and no cube arrays needed. | Phase 1 gate. | open |
| D6 | probes / re-fit | idTech 8 normalizes probe radiance by `frameIrradiance / probeIrradiance` against its own irradiance volumes. | Same formula, with `probeIrradiance` as the capture's L1 SH and `frameIrradiance` from whatever GI the app has (LightProbeGrid, ddgi, lightmap, ...). | We don't own a GI system. | The re-fit lands (phase 2) and is compared on the rooms. | open |
| D7 | SSSR / work lists | FFX SSSR has one compaction (classify → ray list); a miss samples the environment inline. | A second compaction: intersect appends misses to a **miss list**, which the ray-traced pass dispatches over indirectly. | The hybrid only knows screen space failed after intersect. | Phase 4 measures it against tracing every glossy pixel. | open |
| D8 | SSSR→RT / ray origin | Hybrid engines (Pica Pica, idTech 8) vary; some continue from where the march stopped. | The traced ray starts at the surface (offset along the normal) with the same direction the march used. | The march's free-space assumption only holds where it found a hit. | An off-screen scenario shows a measurable cost or quality difference. | open |
| D9 | SSSR→RT / budget | FFX has no ray budget; idTech traces at ½ or ¼ resolution. | `maxTracedRaysPerFrame`, applied per 8×8 tile with per-tile atomic counters. | Atomic append order isn't spatially fair; a global cap starves the same region every frame. | Phase 4. | open |
| D10 | SSSR / wave ops | FFX assumes wave intrinsics (ballot, prefix count, quad reads, SPD wave reductions). | A subgroup variant, plus a workgroup-memory variant for devices without `subgroups`. Both must match bit for bit after sorting. | WebGPU's `subgroups` is optional. | Never, unless `subgroups` becomes core. | planned |
| D11 | RT / hit shading | Lumen shades hits from a surface cache; idTech 8 from its GI and lights. | Hits are shaded by the probes at the hit point plus the engine's cheap direct term. No radiance cache. | Out of scope until the hybrid is measured. | Phase 5 results show hit shading as the main error. | open |

## Notes

- **D1/D2 are a pair.** If the core path moves to cube arrays (phase 1 or 2), D2 disappears for that path, but stays for any adapter still on a 2D array.
- Entries from the source surveys (`docs/research/sources.md`, `docs/research/probe-lineage.md`) are added here as they are found.
