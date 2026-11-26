# W91: release readiness (0.1.0-alpha.0)

Branch `worktree-agent-a33c4ab4aa87c9298` from `2ea5751`. Port 5413, Apple M-series, Chrome headless (WebGPU on Metal); no timings.

## 1. A plain `WebGPURenderer` threw in `Reflections.create` (D5480)

**Cause.** WebGPU counts colour attachment bytes per sample with per-format costs: rgba16float 8, rgba8unorm **8** (not 4), rg16float 4, r16float 2. The G-buffer's base set is output (rgba16f) 8 + normalRoughness (rgba16f) 8 + albedoMetalness (rgba8unorm) 8 + motion (rg16f) 4 = 28; three's lit image is one more rgba16f = 36. WebGPU's default `maxColorAttachmentBytesPerSample` is 32, and three's `WebGPURenderer` asks for no limits, so `FrameGBuffer` (`lit: 'auto'`) dropped `lit` and `screenSpaceComposite` threw "the G-buffer has no lit target" from `HybridReflections`' constructor. The quickstart's `?limits=default` page hid it by raising that one limit.

**(a) Fit 32 bytes: rejected.** Freeing 4 bytes needs albedo + metalness in 4 bytes (r32uint packing or two rg8unorm targets): a frame-contract format change for every consumer of `textures.albedo` (core's SSSR re-shade, the half-res frame, the denoise seam) and it would still lack the specular / shading-roughness / clear-coat targets (46-50 bytes) that the `createReflectionsRenderer` path gets. Not cheap, not the same quality.

**(b) Shipped.** `lit: 'auto'` renders the lit image in a second plain render of the scene into its own rgba16float target when 36 bytes don't fit (`FrameGBuffer.litPass`, `.litTarget`), with one console warning naming the limit, `createReflectionsRenderer()` and `reflectionsRequiredLimits(adapter)`. `lit: 'pass'` forces it, `lit: true` still throws (message names both fixes). The 32-byte path has no `specular` / `shadingRoughness` / `clearcoat` targets, so the composite estimates three's weights (D603's estimate path).

| measure | value |
| --- | --- |
| regressions `gbufferLitPass`: second pass vs the MRT's `lit` attachment (coat, glass, light, environment) | max 4.9e-4, mean 2.2e-8 over 67 % lit px; normals identical; 0 GPU errors |
| regressions gbuffer motion checks (plain renderer, so now on the second-pass path) | all pass (moving instance 209 px inside, 0 outside) |
| quickstart `?limits=default` (no limit raised): reflections on vs off | 8.05 / 255 (full path 7.84) |
| its rest flicker (px > 1/255) | 0.318 % (full path 0.315 %) |
| its image vs the `createReflectionsRenderer` page | 0.44 / 255 mean, 0.5 % px over 12 (estimated weights) |
| warnings | exactly one |

The default path (a device with >= 36 bytes: `createReflectionsRenderer`, R3F, every example) runs the same code as before, so no flicker before / after run.

## 2. The `@pmndrs/bvh` peer stays

`@pmndrs/raytracer` 0.1.0's index re-exports contract / caps / noise / sampling / trace / scene / shade, not the bvh builders core calls (`createMeshLayoutBuilder`, `assembleTraceScene`, `uploadTraceScene`, `buildTopLevel`, `GPU_LAYOUT_VERSION`); it imports `@pmndrs/bvh` itself. So both optional peers stay. Scratch consumers with the tarball + three + `@pmndrs/raytracer` only:

| package manager | `import('@pmndrs/bvh')` from our dist |
| --- | --- |
| pnpm 10 (isolated, defaults) | resolves (pnpm links an optional peer found in the graph); vite build bundles it |
| npm 10 | resolves (hoisted) |
| Yarn 4 PnP | MODULE_NOT_FOUND |

Docs: install both. `loadRaytracer` now names the missing package when a bundler hands it an empty module for a missing optional peer (Vite does), instead of a layout-version mismatch.

## 3. Release machinery

- `npm pack`: 24 files (LICENSE, NOTICE, README.md, CHANGELOG.md, dist), 326.6 kB packed, 1.0 MB unpacked. The packed manifest has no `workspace:` specifier and no private package (scripts/pack-manifest.mjs strips the root's workspace devDependencies at prepack, restores at postpack); dist names none.
- `npx publint`: All good. `npx @arethetypeswrong/cli --pack .`: green on node10, node16 (ESM), bundler; node16 from CJS "ESM (dynamic import only)" (the package is ESM only). `npm publish --dry-run --tag alpha`: OK.
- Scratch Vite + TypeScript consumer (tarball + three 0.187 + @types/three, imports `/three` and `/core`): `tsc --noEmit` clean with `moduleResolution` bundler and node16 (`skipLibCheck: false`); `vite build` OK without `@pmndrs/raytracer` installed. The build warned `"CubeArrayTexture" is not exported by three.webgpu.js` (our feature detection); now read through `Reflect.get`, no warning.
- Fresh clone of the branch: `pnpm install --frozen-lockfile`, typecheck, test 84, build: OK. release.yml's shell steps run in that clone: version guard, dist-tag `alpha`, manifest strip + check, tarball contents, `npm publish --provenance --dry-run`: OK; a mismatched tag is refused. actionlint clean.
- GPU checks after the changes: quickstart 22, ssr 33, hybrid 20, ssr-rt 29, showcase 8, preset 7, probes 45, regressions 55, r3f 7/7 then 6/7 (r3f rt + preset performance rest flicker 1.440 / 1.541 / 1.554 / 1.482 % vs the 1.5 % bound over four runs: W89's borderline, 1.533 / 1.520 % at 051a49c; that page's renderer is `createReflectionsRenderer`, whose path this wave did not change).
