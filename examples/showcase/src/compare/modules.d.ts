// Types for the compare page's optional sources, as examples/vite.config.ts aliases them:
// denoiser/three's ffxReflections and the `denoiser` package (OIDN) from the sibling Denoiser repo, and
// three-gpu-pathtracer's WebGPU entry (the copy the Denoiser repo installs). Each resolves to a null stub
// when its checkout is missing.
declare module '@pmndrs/denoiser-three-ffx' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ffxReflections: ((radiance: any, options: any) => any) | null;
}
declare module 'three-gpu-pathtracer-webgpu' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const WebGPUPathTracer: (new (renderer: any) => any) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const RenderToScreenNodeMaterial: (new (params?: any) => any) | null;
}
declare module '@pmndrs/denoiser-oidn' {
  export interface OidnDenoiser {
    readonly device: GPUDevice;
    quality: 'fast' | 'balanced' | 'high';
    readonly runtime: { name: string; lastChoice?: string };
    denoiseTextures(opts: {
      color: GPUTexture; albedo?: GPUTexture; normal?: GPUTexture; hdr?: boolean;
      inputFlipY?: boolean; auxInputFlipY?: boolean; output?: GPUTexture; transfer?: 'linear' | 'srgb' | 'aces-srgb';
    }): Promise<GPUTexture | null | undefined>;
    abort(): void;
    dispose?(): void;
  }
  export const Denoiser: { create(opts: { device?: GPUDevice; tzaUrl?: string; quality?: 'fast' | 'balanced' | 'high'; precision?: 'fp32' | 'fp16' }): Promise<OidnDenoiser> } | null;
}

/** examples/vite.config.ts: the three-gpu-pathtracer package the alias points at ('' when none was found). */
declare const __PATHTRACER_SOURCE__: string;
