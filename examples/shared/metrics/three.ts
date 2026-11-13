// X0 (W70): the three-adapter side of a MetricsHost (./run.ts): the reflection mask from our G-buffer and the
// linear readbacks of HybridReflections' raw signal and denoised output. Used by examples/ssr and the bench's
// ours methods (examples/showcase/src/compare/ours.ts).
import { getGPUTexture, type HybridReflections, type ScreenSpaceReflectionsPass } from '@pmndrs/reflections/three';
import { readTextureFloats, type LinearFrame } from './run';
import { resampleMask, type Mask } from './stats';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * Glossy geometry at display size: G-buffer perceptual roughness (normal.w) < `threshold` (the tracer's, 0.447)
 * on geometry (depth not at the far plane). Reads the last rendered frame's G-buffer (render one first).
 */
export async function gbufferGlossyMask(ssr: ScreenSpaceReflectionsPass, width: number, height: number, threshold = ssr.settings.roughnessThreshold ?? 0.447): Promise<Mask> {
  const t = ssr.gbuffer.gpuTextures();
  const [dep, nr] = await Promise.all([readTextureFloats(ssr.device, t.depth), readTextureFloats(ssr.device, t.normal)]);
  const inv = (ssr.gbuffer as N).conventions.depthInverted;
  const n = dep.width * dep.height, m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = dep.data[i * 4];
    if (inv ? d <= 0 : d >= 1) continue;
    if (nr.data[i * 4 + 3] < threshold) m[i] = 1;
  }
  return resampleMask(m, dep.width, dep.height, width, height);
}

/** The raw signal (the denoiser's input) and the denoised output as linear RGBA floats (render size). */
export function hybridReaders(renderer: N, ssr: ScreenSpaceReflectionsPass, hybrid: HybridReflections) {
  return {
    readSignal: (): Promise<LinearFrame> => readTextureFloats(ssr.device, getGPUTexture(renderer, hybrid.signalTarget.texture)),
    /** Null while the denoiser isn't running (the texture then holds a stale frame). */
    readDenoised: async (): Promise<LinearFrame | null> => (hybrid.denoise && hybrid.denoiser ? readTextureFloats(ssr.device, getGPUTexture(renderer, hybrid.denoised)) : null),
  };
}
