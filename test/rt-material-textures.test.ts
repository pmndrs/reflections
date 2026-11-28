import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GPU_LAYOUT_TRIANGLE_BYTES, GPU_LAYOUT_TRIANGLE_WORD } from '@pmndrs/bvh';
import * as rt from '@pmndrs/raytracer';
import { alphaTestPlan, createRaytracerTraceProvider, traceTextureMean, BVH_TRIANGLE_MATERIAL_NONE, type BvhTraceScene } from '@pmndrs/reflections-core';
import { bvhTraceSceneFromObjects, defaultHitMaterial } from '@pmndrs/reflections-three';

// W110 (T18): the material textures traced hits read besides the base colour (roughness / metalness, emissive) and the alpha
// test (@pmndrs/bvh's triangle filter over flagged triangles). The GPU side is checked in examples/regressions (rtTextures).

(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
(globalThis as { GPUTextureUsage?: unknown }).GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
const fakeDevice = () => ({
  createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, label: d.label, destroy() {} }),
  createTexture: (d: GPUTextureDescriptor) => ({ ...d, createView: () => ({}), destroy() {} }),
  createSampler: () => ({}),
  queue: { writeBuffer() {}, writeTexture() {} },
  features: new Set<string>(),
  limits: { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxStorageBuffersPerShaderStage: 8, maxComputeWorkgroupStorageSize: 32768, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 },
}) as unknown as GPUDevice;

/** A 2 x 2 RGBA8 DataTexture (row 0 first). */
function tex(px: number[][], colorSpace: string = THREE.NoColorSpace) {
  const t = new THREE.DataTexture(new Uint8Array(px.flat()), 2, 2);
  t.colorSpace = colorSpace as THREE.ColorSpace;
  t.needsUpdate = true;
  return t;
}
const quad = () => new THREE.PlaneGeometry(1, 1);

describe('alphaTestPlan', () => {
  // mesh 0: 2 triangles; mesh 1: 4 triangles with per-triangle materials (0 alpha, 1 opaque, NONE = the instance's)
  const N = BVH_TRIANGLE_MATERIAL_NONE;
  const pos = (tris: number) => new Float32Array(tris * 9);
  const scene: BvhTraceScene = {
    meshes: [{ positions: pos(2) }, { positions: pos(4), triangleMaterials: new Uint16Array([0, 1, N, 0]) }],
    instances: [
      { mesh: 0, matrixWorld: [], material: 0 }, { mesh: 0, matrixWorld: [], material: 0 }, // one run of two
      { mesh: 0, matrixWorld: [], material: 1 }, // opaque: no run
      { mesh: 0, matrixWorld: [], material: 0 }, // a new run
      { mesh: 1, matrixWorld: [], material: 1 }, // its triangles 0 and 3 cut out
      { mesh: 1, matrixWorld: [], material: 0 }, // triangle 2 (NONE) too: its instance's
    ],
    materials: [{ albedo: [1, 1, 1], alphaCutoff: 0.5 }, { albedo: [1, 1, 1] }],
  };
  const plan = alphaTestPlan(scene, (m) => m === 0);
  it('lists runs of instances and triangles, in instance order', () => {
    expect(plan.runs.map((r) => [...r.instances, ...r.triangles, r.material])).toEqual([
      [0, 2, 0, 2, 0], [3, 4, 0, 2, 0],
      [4, 5, 0, 1, 0], [4, 5, 3, 4, 0],
      [5, 6, 0, 1, 0], [5, 6, 2, 4, 0],
    ]);
  });
  it('flags every triangle some instance draws alpha-tested, per mesh', () => {
    expect(Array.from(plan.flags[0]!)).toEqual([1, 1]);
    expect(Array.from(plan.flags[1]!)).toEqual([1, 0, 1, 1]);
    expect(plan.flaggedTriangles).toBe(5);
  });
  it('no alpha-tested material: no runs, no flags', () => {
    const none = alphaTestPlan(scene, () => false);
    expect(none.runs).toEqual([]);
    expect(none.flags.every((f) => f === null)).toBe(true);
  });
});

describe('three materials -> trace textures (W110)', () => {
  const rm = tex([[0, 255, 0, 255], [0, 128, 255, 255], [0, 64, 0, 255], [0, 32, 255, 255]]);
  it('roughness / metalness maps: one glTF texture, factors alone', () => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.5, roughnessMap: rm, metalnessMap: rm });
    const mesh = new THREE.Mesh(quad(), m);
    const hm = defaultHitMaterial(mesh);
    expect(hm.roughnessMap).toBe(rm);
    expect(hm.roughness).toBe(0.8);
    expect(hm.metalness).toBe(0.5);
    const { scene } = bvhTraceSceneFromObjects(mesh);
    expect(scene.materials![0].roughnessMetalnessTexture).toBe(0);
    expect(scene.textures![0].colorSpace).toBe('linear');
    expect(scene.meshes[0].uvs).toBeTruthy();
  });
  it('two maps combine into g (roughness) / b (metalness)', () => {
    const r = tex([[9, 10, 11, 255], [9, 20, 11, 255], [9, 30, 11, 255], [9, 40, 11, 255]]);
    const mt = tex([[1, 2, 100, 255], [1, 2, 110, 255], [1, 2, 120, 255], [1, 2, 130, 255]]);
    const { scene } = bvhTraceSceneFromObjects(new THREE.Mesh(quad(), new THREE.MeshStandardMaterial({ roughnessMap: r, metalnessMap: mt })));
    const t = scene.textures![scene.materials![0].roughnessMetalnessTexture!];
    expect(Array.from(t.data as Uint8ClampedArray).filter((_, i) => i % 4 === 1)).toEqual([10, 20, 30, 40]); // a DataTexture: no flipY
    expect(Array.from(t.data as Uint8ClampedArray).filter((_, i) => i % 4 === 2)).toEqual([100, 110, 120, 130]);
  });
  it('alphaTest: the cutoff and opacity; alphaMap into the base colour alpha', () => {
    const map = tex([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]], THREE.SRGBColorSpace);
    const alphaMap = tex([[0, 0, 0, 255], [0, 255, 0, 255], [0, 128, 0, 255], [0, 255, 0, 255]]);
    const m = new THREE.MeshStandardMaterial({ map, alphaMap, alphaTest: 0.4, opacity: 0.9 });
    const { scene } = bvhTraceSceneFromObjects(new THREE.Mesh(quad(), m));
    const mat = scene.materials![0];
    expect(mat.alphaCutoff).toBe(0.4);
    expect(mat.opacity).toBe(0.9);
    const t = scene.textures![mat.baseColorTexture!];
    expect(t.colorSpace).toBe('srgb');
    expect(Array.from(t.data as Uint8ClampedArray).filter((_, i) => i % 4 === 3)).toEqual([0, 255, 128, 255]);
  });
  it('emissive map: the factor alone (emissive x intensity) and the texture', () => {
    const em = tex([[255, 255, 255, 255], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]], THREE.SRGBColorSpace);
    const m = new THREE.MeshStandardMaterial({ emissive: new THREE.Color(1, 0.5, 0), emissiveIntensity: 2, emissiveMap: em });
    const { scene } = bvhTraceSceneFromObjects(new THREE.Mesh(quad(), m));
    expect(scene.materials![0].emissive).toEqual([2, 1, 0]);
    expect(scene.materials![0].emissiveTexture).toBeDefined();
  });
});

describe('createRaytracerTraceProvider: W110 textures and the alpha test (tinybvh)', () => {
  const rm = tex([[0, 255, 0, 255], [0, 128, 255, 255], [0, 64, 0, 255], [0, 32, 255, 255]]);
  const cut = tex([[255, 255, 255, 0], [255, 255, 255, 255], [255, 255, 255, 0], [255, 255, 255, 255]], THREE.SRGBColorSpace);
  // node has no GPU for the texture mips: the scene copy's upload is stubbed (buildSceneCopy and everything before it are real)
  const module = { ...rt, uploadSceneCopy: (_d: GPUDevice, copy: { textures: unknown }, o: { packing: string }) => ({ packing: o.packing, packed: {}, table: {}, data: {}, ...(copy.textures ? { textures: { views: [], samplers: [] } } : {}), destroy() {} }) };
  type Materials = { sceneCopy: { materials: { alphaMode: number; roughnessMetalTexture: number; specularRoughness: number; metalness: number; baseColor: number[] }[] } };
  const build = async (options = {}) => {
    const leaves = new THREE.Mesh(quad(), new THREE.MeshStandardMaterial({ map: cut, alphaTest: 0.5, roughness: 0.8, metalness: 1, roughnessMap: rm, metalnessMap: rm }));
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial({ color: 0x808080 }));
    wall.position.z = -1;
    const root = new THREE.Group().add(leaves, wall);
    root.updateMatrixWorld(true);
    const provider = await createRaytracerTraceProvider(fakeDevice(), bvhTraceSceneFromObjects(root).scene, { builder: 'tinybvh', module, ...options });
    return provider as typeof provider & Materials;
  };
  it('flags the alpha-tested mesh\'s triangles in its tree and declares the filter', async () => {
    const provider = await build();
    expect(provider.info.alphaTestRuns).toBe(1);
    expect(provider.info.alphaTestTriangles).toBe(2);
    expect(provider.info.textures).toBe(2);
    expect(provider.info.textureBytes).toBeGreaterThan(0);
    const layouts = (provider as unknown as { layouts: { triangles: ArrayBuffer; triangleCount: number }[] }).layouts;
    const flagsOf = (l: { triangles: ArrayBuffer; triangleCount: number }) => Array.from({ length: l.triangleCount }, (_, k) => new Uint32Array(l.triangles)[(k * GPU_LAYOUT_TRIANGLE_BYTES) / 4 + GPU_LAYOUT_TRIANGLE_WORD.flags] & 1);
    expect(layouts.map(flagsOf)).toEqual([[1, 1], [0, 0]]); // the leaves' tree flagged, the wall's not
  });
  it('the scene copy reads the textures; switched off, their means fold into the factors', async () => {
    const on = await build();
    const m = on.sceneCopy.materials[0];
    expect(m.alphaMode).toBe(1);
    expect(m.roughnessMetalTexture).not.toBe(0xffff);
    expect(m.specularRoughness).toBeCloseTo(0.8, 3);
    const off = await build({ textures: { roughnessMetalness: false, alphaTest: false } });
    const o = off.sceneCopy.materials[0];
    expect(o.alphaMode).toBe(0);
    expect(o.specularRoughness).toBeCloseTo(0.8 * ((255 + 128 + 64 + 32) / 4 / 255), 3);
    expect(o.metalness).toBeCloseTo((255 + 255) / 4 / 255, 3);
    expect(off.info.alphaTestTriangles).toBe(0);
    expect(off.info.textures).toBe(1);
    // textures: false (all off): the base colour's mean too (before W110 this gave the factor alone)
    const none = await build({ textures: false });
    expect(none.info.textures).toBe(0);
    expect(none.sceneCopy.materials[0].baseColor[0]).toBeCloseTo(1, 3);
    expect(traceTextureMean({ width: 1, height: 2, data: [255, 0, 0, 0, 0, 0, 0, 0], colorSpace: 'srgb' })).toEqual([0.5, 0, 0]);
  });
});
