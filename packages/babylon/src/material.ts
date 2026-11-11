// Scene colour without specular image-based lighting, for the frame contract's `sceneColor`
// (sceneColorSpecular 'direct'): a material plugin that drops Babylon PBR's environment radiance
// term (`finalRadianceScaled`, the split-sum IBL specular) right before the final colour is composed.
// Everything else stays: emissive, direct diffuse and specular from lights, environment irradiance.
// The reflections composite (./composite.ts) then adds the specular term back from SSR, probes and
// the environment, so nothing is subtracted and nothing is counted twice (unlike the three
// composite's swap, D603).
//
// Babylon scales the term it drops by more than the split-sum weight (@babylonjs/core 9.35.0,
// ShadersWGSL/ShadersInclude/pbrBlockReflectance.js and pbrBlockFinalLitComponents.js): specular AO
// (`seo`, from the ambient texture), horizon occlusion (`eho`, with a bump map), bent-normal
// occlusion, the clear coat's and sheen's attenuation of the base layer, and the multi-scatter
// energy factor. The plugin hands the composite those per pixel in the G-buffer's linear velocity
// target, whose z Babylon leaves at 0 (D1804):
//
//   velocity.z = (1 - specularFactor) + 2 * (multi-scatter energy compensation on ? 1 : 0)
//
// `specularFactor` is the product of the scalar terms above; the composite rebuilds the (colour)
// energy factor from F0 and its own BRDF lookup. A material without the plugin writes 0: factor 1,
// no energy compensation, i.e. the bare split-sum weight. Not carried: the clear coat's tint
// absorption (colour) and its F0 remap, and the clear coat's and sheen's own environment lobes,
// which stay in the lit colour as Babylon computed them.
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines.js';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';

const WGSL = 1; // ShaderLanguage.WGSL
const GLSL = 0;

/**
 * The scalar factors Babylon applies to its base-layer specular IBL, under Babylon's own defines
 * (pbrBlockReflectance, pbrBlockFinalLitComponents), and the energy-compensation flag, packed for
 * velocity.z. `f32` / `float` and the zero vector differ per language.
 */
function specularFactorCode(wgsl: boolean) {
  const f = wgsl ? 'f32' : 'float';
  const v3 = wgsl ? 'vec3f' : 'vec3';
  const decl = (name: string, value: string, type = f) => (wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`);
  return `
${decl('reflectionsSpecular', '0.0')}
#if defined(REFLECTIONS_STRIP_SPECULAR_IBL) && defined(REFLECTION) && !defined(UNLIT)
{
${decl('reflectionsFactor', '1.0')}
#if defined(CLEARCOAT) && defined(ENVIRONMENTBRDF) && !defined(REFLECTIONMAP_SKYBOX)
// Under a clear coat Babylon remaps the base F0 for the coat interface (clearcoatOut.specularEnvironmentR0,
// not the F0 the G-buffer holds) and tints it: the ratio of Babylon's weight (with seo, eho, the
// coat's conservation and tint) to the composite's, by luminance.
${decl('reflectionsBabylon', 'colorSpecularEnvironmentReflectance', v3)}
${decl('reflectionsOurs', `mix(${v3}(environmentBrdf.x), ${v3}(environmentBrdf.y), specularEnvironmentR0)`, v3)}
#ifdef MS_BRDF_ENERGY_CONSERVATION
reflectionsBabylon *= coloredEnergyConservationFactor;
reflectionsOurs *= getEnergyConservationFactor(specularEnvironmentR0, environmentBrdf);
#endif
reflectionsFactor = dot(reflectionsBabylon, ${v3}(0.2126, 0.7152, 0.0722)) / max(dot(reflectionsOurs, ${v3}(0.2126, 0.7152, 0.0722)), 1e-6);
#else
#if defined(ENVIRONMENTBRDF) && !defined(REFLECTIONMAP_SKYBOX)
#if defined(RADIANCEOCCLUSION) && !defined(BENTNORMAL)
reflectionsFactor *= seo;
#endif
#if defined(HORIZONOCCLUSION) && defined(BUMP) && defined(REFLECTIONMAP_3D)
reflectionsFactor *= eho;
#endif
#endif
#ifdef CLEARCOAT
reflectionsFactor *= clearcoatOut.conservationFactor;
#endif
#endif
#ifdef BENTNORMAL
reflectionsFactor *= mix(1.0, environmentBentNormalOcclusion(bentNormalW, reflectedDirection, normalW, NdotVUnclamped, bentAO, alphaG), bentNormalStrength);
#endif
#if defined(SHEEN) && defined(ENVIRONMENTBRDF) && defined(SHEEN_ALBEDOSCALING)
reflectionsFactor *= sheenOut.sheenAlbedoScaling;
#endif
reflectionsSpecular = 1.0 - clamp(reflectionsFactor, ${f}(0.0), ${f}(1.0));
#if defined(ENVIRONMENTBRDF) && defined(MS_BRDF_ENERGY_CONSERVATION)
reflectionsSpecular += 2.0;
#endif
}
#endif
`;
}

/** Removes PBR's specular IBL from the lit colour and writes its extra factors (see the file header). */
export class StripSpecularIBLPlugin extends MaterialPluginBase {
  static readonly Name = 'ReflectionsStripSpecularIBL';
  private _active = true;

  constructor(material: Material) {
    super(material, StripSpecularIBLPlugin.Name, 300, { REFLECTIONS_STRIP_SPECULAR_IBL: true }, true, true);
  }

  /**
   * Off: the material renders Babylon's own specular IBL again and writes velocity.z = 0 (a define,
   * so the material recompiles; Babylon's `_enable(false)` does not deactivate a plugin).
   */
  get active() { return this._active; }
  set active(on: boolean) {
    if (on === this._active) return;
    this._active = on;
    this.markAllDefinesAsDirty();
  }

  override prepareDefines(defines: MaterialDefines) {
    defines['REFLECTIONS_STRIP_SPECULAR_IBL'] = this._active;
  }

  override getClassName() { return 'StripSpecularIBLPlugin'; }

  override isCompatible(shaderLanguage: ShaderLanguage) { return (shaderLanguage as number) === WGSL || (shaderLanguage as number) === GLSL; }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage) {
    if (shaderType !== 'fragment') return null;
    const wgsl = (shaderLanguage as number) === WGSL;
    const zero = wgsl ? 'vec3f(0.0)' : 'vec3(0.0)';
    return {
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `${specularFactorCode(wgsl)}
#if defined(REFLECTIONS_STRIP_SPECULAR_IBL) && defined(REFLECTION)
finalRadianceScaled = ${zero};
#endif
`,
      // pbrBlockPrePass: the linear velocity write, z = 0 -> the packed factor (regex point).
      ...(wgsl
        ? { '!fragData\\[PREPASS_VELOCITY_LINEAR_INDEX\\]=vec4f\\(velocity,0\\.0,writeGeometryInfo\\);': 'fragData[PREPASS_VELOCITY_LINEAR_INDEX]=vec4f(velocity,reflectionsSpecular,writeGeometryInfo);' }
        : { '!WRITE_GEOMETRY_FRAGMENT_OUTPUT\\(PREPASS_VELOCITY_LINEAR_INDEX,vec4\\(velocity,0\\.0,writeGeometryInfo\\)\\)': 'WRITE_GEOMETRY_FRAGMENT_OUTPUT(PREPASS_VELOCITY_LINEAR_INDEX,vec4(velocity,reflectionsSpecular,writeGeometryInfo))' }),
    };
  }
}

/** Attaches (or returns) the plugin on a PBR material. */
export function stripSpecularIBL(material: Material): StripSpecularIBLPlugin {
  const existing = material.pluginManager?.getPlugin(StripSpecularIBLPlugin.Name);
  return (existing as StripSpecularIBLPlugin | null) ?? new StripSpecularIBLPlugin(material);
}

/**
 * Decodes velocity.z as the plugin writes it (WGSL, for composites): x = Babylon's scalar specular
 * factor (specular AO, horizon / bent-normal occlusion, clear coat and sheen attenuation), y = 1 when
 * the material applies multi-scatter energy compensation, else 0.
 */
export const DECODE_SPECULAR_FACTORS_WGSL = /* wgsl */ `
fn decodeSpecularFactors(packed: f32) -> vec2f {
  let ms = select(0.0, 1.0, packed > 1.5);
  return vec2f(clamp(1.0 - (packed - 2.0 * ms), 0.0, 1.0), ms);
}
`;
