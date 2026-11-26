// Types for the compare page's three-gpu-pathtracer WebGPU entry, as examples/vite.config.ts aliases it (a null stub when
// its package is missing).
declare module 'three-gpu-pathtracer-webgpu' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const WebGPUPathTracer: (new (renderer: any) => any) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const RenderToScreenNodeMaterial: (new (params?: any) => any) | null;
}
/** examples/vite.config.ts: the three-gpu-pathtracer package the alias points at ('' when none was found). */
declare const __PATHTRACER_SOURCE__: string;
