// three → core's @pmndrs/bvh trace provider (docs/SPEC.md "Trace seam"). The provider and its math
// live in core (`createPmndrsBvhTraceProvider`); this file only turns three objects into the
// engine-free inputs it takes: positions, indices, vertex normals, world matrices and material ids.
//
// - One mesh tree per BufferGeometry, shared by every Mesh that uses it.
// - One instance per Mesh, and per instance of an InstancedMesh (matrixWorld x instanceMatrix).
// - One material entry per three Material (the first of a multi-material mesh; D1702), coloured
//   by `defaultHitMaterial` unless `options.material` says otherwise.
// - Positions are read through the attribute (interleaved, normalized and non-f32 work); morph
//   targets and skinning are not applied (D1703).
// - Vertex normals (the `normal` attribute, read the same way) shade traced hits (D1700); a
//   geometry without them is shaded flat.
import * as THREE from 'three/webgpu';
import {
  createPmndrsBvhTraceProvider, type BvhMeshGeometry, type BvhTraceInstance, type BvhTraceMaterial, type BvhTraceScene,
  type PmndrsBvhTraceProvider, type PmndrsBvhTraceProviderOptions,
} from '@pmndrs/reflections-core';
import { defaultHitMaterial, type HitMaterial } from './MeshBVHTraceProvider';

export interface PmndrsBvhFromObjectsOptions extends PmndrsBvhTraceProviderOptions {
  /** The material a mesh contributes to traced-hit shading. Default {@link defaultHitMaterial}. */
  material?: (mesh: THREE.Mesh) => HitMaterial;
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
 * Engine-free inputs for {@link createPmndrsBvhTraceProvider} from three objects (meshes, groups or
 * whole scenes; their world matrices must be current).
 */
export function bvhTraceSceneFromObjects(objects: THREE.Object3D | THREE.Object3D[], options: Pick<PmndrsBvhFromObjectsOptions, 'material' | 'filter' | 'shadingNormals'> = {}): ThreeBvhTraceScene {
  const filter = options.filter ?? defaultFilter;
  const materialOf = options.material ?? defaultHitMaterial;
  const meshes: BvhMeshGeometry[] = [];
  const meshIds = new Map<THREE.BufferGeometry, number>();
  const materials: BvhTraceMaterial[] = [];
  const materialIds = new Map<THREE.Material | THREE.Mesh, number>();
  const instances: BvhTraceInstance[] = [];
  const sources: ThreeBvhTraceScene['sources'] = [];
  const m = new THREE.Matrix4();
  const visit = (o: THREE.Object3D) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !filter(mesh)) return;
    const position = mesh.geometry?.getAttribute('position');
    if (!position || position.count < 3) return;
    let mi = meshIds.get(mesh.geometry);
    if (mi === undefined) { mi = meshes.length; meshes.push(geometryInput(mesh.geometry, options.shadingNormals !== false)); meshIds.set(mesh.geometry, mi); }
    // One entry per three material, unless a custom material function makes it per mesh.
    const key = options.material ? mesh : (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) ?? mesh;
    let material = materialIds.get(key);
    if (material === undefined) { material = materials.length; materials.push(materialOf(mesh)); materialIds.set(key, material); }
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
  return { scene: { meshes, instances, materials }, sources };
}

/** A core @pmndrs/bvh provider plus the three objects behind it, so it can follow them. */
export interface ThreePmndrsBvhTraceProvider {
  provider: PmndrsBvhTraceProvider;
  /** The engine-free inputs it was built from (instance i = sources[i]). */
  scene: BvhTraceScene;
  sources: ThreeBvhTraceScene["sources"];
  /** Objects moved (same meshes, current world matrices): new top level, mesh trees untouched. */
  refit(): void;
}

/**
 * Build core's @pmndrs/bvh trace provider over three objects:
 *
 *   const { provider, refit } = await createPmndrsBvhTraceProviderFromObjects(device, scene);
 *   ssr.setTraceProvider(provider);
 *   // per frame for moving objects: scene.updateMatrixWorld(); refit();
 */
export async function createPmndrsBvhTraceProviderFromObjects(
  device: GPUDevice,
  objects: THREE.Object3D | THREE.Object3D[],
  options: PmndrsBvhFromObjectsOptions = {},
): Promise<ThreePmndrsBvhTraceProvider> {
  const { scene, sources } = bvhTraceSceneFromObjects(objects, options);
  const provider = await createPmndrsBvhTraceProvider(device, scene, options);
  const m = new THREE.Matrix4();
  return {
    provider,
    scene,
    sources,
    refit() {
      provider.setTransforms(sources.map(({ mesh, instanceId }) => {
        if (instanceId < 0) return mesh.matrixWorld.elements;
        (mesh as THREE.InstancedMesh).getMatrixAt(instanceId, m);
        return new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, m).elements;
      }));
    },
  };
}
