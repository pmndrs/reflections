// TSL nodes for the frame-contract G-buffer (see ./FrameGBuffer.ts). Each is evaluated per material
// at build time, so materials without a channel (basic, custom) get a sensible constant.
import { Fn, emissive, float, materialMetalness, materialRoughness, output, property } from 'three/tsl';

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
