// Hit materials of three meshes (docs/SPEC.md "Trace seam"): what a traced hit on a three mesh reports to the hit
// shading (albedo, emission, the specular lobe, and the physical base colour / metalness / transmission @pmndrs/raytracer's
// material records take). One set per three material, from its scalars x the mean of its maps (D902, D3510, D5204).
// (Moved out of the deleted stopgap provider's file, W89.)
import * as THREE from 'three/webgpu';


/**
 * Linear diffuse albedo and emitted radiance of a traced hit (WGSL `HitMaterial`), and its specular
 * lobe (WGSL `HitSpecular`, W41, D3510): F0 (linear), perceptual roughness, clear coat factor and
 * roughness. Without `specular` the hit is diffuse only (as before W41).
 */
export interface HitMaterial {
  albedo: readonly [number, number, number];
  emissive: readonly [number, number, number];
  specular?: readonly [number, number, number];
  roughness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** Linear base colour before metalness / transmission (`color x mean(map)`), for physical providers (@pmndrs/raytracer, P1.5). */
  baseColor?: readonly [number, number, number];
  metalness?: number;
  transmission?: number;
}

/**
 * Which of a mesh's materials a hit material is asked for (W49, D1701 / D1702). A mesh with an array
 * of materials and geometry groups is asked once per material its groups draw with; any other mesh
 * once, for its material (the first of an array without groups, `materialIndex` 0).
 */
export interface HitMaterialSource {
  /** The three material: the mesh's, or `mesh.material[materialIndex]`. */
  readonly material: THREE.Material | undefined;
  /** Index into the mesh's array of materials, or -1 for a mesh with one material. */
  readonly materialIndex: number;
}

/** The {@link HitMaterialSource} of `mesh`'s material `materialIndex` (-1 or out of range: its first). */
export function hitMaterialSource(mesh: THREE.Mesh, materialIndex = -1): HitMaterialSource {
  if (!Array.isArray(mesh.material)) return { material: mesh.material, materialIndex: -1 };
  const i = materialIndex >= 0 && materialIndex < mesh.material.length ? materialIndex : 0;
  return { material: mesh.material[i], materialIndex: i };
}

const mapMeans = new WeakMap<THREE.Texture, [number, number, number] | null>();
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Mean linear colour of a texture's image (cached per texture), or null if it can't be read on the
 * CPU (compressed, render target, not loaded yet). Images are averaged over a 16x16 downscale.
 */
export function textureMeanColor(t: THREE.Texture): [number, number, number] | null {
  if (mapMeans.has(t)) return mapMeans.get(t)!;
  let mean: [number, number, number] | null = null;
  const img = t.image as { data?: ArrayLike<number>; width?: number; height?: number } | CanvasImageSource | undefined;
  const srgb = t.colorSpace === THREE.SRGBColorSpace;
  try {
    if (img && 'data' in img && img.data && img.width && img.height) {
      const d = img.data, n = img.width * img.height, ch = Math.round(d.length / n);
      const scale = d instanceof Uint8Array || d instanceof Uint8ClampedArray ? 1 / 255 : 1;
      const acc = [0, 0, 0];
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) acc[c] += d[i * ch + Math.min(c, ch - 1)] * scale;
      mean = acc.map((v) => (srgb ? srgbToLinear(v / n) : v / n)) as [number, number, number];
    } else if (img && typeof document !== 'undefined' && ((img as { width?: number }).width ?? 0) > 0) {
      const S = 16;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const g = cv.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img as CanvasImageSource, 0, 0, S, S);
      const px = g.getImageData(0, 0, S, S).data;
      const acc = [0, 0, 0];
      // 8-bit canvas data is sRGB-encoded whatever the texture says; decode per texel
      for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) acc[c] += srgb ? srgbToLinear(px[i * 4 + c] / 255) : px[i * 4 + c] / 255;
      mean = acc.map((v) => v / (S * S)) as [number, number, number];
    }
  } catch { mean = null; }
  if (mean) mapMeans.set(t, mean);
  return mean;
}

/**
 * Default hit material of a three mesh's material (`source`, W49: one of a multi-material mesh's;
 * default the mesh's, or the first of an array), one set per material from its scalars x the mean of
 * its maps (D902):
 * - diffuse albedo `color x mean(map) x (1 - metalness) x (1 - transmission)`;
 * - `emissive x mean(emissiveMap) x emissiveIntensity`;
 * - specular F0 `mix(0.04, color x mean(map), metalness)` (W41, D3510; standard and physical
 *   materials only), roughness `roughness x mean(roughnessMap).g`, metalness `x mean(metalnessMap).b`,
 *   clear coat `clearcoat x mean(clearcoatMap).r` and `clearcoatRoughness` (physical materials).
 */
export function defaultHitMaterial(mesh: THREE.Mesh, source: HitMaterialSource = hitMaterialSource(mesh)): HitMaterial {
  const m = source.material as THREE.MeshPhysicalMaterial | undefined;
  const albedo: [number, number, number] = [0.5, 0.5, 0.5];
  const emissive: [number, number, number] = [0, 0, 0];
  const out: HitMaterial = { albedo, emissive };
  const pbr = typeof m?.metalness === 'number' && typeof m?.roughness === 'number';
  const metalness = pbr ? m!.metalness * (m!.metalnessMap ? textureMeanColor(m!.metalnessMap)?.[2] ?? 1 : 1) : 0;
  if (m?.color) {
    const t = m.map ? textureMeanColor(m.map) ?? [1, 1, 1] : [1, 1, 1];
    const base = [m.color.r * t[0], m.color.g * t[1], m.color.b * t[2]];
    const k = (1 - metalness) * (1 - (m.transmission ?? 0));
    albedo[0] = base[0] * k; albedo[1] = base[1] * k; albedo[2] = base[2] * k;
    if (pbr) {
      out.baseColor = base as [number, number, number];
      out.metalness = metalness;
      if (m.transmission) out.transmission = m.transmission;
      out.specular = base.map((b) => 0.04 + (b - 0.04) * metalness) as [number, number, number];
      out.roughness = m.roughness * (m.roughnessMap ? textureMeanColor(m.roughnessMap)?.[1] ?? 1 : 1);
      out.clearcoat = (m.clearcoat ?? 0) * (m.clearcoatMap ? textureMeanColor(m.clearcoatMap)?.[0] ?? 1 : 1);
      out.clearcoatRoughness = m.clearcoatRoughness ?? 0;
    }
  }
  if (m?.emissive) {
    const k = m.emissiveIntensity ?? 1;
    const t = m.emissiveMap ? textureMeanColor(m.emissiveMap) ?? [1, 1, 1] : [1, 1, 1];
    emissive[0] = m.emissive.r * t[0] * k; emissive[1] = m.emissive.g * t[1] * k; emissive[2] = m.emissive.b * t[2] * k;
  }
  return out;
}
