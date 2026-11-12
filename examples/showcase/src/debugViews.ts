// Debug views of the hybrid composite, shared by the showcase (main.ts) and the tuning bench (compare/ours.ts).
// One TSL graph per view; the page picks one with a uniform index (`uView`).
import { abs, dFdx, dFdy, exp, float, max, mix, texture, uv, vec3, vec4 } from 'three/tsl';
import { HybridReflections, type ScreenSpaceReflectionsPass } from '@pmndrs/reflections/three';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

export const VIEWS = {
  final: 'Final (hybrid)',
  split: 'Raw | denoised',
  off: 'Reflections off',
  ibl: 'Probes / environment only',
  reflections: 'Reflection term only',
  source: 'Source per pixel',
  rtSource: 'Ray-traced pass per pixel',
  confidence: 'Screen-space confidence',
  ssrWeight: 'Hit weight vs probe (depth-aware blend)',
  hitDistance: 'Hit distance',
  hitRadiance: 'Hit radiance (tracer, x confidence)',
  signal: 'Raw signal (denoiser input)',
  specular: 'Specular radiance (composited, unweighted)',
  denoiseDelta: 'Denoiser change |denoised - raw| (x4)',
  probeSpecular: 'Probe / environment radiance (subtracted)',
  ao: 'AO input (GTAO, for specular occlusion)',
  specularOcclusion: 'Specular occlusion factor (1 = none)',
  traced: 'Traced pixels (the miss list, RT on)',
  depth: 'Depth (view distance, banded)',
  depthEdges: 'Depth edges (screen derivative)',
  normals: 'G-buffer normals (world)',
  roughness: 'G-buffer roughness (tracer / denoiser)',
  shadingRoughness: "three's shading roughness (composite lookup)",
} as const;
export type View = keyof typeof VIEWS;
export const VIEW_IDS = Object.keys(VIEWS) as View[];
/** Views that are a tone-mapped image: the upscaler takes them linear and tone-maps after itself. */
export const LINEAR_VIEWS: View[] = ['final', 'split', 'off', 'ibl', 'reflections'];

export const VIEW_LEGENDS: Partial<Record<View, [string, string][]>> = {
  source: [['#26d940', 'screen-space hit'], ['#3373ff', 'ray-traced hit'], ['#ff8c1a', 'probe'], ['#d933d9', 'environment'], ['#595959', 'rough: probe / environment only']],
  rtSource: [['#3366ff', 'ray-traced hit'], ['#33e6f2', 'ray-traced, colour from screen'], ['#f233d9', 'ray-traced miss'], ['#ff8c1a', 'over the ray budget'], ['#26d940', 'screen-space hit'], ['#d99926', 'probe (grey: environment)']],
};

export interface DebugViewInputs {
  /** The hybrid composite (`hybrid.composite()`). */
  c: ReturnType<HybridReflections['composite']>;
  ssr: ScreenSpaceReflectionsPass;
  /** Tone-map to display (AgX / ... + sRGB), rgb. */
  tone: (x: N) => N;
  /** Tone-mapped image views: linear while the upscaler runs (it tone-maps after), else `tone`. */
  T: (x: N) => N;
  roughnessThreshold: N;
  /** 1 = probes on (rtSource's fallback colour). */
  probesOn: N;
  /** GTAO sample, when the page runs it. */
  ao?: ((u: N) => N) | null;
}

export function buildDebugViews({ c, ssr, tone, T, roughnessThreshold, probesOn, ao }: DebugViewInputs): Record<View, N> {
  const g = ssr.gbuffer.textures;
  const at: N = uv();
  const off: N = c.geometry.select(c.lit.sub(c.weight.mul(c.probeSpecular)).max(0), c.lit);
  const raw: N = c.geometry.select(c.lit.add(c.weight.mul(c.signal.sub(c.probeSpecular)).mul(c.amount)).max(0), c.lit);
  const dim: N = tone(off).mul(0.25);
  const onGeo = (x: N): N => c.geometry.select(x, vec3(0));
  // view-space distance from the hardware depth (reverse-Z or not: the inverse projection handles both)
  const depth: N = texture(g.depth, at).x;
  const ndc: N = vec4(at.x.mul(2).sub(1), at.y.mul(-2).add(1), depth, 1);
  const vp: N = (ssr.uniforms.projectionInverse as N).mul(ndc);
  const dist: N = vp.xyz.div(vp.w).length().toVar();
  return {
    final: T(c.final.rgb),
    split: at.x.sub(0.5).abs().lessThan(0.0008).select(vec3(1), at.x.lessThan(0.5).select(T(raw), T(c.final.rgb))),
    off: T(off),
    ibl: T(c.lit),
    reflections: T(c.specular.mul(c.weight).mul(c.amount)),
    // SSR green, traced blue, probe orange, environment magenta, rough (probe/env, untraced) grey
    source: onGeo(dim.add(HybridReflections.sourceColor(c, roughnessThreshold).mul(0.75))),
    rtSource: (() => {
      // traced hit blue, traced hit coloured from the screen cyan, traced miss magenta, capped
      // orange; untouched: SSR hit green (by confidence), else probe amber / environment grey
      const src: N = c.source.add(0.5).floor();
      const fallback: N = probesOn.equal(1).select(vec3(0.85, 0.6, 0.15), vec3(0.4));
      const ssrHit: N = mix(fallback, vec3(0.15, 0.85, 0.25), c.confidence.clamp(0, 1));
      const col: N = src.equal(1).select(vec3(0.2, 0.4, 1), src.equal(4).select(vec3(0.2, 0.9, 0.95),
        src.equal(2).select(vec3(0.95, 0.2, 0.85), src.equal(3).select(vec3(1, 0.55, 0.1), ssrHit))));
      return onGeo(dim.add(col.mul(0.75)));
    })(),
    confidence: c.geometry.select(vec3(c.confidence), vec3(0.02, 0.03, 0.08)),
    ssrWeight: c.geometry.select(vec3(c.ssrWeight), vec3(0.02, 0.03, 0.08)),
    hitDistance: (() => { const d: N = c.hitDistance; return d.greaterThan(0).select((vec3(1, 0.8, 0.5) as N).mul(d.div(d.add(2))), vec3(0)); })(),
    hitRadiance: onGeo(tone(c.ssr)),
    signal: onGeo(tone(c.signal)),
    specular: onGeo(tone(c.specular)),
    // where the denoiser moved energy: brighter = bigger change; red = it added light, blue = it took light away
    denoiseDelta: (() => {
      const d: N = c.specular.sub(c.signal).mul(c.weight);
      const lum = (x: N): N => x.dot(vec3(0.2126, 0.7152, 0.0722));
      const m: N = abs(lum(d)).mul(4);
      return onGeo(lum(d).greaterThan(0).select(vec3(1, 0.25, 0.1), vec3(0.15, 0.45, 1)).mul(m.div(m.add(0.25))));
    })(),
    probeSpecular: onGeo(tone(c.probeSpecular)),
    ao: ao ? onGeo(vec3(ao(at))) : vec3(0),
    specularOcclusion: onGeo(vec3(c.specularOcclusion)),
    // W38: the pixels the ray-traced pass traced (SSR's miss list, after the tile cap): red where the
    // ray hit the scene, magenta where it missed (or was capped); RT on only
    traced: (() => {
      const src: N = c.source.add(0.5).floor();
      return c.geometry.not().or(src.lessThan(1)).select(vec3(0), src.equal(1).or(src.equal(4)).select(vec3(1, 0, 0), vec3(1, 0, 1)));
    })(),
    // grey ramp by distance with 1 m bands, so a step in the depth target reads as a broken band
    depth: onGeo(vec3(exp(dist.div(-12)).mul(0.85).add(dist.fract().lessThan(0.04).select(float(0.15), float(0))))),
    // relative depth step to the neighbour pixel: silhouettes white; a soft or doubled edge here is the depth pass
    depthEdges: (() => {
      const e: N = max(abs(dFdx(dist)), abs(dFdy(dist))).div(dist.max(1e-3)).mul(40);
      return onGeo(vec3(e.clamp(0, 1)));
    })(),
    normals: onGeo(texture(g.normalRoughness!, at).xyz.mul(0.5).add(0.5)),
    roughness: onGeo(vec3(c.roughness)),
    shadingRoughness: g.shadingRoughness ? onGeo(vec3(texture(g.shadingRoughness, at).x)) : vec3(0),
  };
}
