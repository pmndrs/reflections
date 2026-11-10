// First cut of the hybrid composite (docs/SPEC.md section 5) in TSL on r187: three's lit image
// with its specular image-based term swapped for SSR -> local probes (by coverage) -> environment.
//
// three's PhysicalLightingModel adds `radiance x singleScattering` for the environment, where
// `singleScattering = F0 x DFG.x + DFG.y` (split sum, f90 = 1; F0 mixed from 0.04 and the base
// colour by metalness), and `radiance` is the environment node sampled along the roughness-bent
// reflection vector at three's roughness. So, per pixel,
//
//   probeEnv = reflectionProbes lookup (volumes by coverage, then the atlas's environment slot)
//              x environmentIntensity; without probes, pmremTexture(environment) x intensity
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
// Phase 5 (HybridReflections, ./HybridReflections.ts): `specular` above is also the signal the
// denoise seam takes (FFX SSSR's lerp(fallback, hit, confidence)), with Lagarde's specular
// occlusion from an optional AO input on the probe part; where the denoiser ran, the composite
// uses its output instead: final = lit + weight x (denoised - probeEnv).
//
// With the ray-traced pass on (ScreenSpaceReflectionsPass `trace`), traced hits arrive here as
// confidence 1 and their shaded radiance, and traced misses / capped rays as confidence 0 (or the
// screen-space value), so the same formula composes them: no RT-specific branch.
import * as THREE from 'three/webgpu';
import {
  DFGLUT, float, getViewPosition, mix, normalize, pmremTexture, reflect, texture, uniform, uv, vec3, vec4,
} from 'three/tsl';
import { sampleReflectionProbes, sampleReflectionProbesLocal } from '../probes/ReflectionProbesNode';
import type { ReflectionProbes } from '../probes/ReflectionProbes';
import type { ScreenSpaceReflectionsPass } from './ScreenSpaceReflectionsPass';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface ScreenSpaceCompositeOptions {
  /**
   * Probes the scene lights with (`scene.environmentNode = reflectionProbes(probes)`). The composite
   * reads them with the same lookup (`sampleReflectionProbes`: volumes by coverage, then the atlas's
   * environment slot), so its estimate of three's term matches it outside the volumes too. Only
   * pass probes the lit image used, or the subtraction removes a term that was never added.
   */
  probes?: ReflectionProbes | null;
  /**
   * The environment three lit with (usually `scene.environment`), used only without `probes` (with
   * probes, the atlas's environment slot stands in for it, as in three's lit term). Null: black.
   */
  environment?: THREE.Texture | null;
  /** `scene.environmentIntensity` (a number or a node). Default 1. */
  environmentIntensity?: number | N;
  /** The lit image (HDR, linear). Default: the G-buffer's `lit` target (throws if it has none). */
  lit?: N;
  /** Screen uv to composite at. Default `uv()` (a full-screen pass). */
  uv?: N;
  /**
   * Ambient occlusion in [0, 1] (1 = open) for Lagarde's specular occlusion on the probe /
   * environment part (SSR and traced hits carry their own occlusion, D66): a texture (sampled at
   * the composite uv, .r) or a function of the uv returning a float node. None: no occlusion.
   */
  ao?: THREE.Texture | ((uv: N) => N) | null;
  /**
   * The denoised specular radiance (rgba16float, render size), e.g. `HybridReflections.denoised`.
   * Used where `denoise` is 1; the raw signal elsewhere.
   */
  denoised?: THREE.Texture | null;
  /** Float node or uniform: 1 = composite `denoised`, 0 = the raw signal. Default a uniform(0) (returned as `denoise`). */
  denoise?: N;
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
  /** What is composited: the denoised signal where `denoise` is 1, else `signal`. */
  specular: N;
  /**
   * The raw specular signal the denoiser takes (FFX SSSR's `lerp(fallback, hit, confidence)`):
   * ssr + (1 - confidence) x specularOcclusion x probeSpecular. rgb; 0 on the background.
   */
  signal: N;
  /** The denoised radiance as sampled (rgb; the raw signal when no `denoised` texture was given). */
  denoised: N;
  /** 1 = composite the denoised radiance (a uniform unless `options.denoise` was given). */
  denoise: N;
  /** Lagarde's specular occlusion from `ao` (1 without it). */
  specularOcclusion: N;
  /** Local probe coverage in [0, 1] (0 without probes): the probe vs environment split of `probeSpecular`. */
  coverage: N;
  /** Perceptual roughness from the G-buffer. */
  roughness: N;
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
  let probeSpecular: N;
  let coverage: N = float(0);
  if (options.probes) {
    // the same lookup three lit with (reflectionProbes()): the volumes by coverage, then the atlas's
    // environment slot, not pmremTexture(environment). The two environments differ (capture vs PMREM,
    // and the slot is what the bake saw), and a mismatch shows wherever coverage < 1 (W12, D1501).
    // Coverage alone is a second lookup, compiled only where a debug view reads it.
    probeSpecular = (sampleReflectionProbes as N)(options.probes, P, R, roughness);
    coverage = sampleReflectionProbesLocal(options.probes, P, R, roughness).a;
  } else {
    probeSpecular = options.environment ? (pmremTexture as N)(options.environment, R, roughness).rgb : vec3(0);
  }
  probeSpecular = probeSpecular.mul(intensity).toVar();

  // Lagarde 2014 computeSpecOcclusion, a = perceptual^2 (same as core's probeSpecularOcclusion, D66)
  let specularOcclusion: N = float(1);
  if (options.ao) {
    const ao: N = typeof options.ao === 'function' ? float(options.ao(at)) : texture(options.ao, at).x;
    const a: N = roughness.mul(roughness);
    specularOcclusion = dotNV.add(ao).max(0).pow(a.mul(-16).sub(1).exp2()).sub(1).add(ao).clamp(0, 1).toVar();
  }

  // final = lit + amount x weight x (specular - probeSpecular): three's own IBL term swapped for ours
  const amount: N = uniform(1);
  const ssrRadiance: N = texture(ssr.radiance, at).rgb;
  const confidence: N = texture(ssr.confidence, at).x.toVar();
  const signal: N = geometry.select(ssrRadiance.add(confidence.oneMinus().mul(specularOcclusion).mul(probeSpecular)), vec3(0)).toVar();
  const denoise: N = options.denoise ?? uniform(0);
  const denoised: N = options.denoised ? texture(options.denoised, at).rgb : signal;
  const specular: N = options.denoised ? mix(signal, denoised, float(denoise).clamp(0, 1)).toVar() : signal;
  const delta: N = weight.mul(specular.sub(probeSpecular)).mul(amount);
  const final: N = vec4(geometry.select(lit.add(delta).max(0), lit), 1);
  return {
    final, lit, weight, probeSpecular, specular, signal, denoised, denoise, specularOcclusion, coverage, roughness: float(nr.w),
    confidence, ssr: ssrRadiance, geometry, amount,
    hitDistance: texture(ssr.hitDistance, at).x,
    source: texture(ssr.source, at).x,
  };
}
