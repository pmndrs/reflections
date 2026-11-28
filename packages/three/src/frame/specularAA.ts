// Geometric specular anti-aliasing in variance form (W105, T30, D5660-D5662): a material option that
// replaces three's geometry roughness.
//
// three r187's standard / physical materials shade at `getRoughness(r) = min(1, max(r, 0.045) + g)`,
// g = the largest screen-space derivative of the view normal, added to the *perceptual* roughness. On a
// small bevelled part seen from afar g is large, and added linearly it turns a mirror into brushed
// metal (carConcept's chrome star, W56 / D3720). The specular-AA literature adds a clamped *variance* to
// alpha^2 instead (Kaplanyan et al. 2016; Tokuyoshi & Kaplanyan 2019, "Improved Geometric Specular
// Antialiasing"; Tokuyoshi & Kaplanyan 2021, "Stable Geometric Specular Antialiasing with Projected-Space
// NDF Filtering", JCGT 10(2), Listing 5, the isotropic form for deferred rendering):
//
//   alpha'^2 = saturate(alpha^2 + min(2 sigma^2 (|dn/dx|^2 + |dn/dy|^2), kappa))
//
// with alpha = roughness^2 (three's convention), n the interpolated vertex normal (three's
// `normalViewGeometry`: the same normal three's term reads, so a normal map's own variance stays with
// the normal-map option, D3570), sigma^2 = 1 / (2 pi) the pixel filter's variance and kappa = 0.18 the clamp.
// The 2021 paper's "less conservative" variant (its Eq. 14) drops the factor 2: `variance` / 2 here.
// In alpha^2 the kernel's share falls off as the material gets rougher, and on a near-mirror it is a
// small lobe, not three's +g on the perceptual value.
//
// Hook: an own `setupVariants` on the material that runs three's, then re-assigns three's `roughness`
// (and the clear coat's, and anisotropy's alphaT, which three derives from it) as
// `max(filtered, 0.045)`. three's lit term, the G-buffer's `shadingRoughness` (the composite's probe
// term, D403) and the probe bake read `roughness`; the G-buffer's `normalRoughness.w` (the tracer's and
// the denoiser's roughness) takes the filtered value through {@link specularAARoughness} (without the
// 0.045 floor, as it has none today). A non-node material is converted to its node class by copying its
// enumerable properties (NodeLibrary.fromMaterial), so the own method carries over. The cache key
// carries the mode, so an adjusted material never shares a pipeline with an unadjusted one.
import type * as THREE from 'three/webgpu';
import {
  alphaT, anisotropy, clearcoatRoughness, float, materialClearcoatRoughness, materialRoughness, normalViewGeometry, property, roughness, uniform,
} from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * - `'off'` (default): materials are left as three builds them, three's own geometry roughness included.
 * - `'variance'`: Tokuyoshi & Kaplanyan's variance-form term replaces three's geometry roughness.
 */
export type SpecularAAMode = 'off' | 'variance';

export interface SpecularAAOptions {
  /** Default 'variance': passing options turns it on. */
  mode?: SpecularAAMode;
  /**
   * sigma^2, the screen-space filter's variance in pixels^2. Default 1 / (2 pi) (0.159), the paper's
   * conservative kernel; half of it is its "less conservative" variant. Shared by every material (a uniform).
   */
  variance?: number;
  /** kappa, the cap on the added alpha^2. Default 0.18 (the paper's and Kaplanyan 2016's). Shared by every material. */
  threshold?: number;
  /**
   * The roughness the reflection pass traces and denoises at (the G-buffer's `normalRoughness.w`):
   * 'filtered' (default) the same filtered value three's lit term shades with; 'material' the material's own,
   * as without the option (three's geometry roughness never reached it). The composite's weights and probe
   * term (`shadingRoughness`) follow three's lit term either way.
   */
  traceRoughness?: 'filtered' | 'material';
}

export const SPECULAR_AA_VARIANCE = 1 / (2 * Math.PI);
export const SPECULAR_AA_THRESHOLD = 0.18;

/** sigma^2 and kappa for every adjusted material; changing them needs no rebuild. */
export const specularAAUniforms = { variance: uniform(SPECULAR_AA_VARIANCE), threshold: uniform(SPECULAR_AA_THRESHOLD) };

/**
 * The filtered perceptual roughness of `r` (a perceptual roughness node), no floor:
 * `sqrt(sqrt(saturate(r^4 + min(2 sigma^2 (|dn/dx|^2 + |dn/dy|^2), kappa))))`. Without vertex normals, `r`.
 */
export function varianceSpecularAA(r: N, builder?: N): N {
  const base: N = float(r);
  if (builder?.geometry?.hasAttribute?.('normal') === false) return base;
  const n: N = normalViewGeometry;
  const du: N = n.dFdx();
  const dv: N = n.dFdy();
  const kernel: N = du.dot(du).add(dv.dot(dv)).mul(specularAAUniforms.variance).mul(2).min(specularAAUniforms.threshold);
  const a: N = base.mul(base);
  return a.mul(a).add(kernel).saturate().sqrt().sqrt();
}

/**
 * The base layer's filtered perceptual roughness, assigned in the adjusted material's `setupVariants` and
 * read by the G-buffer's `normalRoughness.w` (`gbufferRoughness`). Only defined for adjusted materials:
 * check {@link specularAAModeOf} first.
 */
export const specularAARoughness: N = property('float', 'reflectionsSpecularAARoughness');

interface Installed { mode: SpecularAAMode; traceRoughness: 'filtered' | 'material' }
const installed = new WeakMap<THREE.Material, Installed>();

/** The mode installed on `material` ('off' when none). */
export function specularAAModeOf(material: THREE.Material | null | undefined): SpecularAAMode {
  return (material && installed.get(material)?.mode) || 'off';
}

/** Whether the G-buffer's `normalRoughness.w` takes the filtered roughness for `material`. */
export function specularAATracesFiltered(material: THREE.Material | null | undefined): boolean {
  const i = material ? installed.get(material) : undefined;
  return i?.mode === 'variance' && i.traceRoughness === 'filtered';
}

const applies = (m: THREE.Material) => (m as N).isMeshStandardMaterial === true || (m as N).isMeshStandardNodeMaterial === true;
const baseCacheKey = (m: THREE.Material) => Object.getPrototypeOf(m).customProgramCacheKey.call(m) as string;

function install(m: THREE.Material, traceRoughness: string) {
  const mm = m as N;
  mm.setupVariants = function (this: N, builder: N) {
    Object.getPrototypeOf(this).setupVariants.call(this, builder);
    const filtered: N = varianceSpecularAA(this.roughnessNode ? this.roughnessNode : materialRoughness, builder);
    specularAARoughness.assign(filtered);
    roughness.assign(filtered.max(0.045));
    if (this.useAnisotropy) alphaT.assign((anisotropy as N).pow2().mix((roughness as N).pow2(), 1));
    if (this.useClearcoat) {
      const cc: N = varianceSpecularAA(this.clearcoatRoughnessNode ? this.clearcoatRoughnessNode : materialClearcoatRoughness, builder);
      clearcoatRoughness.assign(cc.max(0.045));
    }
  };
  m.customProgramCacheKey = function (this: THREE.Material) { return `${baseCacheKey(this)}|specularAA:variance:${traceRoughness}`; };
}

function uninstall(m: THREE.Material) {
  delete (m as N).setupVariants;
  delete (m as Partial<THREE.Material>).customProgramCacheKey;
}

/**
 * Set geometric specular AA on every MeshStandardMaterial / MeshPhysicalMaterial (or their node classes)
 * under `root`, or on one material. `'variance'` replaces three's geometry roughness with the variance
 * form; `'off'` restores three's own. Materials added later need another call. `variance` / `threshold`,
 * when given, set the shared uniforms. Returns the number of materials changed (each rebuilds once).
 *
 * The hook is an own `setupVariants` / `customProgramCacheKey` on the material; a material that already
 * has its own `setupVariants` from elsewhere is replaced while the option is on and loses it when it
 * turns off.
 */
export function applySpecularAA(root: THREE.Object3D | THREE.Material, options: SpecularAAMode | SpecularAAOptions = 'variance'): number {
  const o: SpecularAAOptions = typeof options === 'string' ? { mode: options } : options;
  const mode = o.mode ?? 'variance';
  const traceRoughness = o.traceRoughness ?? 'filtered';
  if (o.variance !== undefined) specularAAUniforms.variance.value = o.variance;
  if (o.threshold !== undefined) specularAAUniforms.threshold.value = o.threshold;
  const seen = new Set<THREE.Material>();
  const visit = (m: THREE.Material) => {
    const was = installed.get(m);
    if (seen.has(m) || !applies(m) || (mode === 'off' ? !was : was?.traceRoughness === traceRoughness)) return;
    seen.add(m);
    if (mode === 'variance') { install(m, traceRoughness); installed.set(m, { mode, traceRoughness }); } else { uninstall(m); installed.delete(m); }
    m.needsUpdate = true;
  };
  if ((root as THREE.Material).isMaterial) visit(root as THREE.Material);
  else (root as THREE.Object3D).traverse((obj) => { for (const m of ([] as THREE.Material[]).concat((obj as THREE.Mesh).material ?? [])) visit(m); });
  return seen.size;
}
