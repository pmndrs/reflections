// The reflections composite for Babylon, as a frame-graph post process (Babylon's own shader system,
// WGSL): the lit colour (specular IBL stripped, ./material.ts) plus core's reflected radiance times
// Babylon's split-sum weight,
//
//   final = lit + amount * mix(brdf.xxx, brdf.yyy, F0) * radiance
//
// with `brdf` Babylon's environment BRDF LUT at (NdotV, perceptual roughness) and the mix its
// height-correlated form (`getReflectanceFromBRDFLookup` with BRDF_V_HEIGHT_CORRELATED, the PBR
// default), so a material reads as Babylon's own IBL would have lit it. `radiance` already holds
// lerp(probes / environment, SSR hit, confidence) from core (see ./ScreenSpaceReflections.ts), so no
// probe maths happens here. Missing vs Babylon's term (D1804): specular AO / horizon occlusion and the
// multi-scatter energy factor.
//
// Debug views (`debugView`): see COMPOSITE_VIEWS.
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Effect } from '@babylonjs/core/Materials/effect.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import type { FrameGraphTextureHandle } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import type { FrameGraphRenderPass } from '@babylonjs/core/FrameGraph/Passes/renderPass.js';
import { FrameGraphPostProcessTask } from '@babylonjs/core/FrameGraph/Tasks/PostProcesses/postProcessTask.js';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore.js';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { ThinCustomPostProcess } from '@babylonjs/core/PostProcesses/thinCustomPostProcess.js';
import { GetEnvironmentBRDFTexture } from '@babylonjs/core/Misc/brdfTextureTools.js';
import type { Scene } from '@babylonjs/core/scene.js';

/** Debug views of the composite, by index. */
export const COMPOSITE_VIEWS = [
  'final', // lit + weight x radiance
  'lit', // Babylon's lit colour as the reflections see it (no specular IBL)
  'reflection', // weight x radiance: what the composite adds
  'radiance', // core's reflected radiance (SSR hit / probes / environment)
  'confidence', // SSR hit confidence
  'hitDistance', // world hit distance / 10
  'normal', // world normal * 0.5 + 0.5
  'roughness', // perceptual roughness
  'f0', // F0 (PREPASS_REFLECTIVITY.rgb)
  'weight', // split-sum weight
  'motion', // linear velocity x 20 + 0.5
] as const;
export type CompositeView = (typeof COMPOSITE_VIEWS)[number];

const NAME = 'reflectionsComposite';
const FRAGMENT_WGSL = /* wgsl */ `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var depthSampler: texture_2d<f32>;
var normalSampler: texture_2d<f32>;
var reflectivitySampler: texture_2d<f32>;
var radianceSampler: texture_2d<f32>;
var confidenceSampler: texture_2d<f32>;
var hitDistanceSampler: texture_2d<f32>;
var velocitySampler: texture_2d<f32>;
var brdfSamplerSampler: sampler;
var brdfSampler: texture_2d<f32>;
uniform invViewProjection: mat4x4f;
uniform cameraPosition: vec3f;
uniform debugView: f32;
uniform amount: f32;
uniform brdfRGBD: f32;
uniform depthInverted: f32;

#define CUSTOM_FRAGMENT_DEFINITIONS
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let size = vec2f(textureDimensions(depthSampler, 0));
  let px = vec2i(clamp(input.vUV * size, vec2f(0.0), size - 1.0));
  let lit = textureSample(textureSampler, textureSamplerSampler, input.vUV);
  let depth = textureLoad(depthSampler, px, 0).x;
  let beforeFar = depth < 1.0;
  let beforeNear = depth > 0.0;
  let geometry = select(beforeFar, beforeNear, uniforms.depthInverted > 0.5);
  let n = normalize(textureLoad(normalSampler, px, 0).xyz * 2.0 - 1.0);
  let refl = textureLoad(reflectivitySampler, px, 0);
  let f0 = refl.rgb;
  let roughness = clamp(1.0 - refl.a, 0.0, 1.0);
  // Babylon's NDC from the post-process uv (row 0 = NDC y -1, as every Babylon render target)
  let clip = uniforms.invViewProjection * vec4f(input.vUV * 2.0 - 1.0, depth, 1.0);
  let P = clip.xyz / clip.w;
  let V = normalize(uniforms.cameraPosition - P);
  let NdotV = clamp(dot(n, V), 1e-4, 1.0);
  var brdf = textureSampleLevel(brdfSampler, brdfSamplerSampler, vec2f(NdotV, roughness), 0.0);
  if (uniforms.brdfRGBD > 0.5) { brdf = vec4f(pow(brdf.rgb, vec3f(2.2)) / max(brdf.a, 1e-4), 1.0); }
  let weight = mix(brdf.xxx, brdf.yyy, f0);
  let radiance = textureLoad(radianceSampler, px, 0);
  let reflection = select(vec3f(0.0), weight * radiance.rgb * uniforms.amount, geometry);
  let view = i32(uniforms.debugView + 0.5);
  var c = lit.rgb + reflection;
  switch view {
    case 1: { c = lit.rgb; }
    case 2: { c = reflection; }
    case 3: { c = select(vec3f(0.0), radiance.rgb, geometry); }
    case 4: { c = vec3f(textureLoad(confidenceSampler, px, 0).x); }
    case 5: { c = vec3f(textureLoad(hitDistanceSampler, px, 0).x / 10.0); }
    case 6: { c = select(vec3f(0.0), n * 0.5 + 0.5, geometry); }
    case 7: { c = select(vec3f(0.0), vec3f(roughness), geometry); }
    case 8: { c = select(vec3f(0.0), f0, geometry); }
    case 9: { c = select(vec3f(0.0), weight, geometry); }
    case 10: { c = vec3f(textureLoad(velocitySampler, px, 0).xy * 20.0 + 0.5, 0.0); }
    default: {}
  }
  fragmentOutputs.color = vec4f(c, 1.0);
}
`;

/**
 * The composite as a frame-graph post-process task. `sourceTexture` is the lit colour; the other
 * inputs are the G-buffer and a FrameGraphReflectionsTask's outputs.
 */
export class FrameGraphReflectionsCompositeTask extends FrameGraphPostProcessTask {
  depthTexture?: FrameGraphTextureHandle;
  worldNormalTexture?: FrameGraphTextureHandle;
  reflectivityTexture?: FrameGraphTextureHandle;
  velocityTexture?: FrameGraphTextureHandle;
  radianceTexture?: FrameGraphTextureHandle;
  confidenceTexture?: FrameGraphTextureHandle;
  hitDistanceTexture?: FrameGraphTextureHandle;
  camera?: Camera;
  /** Index into COMPOSITE_VIEWS. */
  debugView = 0;
  /** 0..1: how much of the reflection term is added. */
  amount = 1;
  declare readonly postProcess: ThinCustomPostProcess;
  private readonly brdf: BaseTexture;
  private readonly invViewProjection = new Matrix();

  constructor(name: string, frameGraph: FrameGraph, scene: Scene) {
    if (!ShaderStore.ShadersStoreWGSL[`${NAME}PixelShader`]) ShaderStore.ShadersStoreWGSL[`${NAME}PixelShader`] = FRAGMENT_WGSL;
    super(name, frameGraph, new ThinCustomPostProcess(name, frameGraph.engine, {
      fragmentShader: NAME,
      shaderLanguage: 1, // WGSL
      uniforms: ['invViewProjection', 'cameraPosition', 'debugView', 'amount', 'brdfRGBD', 'depthInverted'],
      samplers: ['depthSampler', 'normalSampler', 'reflectivitySampler', 'radianceSampler', 'confidenceSampler', 'hitDistanceSampler', 'velocitySampler', 'brdfSampler'],
    }));
    this.brdf = GetEnvironmentBRDFTexture(scene);
    this.postProcess.onBindObservable.add((effect: Effect) => this.bindUniforms(effect));
  }

  override getClassName() { return 'FrameGraphReflectionsCompositeTask'; }

  /** The view by name. */
  setView(view: CompositeView) {
    const i = COMPOSITE_VIEWS.indexOf(view);
    if (i < 0) throw new Error(`FrameGraphReflectionsCompositeTask: unknown view ${view}`);
    this.debugView = i;
  }

  private bindUniforms(effect: Effect) {
    const camera = this.camera!;
    camera.getTransformationMatrix().invertToRef(this.invViewProjection);
    effect.setMatrix('invViewProjection', this.invViewProjection);
    const p: Vector3 = camera.globalPosition;
    effect.setFloat3('cameraPosition', p.x, p.y, p.z);
    effect.setFloat('debugView', this.debugView);
    effect.setFloat('amount', this.amount);
    effect.setFloat('brdfRGBD', this.brdf.isRGBD ? 1 : 0);
    effect.setFloat('depthInverted', this._frameGraph.engine.useReverseDepthBuffer ? 1 : 0);
    effect.setTexture('brdfSampler', this.brdf);
  }

  override record(skipCreationOfDisabledPasses = false): FrameGraphRenderPass {
    const inputs = [this.depthTexture, this.worldNormalTexture, this.reflectivityTexture, this.velocityTexture, this.radianceTexture, this.confidenceTexture, this.hitDistanceTexture];
    if (this.sourceTexture === undefined || inputs.some((h) => h === undefined) || !this.camera) {
      throw new Error(`FrameGraphReflectionsCompositeTask "${this.name}": sourceTexture, depthTexture, worldNormalTexture, reflectivityTexture, velocityTexture, radianceTexture, confidenceTexture, hitDistanceTexture and camera are required`);
    }
    const pass = super.record(skipCreationOfDisabledPasses, undefined, (context) => {
      const effect = this._postProcessDrawWrapper.effect!;
      context.bindTextureHandle(effect, 'depthSampler', this.depthTexture!);
      context.bindTextureHandle(effect, 'normalSampler', this.worldNormalTexture!);
      context.bindTextureHandle(effect, 'reflectivitySampler', this.reflectivityTexture!);
      context.bindTextureHandle(effect, 'velocitySampler', this.velocityTexture!);
      context.bindTextureHandle(effect, 'radianceSampler', this.radianceTexture!);
      context.bindTextureHandle(effect, 'confidenceSampler', this.confidenceTexture!);
      context.bindTextureHandle(effect, 'hitDistanceSampler', this.hitDistanceTexture!);
    });
    pass.addDependencies(inputs as FrameGraphTextureHandle[]);
    return pass;
  }
}
