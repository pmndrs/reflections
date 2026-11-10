// Types for the compare page's optional sources, as examples/vite.config.ts aliases them:
// denoiser/three's ffxReflections (the sibling Denoiser repo) and three-gpu-pathtracer's
// WebGLPathTracer (a sibling checkout). Each resolves to a null stub when its checkout is missing.
declare module '@pmndrs/denoiser-three-ffx' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ffxReflections: ((radiance: any, options: any) => any) | null;
}
declare module 'three-gpu-pathtracer-webgl' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const WebGLPathTracer: (new (renderer: any) => any) | null;
}

/** examples/vite.config.ts: the three-gpu-pathtracer checkout the alias points at ('' when none was found). */
declare const __PATHTRACER_SOURCE__: string;
