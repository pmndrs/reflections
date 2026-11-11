// Stand-in for three-gpu-pathtracer's WebGPUPathTracer when examples/vite.config.ts finds no copy (the
// Denoiser repo's node_modules, or $PATHTRACER_REPO): the showcase compare page then has no path-traced reference.
export const WebGPUPathTracer = null;
export const RenderToScreenNodeMaterial = null;
