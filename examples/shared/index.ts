// The scene kit: procedural reflection test scenes, the denoiser repo's verification scenes, and
// glTF scenes from downloaded assets. See ./kit.ts for the KitScene shape.
import { boxRoom, contact, facingMirrors, mirrorWall, moving, offscreen, roughnessRamp } from './scenes';
import { explainer } from './explainer';
import { rooms } from './rooms';
import type { SceneFactory } from './kit';

export * from './kit';
export { boxRoom, contact, facingMirrors, mirrorWall, moving, offscreen, roughnessRamp, explainer, rooms };
export { ASSET_SCENES, assetUrl, availableAssets, loadGLTF, modelBounds, onMirrorFloor, standOnFloor, type AssetEntry, type MirrorFloorOptions } from './gltf';

/** Every procedural scene by id (no downloads needed). */
export const SCENES: Record<string, SceneFactory> = { mirrorWall, offscreen, contact, roughnessRamp, boxRoom, moving, explainer, rooms, facingMirrors };
export {
  PROBE_LAYOUT_BUDGET, PROBE_LAYOUT_NAMES, PROBE_LAYOUT_SCENES, PROBE_LAYOUT_TOLERANCE, LAYOUT_SET_RESOLUTION, cubeBytes, floorSlab, gridProbes, hasProbeLayouts, layoutBytes, probeLayout,
  type LayoutRegion, type ProbeLayout, type ProbeLayoutName,
} from './probeLayouts';
