// three → core's @pmndrs/raytracer trace provider (docs/SPEC.md "Trace seam", P1.5). The provider lives in core
// (`createRaytracerTraceProvider`); this file turns three objects into its engine-free inputs (the same ones
// `bvhTraceSceneFromObjects` builds: positions, indices, vertex normals, world matrices, material ids) and three's
// lights into the provider's own (for `raytracerHitShading`):
//
// - the brightest DirectionalLight is the sun (`colour x intensity` = irradiance, travelling from the light to its
//   target); @pmndrs/raytracer holds one sun, the others are dropped (D5201);
// - the environment is what `options.environment` says (constant radiance or an equirect map with CPU data);
//   three's own `scene.environment` is not read (a GPU texture, no CPU copy);
// - emissive meshes are lights by their material (@pmndrs/raytracer's scene copy builds the triangle lights).
import * as THREE from 'three/webgpu';
import {
  createRaytracerTraceProvider, type RaytracerTraceScene as BvhTraceScene, type RaytracerEnvironment, type RaytracerSun, type RaytracerTraceProvider,
  type RaytracerTraceProviderOptions,
} from '@pmndrs/reflections-core';
import { bvhTraceSceneFromObjects, type PmndrsBvhFromObjectsOptions, type ThreeBvhTraceScene } from './PmndrsBvhTraceProvider';

export interface RaytracerFromObjectsOptions extends RaytracerTraceProviderOptions, Pick<PmndrsBvhFromObjectsOptions, 'material' | 'filter' | 'shadingNormals'> {
  /** The environment `traceHitShade` samples. Default none (black). */
  environment?: RaytracerEnvironment | null;
  /** The sun. Default: the brightest visible DirectionalLight under `objects` (null: none). */
  sun?: RaytracerSun | null;
}

/** The brightest visible DirectionalLight under `objects` as a sun (direction it travels, irradiance), or null. */
export function sunFromObjects(objects: THREE.Object3D | THREE.Object3D[]): RaytracerSun | null {
  let best: RaytracerSun | null = null, bestLum = 0;
  const p = new THREE.Vector3(), t = new THREE.Vector3();
  for (const root of ([] as THREE.Object3D[]).concat(objects)) {
    root.traverseVisible((o) => {
      const light = o as THREE.DirectionalLight;
      if (!light.isDirectionalLight) return;
      const c = light.color, k = light.intensity;
      const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * k;
      if (lum <= bestLum) return;
      light.getWorldPosition(p);
      light.target.getWorldPosition(t);
      const d = t.sub(p).normalize();
      bestLum = lum;
      best = { direction: [d.x, d.y, d.z], irradiance: [c.r * k, c.g * k, c.b * k] };
    });
  }
  return best;
}

/** A core @pmndrs/raytracer provider plus the three objects behind it, so it can follow them. */
export interface ThreeRaytracerTraceProvider extends ThreeBvhTraceScene {
  provider: RaytracerTraceProvider;
  scene: BvhTraceScene;
  /** Objects moved (same meshes, current world matrices): new top level and scene copy, mesh trees untouched. */
  refit(): void;
}

/**
 * Build core's @pmndrs/raytracer trace provider over three objects:
 *
 *   const { provider, refit } = await createRaytracerTraceProviderFromObjects(device, scene);
 *   ssr.setTraceProvider(provider);
 *   // per frame for moving objects: scene.updateMatrixWorld(); refit();
 */
export async function createRaytracerTraceProviderFromObjects(
  device: GPUDevice,
  objects: THREE.Object3D | THREE.Object3D[],
  options: RaytracerFromObjectsOptions = {},
): Promise<ThreeRaytracerTraceProvider> {
  const built = bvhTraceSceneFromObjects(objects, options);
  const sun = options.sun === undefined ? sunFromObjects(objects) : options.sun;
  const scene: BvhTraceScene = { ...built.scene, lights: { sun, environment: options.environment ?? null } };
  const provider = await createRaytracerTraceProvider(device, scene, options);
  const m = new THREE.Matrix4();
  return {
    ...built,
    scene,
    provider,
    refit() {
      provider.setTransforms(built.sources.map(({ mesh, instanceId }) => {
        if (instanceId < 0) return mesh.matrixWorld.elements;
        (mesh as THREE.InstancedMesh).getMatrixAt(instanceId, m);
        return new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, m).elements;
      }));
    },
  };
}
