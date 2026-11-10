// Roughness mips of three r187's cube PMREM plan (D3): faces down to 8 px, mip `lod` prefiltered
// for roughness `1 - sqrt(1 - lod / maxLod)`, the inverse of the lookup's `maxLod * r * (2 - r)`.

/** Cube PMREM faces stop at 8 px, as in three r187 (`LOD_MIN`). */
export const LOD_MIN = 3;

/** Last roughness mip of a probe of `size` px faces. */
export const maxLodFor = (size: number) => Math.log2(size) - LOD_MIN;

/** The roughness a mip was prefiltered for (inverse of the lookup's `maxLod * r * (2 - r)`). */
export const lodToRoughness = (lod: number, maxLod: number) => (maxLod > 0 ? 1 - Math.sqrt(1 - lod / maxLod) : 0);
