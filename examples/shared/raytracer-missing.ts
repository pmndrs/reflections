// Stand-in for `@pmndrs/raytracer` when examples/vite.config.ts finds no sibling pathtracer checkout
// (it is not on npm yet): the pages hide the raytracer provider option (`__RAYTRACER_AVAILABLE__` is false).
// Core's `createRaytracerTraceProvider` throws this on use, which only happens if the option was forced.
throw new Error('@pmndrs/raytracer is not installed (not on npm yet): clone pmndrs/pathtracer next to this repo or set RAYTRACER_REPO');
