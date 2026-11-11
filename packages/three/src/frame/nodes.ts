// TSL nodes for the frame-contract G-buffer (see ./FrameGBuffer.ts). Each is evaluated per material
// at build time, so materials without a channel (basic, custom) get a sensible constant.
import {
  DFGLUT, Fn, ambientOcclusion, emissive, float, materialEnvIntensity, materialMetalness, materialRoughness, normalView, output,
  positionViewDirection, property, roughness, specularColorBlended, specularF90, vec4,
} from 'three/tsl';

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

/** Perceptual roughness: the material's `roughnessNode`, else its scalar × map, else 1. */
export const gbufferRoughness = /*@__PURE__*/ (Fn((builder: Builder) => {
  const m = builder.material;
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
 * so the composite leaves them as lit. Not included (DIVERGES D603): clearcoat's attenuation of the
 * base layer, sheen's energy compensation, iridescence's Fresnel, anisotropy's bent normal,
 * retroreflection, and a per-material `envMap` (the weight is right, the radiance the composite
 * looks up is the scene's).
 */
export const gbufferSpecular = /*@__PURE__*/ (Fn((builder: Builder) => {
  if (!physicalLit(builder)) return vec4(0);
  const m = builder.material;
  const dotNV: N = (normalView as N).dot(positionViewDirection).clamp();
  const dfg: N = (DFGLUT as N)({ roughness, dotNV });
  const single: N = (specularColorBlended as N).mul(dfg.x).add((specularF90 as N).mul(dfg.y));
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
