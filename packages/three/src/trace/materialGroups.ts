// Multi-material meshes at traced hits (W49, D1701 / D1702). A mesh with an array of materials draws
// each of its geometry's groups with `material[group.materialIndex]`, and three's Raycaster reports
// that group's `face.materialIndex`. Traced hits take the same material: the core @pmndrs/bvh
// provider through a material per triangle (`BvhMeshGeometry.triangleMaterials`), the
// three-mesh-bvh stopgap through its transform slots, one per BVH root (one root per group range).
import type * as THREE from 'three/webgpu';

/** Whether three draws `mesh` per geometry group: an array of materials and at least one group. */
export function isMultiMaterial(mesh: THREE.Mesh): mesh is THREE.Mesh & { material: THREE.Material[] } {
  return Array.isArray(mesh.material) && (mesh.geometry?.groups.length ?? 0) > 0;
}

const vertexCount = (geometry: THREE.BufferGeometry) => (geometry.index ? geometry.index.count : geometry.getAttribute('position').count);

/**
 * Per triangle of the geometry (its index, or its vertex list), the `materialIndex` of the first
 * group that draws it, in `geometry.groups` order, or -1 where none does. A group's triangles are
 * the ones three's Raycaster tests for it: from `max(group.start, drawRange.start)` to the end of
 * the group or of the draw range, whichever comes first, in steps of 3 indices.
 */
export function triangleMaterialIndices(geometry: THREE.BufferGeometry): Int32Array {
  const count = vertexCount(geometry);
  const out = new Int32Array(Math.floor(count / 3)).fill(-1);
  const { start: drawStart, count: drawCount } = geometry.drawRange;
  for (const group of geometry.groups) {
    const start = Math.max(group.start, drawStart);
    const end = Math.min(count, group.start + group.count, drawStart + drawCount);
    for (let j = start; j < end; j += 3) {
      const t = Math.floor(j / 3);
      if (t < out.length && out[t] < 0) out[t] = group.materialIndex ?? 0;
    }
  }
  return out;
}

/**
 * three-mesh-bvh (0.9.18) gives a geometry one BVH root per run of triangles drawn by the same set of
 * groups, within the draw range (core/build/geometryUtils.js `getRootPrimitiveRanges`), and
 * BVHComputeData one transform slot per root. Per root, in order: the `materialIndex` of the first
 * group (in `geometry.groups` order) that covers it, or -1. Empty without groups (one root).
 */
export function rootMaterialIndices(geometry: THREE.BufferGeometry): number[] {
  if (!geometry.groups.length) return [];
  const primitives = vertexCount(geometry) / 3;
  const drawStart = Math.floor(Math.max(0, geometry.drawRange.start / 3));
  const drawEnd = drawStart + Math.floor(Math.min(primitives, (geometry.drawRange.start + geometry.drawRange.count) / 3) - drawStart);
  const groups = geometry.groups.map((g) => {
    const offset = g.start / 3;
    return { offset, end: offset + (Number.isFinite(g.count) ? g.count / 3 : primitives - offset), materialIndex: g.materialIndex ?? 0 };
  });
  const events: { pos: number; start: boolean }[] = [];
  for (const g of groups) {
    if (g.offset < drawEnd && g.end > drawStart) events.push({ pos: Math.max(drawStart, g.offset), start: true }, { pos: Math.min(drawEnd, g.end), start: false });
  }
  events.sort((a, b) => a.pos - b.pos);
  const out: number[] = [];
  let active = 0, last = 0;
  for (const e of events) {
    if (active !== 0 && e.pos !== last) out.push(groups.find((g) => g.offset <= last && last < g.end)?.materialIndex ?? -1);
    active += e.start ? 1 : -1;
    last = e.pos;
  }
  return out;
}
