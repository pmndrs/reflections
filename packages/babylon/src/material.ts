// Scene colour without specular image-based lighting, for the frame contract's `sceneColor`
// (sceneColorSpecular 'direct'): a material plugin that drops Babylon PBR's environment radiance
// term (`finalRadianceScaled`, the split-sum IBL specular) right before the final colour is composed.
// Everything else stays: emissive, direct diffuse and specular from lights, environment irradiance.
// The reflections composite (./composite.ts) then adds the specular term back from SSR, probes and
// the environment, so nothing is subtracted and nothing is counted twice (unlike the three
// composite's swap, D603).
//
// Not removed (D1804): clear coat and sheen environment radiance (their own IBL lobes), and
// Babylon's multi-scatter energy compensation, which scaled the term we drop.
import type { Material } from '@babylonjs/core/Materials/material.js';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';

const WGSL = 1; // ShaderLanguage.WGSL
const GLSL = 0;

/** Removes PBR's specular IBL from the lit colour (see the file header). */
export class StripSpecularIBLPlugin extends MaterialPluginBase {
  static readonly Name = 'ReflectionsStripSpecularIBL';
  private _active = true;

  constructor(material: Material) {
    super(material, StripSpecularIBLPlugin.Name, 300, undefined, true, true);
  }

  /** Off: the material renders Babylon's own specular IBL again (recompiles). */
  get active() { return this._active; }
  set active(on: boolean) {
    if (on === this._active) return;
    this._active = on;
    this._enable(on);
  }

  override getClassName() { return 'StripSpecularIBLPlugin'; }

  override isCompatible(shaderLanguage: ShaderLanguage) { return (shaderLanguage as number) === WGSL || (shaderLanguage as number) === GLSL; }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage) {
    if (shaderType !== 'fragment') return null;
    const zero = (shaderLanguage as number) === WGSL ? 'vec3f(0.0)' : 'vec3(0.0)';
    return {
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef REFLECTION
finalRadianceScaled = ${zero};
#endif
`,
    };
  }
}

/** Attaches (or returns) the plugin on a PBR material. */
export function stripSpecularIBL(material: Material): StripSpecularIBLPlugin {
  const existing = material.pluginManager?.getPlugin(StripSpecularIBLPlugin.Name);
  return (existing as StripSpecularIBLPlugin | null) ?? new StripSpecularIBLPlugin(material);
}
