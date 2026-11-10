# @pmndrs/reflections

Reflections for WebGPU. It covers reflection probes (box-projected, GGX-prefiltered), screen-space reflections and ray-traced fallbacks, composed per pixel into one hybrid. The core is engine-agnostic WGSL on a bare `GPUDevice`, and three.js `WebGPURenderer` is the first adapter. It is a sibling of [`denoiser`](https://github.com/pmndrs/denoiser) and [`@pmndrs/upscaler`](https://github.com/pmndrs/upscaler).

> Early. Phase 0: the reflection probes and their prefilter, moved here from the denoiser repo's examples. The plan is in [docs/SPEC.md](docs/SPEC.md).

## Today

```ts
import { ReflectionProbe, ReflectionProbes, reflectionProbes, sampleReflectionProbes } from '@pmndrs/reflections/three';

const probes = new ReflectionProbes();
const room = new ReflectionProbe(6, 3, 6); // influence box (width, height, depth)
room.position.set(0, 1.5, 0);
probes.add(room);
scene.add(probes);

probes.bake(renderer, scene, { resolution: 128 });
scene.environmentNode = reflectionProbes(probes); // every physical material picks them up

// or in any shader: a traced ray's miss, a composite, a hit point
const radiance = sampleReflectionProbes(probes, positionWorld, direction, roughness);
```

The probes are this library's: an engine-agnostic core (GGX prefilter, cube-array / 2D-array / octahedral layouts, a WGSL lookup with box projection and blending) under a three adapter. The adapter keeps the API of Ben Houston's three.js [#35046](https://github.com/mrdoob/three.js/pull/35046); the two were built side by side and have traded ideas and fixes the whole way, so code moves between them. On three r187 (the floor), which can't bind cube arrays yet, `await installCubeArraySupport(renderer)` (a self-tested runtime port of three.js [#35053](https://github.com/mrdoob/three.js/pull/35053)) lets the adapter store the cubes in a real cube array; without it they live in a 2D array (`layout: 'auto' | 'cube-array' | 'cube2d'`, `bakedLayout` shows which). Extensions over #35046: `sampleReflectionProbes`, `reflectionProbesLocal`, `originOffset`, live/time-sliced `bake`, `bake({ exclude })` (keep moving mirrors out of captures), `bake({ environment: false })`, `seamFix`, and irradiance re-fit.

## Packages

| import | what |
|---|---|
| `@pmndrs/reflections` / `/three` | three.js adapter: probes, TSL nodes |
| `@pmndrs/reflections/core` | engine-agnostic WebGPU: the probe prefilter (more per the spec) |
| `@pmndrs/reflections/babylon` | Babylon.js WebGPUEngine adapter (experimental): core SSR + probe set, frame-graph tasks (`examples/babylon`) |
| `@pmndrs/reflections/pixi` | pixi.js v8 WebGPURenderer adapter (experimental): a small 3-D layer whose materials take pixi Textures, core SSR + probe set on pixi's device, the composite as a pixi `Filter` (`examples/pixi`) |

## Examples

```bash
pnpm install
pnpm assets      # Khronos sample models + two Poly Haven HDRIs into examples/assets/ (not committed)
pnpm examples    # then open http://127.0.0.1:5370/showcase/
```

[`examples/showcase`](examples/showcase/) is the one to open first. Pick a scene (a car concept, a toy car and a chess set on a mirror floor in a studio HDRI, or Sponza with its rough floor swapped for a polished one) and switch the sources on and off: reflection probes (baked per scene, one box per room or region), screen-space reflections, the ray-traced fallback (three-mesh-bvh, built on first use) and the denoiser (denoiser/ffx, when the sibling `Denoiser` repo is checked out). "Off" shows the scene without image-based reflections. The debug views show which source filled each pixel, the screen-space confidence and the raw-versus-denoised split; the panel reads GPU ms per pass. Every other page is listed in [`examples/index.html`](examples/index.html).

## Develop

```bash
pnpm install
pnpm examples    # http://127.0.0.1:5370/probes/
pnpm check       # headless Chrome + WebGPU: every example, validation errors fail the run
pnpm typecheck && pnpm test && pnpm build
```

## Licence

MIT. See [NOTICE](NOTICE) for the three.js and FidelityFX provenance.
