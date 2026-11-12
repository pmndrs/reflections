import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import { GPU_LAYOUT_TRIANGLE_BYTES, GPU_LAYOUT_TRIANGLE_WORD } from '@pmndrs/bvh';
import { createPmndrsBvhTraceProvider, PMNDRS_BVH_TRIANGLE_MATERIAL_NONE, type BvhTraceScene } from '@pmndrs/reflections-core';
import { bvhTraceSceneFromObjects, defaultHitMaterial, type HitMaterialSource } from '@pmndrs/reflections-three';
import { rootMaterialIndices, triangleMaterialIndices } from '../packages/three/src/trace/materialGroups';

// Per-triangle materials at traced hits (W49, D1701 / D1702): a three mesh with an array of materials
// gives each triangle its group's material. @pmndrs/bvh: `triangleMaterials` per mesh tree, built
// from the groups; three-mesh-bvh: a transform slot per BVH root, one root per group range. The GPU
// walks are checked in examples/ssr's multiMaterial scene (`pnpm check -- --only rt-materials`).

// node has no WebGPU globals; the provider names buffer usages
(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
const fakeDevice = () => ({
  createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, label: d.label, destroy() {} }),
  queue: { writeBuffer() {} },
  features: new Set<string>(),
}) as unknown as GPUDevice;

/** A box whose six groups (+x, -x, +y, -y, +z, -z) take materials 0 / 1 as `indices`. */
function box(indices = [0, 1, 1, 0, 0, 1]) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  indices.forEach((materialIndex, i) => { geometry.groups[i].materialIndex = materialIndex; });
  return geometry;
}
const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
const green = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x00ff00, emissiveIntensity: 2 });

describe('three groups -> triangle materials', () => {
  it('each triangle takes its group\'s materialIndex (two triangles per box face)', () => {
    expect(Array.from(triangleMaterialIndices(box()))).toEqual([0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1]);
  });
  it('as three\'s Raycaster: the draw range clips, the first of overlapping groups wins, undrawn is -1', () => {
    const g = box();
    g.clearGroups();
    g.addGroup(0, 12, 2); // triangles 0-3
    g.addGroup(6, 12, 3); // triangles 2-5: 2-3 already taken
    g.setDrawRange(3, 30); // triangles 1-10
    expect(Array.from(triangleMaterialIndices(g))).toEqual([-1, 2, 2, 2, 3, 3, -1, -1, -1, -1, -1, -1]);
  });
  it('per three-mesh-bvh root, the group\'s materialIndex, in MeshBVH\'s root order', () => {
    const cases: THREE.BufferGeometry[] = [box(), box([1, 0, 1, 0, 1, 0])];
    const overlapping = box();
    overlapping.clearGroups();
    overlapping.addGroup(0, 18, 0);
    overlapping.addGroup(12, 24, 1);
    overlapping.setDrawRange(3, 27);
    cases.push(overlapping);
    const unsorted = box();
    unsorted.clearGroups();
    unsorted.addGroup(18, 18, 1);
    unsorted.addGroup(0, 18, 0);
    cases.push(unsorted);
    for (const g of cases) {
      const ours = rootMaterialIndices(g);
      const bvh = new MeshBVH(g.clone());
      const ranges = (bvh as unknown as { getRootRanges(range?: unknown): { offset: number; count: number }[] }).getRootRanges();
      expect(ours.length).toBe((bvh as unknown as { _roots: unknown[] })._roots.length);
      expect(ours.length).toBe(ranges.length);
      // a root's material: the first group (in geometry.groups order) drawing its first triangle
      const tri = triangleMaterialIndices(g);
      expect(ours).toEqual(ranges.map((r) => tri[r.offset]));
    }
    const plain = new THREE.BoxGeometry();
    plain.clearGroups();
    expect(rootMaterialIndices(plain)).toEqual([]);
  });
});

describe('bvhTraceSceneFromObjects: multi-material meshes (D1702)', () => {
  const geometry = box();
  const a = new THREE.Mesh(geometry, [red, green]);
  const b = new THREE.Mesh(geometry, [green, red]);
  const c = new THREE.Mesh(geometry, [red, green]); // same table as a: shares its tree
  const d = new THREE.Mesh(geometry, red); // one material: the tree without triangle materials
  const e = new THREE.Mesh(geometry, [red, red]); // every group the instance's: no triangle materials either
  b.position.x = 2; c.position.x = 4; d.position.x = 6; e.position.x = 8;
  const root = new THREE.Group().add(a, b, c, d, e);
  root.updateMatrixWorld(true);

  it('one entry per three material, a tree per geometry and group table, triangles carry their group\'s', () => {
    const { scene, materialSources, materialIdOf, sources } = bvhTraceSceneFromObjects(root);
    expect(scene.materials).toHaveLength(2);
    expect(materialSources.map((s) => s.material)).toEqual([red, green]);
    expect(scene.materials![1]).toEqual(defaultHitMaterial(a, { material: green, materialIndex: 1 }));
    expect(scene.instances.map((i) => i.mesh)).toEqual([0, 1, 0, 2, 2]);
    expect(scene.instances.map((i) => i.material)).toEqual([0, 1, 0, 0, 0]); // the first material
    expect(sources.map((s) => s.mesh)).toEqual([a, b, c, d, e]);
    const [ta, tb, td] = scene.meshes.map((m) => m.triangleMaterials ? Array.from(m.triangleMaterials) : null);
    expect(ta).toEqual([0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1]);
    expect(tb).toEqual([1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0]);
    expect(td).toBeNull();
    // what rtOracle expects for three's face.materialIndex
    expect([materialIdOf(a, 0), materialIdOf(a, 1), materialIdOf(b, 0), materialIdOf(b, 1), materialIdOf(d, 0), materialIdOf(e, 1)]).toEqual([0, 1, 1, 0, 0, 0]);
    expect(materialIdOf(new THREE.Mesh(geometry, red), 0)).toBeUndefined();
  });

  it('a custom material function is asked once per mesh and material its groups draw with', () => {
    const asked: string[] = [];
    const material = (mesh: THREE.Mesh, source: HitMaterialSource) => {
      asked.push(`${([a, b, c, d, e] as THREE.Mesh[]).indexOf(mesh)}:${source.materialIndex}`);
      return { albedo: [source.materialIndex + 1, 0, 0] as const, emissive: [0, 0, 0] as const };
    };
    const { scene } = bvhTraceSceneFromObjects(root, { material });
    expect(asked).toEqual(['0:0', '0:1', '1:0', '1:1', '2:0', '2:1', '3:-1', '4:0', '4:1']);
    expect(scene.materials).toHaveLength(9);
    // per mesh and material: a, b, c and e each get their own table, so their own trees
    expect(scene.meshes).toHaveLength(5);
    expect(Array.from(scene.meshes[0].triangleMaterials!)).toEqual([0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1]);
    expect(Array.from(scene.meshes[1].triangleMaterials!)).toEqual([2, 2, 3, 3, 3, 3, 2, 2, 2, 2, 3, 3]);
  });

  it('triangles no group draws take the instance\'s material', () => {
    const g = box();
    g.clearGroups();
    g.addGroup(0, 12, 1);
    g.addGroup(12, 12, 0);
    const { scene } = bvhTraceSceneFromObjects(new THREE.Mesh(g, [red, green]));
    const N = PMNDRS_BVH_TRIANGLE_MATERIAL_NONE;
    expect(Array.from(scene.meshes[0].triangleMaterials!)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, N, N, N, N]);
    expect(scene.instances[0].material).toBe(0);
  });
});

describe('createPmndrsBvhTraceProvider: triangle materials into @pmndrs/bvh (tinybvh)', () => {
  it('each triangle record carries its material + 1 in flags bits 16-31, 0 where the instance\'s applies', async () => {
    const geometry = box();
    geometry.clearGroups();
    geometry.addGroup(0, 24, 1); // +x, -x, +y, -y: green
    geometry.addGroup(24, 6, 0); // +z: red; -z: no group (the instance's, red)
    const mesh = new THREE.Mesh(geometry, [red, green]);
    mesh.updateMatrixWorld(true);
    const { scene } = bvhTraceSceneFromObjects(mesh);
    const provider = await createPmndrsBvhTraceProvider(fakeDevice(), scene, { builder: 'tinybvh' });
    const [layout] = (provider as unknown as { layouts: { triangles: ArrayBuffer; triangleCount: number }[] }).layouts;
    const words = new Uint32Array(layout.triangles);
    const byTriangle: number[] = [];
    for (let k = 0; k < layout.triangleCount; k++) {
      const w = (k * GPU_LAYOUT_TRIANGLE_BYTES) / 4;
      byTriangle[words[w + GPU_LAYOUT_TRIANGLE_WORD.originalIndex]] = words[w + GPU_LAYOUT_TRIANGLE_WORD.flags] >>> 16;
    }
    expect(byTriangle).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 0, 0]);
    expect(scene.instances[0].material).toBe(0);
  });

  it('refuses a triangle material outside the table', async () => {
    const geometry = box();
    const s = bvhTraceSceneFromObjects(new THREE.Mesh(geometry, [red, green])).scene;
    const bad: BvhTraceScene = { ...s, meshes: [{ ...s.meshes[0], triangleMaterials: new Uint16Array(12).fill(2) }] };
    await expect(createPmndrsBvhTraceProvider(fakeDevice(), bad, { builder: 'tinybvh' })).rejects.toThrow(/triangle 0 uses material 2; there are 2/);
  });
});
