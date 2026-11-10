// The Babylon ScreenSpaceReflections as a frame-graph task: put it after the geometry render (a
// FrameGraphGeometryRendererTask writing colour, depth, PREPASS_WORLD_NORMAL, PREPASS_REFLECTIVITY and
// PREPASS_VELOCITY_LINEAR) and feed its outputs to a FrameGraphReflectionsCompositeTask (./composite.ts).
//
//   const ssrTask = new FrameGraphReflectionsTask('ssr', graph, ssr);
//   ssrTask.camera = camera;
//   ssrTask.colorTexture = geometry.outputTexture;
//   ssrTask.depthTexture = geometry.outputDepthTexture;
//   ssrTask.worldNormalTexture = geometry.geometryWorldNormalTexture;
//   ssrTask.reflectivityTexture = geometry.geometryReflectivityTexture;
//   ssrTask.velocityTexture = geometry.geometryLinearVelocityTexture;
//   graph.addTask(ssrTask);
//
// After `ssr.configure()` (resize), rebuild the graph: the outputs are new allocations.
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import type { FrameGraphTextureHandle } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';
import type { ScreenSpaceReflections } from './ScreenSpaceReflections';

export class FrameGraphReflectionsTask extends FrameGraphTask {
  /** Linear HDR scene colour (rgba16float), the hit radiance. */
  colorTexture?: FrameGraphTextureHandle;
  depthTexture?: FrameGraphTextureHandle;
  worldNormalTexture?: FrameGraphTextureHandle;
  reflectivityTexture?: FrameGraphTextureHandle;
  velocityTexture?: FrameGraphTextureHandle;
  camera?: Camera;
  /** rgba16float: lerp(fallback, hit, confidence), world ray length in w. */
  readonly radianceTexture: FrameGraphTextureHandle;
  /** r32float hit confidence. */
  readonly confidenceTexture: FrameGraphTextureHandle;
  /** r32float world hit distance. */
  readonly hitDistanceTexture: FrameGraphTextureHandle;
  readonly reflections: ScreenSpaceReflections;

  constructor(name: string, frameGraph: FrameGraph, reflections: ScreenSpaceReflections) {
    super(name, frameGraph);
    this.reflections = reflections;
    const m = frameGraph.textureManager;
    this.radianceTexture = m.createDanglingHandle();
    this.confidenceTexture = m.createDanglingHandle();
    this.hitDistanceTexture = m.createDanglingHandle();
  }

  override getClassName() { return 'FrameGraphReflectionsTask'; }

  override record(): void {
    const m = this._frameGraph.textureManager;
    const { colorTexture: color, depthTexture: depth, worldNormalTexture: normal, reflectivityTexture: reflectivity, velocityTexture: velocity, camera } = this;
    if (color === undefined || depth === undefined || normal === undefined || reflectivity === undefined || velocity === undefined || !camera) {
      throw new Error(`FrameGraphReflectionsTask "${this.name}": colorTexture, depthTexture, worldNormalTexture, reflectivityTexture, velocityTexture and camera must be set.`);
    }
    const ssr = this.reflections;
    m.resolveDanglingHandle(this.radianceTexture, m.importTexture(`${this.name} radiance`, ssr.radiance));
    m.resolveDanglingHandle(this.confidenceTexture, m.importTexture(`${this.name} confidence`, ssr.confidence));
    m.resolveDanglingHandle(this.hitDistanceTexture, m.importTexture(`${this.name} hit distance`, ssr.hitDistance));
    // Generic passes declare their reads at task level; without them the graph's texture aliasing
    // could hand an input's memory to a later task.
    this.dependencies = new Set([color, depth, normal, reflectivity, velocity]);
    const get = (h: FrameGraphTextureHandle): InternalTexture => {
      const t = m.getTextureFromHandle(h);
      if (!t) throw new Error(`FrameGraphReflectionsTask "${this.name}": input texture ${h} is not allocated.`);
      return t;
    };
    const pass = this._frameGraph.addPass(this.name);
    pass.setExecuteFunc(() => {
      ssr.dispatch({ color: get(color), depth: get(depth), worldNormal: get(normal), reflectivity: get(reflectivity), velocity: get(velocity) }, camera);
    });
  }
}
