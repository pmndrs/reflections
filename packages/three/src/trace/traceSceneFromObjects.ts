// three objects → the engine-free inputs of core's trace provider (docs/SPEC.md "Trace seam"; `createRaytracerTraceProvider`,
// wrapped for three by ./RaytracerTraceProvider.ts): positions, indices, vertex normals, world matrices and material ids.
// (W89: the @pmndrs/bvh wrapper provider this file also built is deleted; the raytracer is the one provider.)
//
// - One mesh tree per BufferGeometry, shared by every Mesh that uses it (per BufferGeometry and
//   material table of its groups, for multi-material meshes).
// - One instance per Mesh, and per instance of an InstancedMesh (matrixWorld x instanceMatrix).
// - One material entry per three Material, coloured by `defaultHitMaterial` unless
//   `options.material` says otherwise (then one per mesh and material). A multi-material mesh
//   (material array + geometry groups) stays one mesh and instance, each triangle carrying its
//   group's material (`triangleMaterials`, W49, D1701 / D1702), as @pmndrs/bvh's own `/three` folds
//   it; the instance carries the first material, for triangles no group draws.
// - Positions are read through the attribute (interleaved, normalized and non-f32 work); morph
//   targets and skinning are not applied (D1703).
// - Vertex normals (the `normal` attribute, read the same way) shade traced hits (D1700); a
//   geometry without them is shaded flat.
import * as THREE from 'three/webgpu';
import { BVH_TRIANGLE_MATERIAL_NONE, type BvhMeshGeometry, type BvhTraceInstance, type BvhTraceMaterial, type BvhTraceScene, type BvhTraceTexture } from '@pmndrs/reflections-core';
import { defaultHitMaterial, hitMaterialSource, textureMeanColor, textureTexels, type HitMaterial, type HitMaterialSource } from './hitMaterial';
import { isMultiMaterial, triangleMaterialIndices } from './materialGroups';

export interface TraceSceneFromObjectsOptions {
  /**
   * The material a mesh contributes to traced-hit shading. Default {@link defaultHitMaterial}. A
   * multi-material mesh is asked once per material its groups draw with (`source`, W49).
   */
  material?: (mesh: THREE.Mesh, source: HitMaterialSource) => HitMaterial;
  /** Which meshes to trace. Default: visible meshes that aren't helpers and don't set `userData.noTrace`. */
  filter?: (mesh: THREE.Mesh) => boolean;
  /** Pass the geometries' vertex normals for the shading normal (D1700). Default true. */
  shadingNormals?: boolean;
}

/** What {@link bvhTraceSceneFromObjects} built, with the three objects behind each instance. */
export interface ThreeBvhTraceScene {
  scene: BvhTraceScene;
  /** The mesh behind each instance, and its InstancedMesh index (-1 for a plain mesh). */
  sources: { mesh: THREE.Mesh; instanceId: number }[];
  /** What made each entry of `scene.materials`: the (first) mesh asked and which of its materials. */
  materialSources: ({ mesh: THREE.Mesh } & HitMaterialSource)[];
  /**
   * The `scene.materials` entry a hit on `mesh` with three's `face.materialIndex` reports (the
   * group's material for a multi-material mesh, else the mesh's), or undefined for a mesh not traced.
   */
  materialIdOf(mesh: THREE.Mesh, materialIndex?: number): number | undefined;
}

const defaultFilter = (m: THREE.Mesh) => !(m as unknown as { isHelper?: boolean }).isHelper && !m.userData.noTrace;

/** An attribute as tightly packed `x, y, z` floats (the array itself when it already is). */
function vec3Array(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  if (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && a.array instanceof Float32Array && a.itemSize === 3 && !a.normalized) return a.array;
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) out.set([a.getX(i), a.getY(i), a.getZ(i)], i * 3);
  return out;
}

function geometryInput(geometry: THREE.BufferGeometry, shadingNormals: boolean): BvhMeshGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  let positions = vec3Array(position);
  const normal = shadingNormals ? geometry.getAttribute('normal') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined : undefined;
  const normals = normal && normal.count === position.count && normal.itemSize >= 3 ? vec3Array(normal) : null;
  const index = geometry.getIndex();
  let indices: Uint16Array | Uint32Array | null = null;
  if (index) indices = index.array instanceof Uint16Array || index.array instanceof Uint32Array ? index.array : Uint32Array.from(index.array as ArrayLike<number>);
  // A trailing partial triangle (malformed input) is dropped rather than refused.
  if (indices && indices.length % 3) indices = indices.slice(0, indices.length - (indices.length % 3));
  if (!indices && positions.length % 9) positions = positions.slice(0, positions.length - (positions.length % 9));
  return { positions, indices, normals };
}

/**
 * Engine-free inputs for core's `createRaytracerTraceProvider` from three objects (meshes, groups or
 * whole scenes; their world matrices must be current).
 */
export function bvhTraceSceneFromObjects(objects: THREE.Object3D | THREE.Object3D[], options: TraceSceneFromObjectsOptions = {}): ThreeBvhTraceScene {
  const filter = options.filter ?? defaultFilter;
  const materialOf = options.material ?? defaultHitMaterial;
  const meshes: BvhMeshGeometry[] = [];
  // the mesh tree per geometry and, for a multi-material mesh, the entries its groups take ('' for none)
  const meshIds = new Map<THREE.BufferGeometry, Map<string, number>>();
  const materials: BvhTraceMaterial[] = [];
  const materialSources: ThreeBvhTraceScene['materialSources'] = [];
  const materialIds = new Map<unknown, number>();
  // per traced mesh: its instance's entry and, multi-material, the entry of each materialIndex its groups use
  const meshMaterials = new Map<THREE.Mesh, { instance: number; groups: Map<number, number> | null }>();
  const groupIndices = new Map<THREE.BufferGeometry, Int32Array>();
  const instances: BvhTraceInstance[] = [];
  const sources: ThreeBvhTraceScene['sources'] = [];
  const m = new THREE.Matrix4();
  // One entry per three material, unless a custom material function makes it per mesh and material.
  // W97: base colour maps, decoded once per texture; the materials that use one, and the mesh trees that then need uvs.
  // W110: also roughness / metalness (one glTF texture, or two combined into g / b), emissive, and a base colour + alphaMap
  // combination for the alpha test. A map that can't be decoded keeps its mean (D902).
  const textures: BvhTraceTexture[] = [];
  const textureIds = new Map<unknown, number>();
  const texturedMaterials = new Set<number>();
  const wrapOf = (t: THREE.Texture) => (t.wrapS === THREE.ClampToEdgeWrapping ? 'clamp' : t.wrapS === THREE.MirroredRepeatWrapping ? 'mirror' : 'repeat');
  const addTexture = (key: unknown, make: () => BvhTraceTexture | null) => {
    let id = textureIds.get(key);
    if (id === undefined) {
      const t = make();
      if (!t) return undefined;
      id = textures.length;
      textures.push(t);
      textureIds.set(key, id);
    }
    return id;
  };
  const textureOf = (t: THREE.Texture) => addTexture(t, () => {
    const texels = textureTexels(t);
    return texels && { ...texels, colorSpace: t.colorSpace === THREE.SRGBColorSpace ? 'srgb' : 'linear', wrap: wrapOf(t), label: t.name || undefined };
  });
  /** `a` and `b` decoded at `a`'s size (`b` nearest), combined texel by texel (`b` may be absent). */
  const combine = (a: THREE.Texture, b: THREE.Texture | undefined, colorSpace: 'srgb' | 'linear', f: (out: Uint8ClampedArray, o: number, ta: Uint8ClampedArray, tb: Uint8ClampedArray | null, ob: number) => void) => {
    const da = textureTexels(a), db = b ? textureTexels(b) : null;
    if (!da || (b && !db)) return null;
    const { width, height } = da;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const ob = db ? (Math.floor((y * db.height) / height) * db.width + Math.floor((x * db.width) / width)) * 4 : 0;
      f(data, o, da.data, db?.data ?? null, ob);
    }
    return { width, height, data, colorSpace, wrap: wrapOf(a), label: a.name || undefined } as BvhTraceTexture;
  };
  // base colour (sRGB) with three's alphaMap (green) multiplied into its alpha, or white with that alpha when there's no map
  const alphaMapped = (map: THREE.Texture | undefined, alphaMap: THREE.Texture) => addTexture(`${map?.uuid ?? '-'}+${alphaMap.uuid}:alpha`, () => (map
    ? combine(map, alphaMap, 'srgb', (out, o, ta, tb, ob) => { out[o] = ta[o]; out[o + 1] = ta[o + 1]; out[o + 2] = ta[o + 2]; out[o + 3] = (ta[o + 3] * tb![ob + 1]) / 255; })
    : combine(alphaMap, undefined, 'srgb', (out, o, ta) => { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = ta[o + 1]; })));
  // glTF metallic-roughness: g roughness, b metalness; three's two maps (or one) combined when they differ
  const roughMetal = (rough: THREE.Texture | undefined, metal: THREE.Texture | undefined) => {
    if (rough && metal && rough === metal) return rough.colorSpace === THREE.SRGBColorSpace ? undefined : textureOf(rough);
    const a = (rough ?? metal)!, b = rough && metal ? metal : undefined;
    return addTexture(`${rough?.uuid ?? '-'}+${metal?.uuid ?? '-'}:rm`, () => combine(a, b, 'linear', (out, o, ta, tb, ob) => {
      out[o] = 0; out[o + 3] = 255;
      out[o + 1] = rough ? ta[o + 1] : 255;
      out[o + 2] = metal ? (tb ? tb[ob + 2] : ta[o + 2]) : 255;
    }));
  };
  const scaled = (c: readonly number[] | undefined, k: readonly number[]) => c?.map((x, i) => x * k[i]) as [number, number, number] | undefined;
  const traceMaterial = (hm: HitMaterial): BvhTraceMaterial => {
    const { map, roughnessMap, metalnessMap, emissiveMap, alphaTest, opacity, alphaMap, ...m } = hm;
    const out: { -readonly [K in keyof BvhTraceMaterial]: BvhTraceMaterial[K] } = { ...m };
    // a linear colour map can't be base colour in the scene copy: its mean, as a map that can't be decoded
    const colorMap = map && map.colorSpace === THREE.SRGBColorSpace ? map : undefined;
    const base = alphaMap ? alphaMapped(colorMap, alphaMap) : colorMap && textureOf(colorMap);
    if (base !== undefined) out.baseColorTexture = base;
    if (map && (base === undefined || !colorMap)) out.baseColor = scaled(m.baseColor, textureMeanColor(map) ?? [1, 1, 1]);
    if (alphaTest) { out.alphaCutoff = alphaTest; out.opacity = opacity ?? 1; }
    if (roughnessMap || metalnessMap) {
      const id = roughMetal(roughnessMap, metalnessMap);
      if (id !== undefined) out.roughnessMetalnessTexture = id;
      else {
        if (roughnessMap) out.roughness = (m.roughness ?? 1) * (textureMeanColor(roughnessMap)?.[1] ?? 1);
        if (metalnessMap) out.metalness = (m.metalness ?? 0) * (textureMeanColor(metalnessMap)?.[2] ?? 1);
      }
    }
    if (emissiveMap) {
      const id = textureOf(emissiveMap);
      if (id !== undefined) out.emissiveTexture = id;
      else out.emissive = scaled(m.emissive, textureMeanColor(emissiveMap) ?? [1, 1, 1]);
    }
    return out;
  };
  const entry = (mesh: THREE.Mesh, source: HitMaterialSource) => {
    const key = options.material ? `${mesh.id}:${source.materialIndex}` : source.material ?? mesh;
    let id = materialIds.get(key);
    if (id === undefined) {
      id = materials.length;
      const m = traceMaterial(materialOf(mesh, source));
      if (m.baseColorTexture !== undefined || m.roughnessMetalnessTexture !== undefined || m.emissiveTexture !== undefined) texturedMaterials.add(id);
      materials.push(m); materialSources.push({ mesh, ...source }); materialIds.set(key, id);
    }
    return id;
  };
  const meshGeometries: THREE.BufferGeometry[] = [];
  const needUvs = new Set<number>();
  const visit = (o: THREE.Object3D) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !filter(mesh)) return;
    const position = mesh.geometry?.getAttribute('position');
    if (!position || position.count < 3) return;
    const material = entry(mesh, hitMaterialSource(mesh));
    // W49 (D1701 / D1702): the materials of a multi-material mesh's groups, per triangle
    let tri: Int32Array | null = null, groups: Map<number, number> | null = null, signature = '';
    if (isMultiMaterial(mesh)) {
      tri = groupIndices.get(mesh.geometry) ?? null;
      if (!tri) groupIndices.set(mesh.geometry, tri = triangleMaterialIndices(mesh.geometry));
      groups = new Map();
      for (const i of new Set(tri)) if (i >= 0 && mesh.material[i]) groups.set(i, entry(mesh, { material: mesh.material[i], materialIndex: i }));
      // every group drawn with the instance's entry: the tree needs no per-triangle materials
      if ([...groups.values()].some((id) => id !== material)) signature = [...groups].sort((a, b) => a[0] - b[0]).map(([i, id]) => `${i}:${id}`).join(',');
    }
    meshMaterials.set(mesh, { instance: material, groups });
    let trees = meshIds.get(mesh.geometry);
    if (!trees) meshIds.set(mesh.geometry, trees = new Map());
    let mi = trees.get(signature);
    if (mi === undefined) {
      mi = meshes.length;
      const input = geometryInput(mesh.geometry, options.shadingNormals !== false);
      let triangleMaterials: Uint16Array | null = null;
      if (signature && tri && groups) {
        triangleMaterials = new Uint16Array(tri.length).fill(BVH_TRIANGLE_MATERIAL_NONE);
        for (let t = 0; t < tri.length; t++) { const id = groups.get(tri[t]); if (id !== undefined) triangleMaterials[t] = id; }
      }
      meshes.push(triangleMaterials ? { ...input, triangleMaterials } : input);
      meshGeometries.push(mesh.geometry);
      trees.set(signature, mi);
    }
    if (texturedMaterials.has(material) || (groups && [...groups.values()].some((id) => texturedMaterials.has(id)))) needUvs.add(mi);
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m);
        instances.push({ mesh: mi, matrixWorld: new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, m).elements, material });
        sources.push({ mesh, instanceId: i });
      }
    } else {
      instances.push({ mesh: mi, matrixWorld: mesh.matrixWorld.elements.slice(), material });
      sources.push({ mesh, instanceId: -1 });
    }
  };
  for (const root of ([] as THREE.Object3D[]).concat(objects)) root.traverseVisible(visit);
  // W97: uvs (three's, as they are: `textureTexels` flipped the rows to match) for the trees a textured material is drawn on
  for (const mi of needUvs) {
    const uv = meshGeometries[mi].getAttribute('uv') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!uv || uv.count !== meshGeometries[mi].getAttribute('position').count) continue;
    const uvs = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) { uvs[i * 2] = uv.getX(i); uvs[i * 2 + 1] = uv.getY(i); }
    meshes[mi] = { ...meshes[mi], uvs };
  }
  // (no textured mesh has uvs: core's provider folds the textures' means into the materials, W110)
  const materialIdOf = (mesh: THREE.Mesh, materialIndex = 0) => {
    const e = meshMaterials.get(mesh);
    return e && (e.groups?.get(materialIndex) ?? e.instance);
  };
  return { scene: { meshes, instances, materials, ...(textures.length ? { textures } : {}) }, sources, materialSources, materialIdOf };
}
