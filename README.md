# @pmndrs/reflections

Reflections for WebGPU. Reflection probes (box-projected, GGX-prefiltered), screen-space reflections and a ray-traced fallback, composed per pixel into one denoised hybrid. The core is engine-agnostic WGSL on a bare `GPUDevice`; three.js `WebGPURenderer` is the first adapter (with Babylon.js and pixi.js adapters experimental).

> Early: the API can still change. Needs three.js r187 or newer and a browser with WebGPU. Docs: https://reflections.docs.pmnd.rs. The plan and its gates are in [docs/SPEC.md](docs/SPEC.md).

## Quick start

### three.js

```ts
import * as THREE from 'three/webgpu';
import { Reflections, createReflectionsRenderer } from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from 'denoiser/ffx'; // optional: steady glossy reflections

const renderer = await createReflectionsRenderer({ canvas }); // a WebGPURenderer with the device limits the passes need
const scene = new THREE.Scene(); // standard / physical materials, scene.environment, a glossy floor...

const reflections = await Reflections.create(renderer, scene, {
  denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }),
});

renderer.setAnimationLoop(() => reflections.render(camera)); // where you called renderer.render(scene, camera)
```

> **The denoiser isn't on npm yet.** `denoiser/ffx` is the [`denoiser`](https://github.com/pmndrs/denoiser) 2.x package; the `denoiser` on npm today is the old 0.0.x and has no `ffx` entry. Until 2.0 is published, build it from that repo (or leave the option out: reflections still work, glossy surfaces are noisier).

`Reflections.create` takes `preset` (`'default'`, or `'performance'` for half-resolution reflections), `probes`, `rayTracing: true` (the ray-traced fallback, needs `@pmndrs/bvh`) and `settings`. A complete page: [`examples/quickstart`](examples/quickstart/). Every piece (`reflections.ssr`, `.hybrid`, `.probes`, `.pipeline`) stays public.

### Probes only

The cheapest path for an existing project: one baked probe and your own `renderer.render()`.

```ts
import { ReflectionProbe, ReflectionProbes, installCubeArraySupport, reflectionProbes } from '@pmndrs/reflections/three';

await installCubeArraySupport(renderer); // r187 cannot bind cube arrays yet
const probes = new ReflectionProbes();
const room = new ReflectionProbe(12, 6, 12); // influence box (width, height, depth)
room.position.set(0, 2.5, 0);                // capture point
probes.add(room);
scene.add(probes);
probes.bake(renderer, scene);
scene.environmentNode = reflectionProbes(probes); // every physical material picks them up
```

### React Three Fiber

React Three Fiber v10 (`@react-three/fiber@alpha`, tested with 10.0.0-alpha.6) renders with `WebGPURenderer`. A small hook wraps `Reflections`:

```tsx
import { Canvas } from '@react-three/fiber';
import { createReflectionsRenderer } from '@pmndrs/reflections/three';
import { useReflections } from './useReflections'; // examples/r3f/src/useReflections.ts, about 30 lines

function Effects() {
  useReflections({ denoiser: (device, { roughnessThreshold }) => new FfxReflectionDenoiser(device, { roughnessThreshold: roughnessThreshold ** 2 }) });
  return null;
}

<Canvas renderer={(defaults) => createReflectionsRenderer({ ...defaults, antialias: false })}>
  <Effects />
  {/* your meshes */}
</Canvas>
```

A complete page: [`examples/r3f`](examples/r3f/).

## Which source to use

| source | what it shows | cost | use it when |
|---|---|---|---|
| Probes | a baked, prefiltered capture of the scene, box-projected, blended by influence volume | one lookup per pixel; no extra passes | rough and distant reflections, mobile, or the floor under everything else. Doesn't follow moving objects. |
| Screen space | what is on screen, traced through a depth pyramid | a G-buffer pass and one trace | mirrors, polished floors and metal with things next to them. Misses what is off screen or hidden. |
| Ray traced | what the screen can't see, from a BVH of the scene | the trace, per missed ray | off-screen and back-facing reflections. Opt-in (`rayTracing`), static meshes at build time. |
| Hybrid + denoiser | all of the above per pixel, the noisy part denoised | the sum | the default when you want reflections that look right and stay still |

### Which materials get reflections

Physically based materials do: `MeshStandardMaterial` and `MeshPhysicalMaterial`, and their node versions. The probes, screen-space reflections and ray-traced fallback all take the place of three's own specular environment term, so they follow each material's roughness, metalness and clearcoat.

`MeshBasicMaterial`, `MeshLambertMaterial` and `MeshPhongMaterial` don't, by design (DIVERGES D2802). They have no physically based specular term to replace, and adding one would make a material that says "not shiny" shiny. A basic material's classic `envMap` and `reflectivity` still render the way three draws them, but SSR and the ray-traced pass don't feed them. If a surface needs reflections, give it a standard material: `roughness` and `metalness` replace Phong's `shininess` and `specular`.

## Probes

The probes are this library's: an engine-agnostic core (GGX prefilter, cube-array / 2D-array / octahedral layouts, a WGSL lookup with box projection and blending) under a three adapter. The adapter keeps the API of Ben Houston's three.js [#35046](https://github.com/mrdoob/three.js/pull/35046); the two were built side by side and have traded ideas and fixes the whole way, so code moves between them. On three r187, which can't bind cube arrays yet, `await installCubeArraySupport(renderer)` (a self-tested runtime port of three.js [#35053](https://github.com/mrdoob/three.js/pull/35053)) lets the adapter store the cubes in a real cube array; without it they live in a 2D array (`layout: 'auto' | 'cube-array' | 'cube2d'`, `bakedLayout` shows which). Extensions over #35046: `sampleReflectionProbes` (use a probe in any shader: a traced ray's miss, a composite, a hit point), `reflectionProbesLocal`, `originOffset`, live/time-sliced `bake`, `bake({ exclude })` (keep moving mirrors out of captures), `bake({ environment: false })`, `seamFix`, and irradiance re-fit.

## Packages

| import | what |
|---|---|
| `@pmndrs/reflections` / `/three` | three.js adapter: `Reflections`, probes, screen-space and hybrid passes, TSL nodes |
| `@pmndrs/reflections/core` | engine-agnostic WebGPU: the probe prefilter, the screen-space tracer, the trace seam, the denoise seam |
| `@pmndrs/reflections/babylon` | Babylon.js WebGPUEngine adapter (experimental): core SSR + probe set, frame-graph tasks (`examples/babylon`) |
| `@pmndrs/reflections/pixi` | pixi.js v8 WebGPURenderer adapter (experimental) for pixi-3d scenes: the frame contract from a `View3D`'s outputs, core SSR + probe set on pixi's device, the composite as a pixi `Filter` (`examples/pixi3d/arcade`). It never imports pixi-3d (closed beta); the example needs the beta unpacked locally ([examples/pixi3d/README.md](examples/pixi3d/README.md)) and shows a setup notice without it |

## Examples

```bash
pnpm install
pnpm assets      # Khronos sample models + two Poly Haven HDRIs into examples/assets/ (not committed)
pnpm examples    # then open http://127.0.0.1:5370/quickstart/
```

[`examples/quickstart`](examples/quickstart/) is the smallest complete page (and `probes.html` beside it, probes only); [`examples/r3f`](examples/r3f/) is the same in React Three Fiber. [`examples/showcase`](examples/showcase/) is the whole pipeline on real assets: pick a scene (a car concept, a toy car and a chess set on a mirror floor in a studio HDRI, or Sponza with a polished floor) and switch the sources on and off: probes, screen-space reflections, the ray-traced fallback and the denoiser, with debug views and GPU ms per pass. Every setting, its default and its cost is in [docs/SETTINGS.md](docs/SETTINGS.md). Every page is listed in [`examples/index.html`](examples/index.html).

## Sibling libraries

- [`denoiser`](https://github.com/pmndrs/denoiser) (2.x, not on npm yet): the temporal reflection denoiser (`denoiser/ffx`) behind the `denoiser` option, and OIDN for path-traced frames.
- [`@pmndrs/upscaler`](https://github.com/pmndrs/upscaler): temporal anti-aliasing and upscaling; at ratio 1 it settles the last shimmer. The showcase runs it after the composite.
- [`@pmndrs/bvh`](https://github.com/pmndrs/bvh): the GPU BVH behind `rayTracing`.
- [`@pmndrs/downsampler`](https://github.com/pmndrs/downsampler): the mip chains and Hi-Z pyramid the tracer uses.
- [`@pmndrs/motion-vectors`](https://github.com/pmndrs/motion-vectors): per-pixel motion for the temporal passes.

## Develop

```bash
pnpm install
pnpm examples    # http://127.0.0.1:5370/quickstart/
pnpm check       # headless Chrome + WebGPU: every example, validation errors fail the run
pnpm typecheck && pnpm test && pnpm build
```

## Licence

MIT. See [NOTICE](NOTICE) for the three.js and FidelityFX provenance.
