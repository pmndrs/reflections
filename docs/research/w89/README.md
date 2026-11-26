# W89: sibling sync for the first npm release

Branch `worktree-agent-a3a5d93e55bceac62` from `051a49c`. Port 5411, Apple M-series, Chrome headless (WebGPU on Metal); no timings here.

## What changed

- **Phase A.** `@pmndrs/raytracer` ^0.1.0 and `denoiser` ^2.0.0 from npm: no sibling checkout, no aliases, no stubs; `autoInstallPeers: false` dropped. examples/nrc alone keeps a sibling resolver (`$NRC_PATHTRACER_REPO`) for the pathtracer's unpublished bench modules and stays off the site.
- **Phase B1.** `@pmndrs/raytracer` is the only ray-tracing provider (D5452): the three-mesh-bvh provider, core's `@pmndrs/bvh` wrapper and three's `createPmndrsBvhTraceProviderFromObjects` are deleted; `Reflections.create({ rayTracing: true })`, the pass options, the showcase, ssr, quickstart and r3f use `createRaytracerTraceProviderFromObjects`.
- **Phase B2.** The scene copy is bound packed (one storage buffer, D5450), and a traced pass the device can't fit turns itself off with one warning (D5451). The draft issue for pmndrs/pathtracer: [`raytracer-limits-issue.md`](raytracer-limits-issue.md).
- **Phase B3.** The compare / bench pages' reference is `@pmndrs/pathtracer` 0.1.0 (D5453; ./examples/showcase/src/compare/ptScene.ts builds its scene from three), OIDN from `denoiser`; the compare and bench pages ship on the site.

## Published API differences we hit

| what | published 0.1.0 | what we do |
| --- | --- | --- |
| `rtSceneEntries` / `uploadSceneCopy` / `rtModuleWgsl({ scene })` | take `packing` ('packed' default, D32 there); `SceneCopyBuffers` is `{ packing, table?, data?, packed? }` | packed by default (`packing: 'auto'` falls back to split over `maxStorageBufferBindingSize`); `writeSceneCopy` for rebuilt copies |
| `buildGpuScene`, `loadGltf` (@pmndrs/raytracer) and `ptSceneOptions` (@pmndrs/pathtracer) | documented in pmndrs/pathtracer's docs/, **not in the 0.1.0 tarballs** | the reference builds the trees (`@pmndrs/bvh` `createMeshLayoutBuilder` / `assembleTraceScene` / `uploadTraceScene`) and the scene copy itself, and the kernel options (`ptMaterialFeatures`, envMap, alphaMask) the way `ptSceneOptions` does in the pathtracer's source |
| a three adapter | none | ptScene.ts (textures, materials, sun, point lights as emissive spheres, environment) |
| `.d.ts` re-exports with `.ts` extensions (`export * from './bsdf/bsdf.ts'`) | resolve under our `tsc` (bundler resolution) | nothing |
| the layered dielectric's default `albedoBase: 'internal'` | darker, more saturated diffuse than three's model | the reference passes `albedoBase: 'openpbr'` (`?ptLayering=internal` for the default) |
| denoiser 2.0.0 FFX | no W78 `brdfWeights` / `keepHistoryOnBlack` (unmerged branch); OIDN WGSL logs `subgroupMatrixLoad` deprecation warnings where subgroup matrices exist | nothing (D5454) |

## Device limits (storage buffers per stage, the traced pass)

Pass 3 + radiance fallback (constant 0, probe set 1) + provider (walk 3 + scene copy packed 1 / split 2) + hit shading (probes 1, environment 0, rtShade 0). WebGPU's default is 8; three's `WebGPURenderer` asks for no limits (r187 `WebGPUBackend`: `requiredLimits ?? {}`), so a plain renderer has 8; `createReflectionsRenderer` / `reflectionsRequiredLimits` ask for min(adapter, 10).

| configuration | packed | split | on a default device |
| --- | --- | --- | --- |
| three, probe hit shading (the default with probes) | **8** | 9 | packed runs |
| three, environment hit shading (no probes) | 7 | 8 | runs |
| three, `raytracerHitShading` (rtShade) | 7 | 8 | runs |
| core, probe fallback + probe hit shading | 9 | 10 | does not fit |
| core, probe fallback + rtShade / environment | 8 | 9 | packed runs |
| the old `@pmndrs/bvh` wrapper (deleted), three default | 8 (3 + 0 + 4 + 1) | | ran |

Degrade (D5451): `ScreenSpaceReflectionsPass` catches the traced pass's build failure, warns once, sets `pass.traceError`, and keeps screen space + probes. Check: `pnpm check -- --only quickstart`, pages `?limits=default` (a plain `WebGPURenderer`, 8 storage buffers, colour bytes raised for the lit target) and `&rtPacking=split` (9): packed traces, split degrades with exactly one warning, no validation error, reflections present (7.85 / 255 on vs off).

Finding (not fixed, outside the RT scope): `Reflections.create` on a plain `WebGPURenderer` with WebGPU's default `maxColorAttachmentBytesPerSample` (32) throws in `screenSpaceComposite` ("the G-buffer has no lit target") - the drop-in path needs `createReflectionsRenderer` or that one limit raised.

## PT reference: old (three-gpu-pathtracer 0.0.28) vs new (@pmndrs/pathtracer 0.1.0)

`pnpm check -- --only pt-reference` (new, opt-in): bench Measure at the hero pose, 32 spp + OIDN, ours + RT and ours denoised, 16 warm-up + 4 frames, 960x540. Same "ours" build on both sides (the provider swap is already in). MAD in 8-bit display units. JSON in `pt-reference/`.

| scene | PT frame luma old -> new | PT glossy luma | ours + RT MAD frame | ours MAD frame | ours + RT MAD glossy | ours MAD glossy |
| --- | --- | --- | --- | --- | --- | --- |
| carConcept | 136.1 -> 135.6 | 135.7 -> 135.1 | 8.40 -> 9.24 | 11.14 -> 11.98 | 11.49 -> 12.65 | 15.35 -> 16.49 |
| toyCar | 142.4 -> 141.0 | 150.7 -> 149.4 | 8.14 -> 8.86 | 8.29 -> 9.02 | 11.46 -> 12.04 | 11.70 -> 12.28 |
| chess | 148.7 -> 148.0 | 152.2 -> 151.2 | 6.90 -> 7.25 | 7.19 -> 7.54 | 9.48 -> 9.93 | 9.89 -> 10.33 |
| sponza | 30.5 -> 32.1 | 57.1 -> 59.2 | 42.53 -> 41.13 | 42.75 -> 41.36 | 43.05 -> 41.54 | 44.01 -> 42.49 |
| lineSpread | 7.0 -> 6.2 | 9.6 -> 8.2 | 6.48 -> 6.98 | 6.35 -> 6.85 | 10.30 -> 11.15 | 10.09 -> 10.93 |
| lineSpreadThin | 6.8 -> 6.1 | 9.2 -> 8.0 | 5.89 -> 5.16 | 5.87 -> 5.14 | 9.14 -> 7.98 | 9.11 -> 7.94 |
| grazing | 151.8 -> 149.3 | 169.7 -> 166.4 | 6.56 -> 6.24 | 5.07 -> 5.26 | 9.73 -> 9.54 | 6.95 -> 7.74 |
| cubeFloor | 185.5 -> 183.7 | 191.5 -> 189.0 | 5.04 -> 6.28 | 5.08 -> 6.33 | 5.78 -> 7.50 | 5.83 -> 7.56 |
| edgesFloor | 183.0 -> 180.9 | 190.7 -> 188.1 | 9.43 -> 10.13 | 9.57 -> 10.27 | 11.59 -> 12.39 | 11.76 -> 12.57 |
| plateFloor | 187.0 -> 185.3 | 191.2 -> 189.1 | 3.89 -> 5.19 | 5.00 -> 6.28 | 4.58 -> 6.18 | 5.93 -> 7.51 |

Where the reference moved and why:
- **0.5-2.5 luma darker almost everywhere** (and our MADs up by 0.3-1.7): the material model. The new reference is OpenPBR (layered dielectric, complex-Fresnel conductors), the old was three's own model, which is also what the raster methods render. With the pathtracer's default layering (`albedoBase: 'internal'`, `new-internal-layering.json`) it was much darker: Sponza 18.6, cubeFloor 180.0 (`sponza-new-internal-layering.jpg`); `'openpbr'` scaling is the closest.
- **Sponza +1.6** (and ours closer by 1.4): torches are emissive spheres here (visible as bright dots, `sponza-new.jpg`) without three's 9 m cut-off; no indirect clamp (the old clamped indirect at 10).
- **grazing**: a 2x2 nearest-filtered checker on the emissive wall; the scene copy's samplers are trilinear, so ptScene.ts blows such textures up with nearest texels first (before that fix the wall read 174.5 and MAD 36.7).
- Stored expectations: no check holds an absolute PT number (showcase-compare and bench check render / stop / denoise / regions only), so nothing moved in a check. docs/research/showcase-compare.md (W21's numbers against the WebGL reference) stays history. Our bench "ours + RT" luma is identical between the old provider (051a49c) and the raytracer to 0.01 on carConcept / Sponza / cubeFloor / grazing (the hit shading is the probes either way).

## Flicker: before (051a49c) and after, FLICKER_REPEAT=2

The default scenes, examples/ssr's RT pages (`rt=1`; before: the old default provider, the @pmndrs/bvh wrapper, and the opt-in raytracer `&bvhCore=raytracer` (split, sibling)), and the bench's `ours-rt` on five scenes (before: the wrapper). Rule: contact drift noise ~0.1 absolute, elsewhere 5 %. No metric rose beyond noise; the largest relative moves are on tiny values (plateFloor underPlate drift 0.0128 -> 0.0136, mirrorWall speckle 0.0141 -> 0.0159 %) or inside 5 % (carConcept wheel drift 1.217 -> 1.259). JSON in `flicker-before/`, `flicker-after/`.

**defaults** (before -> after; drift and orbit std are the mean of the two repeats)

| scene | region | drift | rest | orbit std | d2 | speckle % | pan d2 |
|---|---|---|---|---|---|---|---|
| ssr:contact | reflection | 0.3784 -> 0.3789 | 0.0066 -> 0.0067 | 0.4672 -> 0.4682 | 0.5820 -> 0.5825 | 0.0169 -> 0.0171 | 3.664 -> 3.665 |
| ssr:mirrorWall | reflection | 0.3059 -> 0.3059 | 0.0095 -> 0.0094 | 0.4636 -> 0.4642 | 0.7488 -> 0.7483 | 0.0141 -> 0.0159 | 7.684 -> 7.680 |
| bench:cubeFloor | reflection | 0.0355 -> 0.0355 | 0.0011 -> 0.0011 | 0.0717 -> 0.0718 | 0.1524 -> 0.1524 | 0.0000 -> 0.0000 | 0.402 -> 0.402 |
| bench:cubeFloor | cubeRefl | 0.1785 -> 0.1788 | 0.0061 -> 0.0059 | 0.2414 -> 0.2439 | 0.2188 -> 0.2190 | 0.0000 -> 0.0000 | 0.402 -> 0.402 |
| bench:cubeFloor | slabRefl | 0.2497 -> 0.2495 | 0.0053 -> 0.0053 | 0.2914 -> 0.2909 | 0.1925 -> 0.1924 | 0.0000 -> 0.0000 | 0.402 -> 0.402 |
| bench:cubeFloor | contact | 0.3251 -> 0.3259 | 0.0072 -> 0.0071 | 0.3174 -> 0.3180 | 0.1526 -> 0.1522 | 0.0000 -> 0.0000 | 0.402 -> 0.402 |
| bench:edgesFloor | reflection | 0.1988 -> 0.1990 | 0.0032 -> 0.0032 | 0.2072 -> 0.2075 | 0.3655 -> 0.3655 | 0.0000 -> 0.0000 | 0.489 -> 0.489 |
| bench:edgesFloor | panelRefl | 1.2356 -> 1.2390 | 0.0180 -> 0.0180 | 1.1646 -> 1.1687 | 1.0419 -> 1.0413 | 0.0000 -> 0.0000 | 0.489 -> 0.489 |
| bench:plateFloor | reflection | 0.0107 -> 0.0109 | 0.0004 -> 0.0004 | 0.0561 -> 0.0562 | 0.1323 -> 0.1323 | 0.0001 -> 0.0001 | 0.375 -> 0.375 |
| bench:plateFloor | plateRefl | 0.1081 -> 0.1095 | 0.0013 -> 0.0012 | 0.1516 -> 0.1517 | 0.1282 -> 0.1279 | 0.0000 -> 0.0000 | 0.375 -> 0.375 |
| bench:plateFloor | underPlate | 0.0128 -> 0.0136 | 0.0005 -> 0.0004 | 0.1367 -> 0.1387 | 0.0589 -> 0.0591 | 0.0000 -> 0.0000 | 0.375 -> 0.375 |
| bench:carConcept@w50 | reflection | 0.2680 -> 0.2681 | 0.0074 -> 0.0073 | 0.3921 -> 0.3924 | 0.3272 -> 0.3274 | 0.0576 -> 0.0575 | 0.683 -> 0.681 |
| bench:carConcept@w50 | wheel | 1.2172 -> 1.2588 | 0.0250 -> 0.0252 | 2.1475 -> 2.1304 | 1.6006 -> 1.6055 | 0.0000 -> 0.0000 | 0.683 -> 0.681 |
| bench:carConcept@w50 | car | 0.5777 -> 0.5785 | 0.0118 -> 0.0118 | 0.7786 -> 0.7807 | 0.6396 -> 0.6407 | 0.0123 -> 0.0120 | 0.683 -> 0.681 |
| bench:sponza@hero | reflection | 0.3112 -> 0.3083 | 0.0114 -> 0.0114 | 0.5539 -> 0.5544 | 5.3179 -> 5.3177 | 0.3510 -> 0.3561 | 7.084 -> 7.083 |

**RT: old default (@pmndrs/bvh wrapper) -> raytracer** (before -> after; drift and orbit std are the mean of the two repeats)

| scene | region | drift | rest | orbit std | d2 | speckle % | pan d2 |
|---|---|---|---|---|---|---|---|
| ssr:contact | reflection | 0.3755 -> 0.3750 | 0.0066 -> 0.0067 | 0.4811 -> 0.4795 | 0.5518 -> 0.5520 | 0.0188 -> 0.0186 | 3.792 -> 3.794 |
| ssr:mirrorWall | reflection | 0.3034 -> 0.3038 | 0.0091 -> 0.0093 | 0.4045 -> 0.3987 | 0.7255 -> 0.7267 | 0.0145 -> 0.0126 | 7.711 -> 7.713 |

**RT: raytracer (sibling, split) -> raytracer (npm, packed)** (before -> after; drift and orbit std are the mean of the two repeats)

| scene | region | drift | rest | orbit std | d2 | speckle % | pan d2 |
|---|---|---|---|---|---|---|---|
| ssr:contact | reflection | 0.3755 -> 0.3750 | 0.0066 -> 0.0067 | 0.4796 -> 0.4795 | 0.5519 -> 0.5520 | 0.0188 -> 0.0186 | 3.794 -> 3.794 |
| ssr:mirrorWall | reflection | 0.3034 -> 0.3038 | 0.0091 -> 0.0093 | 0.4043 -> 0.3987 | 0.7257 -> 0.7267 | 0.0144 -> 0.0126 | 7.711 -> 7.713 |

**RT bench ours-rt: @pmndrs/bvh wrapper -> raytracer** (before -> after; drift and orbit std are the mean of the two repeats)

| scene | region | drift | rest | orbit std | d2 | speckle % | pan d2 |
|---|---|---|---|---|---|---|---|
| bench:cubeFloor/ours-rt | reflection | 0.0796 -> 0.0796 | 0.0013 -> 0.0013 | 0.0877 -> 0.0877 | 0.1522 -> 0.1522 | 0.0000 -> 0.0000 | 0.408 -> 0.408 |
| bench:cubeFloor/ours-rt | cubeRefl | 0.1713 -> 0.1712 | 0.0064 -> 0.0065 | 0.2248 -> 0.2253 | 0.2155 -> 0.2153 | 0.0000 -> 0.0000 | 0.408 -> 0.408 |
| bench:cubeFloor/ours-rt | slabRefl | 0.2210 -> 0.2209 | 0.0047 -> 0.0048 | 0.2645 -> 0.2644 | 0.1757 -> 0.1755 | 0.0000 -> 0.0000 | 0.408 -> 0.408 |
| bench:cubeFloor/ours-rt | contact | 0.2655 -> 0.2657 | 0.0069 -> 0.0070 | 0.2804 -> 0.2802 | 0.1360 -> 0.1359 | 0.0000 -> 0.0000 | 0.408 -> 0.408 |
| bench:edgesFloor/ours-rt | reflection | 0.2400 -> 0.2399 | 0.0033 -> 0.0032 | 0.2210 -> 0.2210 | 0.3639 -> 0.3640 | 0.0000 -> 0.0000 | 0.495 -> 0.495 |
| bench:edgesFloor/ours-rt | panelRefl | 1.2024 -> 1.2001 | 0.0173 -> 0.0171 | 1.1170 -> 1.1170 | 1.0317 -> 1.0335 | 0.0000 -> 0.0000 | 0.495 -> 0.495 |
| bench:plateFloor/ours-rt | reflection | 0.0606 -> 0.0606 | 0.0006 -> 0.0006 | 0.0784 -> 0.0784 | 0.1342 -> 0.1342 | 0.0001 -> 0.0001 | 0.380 -> 0.380 |
| bench:plateFloor/ours-rt | plateRefl | 0.1167 -> 0.1172 | 0.0012 -> 0.0011 | 0.1340 -> 0.1339 | 0.1335 -> 0.1336 | 0.0000 -> 0.0000 | 0.380 -> 0.380 |
| bench:plateFloor/ours-rt | underPlate | 0.0965 -> 0.0964 | 0.0010 -> 0.0010 | 0.2465 -> 0.2469 | 0.0857 -> 0.0856 | 0.0000 -> 0.0000 | 0.380 -> 0.380 |
| bench:carConcept@w50/ours-rt | reflection | 0.3059 -> 0.3060 | 0.0074 -> 0.0074 | 0.3639 -> 0.3634 | 0.2957 -> 0.2957 | 0.0527 -> 0.0528 | 0.605 -> 0.605 |
| bench:carConcept@w50/ours-rt | wheel | 0.6632 -> 0.6622 | 0.0157 -> 0.0155 | 1.0571 -> 1.0557 | 0.7630 -> 0.7641 | 0.0000 -> 0.0000 | 0.605 -> 0.605 |
| bench:carConcept@w50/ours-rt | car | 0.5104 -> 0.5108 | 0.0101 -> 0.0101 | 0.5660 -> 0.5665 | 0.4731 -> 0.4730 | 0.0094 -> 0.0098 | 0.605 -> 0.605 |
| bench:sponza@hero/ours-rt | reflection | 0.3001 -> 0.3003 | 0.0112 -> 0.0112 | 0.5543 -> 0.5543 | 5.2864 -> 5.2865 | 0.2187 -> 0.2192 | 7.125 -> 7.126 |
