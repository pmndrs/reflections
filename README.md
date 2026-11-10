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

This is the API of three.js [#35046](https://github.com/mrdoob/three.js/pull/35046) (Ben Houston), running on r186, which can't bind cube arrays. It adds `sampleReflectionProbes`, `originOffset`, `bake({ environment: false })` and `seamFix`.

## Packages

| import | what |
|---|---|
| `@pmndrs/reflections` / `/three` | three.js adapter: probes, TSL nodes |
| `@pmndrs/reflections/core` | engine-agnostic WebGPU: the probe prefilter (more per the spec) |

## Develop

```bash
pnpm install
pnpm examples    # http://127.0.0.1:5370/probes/
pnpm check       # headless Chrome + WebGPU: every example, validation errors fail the run
pnpm typecheck && pnpm test && pnpm build
```

## Licence

MIT. See [NOTICE](NOTICE) for the three.js and FidelityFX provenance.
