// First cut of the hybrid composite (docs/SPEC.md section 5) in TSL on r187: three's lit image
// with its specular image-based term swapped for SSR -> local probes (by coverage) -> environment.
//
// three's PhysicalLightingModel adds `radiance x singleScattering x specularOcclusion` for the
// environment, where `singleScattering = specularColorBlended x DFG.x + specularF90 x DFG.y` (split
// sum at three's shading roughness), `radiance` is the environment node sampled along the
// roughness-bent reflection vector at that roughness, times `materialEnvIntensity` (the material's
// envMapIntensity when it has an envMap, else scene.environmentIntensity), and the occlusion is
// Lagarde's from the AO map. The G-buffer's `specular` target holds those factors as three computed
// them (W27, D603): rgb = singleScattering (`weight`), a = occlusion x env intensity (`scale`), and
// `shadingRoughness` three's roughness. So, per pixel,
//
//   probeEnv = reflectionProbes lookup (volumes by coverage, then the atlas's environment slot)
//              x scale; without probes, pmremTexture(environment) x scale
//   specular = mix(probeEnv, ssrHit, w) = ssrHit x w + (1 - w) x probeEnv
//   final    = lit - weight x probeEnv + weight x specular
//
// Without that target (a device under 46 bytes per sample, or `specular: false`) the factors are
// estimated as before: weight from F0 = mix(0.04, base, metalness) with f90 = 1 at the G-buffer's
// roughness (max 0.045), scale = environmentIntensity, no occlusion.
//
// with w = confidence (FFX), or, with the depth-aware blend (W22, D2400, default), w raised toward
// the screen-edge fade alone where the probe's box-projected surface lies behind the hit.
//
// (`ssrRadiance` is already confidence x hit, see ScreenSpaceReflectionsPass.radiance). This only
// needs `lit` and an estimate of what three added, not a specular-free re-render; with confidence
// 0 the result is `lit` exactly. What it gets wrong is in docs/DIVERGES.md D603-D606: the
// subtraction is only as good as our copy of three's term (with the G-buffer's `specular` target
// it is three's own weights, D603, a clear coat's base attenuation included, D3512; the coat's own
// layer, sheen / iridescence / anisotropy and per-material
// envMap radiance are still not modelled, nor anything in the estimate path), hit radiance has no
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
  DFGLUT, float, getViewPosition, int, mix, normalize, pmremTexture, reflect, smoothstep, texture, textureSize, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { sampleReflectionProbes, sampleReflectionProbesLocal, sampleReflectionProbesProxyShare } from '../probes/ReflectionProbesNode';
import type { ReflectionProbes } from '../probes/ReflectionProbes';
import { RT_SOURCE, PROBE_LOOKUP_NUDGE_SCALE, PROBE_LOOKUP_NUDGE_BIAS } from '@pmndrs/reflections-core';
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
  /**
   * `scene.environmentIntensity` (a number or a node). Default 1. Used only when the G-buffer has
   * no `specular` target: with it, three's own per-material intensity is in the target.
   */
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
  /**
   * Depth-aware blend (W22, DIVERGES D2400), a float node or uniform in [0, 1]: 1 (default) keeps the
   * probe / environment term off a screen-space or traced hit wherever the probe's box-projected
   * surface lies behind the hit (the probe can't be what the ray sees there), so only the screen-edge
   * fade blends toward it; 0 = FFX's `mix(fallback, hit, confidence)`. Returned as `depthAware`.
   */
  depthAware?: N;
  /**
   * W75 (plan X5, D5080, D5081): composite a half-res reflection upsampled to this size instead of
   * the pass's own targets (`HybridReflections` passes it when `ssr.settings.reflectionResolution` is
   * 'half'). `residual` is the upsampled `specular - (1 - ssrWeight) x SO x probeSpecular` of the
   * half-res samples in rgb and their `ssrWeight` in a, so `specular = residual.rgb + (1 - residual.a)
   * x SO x probeSpecular` with this pixel's own probe term: the probe keeps full-res detail where it
   * is the reflection, and adds none where the hit is. Confidence, hit distance and source are the
   * upsampled ones. The raw / denoised choice was made at half res, so `signal` and `denoised` equal
   * `specular` here.
   */
  upsampled?: {
    residual: THREE.Texture; confidence: THREE.Texture; hitDistance: THREE.Texture; source: THREE.Texture;
    // (W75's `mirror`, X5 step 2's full-res mirror path, was removed by W76: D5084)
  } | null;
}

/** The composite and the terms it is built from, as TSL nodes (all linear HDR). */
export interface ScreenSpaceComposite {
  /** vec4(final, 1). */
  final: N;
  /** three's lit image as rendered (the composite with SSR off). */
  lit: N;
  /** Specular radiance weight: three's single scattering (specularColorBlended x DFG.x + specularF90 x DFG.y), or the F0 estimate. */
  weight: N;
  /** What three multiplied its environment radiance by besides `weight`: specular occlusion x env intensity (G-buffer), or `environmentIntensity`. */
  scale: N;
  /** 1 when `weight` / `scale` / the lookup roughness come from the G-buffer's `specular` target, 0 for the estimate. */
  exact: N;
  /** Probe / environment radiance along the reflection (what three's term is assumed to be). */
  probeSpecular: N;
  /** What is composited: the denoised signal where `denoise` is 1, else `signal`. */
  specular: N;
  /**
   * The raw specular signal the denoiser takes (FFX SSSR's `lerp(fallback, hit, confidence)`):
   * hit x ssrWeight + (1 - ssrWeight) x specularOcclusion x probeSpecular (ssrWeight = confidence
   * with `depthAware` 0). rgb; 0 on the background.
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
  /**
   * The weight the composite gives the SSR / traced hit against the probe / environment term:
   * `confidence` where the probe is consistent with the hit (or `depthAware` is 0), up to the
   * screen-edge fade alone where the probe's surface is behind the hit (D2400).
   */
  ssrWeight: N;
  /** Screen-edge fade of the hit (FFX's vignette, recomputed at the hit along the mirror direction). */
  hitFade: N;
  /** Share of the probe term whose box-projected surface is not behind the hit (0 without probes). */
  probeConsistency: N;
  /** 1 = depth-aware blend on (a uniform unless `options.depthAware` was given). */
  depthAware: N;
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
  // three's own weights when the G-buffer wrote them (D603), else the estimate
  const exact = !!g.specular;
  // three's shading roughness: the G-buffer's copy of it (geometry roughness included, D403), or the
  // material's clamped to three's minimum (r187 getRoughness: >= 0.045)
  const roughness: N = (g.shadingRoughness ? float(texture(g.shadingRoughness, at).x) : float(nr.w).max(0.045).min(1)).toVar();
  const dotNV: N = Nw.dot(V).clamp(1e-4, 1);
  // three's radiance direction: the reflection bent toward the normal by roughness^4 (EnvironmentNode)
  const R: N = mix(reflect(V.negate(), Nw), Nw, roughness.pow(4)).normalize().toVar();

  let weight: N, scale: N;
  if (exact) {
    const sp: N = texture(g.specular!, at);
    weight = sp.rgb.toVar();
    scale = float(sp.a).toVar();
  } else {
    const dfg: N = (DFGLUT as N)({ roughness, dotNV });
    const F0: N = mix(vec3(0.04), am.rgb, am.w);
    weight = F0.mul(dfg.x).add(dfg.y).toVar();
    scale = typeof options.environmentIntensity === 'number' || options.environmentIntensity === undefined
      ? uniform(options.environmentIntensity ?? 1) : options.environmentIntensity;
  }
  let probeSpecular: N;
  let coverage: N = float(0);
  if (options.probes) {
    // the same lookup three lit with (reflectionProbes()): the volumes by coverage, then the atlas's
    // environment slot, not pmremTexture(environment). The two environments differ (capture vs PMREM,
    // and the slot is what the bake saw), and a mismatch shows wherever coverage < 1 (W12, D1501).
    // Coverage alone is a second lookup, compiled only where a debug view reads it.
    // W87 (D5420): P is rebuilt from depth, so a surface lying on a volume's face (a floor probe's box
    // starts at the floor) lands a few 1e-6 m either side of it: the lookup flips between the volume and
    // the environment per pixel (stripes, and a flicker once the jitter moves the error). Three's lit pass
    // has the exact position, inside. Nudge P off the surface by more than the reconstruction error
    // (constants shared with core's radiance fallback, W88 D5440).
    const Pprobe: N = P.add(Nw.mul(viewPosition.length().mul(PROBE_LOOKUP_NUDGE_SCALE).add(PROBE_LOOKUP_NUDGE_BIAS)));
    probeSpecular = (sampleReflectionProbes as N)(options.probes, Pprobe, R, roughness);
    coverage = sampleReflectionProbesLocal(options.probes, Pprobe, R, roughness).a;
  } else {
    probeSpecular = options.environment ? (pmremTexture as N)(options.environment, R, roughness).rgb : vec3(0);
  }
  probeSpecular = probeSpecular.mul(scale).toVar();

  // W75 (X5): the half-res path's upsampled targets
  const up = options.upsampled ?? null;
  const own = { radiance: ssr.radiance, confidence: ssr.confidence, hitDistance: ssr.hitDistance, source: ssr.source };
  const sourceAt = (): N => (!up ? texture(ssr.source, at).x : texture(up.source, at).x);

  // Lagarde 2014 computeSpecOcclusion, a = perceptual^2 (same as core's probeSpecularOcclusion, D66)
  let specularOcclusion: N = float(1);
  if (options.ao) {
    const ao: N = typeof options.ao === 'function' ? float(options.ao(at)) : texture(options.ao, at).x;
    const a: N = roughness.mul(roughness);
    const lagarde: N = dotNV.add(ao).max(0).pow(a.mul(-16).sub(1).exp2()).sub(1).add(ao).clamp(0, 1);
    // W45 (D3551, D4513): a traced miss is a ray that left the scene unblocked: its own visibility
    // (D66: rays carry their occlusion; over the denoiser's samples the lobe's), so Lagarde's guess
    // from the AO would occlude it twice. Untraced pixels (no RT, capped, rougher than the tracer)
    // keep it.
    const tracedMiss: N = sourceAt().add(0.5).floor().equal(RT_SOURCE.tracedMiss);
    specularOcclusion = tracedMiss.select(float(1), lagarde).toVar();
  }

  // final = lit + amount x weight x (specular - probeSpecular): three's own IBL term swapped for ours
  const amount: N = uniform(1);
  const ssrRadiance: N = texture(own.radiance, at).rgb;
  const confidence: N = texture(up ? up.confidence : own.confidence, at).x.toVar();
  const hitDistance: N = texture(up ? up.hitDistance : own.hitDistance, at).x.toVar();

  // Depth-aware blend (W22, DIVERGES D2400). FFX's confidence is one number for two things: the
  // screen-edge fade (vignette: the hit is real but about to leave the screen) and the thickness
  // falloff (how far the ray was behind the depth buffer where the march stopped). FFX blends the
  // fallback in for both. The fallback here is the probe, box-projected onto its proxy volume; where
  // that surface lies behind the hit along the same ray (a reflected object in front of the room's
  // walls), the probe shows what is behind the object: the wall pattern through the reflected sphere
  // in mirrorWall. So: split the fade back out (the vignette at the hit, projected along the mirror
  // direction), and give the thickness part's remainder to the hit for the share of the probe term
  // whose surface is behind it. The screen-edge fade still blends to the probe (D41: no pop when the
  // hit leaves the screen); rejected rays (confidence 0) still take the probe; a probe surface at or
  // in front of the hit (the room's own walls) keeps FFX's blend.
  const depthAware: N = options.depthAware ?? uniform(1);
  const valid: N = hitDistance.greaterThan(0).and(confidence.greaterThan(1e-3));
  const hitP: N = P.add(reflect(V.negate(), Nw).mul(hitDistance));
  const clip: N = (ssr.uniforms.viewProjection as N).mul(vec4(hitP, 1));
  const hitUV: N = clip.xy.div(clip.w.max(1e-6)).mul(0.5).add(0.5);
  const size: N = vec2((textureSize as N)(texture(ssr.confidence), int(0)));
  const edge: N = vec2(size.y.div(size.x), 1).mul(0.05); // FFX ValidateHit: 0.05 x (h / w, 1)
  const border: N = smoothstep(vec2(0), edge, hitUV).mul(smoothstep(vec2(1).sub(edge), vec2(1), hitUV).oneMinus());
  const hitFade: N = valid.select(border.x.mul(border.y), float(0)).toVar();
  const hitThickness: N = confidence.div(hitFade.max(1e-4)).clamp(0, 1);
  // the probe term's share whose surface is nearer than ~the hit (10 % slack for the hit's and the
  // box's error, faded out by 25 %): the probe can be what the ray sees there
  const probeConsistency: N = (options.probes
    ? sampleReflectionProbesProxyShare(options.probes, P, R, hitDistance.mul(1.1), hitDistance.mul(1.25))
    : float(0)).toVar();
  const depthAwareWeight: N = hitFade.mul(hitThickness.oneMinus().mul(probeConsistency).oneMinus());
  const ssrWeight: N = valid.select(mix(confidence, depthAwareWeight.max(confidence), float(depthAware).clamp(0, 1)), confidence).toVar();
  // the tracer stores confidence x hit (black fallback): rescale to the new weight
  const ssrTerm: N = valid.select(ssrRadiance.mul(ssrWeight.div(confidence.max(1e-3))), ssrRadiance);
  const signal: N = geometry.select(ssrTerm.add(ssrWeight.oneMinus().mul(specularOcclusion).mul(probeSpecular)), vec3(0)).toVar();
  const denoise: N = options.denoise ?? uniform(0);
  if (up) {
    // W75: the half-res hit part, upsampled, plus this pixel's own probe part (D5081)
    const residual: N = texture(up.residual, at).toVar();
    const upWeight: N = float(residual.a).clamp(0, 1).toVar();
    const upSpecular: N = residual.rgb.add(upWeight.oneMinus().mul(specularOcclusion).mul(probeSpecular)).toVar();
    const final: N = vec4(geometry.select(lit.add(weight.mul(upSpecular.sub(probeSpecular)).mul(amount)).max(0), lit), 1);
    return {
      final, lit, weight, scale, exact: float(exact ? 1 : 0), probeSpecular, specular: upSpecular, signal: upSpecular, denoised: upSpecular, denoise, specularOcclusion, coverage, roughness: float(nr.w),
      confidence, ssrWeight: upWeight, hitFade, probeConsistency, depthAware, ssr: ssrRadiance, geometry, amount,
      hitDistance,
      source: sourceAt(),
    };
  }
  const denoised: N = options.denoised ? texture(options.denoised, at).rgb : signal;
  const specular: N = options.denoised ? mix(signal, denoised, float(denoise).clamp(0, 1)).toVar() : signal;
  const delta: N = weight.mul(specular.sub(probeSpecular)).mul(amount);
  const final: N = vec4(geometry.select(lit.add(delta).max(0), lit), 1);
  return {
    final, lit, weight, scale, exact: float(exact ? 1 : 0), probeSpecular, specular, signal, denoised, denoise, specularOcclusion, coverage, roughness: float(nr.w),
    confidence, ssrWeight, hitFade, probeConsistency, depthAware, ssr: ssrRadiance, geometry, amount,
    hitDistance,
    source: texture(ssr.source, at).x,
  };
}
