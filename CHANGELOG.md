# Changelog

## Unreleased

- Babylon: `probeIrradiance(material, probes)`, a PBR material plugin that lights the material's diffuse
  image-based lighting from a `BabylonProbeSet` per pixel (bounce light, as three's materials get from
  `scene.environmentNode`). `BabylonProbeSet.bake()` now captures with the set disabled. `engines/babylon` uses it.
- `minTraversalOccupancy` defaults to 0 (was 4, FFX's early exit) in core, so in three, r3f and pixi too: every glossy
  ray marches to its end. The exit made a still frame trace differently every dispatch; 0 lowers rest flicker
  (quickstart 0.31 -> 0.25 % of px, engines/three 0.0080 -> 0.0074 / 255) for intersect +0.05-0.14 ms at 1080p.
  Pass `settings: { minTraversalOccupancy: 4 }` for the old behaviour.
- Babylon: `ScreenSpaceReflections` defaults `minTraversalOccupancy` to 0, so a still view is bit-identical from frame
  to frame (the early exit made glossy rays end differently every dispatch; no denoiser hides it there).
- `Reflections.create` takes `gbufferOptions` (e.g. a render size below the canvas, for an upscaler after the
  composite) and `timestamps` (per-pass GPU ms through `reflections.ssr.readTimings()`), passed to the pass.
- `applyReflectionsPreset(reflections, name)` takes a `Reflections` and rebuilds it when the preset changes the
  reflection resolution (no "rebuild your composites" warning); `{ ssr, hybrid }` works as before.
- The examples: a catalog of pages, one per feature and one per engine, each with what it shows, what to try
  and a compare switch (`examples/catalog.ts`, the gallery at `/examples/`).

## 0.1.0-alpha.0

First release (npm dist-tag `alpha`).

Reflections for WebGPU: box-projected, prefiltered reflection probes, stochastic screen-space reflections
(a WGSL port of FidelityFX SSSR) and an optional ray-traced fallback for what the screen can't see,
composed into one hybrid with a temporal denoise seam.

- `@pmndrs/reflections/three` (also `.`): the three.js `WebGPURenderer` adapter (three >= 0.187).
  `Reflections.create(renderer, scene, options)` wires the G-buffer, screen-space reflections, probes,
  ray tracing (optional), a denoiser (optional) and the composite; `createReflectionsRenderer()` builds a
  renderer with the device limits the passes want. A plain `new WebGPURenderer()` works too: with
  WebGPU's default 32 colour bytes per sample the lit image is rendered in a second pass (one warning).
- `@pmndrs/reflections/core`: the engine-agnostic WGSL passes on a bare `GPUDevice`.
- `@pmndrs/reflections/babylon` (Babylon.js `WebGPUEngine`, >= 9.35) and `@pmndrs/reflections/pixi`
  (PixiJS v8 `WebGPURenderer`, >= 8.22): experimental adapters.
- Optional peers: `three`, `@babylonjs/core`, `pixi.js` (the engine you use); `@pmndrs/raytracer` and
  `@pmndrs/bvh` ^0.1.0 for ray tracing (install both). A denoiser is not bundled: `denoiser` ^2.0.0
  (`denoiser/ffx`) plugs into the denoise seam.
- ESM only, WebGPU only.
