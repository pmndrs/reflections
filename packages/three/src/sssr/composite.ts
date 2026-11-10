// First cut of the hybrid composite (docs/SPEC.md section 5) in TSL on r187: three's lit image
// with its specular image-based term swapped for SSR -> local probes (by coverage) -> environment.
//
// three's PhysicalLightingModel adds `radiance x singleScattering` for the environment, where
// `singleScattering = F0 x DFG.x + DFG.y` (split sum, f90 = 1; F0 mixed from 0.04 and the base
// colour by metalness), and `radiance` is the environment node sampled along the roughness-bent
// reflection vector at three's roughness. So, per pixel,
//
//   probeEnv = mix(environment, probeLocal.rgb, probeLocal.a) x environmentIntensity
//   specular = mix(probeEnv, ssrHit, confidence) = ssrRadiance + (1 - confidence) x probeEnv
//   final    = lit - weight x probeEnv + weight x specular
//            = lit + weight x (ssrRadiance - confidence x probeEnv)
//
// (`ssrRadiance` is already confidence x hit, see ScreenSpaceReflectionsPass.radiance). This only
// needs `lit` and an estimate of what three added, not a specular-free re-render; with confidence
// 0 the result is `lit` exactly. What it gets wrong is in docs/DIVERGES.md D603-D606: the
// subtraction is only as good as our estimate of three's term (geometry roughness, AO maps,
// clearcoat / sheen / iridescence / specular colour are not modelled), hit radiance has no
// specular (scene colour without it, D400), and there is no denoiser here (rule 7), so glossy SSR
// is one noisy sample per quad.
//
// With the ray-traced pass on (ScreenSpaceReflectionsPass `trace`), traced hits arrive here as
// confidence 1 and their shaded radiance, and traced misses / capped rays as confidence 0 (or the
// screen-space value), so the same formula composes them: no RT-specific branch.
import * as THREE from 'three/webgpu';
import {
  DFGLUT, float, getViewPosition, mix, normalize, pmremTexture, reflect, texture, uniform, uv, vec3, vec4,
} from 'three/tsl';
import { sampleReflectionProbesLocal } from '../probes/ReflectionProbesNode';
import type { ReflectionProbes } from '../probes/ReflectionProbes';
import type { ScreenSpaceReflectionsPass } from './ScreenSpaceReflectionsPass';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface ScreenSpaceCompositeOptions {
  /**
   * Probes the scene lights with (`scene.environmentNode = reflectionProbes(probes)`). The composite
   * reads them with `sampleReflectionProbesLocal` and falls back to `environment` by coverage. Only
   * pass probes the lit image used, or the subtraction removes a term that was never added.
   */
  probes?: ReflectionProbes | null;
  /** The environment three lit with (usually `scene.environment`). Null: black. */
  environment?: THREE.Texture | null;
  /** `scene.environmentIntensity` (a number or a node). Default 1. */
  environmentIntensity?: number | N;
  /** The lit image (HDR, linear). Default: the G-buffer's `lit` target (throws if it has none). */
  lit?: N;
  /** Screen uv to composite at. Default `uv()` (a full-screen pass). */
  uv?: N;
}

/** The composite and the terms it is built from, as TSL nodes (all linear HDR). */
export interface ScreenSpaceComposite {
  /** vec4(final, 1). */
  final: N;
  /** three's lit image as rendered (the composite with SSR off). */
  lit: N;
  /** Specular radiance weight (F0 x DFG.x + DFG.y). */
  weight: N;
  /** Probe / environment radiance along the reflection (what three's term is assumed to be). */
  probeSpecular: N;
  /** mix(probeSpecular, ssr hit, confidence). */
  specular: N;
  confidence: N;
  /** SSR radiance (confidence x hit). */
  ssr: N;
  hitDistance: N;
  /** 1 on geometry, 0 on the background. */
  geometry: N;
  /** 0..1: blend SSR in (1, default) or not (0). */
  amount: N;
  /** What the ray-traced pass did per pixel (`ScreenSpaceReflectionsPass.source`, core RT_SOURCE codes); 0 without it. */
  source: N;
}

/**
 * Build the hybrid composite for `ssr`'s G-buffer. Use `final` as a RenderPipeline's output (then
 * apply tone mapping and the output colour space, e.g. `renderOutput(final)`).
 */
export function screenSpaceComposite(ssr: ScreenSpaceReflectionsPass, options: ScreenSpaceCompositeOptions = {}): ScreenSpaceComposite {
  const g = ssr.gbuffer.textures;
  const at = options.uv ?? uv();
  if (!options.lit && !g.lit) throw new Error('screenSpaceComposite: the G-buffer has no lit target (raise maxColorAttachmentBytesPerSample to 36+) and no `lit` was given');
  const lit: N = options.lit ?? texture(g.lit!, at).rgb;
  const nr: N = texture(g.normalRoughness!, at);
  const am: N = texture(g.albedoMetalness!, at);
  const depth: N = texture(g.depth, at).x;
  const inverted = ssr.renderer.reversedDepthBuffer === true;
  const geometry: N = inverted ? depth.greaterThan(0) : depth.lessThan(1);

  const { projectionInverse, cameraWorld, cameraPosition } = ssr.uniforms;
  const viewPosition: N = (getViewPosition as N)(at, depth, projectionInverse);
  const P: N = (cameraWorld as N).mul(vec4(viewPosition, 1)).xyz.toVar();
  const Nw: N = normalize(nr.xyz).toVar();
  const V: N = normalize((cameraPosition as N).sub(P)).toVar();
  // three's shading roughness is clamped to >= 0.0525 (plus geometry roughness, not modelled: D403)
  const roughness: N = float(nr.w).max(0.0525).min(1).toVar();
  const dotNV: N = Nw.dot(V).clamp(1e-4, 1);
  // three's radiance direction: the reflection bent toward the normal by roughness^4 (EnvironmentNode)
  const R: N = mix(reflect(V.negate(), Nw), Nw, roughness.pow(4)).normalize().toVar();

  const dfg: N = (DFGLUT as N)({ roughness, dotNV });
  const F0: N = mix(vec3(0.04), am.rgb, am.w);
  const weight: N = F0.mul(dfg.x).add(dfg.y).toVar();

  const intensity: N = typeof options.environmentIntensity === 'number' || options.environmentIntensity === undefined
    ? uniform(options.environmentIntensity ?? 1) : options.environmentIntensity;
  const environment: N = options.environment ? (pmremTexture as N)(options.environment, R, roughness).rgb : vec3(0);
  let probeSpecular: N = environment;
  if (options.probes) {
    const local: N = sampleReflectionProbesLocal(options.probes, P, R, roughness).toVar();
    probeSpecular = mix(environment, local.rgb, local.a);
  }
  probeSpecular = probeSpecular.mul(intensity).toVar();

  const amount: N = uniform(1);
  const ssrRadiance: N = texture(ssr.radiance, at).rgb;
  const confidence: N = texture(ssr.confidence, at).x.mul(amount).toVar();
  const ssrTerm: N = ssrRadiance.mul(amount);
  const specular: N = ssrTerm.add(confidence.oneMinus().mul(probeSpecular));
  const delta: N = weight.mul(ssrTerm.sub(confidence.mul(probeSpecular)));
  const final: N = vec4(geometry.select(lit.add(delta).max(0), lit), 1);
  return {
    final, lit, weight, probeSpecular, specular, confidence, ssr: ssrRadiance, geometry, amount,
    hitDistance: texture(ssr.hitDistance, at).x,
    source: texture(ssr.source, at).x,
  };
}
