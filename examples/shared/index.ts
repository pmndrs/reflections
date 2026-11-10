// The scene kit: procedural reflection test scenes, the denoiser repo's verification scenes, and
// glTF scenes from downloaded assets. See ./kit.ts for the KitScene shape.
import { boxRoom, contact, facingMirrors, mirrorWall, moving, offscreen, roughnessRamp } from './scenes';
import { explainer } from './explainer';
import { rooms } from './rooms';
import type { SceneFactory } from './kit';

export * from './kit';
export { boxRoom, contact, facingMirrors, mirrorWall, moving, offscreen, roughnessRamp, explainer, rooms };
export { ASSET_SCENES, assetUrl, availableAssets, loadGLTF, onMirrorFloor, type AssetEntry, type MirrorFloorOptions } from './gltf';

/** Every procedural scene by id (no downloads needed). */
export const SCENES: Record<string, SceneFactory> = { mirrorWall, offscreen, contact, roughnessRamp, boxRoom, moving, explainer, rooms, facingMirrors };
