// Probe bounce light for Babylon's PBR materials: a material plugin that takes the material's diffuse
// image-based lighting (Babylon's `environmentIrradiance`) from a BabylonProbeSet instead of the scene's
// environment texture, per pixel, through core's probe lookup (influence blending, box projection, the
// environment slot for what no probe covers). three's materials get the same from
// `scene.environmentNode = reflectionProbes(probes)`; Babylon has no per-pixel environment hook, so the
// lookup runs inside the material (core's function form, `probeLookupFunctionWgsl`, with Babylon owning
// the bindings: the atlas as a texture, the volume table as a storage buffer).
//
//   const probes = new BabylonProbeSet(scene, { capacity: 3 });
//   for (const m of scene.materials) if (m instanceof PBRMaterial) probeIrradiance(m, probes);
//
// What it samples: the lookup at the surface (P, N) along N at roughness 1, the same lookup three's
// EnvironmentNode makes for its irradiance (direction = normal, texture level = roughness 1). That is
// the probes' widest GGX mip, not a cosine convolution (Babylon convolves its own environment into SH),
// D5520. Babylon's own weighting then applies unchanged (pbrBlockFinalLitComponents): the base layer's
// specular energy, the clear coat's, the albedo, `scene.environmentIntensity` and ambient occlusion.
//
// With a scene environment texture (Babylon's REFLECTION path) the plugin replaces its irradiance and
// Babylon composes the result as usual; without one (the usual setup with the strip plugin, whose
// composite adds the specular from the probes), the plugin runs Babylon's same irradiance block and
// adds it to the colour. Captures render with the set disabled (BabylonProbeSet.bake), so a bake sees
// direct light and the environment only, as three's does.
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines.js';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage.js';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer.js';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { probeLookupFunctionWgsl, probeLookupIncludesWgsl, type ProbeSet } from '@pmndrs/reflections-core';
import { asWebGPUEngine, wrapGPUBuffer, wrapGPUTextureView, type WrappedStorageBuffer } from './internal/babylonWebGPU';
import type { BabylonProbeSet } from './probes';

const WGSL = 1; // ShaderLanguage.WGSL
const ATLAS = 'reflectionsProbeAtlas';
const TABLE = 'reflectionsProbeTable';

/** Babylon-side handles of a set's atlases and table (one per set, shared by every material). */
interface Bindings { atlases: BaseTexture[]; table: WrappedStorageBuffer; code: string; key: number }
const bindings = new WeakMap<ProbeSet, Bindings>();
/** One effect-cache key per distinct shader code (layout, atlas count, lookup options). */
const codeKeys = new Map<string, number>();

/** The bindings of the plugin under construction (MaterialPluginBase's constructor calls getCustomCode). */
let constructing: Bindings | null = null;

const atlasName = (k: number) => (k === 0 ? ATLAS : `${ATLAS}${k}`);

function bindingsFor(engine: AbstractEngine, set: ProbeSet): Bindings {
  let b = bindings.get(set);
  if (b) return b;
  const options = set.lookupOptions();
  const textureType = set.layout.textureType;
  // Babylon declares each texture with its own sampler (`<name>Sampler`); the lookup filters every atlas with the first.
  const decls = set.atlases.map((_, k) => `var ${atlasName(k)}Sampler: sampler;\nvar ${atlasName(k)}: ${textureType};\n`).join('');
  const extra = set.atlases.slice(1).map((_, k) => `${atlasName(k + 1)}, `).join('');
  const code = `${decls}var<storage, read> ${TABLE}: array<vec4f>;
${probeLookupIncludesWgsl(options)}
${probeLookupFunctionWgsl(options, 'reflectionsProbeLookup')}
fn reflectionsProbeIrradiance(P: vec3f, N: vec3f) -> vec3f {
  return reflectionsProbeLookup(${ATLAS}, ${extra}${ATLAS}Sampler, &${TABLE}, P, N, N, 1.0, PR_IDENTITY, vec3f(-1.0), true).rgb;
}
`;
  let key = codeKeys.get(code);
  if (key === undefined) codeKeys.set(code, (key = codeKeys.size + 1));
  b = {
    atlases: set.atlases.map((t, k) => {
      const handle = wrapGPUTextureView(engine, t, { dimension: set.layouts[k].viewDimension });
      const texture = new BaseTexture(engine, handle);
      texture.name = `reflections probe atlas ${k}`;
      texture.wrapU = texture.wrapV = texture.wrapR = 0; // clamp, as core's own sampler
      return texture;
    }),
    table: wrapGPUBuffer(set.table),
    code,
    key,
  };
  bindings.set(set, b);
  return b;
}

/** Feeds a PBR material's diffuse IBL from a probe set (see the file header). */
export class ProbeIrradiancePlugin extends MaterialPluginBase {
  static readonly Name = 'ReflectionsProbeIrradiance';
  readonly probes: BabylonProbeSet;
  private readonly bindings: Bindings;
  private _active = true;

  constructor(material: Material, probes: BabylonProbeSet) {
    // the base constructor already asks for the custom code
    constructing = bindingsFor(asWebGPUEngine(material.getScene().getEngine()), probes.set);
    super(material, ProbeIrradiancePlugin.Name, 310, { REFLECTIONS_PROBE_IRRADIANCE: false, REFLECTIONS_PROBE_SET: 0 }, true, false);
    this.bindings = constructing;
    constructing = null;
    this.probes = probes;
    this.registerForExtraEvents = true; // hardBindForSubMesh (read when the plugin is enabled)
    this._enable(true);
  }

  /** Off: the material's diffuse IBL is Babylon's own again (a define: the material recompiles). */
  get active() { return this._active; }
  set active(on: boolean) {
    if (on === this._active) return;
    this._active = on;
    this.markAllDefinesAsDirty();
  }

  override prepareDefines(defines: MaterialDefines) {
    defines['REFLECTIONS_PROBE_IRRADIANCE'] = this._active;
    defines['REFLECTIONS_PROBE_SET'] = this._active ? this.bindings.key : 0;
  }

  override getClassName() { return 'ProbeIrradiancePlugin'; }

  override isCompatible(shaderLanguage: ShaderLanguage) { return (shaderLanguage as number) === WGSL; }

  override getSamplers(samplers: string[]) {
    for (let k = 0; k < this.bindings.atlases.length; k++) samplers.push(atlasName(k));
  }

  // Every draw (not only on a rebind): the storage buffer lives in each mesh's draw context.
  override hardBindForSubMesh(_ubo: UniformBuffer, _scene: Scene, engine: AbstractEngine, subMesh: SubMesh) {
    if (!this._active) return;
    const effect = subMesh.effect;
    if (!effect) return;
    this.bindings.atlases.forEach((t, k) => effect.setTexture(atlasName(k), t));
    asWebGPUEngine(engine).setStorageBuffer(TABLE, this.bindings.table as never);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage) {
    if (shaderType !== 'fragment' || (shaderLanguage as number) !== WGSL) return null;
    const { code } = this.bindings ?? constructing!;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef REFLECTIONS_PROBE_IRRADIANCE\n${code}#endif\n`,
      // pbrBlockFinalLitComponents: Babylon's irradiance block runs with the probes' irradiance, with or without REFLECTION
      '!#ifdef REFLECTION\\s+var finalIrradiance: vec3f=reflectionOut\\.environmentIrradiance;':
        '#if defined(REFLECTION) || defined(REFLECTIONS_PROBE_IRRADIANCE)\n'
        + '#ifdef REFLECTIONS_PROBE_IRRADIANCE\nvar finalIrradiance: vec3f=reflectionsProbeIrradiance(fragmentInputs.vPositionW, normalW);\n'
        + '#else\nvar finalIrradiance: vec3f=reflectionOut.environmentIrradiance;\n#endif',
      // pbrBlockFinalColorComposition adds finalIrradiance only under REFLECTION
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: '#if defined(REFLECTIONS_PROBE_IRRADIANCE) && !defined(REFLECTION) && !defined(UNLIT)\nfinalAmbient += finalIrradiance;\n#endif\n',
    };
  }
}

/** Attaches (or returns) the plugin on a PBR material. */
export function probeIrradiance(material: Material, probes: BabylonProbeSet): ProbeIrradiancePlugin {
  const existing = material.pluginManager?.getPlugin(ProbeIrradiancePlugin.Name) as ProbeIrradiancePlugin | null | undefined;
  if (existing) {
    if (existing.probes !== probes) throw new Error('probeIrradiance: the material already takes its irradiance from another probe set');
    return existing;
  }
  return new ProbeIrradiancePlugin(material, probes);
}
