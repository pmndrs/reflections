// Multi-material meshes at traced hits (W49, D1701 / D1702). A mesh with an array of materials draws
// each of its geometry's groups with `material[group.materialIndex]`, and three's Raycaster reports
// that group's `face.materialIndex`. Traced hits take the same material: the core provider through a
// material per triangle (`BvhMeshGeometry.triangleMaterials`).
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
