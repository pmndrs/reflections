// `@pmndrs/raytracer` is an optional peer that is not on npm yet (pmndrs/pathtracer is private), so a fresh clone
// cannot install it. core imports it on demand and types it locally (`RaytracerModule` in raytracer.ts); this
// shorthand declaration keeps `tsc` green whether or not the package resolves.
declare module '@pmndrs/raytracer';
