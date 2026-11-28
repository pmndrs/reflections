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
// W112 (T77): "samples it" means "references it": a graph that holds `sample()` behind a uniform-picked
// branch (a debug-view select) still renders GTAO every frame (~6 ms at 1080p). The pages construct it
// only when specOcc or the `ao` view reads it, and rebuild their display when that changes.
//
// W111 (T8, D5780): GTAO turns its slice directions by a 5 x 5 tiled pattern (and jitters its steps), so
// its raw output carries a fixed grain that reached rough surfaces through the specular occlusion and
// crawled under motion. `sample()` now filters it where it is read: a 5 x 5 box over the tile, each tap
// weighted by its distance to the centre's surface plane and by normal agreement (a cross-bilateral
// blur, the spatial denoise GTAO's own docs ask for when temporal filtering is off). No extra pass and
// no history: still nothing changes at rest. `denoise: false` reads the raw GTAO. Cost ~2 ms per frame at
// 1080p over the raw GTAO (W111, a shared GPU); three's DenoiseNode through an RTT pass cost more.
import * as THREE from 'three/webgpu';
import { abs, dot, float, getViewPosition, isBackgroundDepth, max, pow, select, texture, textureSize, uniform, vec2, vec4 } from 'three/tsl';
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
  /** Depth- and normal-aware 5 x 5 filter over GTAO's noise tile, applied in `sample()`. Default true (W111). */
  denoise?: boolean;
}

export class ScreenSpaceAO {
  /** The GTAO node (its uniforms: radius, thickness, scale, samples, distanceFallOff). */
  readonly node: N;
  /** Whether `sample()` filters (the `denoise` option). */
  readonly denoise: boolean;
  private readonly tex: N;
  private readonly depth: N;
  private readonly normal: (uv: N) => N;
  private readonly view: N;
  private readonly projInv: N;

  constructor(gbuffer: FrameGBuffer, camera: THREE.Camera, o: ScreenSpaceAOOptions = {}) {
    const g = gbuffer.textures;
    // GTAO reads view-space normals with `normalNode.sample(uv)`: the G-buffer's are world space
    this.view = uniform(camera.matrixWorldInverse);
    this.projInv = uniform(camera.projectionMatrixInverse);
    this.depth = texture(g.depth);
    this.normal = (uv: N): N => texture(g.normalRoughness!, uv).xyz;
    const normals = { sample: (uv: N): N => vec4(this.view.mul(vec4(this.normal(uv), 0)).xyz, 1) };
    this.node = (gtao as N)(texture(g.depth), normals, camera);
    this.node.radius.value = o.radius ?? 0.5;
    this.node.samples.value = o.samples ?? 16;
    this.node.scale.value = o.scale ?? 1;
    this.tex = this.node.getTextureNode();
    this.denoise = o.denoise !== false;
  }

  /** AO in [0, 1] (1 = open) at screen uv. */
  sample(uv: N): N {
    if (!this.denoise) return float(this.tex.sample(uv).r);
    return this.filtered(uv);
  }

  /** The 5 x 5 depth- and normal-aware filter at `uv` (D5780). */
  private filtered(uv: N): N {
    const raw = float(this.tex.sample(uv).r);
    const texel = vec2(1).div(vec2((textureSize as N)(this.depth, 0)));
    const d0 = this.depth.sample(uv).x;
    const p0 = getViewPosition(uv, d0, this.projInv);
    const n0 = this.normal(uv);
    const nv0 = this.view.mul(vec4(n0, 0)).xyz;
    // plane tolerance: 2 % of the view distance (a tap off the centre's surface by more gets no weight)
    const tol = abs(p0.z).mul(0.02).add(1e-4);
    let sum: N = raw;
    let wsum: N = float(1);
    for (let y = -2; y <= 2; y++) {
      for (let x = -2; x <= 2; x++) {
        if (x === 0 && y === 0) continue;
        const u = uv.add(texel.mul(vec2(x, y)));
        const d = this.depth.sample(u).x;
        const plane = abs(dot(getViewPosition(u, d, this.projInv).sub(p0), nv0));
        const w = max(float(1).sub(plane.div(tol)), 0).mul(pow(max(dot(this.normal(u), n0), 0), 8));
        sum = sum.add(float(this.tex.sample(u).r).mul(w));
        wsum = wsum.add(w);
      }
    }
    return select(isBackgroundDepth(d0), raw, sum.div(wsum));
  }

  dispose() { this.node.dispose?.(); }
}
