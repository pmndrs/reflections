// The reflections composite as a pixi Filter (WGSL, pixi's own filter pipeline): put it on any
// display object that shows the view (a ReflectionsView does it for you, ./ReflectionsView.ts), and
// pixi runs it like a blur or a colour matrix, alongside the user's other filters.
//
//   final = lit + amount * (F0 * A + B) * radiance        (geometry pixels; the sky passes through)
//
// `lit` is the view's colour (pixi-3d with REFLECTIONS_SCENE_COLOR_BIT: no environment specular), `radiance` core's lerp(probes / environment,
// SSR hit, confidence) (./ScreenSpaceReflections.ts), F0 = mix(0.04, albedo, metalness), and (A, B)
// the split-sum environment BRDF. Core exports no DFG term and pixi-3d's BRDF table isn't reachable
// from a Filter, so the adapter uses Karis' analytic fit (D2004). The result is exposed, tone-mapped (ACES fit) and
// sRGB-encoded for pixi's 8-bit canvas: the filter is the view's "present" step.
//
// The filter samples the frame by the position inside the filtered object's bounds (the
// vertex attribute pixi feeds every filter), not by its input texture: pixi renders a filter's input
// into an 8-bit texture, which would clip the HDR colour. So the object must be an unrotated
// rectangle showing the whole view (a Sprite of the view's colour target, scaled freely), D2005.
import { Filter, GpuProgram, type Texture } from 'pixi.js';

/** Debug views, by index. */
export const REFLECTION_VIEWS = [
  'final', // lit + weight x radiance
  'lit', // the view's colour (no environment specular)
  'reflection', // weight x radiance: what the composite adds
  'radiance', // core's reflected radiance (SSR hit / probes / environment)
  'confidence', // SSR hit confidence
  'hitDistance', // world hit distance / 10
  'normal', // world normal * 0.5 + 0.5
  'roughness', // perceptual roughness
  'metalness',
  'albedo',
  'weight', // split-sum weight
  'motion', // uv motion x 50 + 0.5
] as const;
export type ReflectionViewName = (typeof REFLECTION_VIEWS)[number];

const WGSL = /* wgsl */ `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};
struct CompositeUniforms {
  uView: f32,
  uAmount: f32,
  uExposure: f32,
  uTonemap: f32,
};
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> compositeUniforms: CompositeUniforms;
@group(1) @binding(1) var uSceneColor: texture_2d<f32>;
@group(1) @binding(2) var uNormal: texture_2d<f32>;
@group(1) @binding(3) var uMaterial: texture_2d<f32>;
@group(1) @binding(4) var uMotion: texture_2d<f32>;
@group(1) @binding(5) var uReflection: texture_2d<f32>;
@group(1) @binding(6) var uAux: texture_2d<f32>;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) local: vec2<f32>,
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  // aPosition runs 0..1 across the filter's bounds: the filtered object's rectangle
  return VSOutput(vec4(position, 0.0, 1.0), aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw), aPosition);
}

// Karis, "Physically Based Shading on Mobile" (2014): analytic split-sum environment BRDF.
fn envBRDF(NdotV: f32, roughness: f32) -> vec2f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  return vec2f(-1.04, 1.04) * a004 + r.zw;
}

// Narkowicz's ACES fit.
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn linearToSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>, @location(1) local: vec2<f32>) -> @location(0) vec4<f32> {
  let size = vec2f(textureDimensions(uSceneColor));
  let px = vec2i(clamp(local * size, vec2f(0.0), size - 1.0));
  let lit = textureLoad(uSceneColor, px, 0).rgb;
  let nr = textureLoad(uNormal, px, 0);
  let mat = textureLoad(uMaterial, px, 0);
  let mo = textureLoad(uMotion, px, 0);
  let refl = textureLoad(uReflection, px, 0);
  let aux = textureLoad(uAux, px, 0);
  let geometry = mo.w > 0.5;
  let roughness = nr.w;
  let F0 = mix(vec3f(0.04), mat.rgb, mat.a);
  let ab = envBRDF(mo.z, roughness);
  let weight = F0 * ab.x + ab.y;
  let reflection = select(vec3f(0.0), weight * refl.rgb * compositeUniforms.uAmount, geometry);
  var c = lit + reflection;
  var hdr = true;
  switch i32(compositeUniforms.uView + 0.5) {
    case 1: { c = lit; }
    case 2: { c = reflection; }
    case 3: { c = select(vec3f(0.0), refl.rgb, geometry); }
    case 4: { c = vec3f(refl.a); hdr = false; }
    case 5: { c = vec3f(aux.r / 10.0); hdr = false; }
    case 6: { c = select(vec3f(0.0), nr.xyz * 0.5 + 0.5, geometry); hdr = false; }
    case 7: { c = select(vec3f(0.0), vec3f(roughness), geometry); hdr = false; }
    case 8: { c = select(vec3f(0.0), vec3f(mat.a), geometry); hdr = false; }
    case 9: { c = select(vec3f(0.0), mat.rgb, geometry); hdr = false; }
    case 10: { c = select(vec3f(0.0), weight, geometry); hdr = false; }
    case 11: { c = vec3f(mo.xy * 50.0 + 0.5, 0.0); hdr = false; }
    default: {}
  }
  // data views show raw values; radiance views are exposed, tone-mapped and sRGB-encoded
  if (!hdr) { return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0); }
  if (compositeUniforms.uTonemap > 0.5) { c = aces(c * compositeUniforms.uExposure); }
  return vec4f(linearToSrgb(clamp(c, vec3f(0.0), vec3f(1.0))), 1.0);
}
`;

/** The textures the composite reads (a ReflectionsView's G-buffer and SSR outputs). */
export interface ReflectionsFilterSources {
  sceneColor: Texture;
  normal: Texture;
  material: Texture;
  motion: Texture;
  reflection: Texture;
  aux: Texture;
}

export interface ReflectionsFilterOptions {
  view?: ReflectionViewName;
  /** 0..1: how much of the reflection term is added. Default 1. */
  amount?: number;
  /** Exposure before tone mapping. Default 1. */
  exposure?: number;
  /** ACES tone mapping (off: clamp). Default true. */
  toneMapping?: boolean;
}

export class ReflectionsFilter extends Filter {
  constructor(sources: ReflectionsFilterSources, options: ReflectionsFilterOptions = {}) {
    super({
      gpuProgram: GpuProgram.from({
        name: 'reflections-composite',
        vertex: { source: WGSL, entryPoint: 'mainVertex' },
        fragment: { source: WGSL, entryPoint: 'mainFragment' },
      }),
      resources: {
        compositeUniforms: {
          uView: { value: REFLECTION_VIEWS.indexOf(options.view ?? 'final'), type: 'f32' },
          uAmount: { value: options.amount ?? 1, type: 'f32' },
          uExposure: { value: options.exposure ?? 1, type: 'f32' },
          uTonemap: { value: options.toneMapping === false ? 0 : 1, type: 'f32' },
        },
        ...ReflectionsFilter.textureResources(sources),
      },
      // the composite maps 0..1 over the object's own rectangle: no padding, never clipped to the screen
      padding: 0,
      clipToViewport: false,
      resolution: 'inherit',
      antialias: 'off',
    });
  }

  private static textureResources(s: ReflectionsFilterSources) {
    return {
      uSceneColor: s.sceneColor.source, uNormal: s.normal.source, uMaterial: s.material.source,
      uMotion: s.motion.source, uReflection: s.reflection.source, uAux: s.aux.source,
    };
  }

  /** Re-points the filter at new textures (after the view resized). */
  setSources(sources: ReflectionsFilterSources) {
    Object.assign(this.resources, ReflectionsFilter.textureResources(sources));
  }

  private get u() { return this.resources.compositeUniforms.uniforms as { uView: number; uAmount: number; uExposure: number; uTonemap: number }; }

  get view(): ReflectionViewName { return REFLECTION_VIEWS[Math.round(this.u.uView)] ?? 'final'; }
  set view(v: ReflectionViewName) {
    const i = REFLECTION_VIEWS.indexOf(v);
    if (i < 0) throw new Error(`ReflectionsFilter: unknown view ${v}`);
    this.u.uView = i;
  }
  get amount() { return this.u.uAmount; }
  set amount(v: number) { this.u.uAmount = v; }
  get exposure() { return this.u.uExposure; }
  set exposure(v: number) { this.u.uExposure = v; }
  get toneMapping() { return this.u.uTonemap > 0.5; }
  set toneMapping(on: boolean) { this.u.uTonemap = on ? 1 : 0; }
}
