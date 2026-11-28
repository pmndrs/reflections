// TSL nodes for the frame-contract G-buffer (see ./FrameGBuffer.ts). Each is evaluated per material
// at build time, so materials without a channel (basic, custom) get a sensible constant.
import {
  DFGLUT, F_Schlick, Fn, ambientOcclusion, clearcoat, clearcoatNormalView, clearcoatRoughness, emissive, float, materialEnvIntensity, materialMetalness, materialRoughness, normalView, output,
  positionViewDirection, property, roughness, specularColorBlended, specularF90, vec2, vec3, vec4,
} from 'three/tsl';
import { specularAATracesFiltered, specularAARoughness } from './specularAA';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any; // TSL's node typings are too strict for builder-time branching
interface Builder { material?: N; renderer: N; environmentNode?: N }

/**
 * Lighting without the specular lobe: emissive + direct diffuse + indirect diffuse.
 *
 * three's LightsNode sums `directDiffuse + indirectDiffuse` into a shader property named
 * `totalDiffuse` before adding specular (r186 LightsNode.setup). A PropertyNode is shared by name,
 * so reading `property('vec3', 'totalDiffuse')` in an MRT output gives that sum for the same
 * fragment, with no second render and no patch to the lighting model. Lit materials with no lights
 * leave it at zero, which is what they render (plus emissive) anyway. Materials that don't light
 * (`lights === false`: backgrounds, unlit node materials), basic materials, and materials with a
 * custom `fragmentNode` / `outputNode` write their output colour, which has no specular to remove.
 * Except basic materials with an environment (`envMap` / `envNode`): BasicLightingModel.finish adds
 * the env reflection to the output after `totalDiffuse` (= diffuse colour × AO × light map) is set,
 * and an env map always runs the lighting context, so those take `totalDiffuse` too.
 */
export const sceneColorNoSpecular = /*@__PURE__*/ (Fn((builder: Builder) => {
  const m = builder.material;
  const custom = !m || m.fragmentNode != null || m.outputNode != null;
  // builder.material is the app's material (e.g. a MeshStandardMaterial, which has no `lights`
  // field); its node twin has lights = true. Basic materials have no specular lobe to remove.
  const lighting = builder.renderer.lighting?.enabled !== false;
  const basicWithEnv = m && (m.isMeshBasicMaterial === true || m.isMeshBasicNodeMaterial === true) && (m.envMap != null || m.envNode != null);
  const unlit = custom || m.lights === false || (m.isMeshBasicMaterial === true && !basicWithEnv) || !lighting;
  if (unlit) return (output as N).rgb;
  return (property('vec3', 'totalDiffuse') as N).add(emissive);
}) as N)();

const has = (m: N, key: string) => m != null && typeof m[key] === 'number';

// A node material's roughnessNode / metalnessNode replaces the scalar and map (as in
// MeshStandardNodeMaterial.setupVariants), before three's geometry-roughness adjustment (D403).

/**
 * Perceptual roughness: the material's `roughnessNode`, else its scalar × map, else 1. With variance specular
 * AA on the material (`applySpecularAA`, W105, `traceRoughness: 'filtered'`), that value filtered by the normal's
 * screen-space variance, as three's lit term shades it (without three's 0.045 floor).
 */
export const gbufferRoughness = /*@__PURE__*/ (Fn((builder: Builder) => {
  const m = builder.material;
  if (specularAATracesFiltered(m) && m.fragmentNode == null) return specularAARoughness;
  if (m?.roughnessNode != null) return float(m.roughnessNode);
  return has(m, 'roughness') ? materialRoughness : float(1);
}) as N)();

/** Metalness: the material's `metalnessNode`, else its scalar × map, else 0. */
export const gbufferMetalness = /*@__PURE__*/ (Fn((builder: Builder) => {
  const m = builder.material;
  if (m?.metalnessNode != null) return float(m.metalnessNode);
  return has(m, 'metalness') ? materialMetalness : float(0);
}) as N)();

/**
 * How much of the base layer's specular survives a clear coat, three's `PhysicalLightingModel.finish`:
 * `1 - clearcoat x F_Schlick(0.04, 1, dot(clearcoatNormal, V))` (W41, D3512); 1 without one. Folded
 * into `gbufferSpecular`'s weight, so the composite swaps the base layer's term at the weight three gave
 * it, not more (the full weight over-subtracted carConcept's red paint to black / cyan at grazing angles).
 */
function clearcoatBaseScale(builder: Builder): N {
  const m = builder.material;
  const coated = m != null && ((typeof m.clearcoat === 'number' && m.clearcoat > 0) || m.clearcoatNode != null);
  if (!coated) return float(1);
  const dotNVcc: N = (clearcoatNormalView as N).dot(positionViewDirection).clamp();
  const Fcc: N = (F_Schlick as N)({ dotVH: dotNVcc, f0: vec3(0.04), f90: float(1) }).x;
  return float(1).sub((clearcoat as N).mul(Fcc));
}

/**
 * Materials whose lit colour carries three's physical environment specular (MeshStandard /
 * MeshPhysical and their node twins, lit, no custom fragment or output node).
 */
function physicalLit(builder: Builder) {
  const m = builder.material;
  if (!m || m.fragmentNode != null || m.outputNode != null || m.lights === false) return false;
  if (builder.renderer.lighting?.enabled === false) return false;
  return m.isMeshStandardMaterial === true || m.isMeshStandardNodeMaterial === true;
}

/**
 * three's environment specular term, per pixel, as its PhysicalLightingModel adds it (r187
 * `indirectSpecular` + `ambientOcclusion`): `radiance x singleScattering x specularOcclusion`, with
 * `radiance = env(R, roughness) x materialEnvIntensity` and
 * `singleScattering = specularColorBlended x DFG.x + specularF90 x DFG.y` (DFG at three's
 * `roughness` and dot(N, V)). The shader properties are three's own, read in the same MRT render
 * (like `totalDiffuse` above), so specularIntensity / specularColor / ior (F0 and F90), the
 * geometry-adjusted roughness, the AO map's (or `aoNode`'s, or a context `getAO`'s) specular
 * occlusion and the env intensity are three's exact values, not re-derived per material.
 *
 * rgb = singleScattering (the radiance weight: what a reflection hit should be multiplied by);
 * a = specularOcclusion x materialEnvIntensity (what three's environment radiance was multiplied by
 * besides that weight; 0 where the material has no environment). Materials without three's physical
 * lighting (basic, phong, lambert, unlit, custom output) write 0: their lit image has no such term,
 * so the composite leaves them as lit. rgb includes a clear coat's attenuation of the base layer
 * (W41, D3512); the coat's own layer is not swapped. Not included (DIVERGES D603): sheen's energy compensation, iridescence's Fresnel, anisotropy's bent normal,
 * retroreflection, and a per-material `envMap` (the weight is right, the radiance the composite
 * looks up is the scene's).
 */
export const gbufferSpecular = /*@__PURE__*/ (Fn((builder: Builder) => {
  if (!physicalLit(builder)) return vec4(0);
  const m = builder.material;
  const dotNV: N = (normalView as N).dot(positionViewDirection).clamp();
  const dfg: N = (DFGLUT as N)({ roughness, dotNV });
  const single: N = (specularColorBlended as N).mul(dfg.x).add((specularF90 as N).mul(dfg.y)).mul(clearcoatBaseScale(builder));
  const hasEnvironment = m.envNode != null || m.envMap != null || builder.environmentNode != null;
  if (!hasEnvironment) return vec4(single, 0);
  // PhysicalLightingModel.ambientOcclusion: Lagarde's specular occlusion at three's roughness
  const ao: N = ambientOcclusion;
  const aoExp: N = (roughness as N).mul(-16).oneMinus().negate().exp2();
  const occlusion: N = ao.sub(dotNV.add(ao).pow(aoExp).oneMinus()).clamp();
  return vec4(single, occlusion.mul(materialEnvIntensity));
}) as N)();

/** three's shading roughness (`roughness`: the material's, raised by geometry roughness, >= 0.045), D403. */
export const gbufferShadingRoughness = /*@__PURE__*/ (Fn((builder: Builder) => (physicalLit(builder) ? float(roughness) : gbufferRoughness)) as N)();

/**
 * The clear coat layer for a screen-space hit's re-shade (W44, D3541): three's `clearcoat` factor and
 * `clearcoatRoughness` (perceptual, after three's geometry adjustment) of a lit physical material with
 * a clear coat; 0 for everything else.
 */
export const gbufferClearcoat = /*@__PURE__*/ (Fn((builder: Builder) => {
  const m = builder.material;
  const coated = m != null && ((typeof m.clearcoat === 'number' && m.clearcoat > 0) || m.clearcoatNode != null);
  if (!coated || !physicalLit(builder)) return vec2(0);
  return vec2(clearcoat as N, clearcoatRoughness as N);
}) as N)();
