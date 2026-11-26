// Code samples for the Babylon page. See three.ts for how these are checked.
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import type { FrameGraphGeometryRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js';
import type { FrameGraphObjectRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask.js';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import type { Scene } from '@babylonjs/core/scene.js';
import {
  BabylonProbeSet,
  FrameGraphReflectionsCompositeTask,
  FrameGraphReflectionsTask,
  ScreenSpaceReflections,
  stripSpecularIBL,
} from '@pmndrs/reflections/babylon';

// #region babylon-engine
export async function createEngine(canvas: HTMLCanvasElement): Promise<WebGPUEngine> {
  // enableAllFeatures: subgroups for the tracer's faster variant. setMaximumLimits: four colour targets.
  const engine = new WebGPUEngine(canvas, { antialias: false, enableAllFeatures: true, setMaximumLimits: true });
  await engine.initAsync();
  return engine;
}
// #endregion

export async function babylonSetup(engine: WebGPUEngine, scene: Scene, skybox: AbstractMesh, materials: PBRMaterial[]) {
  // #region babylon-reflections
  // The composite adds the specular IBL term back from the sources, so take it out of the materials.
  materials.forEach((m) => stripSpecularIBL(m));

  // One probe over the room, plus the environment as a slot.
  const probes = new BabylonProbeSet(scene, { capacity: 1, sourceSize: 128, environment: [skybox] });
  probes.setProbes([{ position: [0, 2, 0], influenceSize: [16, 4.2, 16], projectionSize: [16, 4.2, 12] }]);
  await scene.whenReadyAsync();
  await probes.bake();

  const ssr = new ScreenSpaceReflections({ engine, probes });
  // #endregion
  return { probes, ssr };
}

export function babylonFrameGraph(
  graph: FrameGraph,
  scene: Scene,
  camera: FreeCamera,
  ssr: ScreenSpaceReflections,
  geometry: FrameGraphGeometryRendererTask,
  sky: FrameGraphObjectRendererTask,
) {
  // #region babylon-tasks
  // The geometry task writes world normals, reflectivity and linear velocity. `sky` holds the lit colour and depth.
  const trace = new FrameGraphReflectionsTask('reflections', graph, ssr);
  trace.camera = camera;
  trace.colorTexture = sky.outputTexture;
  trace.depthTexture = sky.outputDepthTexture;
  trace.worldNormalTexture = geometry.geometryWorldNormalTexture;
  trace.reflectivityTexture = geometry.geometryReflectivityTexture;
  trace.velocityTexture = geometry.geometryLinearVelocityTexture;
  graph.addTask(trace);

  const composite = new FrameGraphReflectionsCompositeTask('composite', graph, scene);
  composite.camera = camera;
  composite.sourceTexture = sky.outputTexture;
  composite.depthTexture = sky.outputDepthTexture;
  composite.worldNormalTexture = geometry.geometryWorldNormalTexture;
  composite.reflectivityTexture = geometry.geometryReflectivityTexture;
  composite.velocityTexture = geometry.geometryLinearVelocityTexture;
  composite.radianceTexture = trace.radianceTexture;
  composite.confidenceTexture = trace.confidenceTexture;
  composite.hitDistanceTexture = trace.hitDistanceTexture;
  graph.addTask(composite);
  // #endregion
  return composite;
}
