# Draft issue for pmndrs/pathtracer: a lower-binding mode for the inline trace module

*Ready to file (W89). Not filed: the lead files it.*

---

**Title:** `@pmndrs/raytracer`: an inline-module layout that fits next to a host pass under WebGPU's default 8 storage buffers per stage

## What we do

`@pmndrs/reflections` (pmndrs/reflections) uses `@pmndrs/raytracer` 0.1.0 as its only ray-tracing provider: `rtModuleWgsl` is pasted into our traced-reflection compute pass (`rtClosest`, `rtVisible`, `rtSurface`, `rtMaterial`, optionally `rtShade`), bound from `rtWalkEntries(format)` + `rtSceneEntries(packing)`. The pass is a host kernel with its own bindings, so the module's storage buffers add to ours in one compute stage.

Many apps never raise `maxStorageBuffersPerShaderStage`: three.js's `WebGPURenderer` requests no limits unless the app passes `requiredLimits` (r187 `WebGPUBackend`: `requiredLimits: parameters.requiredLimits ?? {}`), so the device has WebGPU's default **8**. We can't count on an app building its device through our `reflectionsRequiredLimits()`.

## The budget today (0.1.0, record leaves, quantized nodes)

Storage buffers in the traced pass's compute stage:

| part | buffers |
| --- | --- |
| our pass (miss list, tile counters, state) | 3 |
| radiance fallback: constant / probe set | 0 / 1 |
| `@pmndrs/raytracer` walk (`rtWalkEntries`: nodes, triangles, top level; +1 positions with indexed leaves) | 3 |
| scene copy, `packing: 'packed'` / `'split'` (`rtSceneEntries`) | 1 / 2 |
| hit shading: environment / probe set / `rtShade` (ours) | 0 / 1 / 0 |

| configuration | packed | split | default device (8) |
| --- | --- | --- | --- |
| three adapter, probe hit shading (our default) | 3 + 0 + 4 + 1 = **8** | 9 | packed fits, split does not |
| three adapter, environment hit shading | 7 | 8 | fits |
| three adapter, `rtShade` hit shading | 7 | 8 | fits |
| core, probe fallback + probe hit shading | **9** | 10 | does not fit |
| core, probe fallback + `rtShade` | 8 | 9 | packed fits |
| core, probe fallback + environment | 8 | 9 | packed fits |

With 0.1.0's `packing: 'packed'` (thank you for P3.11) our default configuration lands exactly on 8, with no room left: one more binding on either side (an indexed-leaf scene, a scene copy over `maxStorageBufferBindingSize` that has to go split, the core path with a probe fallback, any new feature of ours) and the pass can't be built. We now degrade to screen space + probes with one console warning when that happens, but users lose ray tracing on a device that could trace.

## What we ask

An opt-in layout where the inline module needs **at most 2 storage buffers in total** (walk + scene copy), ideally 1. For example:

1. **Packed walk:** nodes, triangle records and the top level in one storage buffer (offsets in a small header, the way `packing: 'packed'` does it for the scene copy): `rtWalkEntries` would return 1 entry (2 with indexed leaves' positions, or fold those in too).
2. **One buffer for everything:** the packed walk and the packed scene copy in one `array<vec4u>` (`rtSceneEntries` returns nothing extra), for consumers that rebuild both together anyway.

Either way the module text would read through the header's offsets (one uniform-address load each, as the packed scene copy's `dataBase`), so the cost should be close to what P3.11 measured for the scene copy (a wash on Sponza, +2 % on Cornell for the megakernel).

## What it gives us

| configuration | today (packed) | with (1) | with (2) |
| --- | --- | --- | --- |
| three adapter, probe hit shading | 8 | 6 | 5 |
| core, probe fallback + probe hit shading | 9 | 7 | 6 |

Every configuration we ship would fit WebGPU's default 8 with room for one or two more bindings, so `@pmndrs/reflections` could drop `maxStorageBuffersPerShaderStage` from its required limits altogether. The same applies to anyone pasting `rtModuleWgsl` into an existing kernel (G-buffer consumers, probe bakers, GI passes), which usually already spend 3-5 storage buffers of their own.

## Smaller asks, in case (1) / (2) are too large

- `rtModuleStorageBuffers(options)` already exists: document it as *the* number for host kernels, including the indexed-leaf case.
- Let `buildGpuScene` / `uploadTraceScene` report when a scene would need indexed leaves (one more binding) before the consumer compiles a kernel.

## Context

- pmndrs/reflections W89 (`docs/research/w89/`, `docs/DIVERGES.md` D5450 / D5451): the packed scene copy as our default, and the degrade path (a check on a default-limits device).
- Measured on Chrome / Metal (Apple M-series), where adapters offer more than 8; the 8 is the device default an app gets without asking.
