# Demo and bench scenes for reflections

Research stream R3. Facts marked (verified) were checked against the source on 2026-11-10 (Khronos repo license files and tree sizes via `gh api`, Intel HEAD request, SEED repo README, NVIDIA ORCA page). Facts marked (unverified) come from search snippets or memory and need a check before we rely on them.

## Direct answer

**Is Sponza good for reflections? Not as the main scene.** Sponza is the standard for diffuse global illumination, shadows, AO and light leaking: lots of occluders, one bright courtyard, a long colonnade. Its materials are mostly rough stone, plaster and fabric. The only reflective things are a few glossy floor tiles, the pond-less atrium floor (rough) and the curtains/lion heads (not mirror-like). Measured on reflection criteria it has almost no mirror or glossy-floor content, no metals worth the name, and no contact reflections of interest. SSR on Sponza looks "fine" because there is little to get wrong. It is still useful as a **stress scene for the miss path**: a camera in the colonnade looking down the arcade makes screen-space rays leave the screen constantly, and probe parallax matters in the narrow aisles. So keep it as one scene (you already have it), not as the headline.

**Is there a standard?** No single one. What papers and vendors actually do:

- **Papers on SSR and hybrid reflections** (Stachowiak/Uludag SSSR, Frostbite and Ubisoft talks, Hi-Z tracing) show purpose-built scenes: a glossy or mirror floor with props on it, a wet street, a metal-and-glass interior. The reproducible academic versions use McGuire archive scenes (Sponza, Sibenik, San Miguel, Breakfast Room, Salle de Bain, Bistro) mostly for GI and shadows, with the reflective floor added by the author.
- **RT-reflection samples and demos:** SEED PICA PICA (toy-scale diorama with glossy plastic and metal), NVIDIA Falcor/Lumberyard Bistro (wet-looking streets, glass, glossy tables), NVIDIA Sun Temple (water, polished stone), Intel New Sponza, Unreal Matrix/Lumen demos (not available to us).
- **Khronos:** there is a de facto "specular conformance" set in glTF-Sample-Assets, tagged `testing` and `pbrtest`: MetalRoughSpheres (roughness x metallic grid), EnvironmentTest (IBL mirror/rough spheres), SpecularTest, NormalTangentMirrorTest, Compare* models. These test the material response, not scene-scale reflection, but they are the closest thing to a standard and they are tiny.

**What "PBR v4" probably means.** I cannot find a model collection with that exact name. Plausible meanings, in order of likelihood:

1. **Khronos glTF-Sample-Assets** (formerly glTF-Sample-Models, renamed 2023), the PBR-tagged set (`core`, `testing`, `pbrtest`, `showcase`). Most likely, since that is where "PBR models" live for three.js folks.
2. **Intel "New Sponza"** (the PBR remake of Sponza, with ivy/curtains/trees add-ons). It is the thing people mean when they say "PBR Sponza v2/v4-ish".
3. **Alexandre Pestana's "PBR textures for Sponza"**, which is what the Khronos Sponza asset is built from.
4. Sketchfab/Substance "PBR metal-rough v4" texture packs, or the Khronos "PBR Neutral" tone mapper (a renderer feature, not a model).

I am assuming (1). Ask the maintainer if they had a specific name or URL in mind.

Local state: `/Users/dex/Developer/sponza-optimized` holds the Khronos-style Sponza (`Sponza.gltf` 106 KB, `Sponza.bin` 6.9 MB, 69 JPG textures 41 MB, plus a 64 MB `.blend` we do not need). So about 48 MB to serve, already JPG-compressed. `/Users/dex/Developer/Capsaicin/assets` is empty (submodule or download not fetched), and its docs name no scene, so nothing to learn there. The FidelityFX SDK SSSR sample page (gpuopen.com/manuals/fidelityfx_sdk/samples/stochastic-screen-space-reflections) does not name its scene; the Cauldron-based samples ship a small set of glTF scenes, but I could not confirm which one SSSR uses (unverified).

## Comparison

Reflection content scored 0 (none) to 3 (rich). Sizes are for the download you would actually fetch.

| Scene | Reflection content | Format | Size | License | Hosted-demo redistribution | Who uses it |
|---|---|---|---|---|---|---|
| Khronos Sponza | 0-1: rough stone; off-screen content behind camera is plentiful; narrow aisles suit probes | glTF, ready | 52.7 MB (PNG) / ~48 MB local JPG | Crytek CryENGINE Limited License for the mesh and textures (not CC); Khronos metadata CC-BY | Restricted: treat as "fetch at dev time", do not host copies without reading the license | Everyone; Khronos viewer, three.js examples, countless GI papers |
| Intel New Sponza (main + curtains, ivy, trees) | 1: PBR materials, a bit more gloss, still mostly rough; curtains add cloth | glTF, FBX, USD (also 3ds Max) | Main 3.71 GB (verified, HEAD 3,987,608,266 bytes); curtains 750 MB, ivy 1.29 GB, trees 907 MB, candles 2.97 GB | CC-BY (Intel page: "available under the Creative Commons Attribution license") | Yes with attribution, but we would have to re-host a decimated version (see below) | Intel research, ray tracing / GI papers, UE and Unity ports |
| NVIDIA ORCA Sun Temple | 2: polished stone, water pool, metal doors (unverified in detail) | FBX / Falcor, no official glTF | not listed (hundreds of MB) | CC BY-NC-SA 4.0 per ASWF wiki (unverified) | No for a public demo if we ever monetise; share-alike taints derivatives | NVIDIA Falcor, RT papers |
| Amazon Lumberyard Bistro | 2-3: glossy tables, glass, metal fixtures, wet-looking exterior street; interior and exterior variants (1.05M / 1.29M with wine / 2.83M triangles, verified) | FBX + Falcor; community GLBs exist (unverified); no wet variant on the ORCA page | ~850 MB zip (unverified, third-party blog) | CC-BY 4.0 (verified on ORCA page) | Yes with attribution | NVIDIA, Intel, AMD, Bevy, nearly every recent RT/GI paper; best "real scene" candidate |
| SEED PICA PICA assets | 3 at toy scale: glossy plastics, metals, rubber; small diorama | FBX + TGA | Diorama FBX 12.4 MB plus a handful of textures | CC BY-NC 4.0 (verified in README) | Non-commercial only; fine for a free demo, not for anything commercial | SEED's own RT reflection talks (PICA PICA, GDC 2018) |
| McGuire archive: Breakfast Room, Salle de Bain, Conference, Sibenik, San Miguel | Breakfast Room 2 (glossy table, mirror-like fixtures); Salle de Bain 3 (mirrors, glossy tile); Conference 1; Sibenik 0; San Miguel 1 | OBJ + PNG only, no glTF | small to ~hundreds of MB | Mixed per scene (unverified, check each readme) | Per scene | Dominant in academic papers (Breakfast Room, Salle de Bain, Sibenik, San Miguel) |
| Khronos MetalRoughSpheres | 3 for material response: 7x5 grid of metal/roughness spheres | glTF | 11.2 MB (textures); NoTextures variant much smaller | CC-BY 4.0 | Yes with attribution | Khronos conformance |
| Khronos EnvironmentTest | 3 for IBL: mirror and rough spheres on a table | glTF, `glTF-IBL` variant with HDR | 0.3 MB (glTF) / 1.4 MB with IBL | Model: Adobe Stock license (verified); not freely redistributable | Dev-time only | three.js, Babylon, Filament |
| Khronos SpecularTest / Compare* | 2 for KHR_materials_specular, clearcoat, sheen, iridescence comparisons | glTF | 0.2 MB each | CC-BY 4.0 | Yes | Khronos, all engines |
| Khronos ToyCar | 3: clearcoat, sheen, transmission, polished paint, glass | glTF/GLB | 5.4 MB | CC0 | Yes, free | Khronos showcase; three.js and Babylon docs |
| Khronos ABeautifulGame | 3: glossy chess board and glass-like pieces, many small contacts | glTF/GLB | 29.8 MB glTF, 43 MB GLB, 12.1 MB KTX2+Draco | CC-BY 4.0 | Yes with attribution | Microsoft/ASWF showcase |
| Khronos CarConcept | 3: curved clearcoat paint, chrome, glass, dark environment | glTF | 11.4 MB (3.6 MB KTX2+Draco) | CC-BY 4.0 (+ Khronos trademark carve-out) | Yes with attribution | Khronos showcase |
| Khronos ChronographWatch | 3 at small scale: metal, sapphire glass, curved reflections | glTF | 7.5 MB | CC-BY 4.0 | Yes | Khronos showcase |
| Khronos FlightHelmet | 2: leather and glass visor, metal bits | glTF | 48.4 MB (34 MB KTX2) | CC0 (assets) | Yes, free | Everyone, three.js examples |
| Khronos NormalTangentMirrorTest | tests mirrored UV and normals, not reflections | glTF | 1.6 MB | CC-BY 4.0 | Yes | Khronos conformance |
| Poly Haven models and HDRIs | Models: individual props, CC0, glTF with textures. HDRIs: environment lighting, 1k-4k | glTF via `api.polyhaven.com` | 1-30 MB per model, HDRIs 1-30 MB | CC0 | Yes, free | Everyone; Poly Haven documents CC0 |
| Blender demo files | Classroom (CC0, 72 MB per the listing) is a lit interior with glossy floor; Barbershop is CC-BY-ND, so no derivatives, rejected | .blend, need export | 72-280 MB | Mixed | Classroom yes | Blender benchmarks |

## Recommendation

Three asset scenes plus a fourth optional, then procedural rooms built in this repo. The asset scenes cover real-world materials and scale; the procedural rooms are the ones that decide pass or fail, because they isolate one behaviour each and have known ground truth.

### Asset scenes

1. **Amazon Lumberyard Bistro (interior, with exterior as a stretch).** The best real scene for reflections: glossy tabletops, glass, metal, a street with wet-looking surfaces, plenty of content outside the screen. Tests all four sources. Cost: FBX only from NVIDIA, ~850 MB, and converting to a web-friendly glTF takes work. See the plan below. If the conversion is too much work for Phase 3, defer; it is a Phase 4 and 5 scene.
2. **Khronos Sponza (what we already have), as the off-screen / probe-occlusion scene.** Mostly rough, so it tests the "miss list and probe fallback under a long colonnade" path rather than gloss. Cheap, and no new fetch.
3. **Khronos ToyCar + CarConcept + ABeautifulGame (a "showpiece row", three small models).** Together 5 + 11 + 30 MB. Curved clearcoat and chrome (CarConcept), glass and sheen (ToyCar), glossy board with contacts (ABeautifulGame). We put each on our own mirror floor or table, inside a procedural box room, so the asset's material range meets our reflection test geometry. License is friendly (CC0 / CC-BY).
4. **Khronos MetalRoughSpheres + EnvironmentTest (conformance strip).** Roughness x metallic grid for the resolve and filtering, EnvironmentTest only for dev-time comparison since the Adobe Stock license does not allow shipping it. For a shippable version, use our own sphere grid in code and compare numerically.

Not recommended: Intel New Sponza (3.71 GB for the main pack alone; materials are barely more reflective than Khronos Sponza; the CC-BY license is friendly, but we would need to decimate and re-host, and the payoff is low for reflections); Sun Temple (NC-SA, FBX only); McGuire scenes (OBJ only, mixed licenses, but Breakfast Room and Salle de Bain are the best academic references; consider them as dev-only comparison scenes for paper-figure parity, convert locally with `obj2gltf` and never ship); PICA PICA (NC license, FBX, small scale; useful as a conceptual model for our procedural toy diorama, not as a download).

### Procedural test rooms to build ourselves

Each is a few lines of three.js code, loads instantly, and has analytic ground truth. Source column is which reflection source the room is designed to exercise.

| Room | Setup | Tests | Source |
|---|---|---|---|
| Mirror floor, lit wall | Perfect mirror (roughness 0) floor in front of a bright, textured wall; camera sees the wall's reflection fully on screen | Screen-space sees everything; reference for hit quality, edge fade, thickness | SSSR |
| Off-screen behind camera | Same mirror floor; a bright coloured object placed behind and above the camera | SSSR must miss; probe or RT must fill; the hybrid must show it with no seam | Hybrid, RT, probes |
| Contact | Sphere and box resting on glossy floor (roughness 0.1 to 0.3) | Contact hardening, ray start bias, self-intersection, thin-contact error | SSSR, RT |
| Roughness ramp | Row of floor strips or spheres at roughness 0 to 1 in 8 steps, same reflected content | Cone widening, denoiser blur, SSSR to probe blending by roughness | All, plus denoiser |
| Moving object | Reflected sphere on a circular path; a camera orbit script | Temporal stability, disocclusion, ghosting, probe staleness for dynamic content | SSSR + denoise, RT, live probes |
| Box room for parallax | Closed box room, camera inside, glossy floor and a metal ball, one probe at the centre vs off-centre | Box-projected probe parallax vs infinite-distance cubemap; error versus ray-traced reference | Probes |
| Corridor / thin-feature | Long hallway with pillars and a thin railing | Thickness heuristic, self-hit, missed-hit holes | SSSR, RT |
| Sphere grid, no textures | MetalRoughSpheres rebuilt procedurally | Filtering/prefilter correctness vs analytic GGX | Probes |

The existing explainer room (mirror, off-screen, moving, contact, rough scenarios) and Ben's two rooms already cover the first five; the new ones are corridor and sphere grid. Keep them as the pass/fail benches in `pnpm check` and use asset scenes for visual review and GPU-ms numbers.

### Per-asset fetch details

**Khronos Sponza (already local).**
- URL: `https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Sponza/glTF` (raw: `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Sponza/glTF/Sponza.gltf`; fetch the directory with `gh` or a sparse clone).
- Size: 52.7 MB (PNG textures). The local `sponza-optimized` copy is JPG, 41 MB of textures plus 6.9 MB bin.
- License: Crytek's CryENGINE Limited License for the model and textures (CC-BY only covers Khronos's metadata). The Khronos README records it was confirmed available at cryengine.com/marketplace. Do not commit; fetch at dev time.
- Conversion: none to load. To shrink for a hosted demo: `gltf-transform optimize Sponza.gltf Sponza.glb --texture-compress webp --texture-size 1024`, or `--texture-compress ktx2` if the ktx toolchain is installed.
- Known issues: many alpha-masked leaf and curtain materials; set `alphaTest`/`alphaToCoverage` correctly or reflection hits on leaves look wrong; double-sided geometry on thin walls gives SSR self-hits.

**Amazon Lumberyard Bistro.**
- URL: `https://developer.nvidia.com/orca/amazon-lumberyard-bistro` (Download button goes to `/bistro`). Formats FBX and Falcor. Interior 1,046,609 triangles, interior with wine 1,293,691, exterior 2,832,120.
- Size: ~850 MB zip (unverified); not stated by NVIDIA.
- License: CC-BY 4.0 (verified on the ORCA page). Attribution to Amazon Lumberyard.
- Conversion (plan, untested): import FBX in Blender (or `FBX2glTF`), export GLB with textures, then `gltf-transform` pipeline: `gltf-transform dedup in.glb a.glb && gltf-transform weld a.glb b.glb && gltf-transform meshopt b.glb c.glb --level high && gltf-transform resize c.glb d.glb --width 1024 --height 1024 && gltf-transform webp d.glb bistro-interior.glb`. Target well under 100 MB for the interior. Community glb conversions exist (an `Animats` r/gamedev post and bevy_bistro_playground), but check their licenses before using; they inherit CC-BY.
- Known issues: lots of foliage cards with alpha; some materials lose roughness on export; 1M triangles stresses three-mesh-bvh build time (use it as the BVH build bench too).

**Khronos ToyCar, CarConcept, ABeautifulGame, MetalRoughSpheres.**
- URLs: `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/<Name>/glTF-Binary/<Name>.glb` for ToyCar (5.4 MB), ABeautifulGame (43 MB; the `glTF-Binary-KTX-ETC1S-Draco` variant is 12.1 MB), MetalRoughSpheres (11.2 MB), ChronographWatch (7.4 MB). CarConcept GLB lives in `GLB/` (10.3 MB) and `glTF-Binary/` (11.8 MB).
- Licenses: ToyCar CC0; FlightHelmet CC0; CarConcept, ChronographWatch, ABeautifulGame, MetalRoughSpheres, SpecularTest CC-BY 4.0 (verified in each LICENSE.md). EnvironmentTest model is under the Adobe Stock license, dev-time only.
- Conversion: none.
- Known issues in three.js (from memory, verify with `pnpm check`): ToyCar and CarConcept use `KHR_materials_transmission`/`volume`/`clearcoat`/`sheen`; transmission is rendered through a separate transmission pass in three, so it will not appear in our reflection source unless we feed it explicitly. Treat glass as opaque-gloss for reflection-source testing, or exclude it from the reflected scene. ABeautifulGame also uses transmission on glass pieces. KTX2/Draco variants need the loader decoders set up.

**Fetch script idea.** One `scripts/fetch-scenes.sh` using `gh api` or `curl` against the raw URLs above into a gitignored `examples/.cache/`, with the license text printed on download. Never commit the assets (matches the CLAUDE.md "fetch at dev time" rule).

### Suggested order

1. Procedural rooms (already partly built).
2. ToyCar and CarConcept in a mirror-floor room (cheap, shippable, CC0/CC-BY).
3. Sponza (local) as the miss-path scene.
4. Bistro interior once Phase 4 (trace seam) needs a heavy BVH and a real scene.
5. McGuire Breakfast Room / Salle de Bain as dev-only paper-parity checks, converted locally, never shipped.

## Open questions for the maintainer

- What did "PBR v4" refer to? The answer changes whether Intel New Sponza deserves a place after all.
- Is a hosted demo planned, and is it commercial? That decides whether CC BY-NC assets (PICA PICA) and the Crytek license are acceptable.
- Is Bistro worth a converted glTF we host (CC-BY allows it with attribution), possibly as a shared `@pmndrs` asset?
