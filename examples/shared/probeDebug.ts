// Probe debug views for the example pages (W61): which probe a pixel reads, how many volumes it
// blends, and the volumes themselves drawn in the scene.
//
//   probeWeights(probes, P)       per-pixel volume weights from world position P, walked as core's
//                                 lookup walks them (table order, smallest first; each takes
//                                 clamp(inside / blendDistance) x what is left). Returns the dominant
//                                 volume's table index, the count of volumes with weight > 0 (each is
//                                 one atlas sample in the lookup: its cost), and the weights' sum,
//                                 which equals the lookup's own coverage. A view check compares that
//                                 sum with the composite's `coverage` (core's walk), so a change in
//                                 core's weights shows up as a failing check, not a lying view.
//   probeColor(i) / heatColor(n)  the palettes (TSL); probePaletteColor(i) on the CPU, same hues.
//   ProbeVolumesOverlay           influence boxes (solid colour of the probe), projection boxes (the
//                                 same colour, dimmed), a dot at each capture point; kept out of the
//                                 captures (`reflectionProbeExclude`) and the BVH (`noTrace`).
import * as THREE from 'three/webgpu';
import { float, getViewPosition, texture, vec3, vec4 } from 'three/tsl';
import { reflectionProbeVolumes, type ReflectionProbes } from '@pmndrs/reflections/three';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Hue of probe `i` (golden-ratio steps, so neighbours in table order differ). */
const hue = (i: number) => (i * 0.618034) % 1;
export const probePaletteColor = (i: number) => new THREE.Color().setHSL(hue(i), 0.8, 0.55);

/** World position of the G-buffer pixel at `at` (as the composite reconstructs it) and the geometry flag. */
export function gbufferWorldPosition(ssr: { gbuffer: { textures: { depth: THREE.Texture } }; uniforms: { projectionInverse: N; cameraWorld: N }; renderer: N }, at: N) {
  const depth: N = texture(ssr.gbuffer.textures.depth, at).x;
  const geometry: N = ssr.renderer.reversedDepthBuffer === true ? depth.greaterThan(0) : depth.lessThan(1);
  const view: N = (getViewPosition as N)(at, depth, ssr.uniforms.projectionInverse);
  const P: N = (ssr.uniforms.cameraWorld as N).mul(vec4(view, 1)).xyz.toVar();
  return { P, geometry };
}

export interface ProbeWeights { dominant: N; count: N; sum: N; volumes: number }

/** The baked set's volume weights at P (see the header); TSL, unrolled over the set's volumes. */
export function probeWeights(probes: ReflectionProbes | null, P: N): ProbeWeights {
  const vols = probes ? reflectionProbeVolumes(probes) : [];
  let remaining: N = float(1).toVar();
  let best: N = float(0).toVar(), dominant: N = float(-1).toVar(), count: N = float(0).toVar();
  vols.forEach((v, k) => {
    const lp: N = P.sub(vec3(...v.center));
    const d: N = vec3(...v.halfSize).sub(lp.abs());
    const inside: N = d.x.min(d.y).min(d.z);
    const w: N = inside.div(Math.max(v.fade ?? 0.5, 1e-6)).clamp(0, 1).mul(remaining).toVar();
    const better: N = w.greaterThan(best);
    dominant = better.select(float(k), dominant).toVar();
    best = better.select(w, best).toVar();
    count = count.add(w.greaterThan(0).select(float(1), float(0))).toVar();
    remaining = remaining.sub(w).toVar();
  });
  return { dominant, count, sum: float(1).sub(remaining), volumes: vols.length };
}

/** The palette colour of table index `i` (a float node; -1: none, dark grey). */
export function probeColor(i: N, n: number): N {
  let c: N = vec3(0.12);
  for (let k = 0; k < n; k++) {
    const p = probePaletteColor(k);
    c = i.equal(float(k)).select(vec3(p.r, p.g, p.b), c);
  }
  return c;
}

/** Blend-count heat: 0 environment only (dark blue), 1 green, 2 yellow, 3 orange, 4 red, 5+ magenta. */
export const HEAT_LEGEND: [string, string][] = [['#0d0d40', '0 (environment)'], ['#1a9933', '1'], ['#f2d91a', '2'], ['#ff800d', '3'], ['#e61a1a', '4'], ['#ff4dff', '5+']];
export function heatColor(n: N): N {
  const stops = [[0.05, 0.05, 0.25], [0.1, 0.6, 0.2], [0.95, 0.85, 0.1], [1, 0.5, 0.05], [0.9, 0.1, 0.1], [1, 0.3, 1]];
  let c: N = vec3(...stops[5]);
  for (let k = 4; k >= 0; k--) c = n.lessThan(k + 0.5).select(vec3(...stops[k]), c);
  return c;
}

/** The volumes of a baked set drawn in the scene (see the header). */
export class ProbeVolumesOverlay extends THREE.Group {
  private readonly dot: THREE.SphereGeometry;
  constructor(probes: ReflectionProbes, dotRadius = 0.08) {
    super();
    this.dot = new THREE.SphereGeometry(dotRadius, 12, 8);
    reflectionProbeVolumes(probes).forEach((v, i) => {
      const c = probePaletteColor(i);
      const half = new THREE.Vector3(...v.halfSize);
      const centre = new THREE.Vector3(...v.center);
      this.add(new THREE.Box3Helper(new THREE.Box3(centre.clone().sub(half), centre.clone().add(half)), c));
      const ps = new THREE.Vector3(...(v.projectionSize ?? v.halfSize.map((h) => h * 2) as [number, number, number]));
      const pc = centre.clone().add(new THREE.Vector3(...(v.projectionOffset ?? [0, 0, 0])));
      const pb = new THREE.Box3Helper(new THREE.Box3().setFromCenterAndSize(pc, ps), c.clone().multiplyScalar(0.45));
      this.add(pb);
      const m = new THREE.Mesh(this.dot, new THREE.MeshBasicMaterial({ color: c }));
      m.position.set(...(v.origin ?? v.center));
      this.add(m);
    });
    // out of the probe captures and the BVH
    this.traverse((o) => { o.userData.reflectionProbeExclude = true; o.userData.noTrace = true; });
  }
  dispose() {
    this.traverse((o) => {
      if ((o as THREE.Box3Helper).isLineSegments) (o as THREE.Box3Helper).dispose();
      else if ((o as THREE.Mesh).isMesh) ((o as THREE.Mesh).material as THREE.Material).dispose();
    });
    this.dot.dispose();
    this.clear();
  }
}
