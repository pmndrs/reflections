// Geometry roughness off or scaled (W56, D3720): an examples-side material option, not package API.
//
// three r187's standard / physical materials shade at `getRoughness(r) = min(1, max(r, 0.045) + g)`,
// where g = getGeometryRoughness() = the largest screen-space derivative of the interpolated view normal
// (Kaplanyan-style specular AA without the variance form). On a small, bevelled part seen from a distance
// g is large, so a mirror (carConcept's chrome `Rim2`, r 0.049) shades its environment term blurred.
// The path tracer has no such term (it supersamples). This option re-assigns three's `roughness`
// (and the clear coat's) after three's own `setupVariants`, as
//   min(1, max(r, 0.045) + g x scale)
// with scale 0 ('off') or a number; 'three' (the default) installs nothing. It is exact: the same
// expression three builds, with g scaled. three's lit term, the G-buffer's `shadingRoughness`
// (`gbufferShadingRoughness` reads three's `roughness`, D403) and the probe bake all read it; the
// tracer's and the denoiser's roughness (`normalRoughness.w`, the material's) never had it.
//
// How: a non-node material is converted to its node class by copying its enumerable properties
// (NodeLibrary.fromMaterial), so an own `setupVariants` on the material carries over and runs in place of
// the class's, which it calls first. The cache key carries the mode, so pipelines are never shared with
// an unadjusted material. Limit: physical anisotropy's alphaT is computed inside three's setupVariants
// from the unadjusted roughness (no showcase material uses anisotropy).
import type * as THREE from 'three/webgpu';
import { clearcoatRoughness, float, materialClearcoatRoughness, materialRoughness, normalViewGeometry, roughness, uniform } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export type GeometryRoughnessMode = 'three' | 'off' | number;

/** The geometry term's scale (0 = off, 1 = three's). One uniform for every adjusted material. */
export const geometryRoughnessScale = uniform(1);

/** `?geometryRoughness=` -> mode: absent / 'three' = three's own (nothing installed), 'off' = 0, a number = that scale. */
export function geometryRoughnessFromQuery(q: URLSearchParams): GeometryRoughnessMode {
  const v = q.get('geometryRoughness');
  if (v === null || v === 'three') return 'three';
  if (v === 'off') return 'off';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 'three';
}

const adjusted = (r: N, builder: N): N => {
  const base: N = float(r).max(0.045);
  if (builder.geometry?.hasAttribute?.('normal') === false) return base.min(1);
  const d: N = (normalViewGeometry as N).dFdx().abs().max((normalViewGeometry as N).dFdy().abs());
  return base.add(d.x.max(d.y).max(d.z).mul(geometryRoughnessScale)).min(1);
};

const installed = new WeakSet<THREE.Material>();

/**
 * Install the adjustment on every standard / physical material under `root` (the mode's scale in the shared
 * uniform). 'three' installs nothing. Returns the number of materials changed.
 */
export function setGeometryRoughness(root: THREE.Object3D, mode: GeometryRoughnessMode): number {
  if (mode === 'three') return 0;
  geometryRoughnessScale.value = mode === 'off' ? 0 : mode;
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? [])) {
      if (seen.has(m) || installed.has(m) || !(m as N).isMeshStandardMaterial) continue;
      seen.add(m);
      installed.add(m);
      const mm = m as N;
      mm.setupVariants = function (this: N, builder: N) {
        Object.getPrototypeOf(this).setupVariants.call(this, builder);
        roughness.assign(adjusted(this.roughnessNode ? this.roughnessNode : materialRoughness, builder));
        if (this.useClearcoat) clearcoatRoughness.assign(adjusted(this.clearcoatRoughnessNode ? this.clearcoatRoughnessNode : materialClearcoatRoughness, builder));
      };
      const key = m.customProgramCacheKey;
      m.customProgramCacheKey = function (this: THREE.Material) { return `${key.call(this)}|geoRough`; };
      m.needsUpdate = true;
    }
  });
  return seen.size;
}
