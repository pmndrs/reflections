# Changelog

## Unreleased

- Probes: oriented boxes. three: `ReflectionProbe.oriented` (default false) turns a probe's influence and projection
  boxes, its blend and both offsets with the probe's world rotation, so a probe fits a turned room or a part of a
  turned car; the captures stay world-aligned, and `ReflectionProbesHelper` draws the turned boxes. Babylon:
  `BabylonProbe.rotation` (a quaternion). Core: `ProbeVolume.rotation`; the volume table takes 6 rows per volume (was 5;
  `PROBE_ROWS_PER_VOLUME`), row 5 the rotation. Axis-aligned probes render as before, bit for bit, at the same cost.

- three: a material that samples the probes and binds more textures (or samplers) per stage than the device allows now
  gets one console warning naming it, the count, how many are probe atlases, the limit and the fix
  (`reflectionsRequiredLimits(adapter)`, or fewer probe sizes), when three builds it and before WebGPU rejects its
  pipeline. It replaces the bake's warning at three or more probe sizes, which also fired when everything fit.

## 0.1.0

First stable release (npm dist-tag `latest`), with the examples set. Changes since 0.1.0-alpha.0:

- Babylon: `probeIrradiance(material, probes)`, a PBR material plugin that lights the material's diffuse
  image-based lighting from a `BabylonProbeSet` per pixel (bounce light, as three's materials get from
  `scene.environmentNode`). `BabylonProbeSet.bake()` now captures with the set disabled. `engines/babylon` uses it.
- `minTraversalOccupancy` defaults to 0 (was 4, FFX's early exit) in core, so in three, r3f and pixi too: every glossy
  ray marches to its end. The exit made a still frame trace differently every dispatch; 0 lowers rest flicker
  (quickstart 0.31 -> 0.25 % of px, engines/three 0.0080 -> 0.0074 / 255) for intersect +0.05-0.14 ms at 1080p.
  Pass `settings: { minTraversalOccupancy: 4 }` for the old behaviour.
- Babylon: `ScreenSpaceReflections` defaults `minTraversalOccupancy` to 0, so a still view is bit-identical from frame
  to frame (the early exit made glossy rays end differently every dispatch; no denoiser hides it there).
- Ray-traced hits sample the material's base colour texture at the hit (was the texture's average colour, which
  showed as flat grey shapes where a fallback ray hit a textured surface). Read once from each readable sRGB colour
  map (at most 1024 px a side, at most 4 texture arrays; the storage-buffer count is unchanged). The new provider
  option `textures: false | { maxSize, maxBuckets, cone }` controls it; `false` restores the averages. The default
  `cone` (0.05) reads textures slightly soft, which keeps the rest flicker where it was.
- Babylon: `BabylonProbe` takes `originOffset` and `projectionOffset` (as three's `ReflectionProbe`), and
  `ScreenSpaceReflections` honours `settings.frameIndex` instead of overwriting it.
- webpack 5 and Next.js build an app that does not install the optional `@pmndrs/raytracer` / `@pmndrs/bvh`
  (a warning instead of a failed build). Tested: webpack 5 with and without them, Vite 6 and esbuild without them.
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
