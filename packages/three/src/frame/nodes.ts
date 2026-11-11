// TSL nodes for the frame-contract G-buffer (see ./FrameGBuffer.ts). Each is evaluated per material
// at build time, so materials without a channel (basic, custom) get a sensible constant.
import { F_Schlick, Fn, clearcoat, clearcoatNormalView, emissive, float, materialMetalness, materialRoughness, output, positionViewDirection, property, vec3 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any; // TSL's node typings are too strict for builder-time branching
interface Builder { material?: N; renderer: N }

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
 * How much of the base layer's specular survives the clear coat, three's `PhysicalLightingModel.finish`:
 * `1 - clearcoat x F_Schlick(0.04, 1, dot(clearcoatNormal, V))` (W27, D2702). The composite scales its
 * estimate of three's specular IBL term by it, so it swaps the base layer's term at the weight three
 * gave it, not more (which over-subtracted red car paint to black / cyan at grazing angles).
 * 1 for materials without a clear coat. Transparent (blended) materials keep their alpha, which the
 * blend needs: the composite reads it there as an approximate 1.
 */
export const gbufferBaseSpecularScale = /*@__PURE__*/ (Fn((builder: Builder) => {
  const m = builder.material;
  if (m?.transparent === true) return (output as N).a;
  const coated = m != null && ((typeof m.clearcoat === 'number' && m.clearcoat > 0) || m.clearcoatNode != null);
  if (!coated) return float(1);
  const dotNVcc = (clearcoatNormalView as N).dot(positionViewDirection).clamp();
  const Fcc = (F_Schlick as N)({ dotVH: dotNVcc, f0: vec3(0.04), f90: float(1) }).x;
  return float(1).sub((clearcoat as N).mul(Fcc));
}) as N)();
