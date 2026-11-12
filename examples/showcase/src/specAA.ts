// Roughness from normal-map variance (W46, D3570-D3572): an examples-side material option, not package API.
//
// A minified normal map loses its normals' spread: the hardware averages the texels of the sampled mip,
// three normalizes the average and shades the smooth result at the authored roughness, while a path
// tracer supersamples the texels and sees the whole lobe. CarConcept's paint is the case (D3552): a
// 128 px flake map tiled x30 at normal scale 0.3, authored roughness 0.25, acts like roughness ~0.4 in
// the path tracer. Toksvig (2005) folds the lost spread back into the specular lobe from the averaged
// normal's length; this is the vMF form for a microfacet BRDF (Karis 2013 "Normalmap filtering",
// after Han et al. 2007): with r = |average of the decoded texels| at the sampled mip,
//   kappa = (3 r - r^3) / (1 - r^2)     (vMF concentration),  2 / kappa ~ the normals' slope variance,
//   alpha'^2 = alpha^2 + s^2 x (2 / kappa(r) - 2 / kappa(r0)) x strength,
// alpha = roughness^2 (three's convention), s^2 the normal scale squared (three scales the tangent
// slope by normalScale; the variance of the scaled slopes is s^2 times the map's), and r0 the length at
// mip 0 at the same uv (8-bit texels and bilinear blending already sit at r ~0.996: what the full-res
// map shows is no loss). Roughness = alpha'^(1/2), capped at 1. On CarConcept's flake map the full
// average gives r 0.933 (exact scaled slope variance 0.0133, vMF estimate 0.0117), so the paint at 0.25
// shades at ~0.35.
//
// Applied as the material's `roughnessNode`, which three's lit term (setupVariants, then its geometry
// roughness adjustment) and the frame G-buffer (`gbufferRoughness` / `gbufferShadingRoughness`) both read,
// so the composite's weights, the screen-space hit re-shade and three's own term stay one model; traced
// hits get the same adjustment once per mesh from the map's mean (`specAAHitMaterial`). The path tracer
// is left alone: it is the reference.
import type * as THREE from 'three/webgpu';
import { defaultHitMaterial, textureMeanColor, type HitMaterial } from '@pmndrs/reflections/three';
import { float, materialReference, materialRoughness, texture, uniform } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** The showcase's and compare page's default strength when the URL has no `?specAA=` (0 = off). W46: see D3570. */
export const SPEC_AA_DEFAULT = 0;

/** Scales the added variance (1 = the formula). One uniform for every material: changing it needs no rebuild. */
export const specAAStrength = uniform(1);

/** 2 / kappa for the vMF fitted to an average normal of length r (Karis 2013; Han et al. 2007). */
const vmfVariance = (r: N): N => {
  const c: N = r.clamp(1e-3, 0.9999);
  const c2: N = c.mul(c);
  return c2.oneMinus().mul(2).div(c.mul(float(3).sub(c2)));
};
const vmfVarianceCPU = (r: number) => { const c = Math.min(Math.max(r, 1e-3), 0.9999); return (2 * (1 - c * c)) / (c * (3 - c * c)); };

/** A standard / physical material's perceptual roughness raised by its normal map's variance at the sampled mip. */
export function normalVarianceRoughness(material: THREE.MeshStandardMaterial): N {
  const map = material.normalMap!;
  // texture(map) with no uv: three's own uv channel and texture matrix (KHR_texture_transform), hardware mip
  const r: N = (texture(map) as N).rgb.mul(2).sub(1).length();
  const r0: N = (texture(map, null, float(0)) as N).rgb.mul(2).sub(1).length();
  const ns: N = materialReference('normalScale', 'vec2');
  const s2: N = ns.dot(ns).mul(0.5);
  const extra: N = vmfVariance(r).sub(vmfVariance(r0)).max(0).mul(s2).mul(specAAStrength);
  const alpha: N = (materialRoughness as N).mul(materialRoughness);
  return alpha.mul(alpha).add(extra).sqrt().sqrt().min(1);
}

const nodes = new WeakMap<THREE.Material, N>();
const applies = (m: THREE.Material): m is THREE.MeshStandardMaterial => {
  const s = m as THREE.MeshStandardMaterial;
  return (s.isMeshStandardMaterial === true) && s.normalMap != null && (s as N).roughnessNode == null;
};

/**
 * Turn the option on or off for every standard / physical material with a normal map under `root`
 * (materials with their own `roughnessNode` are left alone). Returns the number of materials changed.
 */
export function setSpecularAA(root: THREE.Object3D, on: boolean): number {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? [])) {
      if (seen.has(m)) continue;
      const ours = nodes.get(m);
      const current = (m as N).roughnessNode;
      if (on && current == null && applies(m)) {
        const node = ours ?? normalVarianceRoughness(m);
        nodes.set(m, node);
        (m as N).roughnessNode = node;
      } else if (!on && ours != null && current === ours) {
        (m as N).roughnessNode = null;
      } else continue;
      m.needsUpdate = true;
      seen.add(m);
    }
  });
  return seen.size;
}

/**
 * Traced-hit material with the option on: {@link defaultHitMaterial}, its roughness raised by the whole
 * map's variance (the coarsest mip: one value per mesh, as the hit material is), at the current strength.
 */
export function specAAHitMaterial(mesh: THREE.Mesh): HitMaterial {
  const out = defaultHitMaterial(mesh);
  const m = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
  if (out.roughness === undefined || !m || nodes.get(m) == null || (m as N).roughnessNode !== nodes.get(m)) return out;
  const mean = m.normalMap ? textureMeanColor(m.normalMap) : null;
  if (!mean) return out;
  const r = Math.hypot(mean[0] * 2 - 1, mean[1] * 2 - 1, mean[2] * 2 - 1);
  const s2 = (m.normalScale.x ** 2 + m.normalScale.y ** 2) / 2;
  const a = out.roughness ** 2;
  const a2 = a * a + Math.max(0, vmfVarianceCPU(r) - vmfVarianceCPU(0.996)) * s2 * specAAStrength.value;
  return { ...out, roughness: Math.min(1, Math.sqrt(Math.sqrt(a2))) };
}

/** `?specAA=` -> strength: absent / 0 = off, 1 = on, other numbers = on at that strength. */
export function specAAFromQuery(q: URLSearchParams, fallback: number): number {
  if (!q.has('specAA')) return fallback;
  const v = Number(q.get('specAA'));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
