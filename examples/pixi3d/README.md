# pixi-3d examples

pixi-3d (`@pixi/3d`) is in **closed beta**: it isn't on npm yet, and the beta asks testers to keep its code and builds inside the beta. So this repo never commits or bundles it. These examples run against your own copy of the beta and show a setup notice without it, which is also what CI and a public build get. (The same split as `@pmndrs/upscaler`'s pixi-3d examples.)

## Running them

1. Download the beta's release tarball (`pixi-3d-<version>.tgz`) from the beta repository's releases. The arcade needs `DepthOutputPass` and `MotionVectorPass` (0.1.0-beta.2 with the temporal branch, or later).
2. From the repo root, unpack it into `examples/pixi3d/vendor/` (gitignored):

   ```bash
   mkdir -p examples/pixi3d/vendor
   tar -xzf pixi-3d-*.tgz -C examples/pixi3d/vendor --strip-components=1
   pnpm examples      # http://127.0.0.1:5370/pixi3d/arcade/
   ```

`examples/vite.config.ts` notices `vendor/package.json` and resolves `@pixi/3d` (and `@pixi/3d/extras`) from there; without it each example's `main.ts` is served as `unavailable.ts`, the notice. pixi-3d's one runtime dependency, `meshoptimizer`, is already a devDependency here.

Typecheck against the beta's types with `pnpm exec tsc -p examples/pixi3d`. The root `pnpm typecheck` skips these examples, because CI has no beta. `pnpm check -- --only pixi3d` runs the arcade's GPU checks when `vendor/` exists, and otherwise checks that the notice renders.

| Demo | Shows |
|---|---|
| **arcade** | A neon arcade: pixi `Text` and `Graphics` as `ContainerTexture`s (emissive maps of 3-D planes), a glossy floor, a mirror sphere, a gold torus, a skyline. pixi-3d renders colour, depth (`DepthOutputPass`) and motion (`MotionVectorPass`); `ReflectionsGBufferPass` adds normals and material values; `@pmndrs/reflections/pixi` runs core's screen-space tracer with a probe (six pixi-3d cameras) and the sky as fallback, and a pixi `Filter` composites. SSR / probes / denoise toggles, debug views, a debug inset. |

## How the pieces fit

```ts
import { DepthOutputPass, MotionVectorPass, View3D } from '@pixi/3d';
import { ReflectionsView } from '@pmndrs/reflections/pixi';
import { ReflectionsGBufferPass, reflectiveMaterial } from '../shared/reflections';

const depth = new DepthOutputPass(), motion = new MotionVectorPass(), gbuffer = new ReflectionsGBufferPass();
const view3d = new View3D({ environment: sky, background: sky, toneMapping: 'custom', passes: [depth, motion, gbuffer] });
const reflections = new ReflectionsView({ renderer: app.renderer, width: 960, height: 540, probes });
view3d.setSize(reflections.pixelWidth, reflections.pixelHeight);
// meshes use reflectiveMaterial({ baseColor, roughness, metallic, ... })
app.stage.addChild(reflections);
app.ticker.add(() => {
  app.renderer.render({ container: view3d, target: reflections.colorTarget });
  reflections.render({ depth: depth.texture, motion: motion.texture, gbuffer: gbuffer.texture }, view3d.camera);
}, undefined, UPDATE_PRIORITY.HIGH);
```

`shared/reflections.ts` holds what needs the beta's classes (so it can't live in the published adapter): the G-buffer `Pass3D`, `reflectiveMaterial()` (the specular-free colour bit + the G-buffer opt-in) and `ProbeCapture`. What pixi-3d would need to expose so these go away: [docs/research/pixi3d-needs.md](../../docs/research/pixi3d-needs.md).
