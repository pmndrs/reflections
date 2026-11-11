// A screen-space ambient occlusion source for the example pages (W39): three r187's GTAO node
// (three/addons/tsl/display/GTAONode.js) run on the frame-contract G-buffer (FrameGBuffer depth and
// world normals, turned to view space), so the pages can hand the hybrid composite an `ao` input and
// show Lagarde's specular occlusion (D66) on and off. Examples only: the library takes any AO the app has.
//
//   const ao = new ScreenSpaceAO(ssr.gbuffer, camera);
//   hybrid.options.ao = (uv) => ao.sample(uv);  hybrid.rebuild();
//
// GTAO renders once per frame (its `updateBefore`) the first time a material that samples it is drawn:
// the hybrid signal pass in `hybrid.update()`, after `ssr.render()` wrote this frame's G-buffer. No
// temporal filtering (the node's `useTemporalFiltering` stays off), so it does not flicker at rest.
import * as THREE from 'three/webgpu';
import { float, texture, uniform, vec4 } from 'three/tsl';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import type { FrameGBuffer } from '@pmndrs/reflections/three';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface ScreenSpaceAOOptions {
  /** World-space radius (GTAO `radius`). Default 0.5. */
  radius?: number;
  /** GTAO samples per pixel. Default 16. */
  samples?: number;
  /** Intensity (GTAO `scale`). Default 1. */
  scale?: number;
}

export class ScreenSpaceAO {
  /** The GTAO node (its uniforms: radius, thickness, scale, samples, distanceFallOff). */
  readonly node: N;
  private readonly tex: N;

  constructor(gbuffer: FrameGBuffer, camera: THREE.Camera, o: ScreenSpaceAOOptions = {}) {
    const g = gbuffer.textures;
    // GTAO reads view-space normals with `normalNode.sample(uv)`: the G-buffer's are world space
    const view: N = uniform(camera.matrixWorldInverse);
    const normals = { sample: (uv: N): N => vec4(view.mul(vec4(texture(g.normalRoughness!, uv).xyz, 0)).xyz, 1) };
    this.node = (gtao as N)(texture(g.depth), normals, camera);
    this.node.radius.value = o.radius ?? 0.5;
    this.node.samples.value = o.samples ?? 16;
    this.node.scale.value = o.scale ?? 1;
    this.tex = this.node.getTextureNode();
  }

  /** AO in [0, 1] (1 = open) at screen uv. */
  sample(uv: N): N { return float(this.tex.sample(uv).r); }

  dispose() { this.node.dispose?.(); }
}
