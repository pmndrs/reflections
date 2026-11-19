# W81: core's trace provider onto @pmndrs/raytracer (pmndrs/pathtracer P1.5)

The P1 exit gate of pmndrs/pathtracer: reflections switches to its trace core by deleting code, traced hits are no
longer darker than the path tracer, and reflection rays/s do not regress. Branch `p1.5-raytracer-core`.

## What changed

- `createRaytracerTraceProvider` (core) replaces `createPmndrsBvhTraceProvider`; three's
  `createRaytracerTraceProviderFromObjects` replaces `createPmndrsBvhTraceProviderFromObjects`. Same inputs (meshes,
  instances, materials) plus `lights` (sun, environment) for `rtShade`. The bvh trees are built exactly as before
  (`createMeshLayoutBuilder` + `assembleTraceScene`), so the walk and its hits are the same.
- The provider's WGSL is @pmndrs/raytracer's inline module (`rtClosest`, `rtVisible`, `rtSurface`, `rtMaterial`,
  `rtShade`) plus ~30 lines mapping it onto the seam. Our shading buffer, normal-matrix packing and vertex-normal walk are
  gone; materials, normals and lights come from its scene copy (D5204).
- New seam capability `hitShade` (`traceHitShade`) and an opt-in `raytracerHitShading` (D5201). The default hit shading
  is unchanged.
- Code size: core provider 306 -> 308 lines of code, three side 130 -> 160. The deletion removed the old wrapper, but the
  new provider is not smaller: it also translates materials, takes lights and exposes `rtShade`.

## Checks (M5 Pro, Chrome 157, port 5453)

`pnpm check -- --only ssr-rt-bvh --rt-core raytracer`, before the deletion: 38/38, provider `@pmndrs/raytracer` logged.
Oracle vs THREE.Raycaster 4096/4096 (camera and scene rays, both builders); vs three-mesh-bvh 16384/16384 on offscreen,
mirrorWall, contact, boxRoom, moving, facingMirrors, rooms; per-triangle materials 100%; shading normals 3989/3989
within cos 0.999; D901 ratios 1.014 / 1.095 / 0.969. After the deletion: full `pnpm check`, see the HANDOFF log.

## Trace cost (best effort)

`rt trace` GPU ms at 1920x1080, default misses / all below confidence 1.01 traced, loop stopped, median of 20 frames per
run. Load 2.0-4.4 on 18 cores, 4-5 Chrome GPU processes: **not** the quiet pass. Every variant had bursts of 2-20x
slow runs on moving and boxRoom, so the floors (min over runs) and medians are compared. Raw runs:
`rt-bvh-timing.json`.

| scene | runs | @pmndrs/bvh wrapper | @pmndrs/raytracer | ratio | three-mesh-bvh |
|---|---|---|---|---|---|
| offscreen 'mirror' | 3, min | 0.295 / 0.467 | 0.301 / 0.471 | 1.02 / 1.01 | 0.349 / 0.542 |
| mirrorWall | 3, min | 0.113 / 0.505 | 0.110 / 0.533 | 0.97 / 1.06 | 0.169 / 0.518 |
| contact | 5, median | 0.391 / 0.677 | 0.409 / 0.671 | 1.05 / 0.99 | 0.507 / 0.781 |
| moving | 8, min | 0.493 / 0.947 | 0.499 / 0.957 | 1.01 / 1.01 | 0.758 / 1.217 |
| boxRoom | 8, min | 0.219 / 0.371 | 0.218 / 0.377 | 1.00 / 1.02 | 0.274 / 0.436 |
| Sponza | 3, min | 0.847 / 1.051 | 0.859 / 1.050 | 1.01 / 1.00 | 1.489 / 1.781 |

Verdict: the same walk at the same cost within the noise (-3 .. +6%). The wrapper's own spread on contact was
0.383-0.407 ms. Quiet-pass command, from commit 36e206a (both providers): `REFLECTIONS_PORT=5453 pnpm check -- --only ssr-rt-bvh --rt-bvh-timing-only --rt-bvh-rounds 5`.

## Brightness against the path tracer

pmndrs/pathtracer `bench/pages/reflections-ab.ts` (`REFLECTIONS_REPO=<checkout> node bench/runner/run.ts --page
reflections-ab --args reflections=<checkout> size=128 frames=1024 spp=1024`; the checkout must still have the wrapper,
e.g. this branch at 36e206a). The same camera rays go through this repo's WGSL seam (`HIT_WGSL` + provider +
`shadeTracedHit`, normals turned as the traced pass does):

- A: the @pmndrs/bvh wrapper + `environmentHitShading` (sky mean + shadowed directional light; our hit shading without
  probes).
- B: the raytracer provider + `raytracerHitShading`.
- Reference: @pmndrs/pathtracer's `PtMegakernel` at maxDepth 1 over B's buffers. Scenes with OpenPBR materials are also
  rendered with its library layering (albedo + internal) and with its stochastic walk.

Pixel-centre hits agree on every ray with identical triangle, instance and material ids (16384 per scene). Mean
luminance over the reference, per material, leaving out pixels next to an emitter (raw metrics:
`reflections-ab-metrics.json`):

| scene | material | A / PT | B / PT |
|---|---|---|---|
| Cornell (one area lamp) | white / red / green walls | 0.000 | 1.000 / 1.000 / 1.000 |
| lights-mix-lamps (lamps key, weak sun + sky) | floor | 0.117 | 0.999 |
| lights-mix (sun + sky key, two lamps) | floor | 0.923 | 1.000 |
| glossy (lamp, sun, sky) | floor | 0.717 | 1.000 |
| glossy | gold (metal, roughness 0.3) | 0.119 | 0.997 |
| glossy | red plastic (roughness 0.3) | 0.981 | 1.617 (OpenPBR albedo + internal), 1.632 (walk), 1.111 (pure Lambert) |

- Without probes, A misses every area lamp and lights a metal only through the sky. It is darker than the path tracer
  wherever lamps matter: 72% of Cornell's pixels and 98% of the lamp-lit floor are more than 10% darker. With probes,
  the probes' irradiance carries some of that light, measured by D901 against the on-screen colour, not against a path
  tracer.
- B is the path tracer's first bounce, except on the saturated plastic. The plastic difference is the BSDF model, not
  the lighting: @pmndrs/raytracer's builtin BSDF is Lambert + GGX (three-like), while @pmndrs/pathtracer's OpenPBR mode
  is a dielectric coat over a diffuse base with internal reflection. That is pathtracer's open choice P1.3c (builtin vs
  the path tracer's BSDF through `bsdf: 'external'`).
- A's emission is two-sided. The lights-mix lamps are seen from behind, where A adds their emission and the path tracer
  and B do not.
