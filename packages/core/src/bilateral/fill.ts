// bilateralFill (W74, plan X4; written to be reused by X5's half-res upsample): a joint bilateral
// gather of a sparse reflection signal (radiance + ray length, hit distance, confidence, hit source)
// guided by the full-resolution G-buffer. After Kopf et al., "Joint Bilateral Upsampling" (SIGGRAPH
// 2007), with the geometric range weights games use instead of a colour guide (docs/research/
// ssr-external-sources.md, section 2): plane distance, a normal power, a roughness difference, and
// the hit source (D3660: neighbours of another source are another signal).
//
// The kernel is a WGSL module plus one function its includer defines, so the same weights serve a
// fill (X4: an untraced miss pixel takes its traced neighbours, in place) and an upsample (X5: a
// full-res pixel takes the half-res samples around it):
//
//   fn bilateralTap(cell: vec2i, pixel: vec2i) -> BilateralTap   // includer
//
// `cell` walks a footprint of the caller's sample grid around `originCell` (X4: 2x2 quads, X5: the
// half-res texels); `pixel` is the full-res pixel being filled, so the includer can pick the
// sample's pixel nearest to it (X4) or a bilinear spatial weight (X5, `spatial`).
//
//   let r = bilateralFill(center, cameraPosition, pixel, originCell, footprint, weights);
//   if (r.weightSum < weights.minWeightSum) { /* no usable neighbour: keep / take the probe */ }
//
// Footprint: 2 = cells originCell + {0, 1}^2 (a bilinear 2x2), 3 = originCell + {-1, 0, 1}^2,
// 4 = originCell + {-1 .. 2}^2. Taps with `spatial` 0, an invalid surface (background, off screen)
// or a source outside `sourceMask` take weight 0.

/** The bilateral weights (WGSL `BilateralWeights`). Every tolerance 0 turns its term off. */
export interface BilateralFillWeights {
  /**
   * Plane distance: a tap q at distance d = |dot(n_p, x_q - x_p)| from the filled pixel's tangent plane
   * weighs saturate(1 - d / (planeTolerance x |x_p - camera|)). Relative to the view distance, so
   * one value serves every scene scale. Default 0.01.
   */
  planeTolerance: number;
  /** Normal term pow(saturate(dot(n_p, n_q)), normalPower). Default 16 (25 degrees: 0.21). */
  normalPower: number;
  /** Roughness term saturate(1 - |r_p - r_q| / roughnessTolerance), perceptual roughness. Default 0.1. */
  roughnessTolerance: number;
  /**
   * Accepted tap hit sources, one bit per code (bit c for code c, codes < 32). The X4 fill passes
   * `RT_SOURCE` codes: default bits 1 (traced hit), 2 (traced miss) and 4 (traced hit shaded from
   * the screen) = 0b10110: a miss pixel takes what the tracer found for its neighbours, not their
   * screen-space hits (bit 0) nor capped entries (bit 3).
   */
  sourceMask: number;
  /** Below this weight sum the result is not used (the caller keeps or takes the probe). Default 0.01. */
  minWeightSum: number;
}

export const DEFAULT_BILATERAL_FILL_WEIGHTS: Readonly<BilateralFillWeights> = Object.freeze({
  planeTolerance: 0.01,
  normalPower: 16,
  roughnessTolerance: 0.1,
  sourceMask: (1 << 1) | (1 << 2) | (1 << 4),
  minWeightSum: 0.01,
});

/** The weights with defaults filled in and clamped to their ranges. */
export function resolveBilateralFillWeights(w: Partial<BilateralFillWeights> = {}): BilateralFillWeights {
  const d = DEFAULT_BILATERAL_FILL_WEIGHTS;
  return {
    planeTolerance: Math.max(0, w.planeTolerance ?? d.planeTolerance),
    normalPower: Math.max(0, w.normalPower ?? d.normalPower),
    roughnessTolerance: Math.max(0, w.roughnessTolerance ?? d.roughnessTolerance),
    sourceMask: (w.sourceMask ?? d.sourceMask) >>> 0,
    minWeightSum: Math.max(0, w.minWeightSum ?? d.minWeightSum),
  };
}

/** Number of source codes the gather tracks for the dominant source (codes >= this never tap). */
export const BILATERAL_SOURCE_CODES = 8;

/**
 * The kernel. Defines `BilateralSurface`, `BilateralTap`, `BilateralWeights`, `BilateralResult`,
 * `bilateralWeight`, `bilateralFill` (linear) and `bilateralFillMajority` (one coverage class, W74 review); needs the
 * includer's `bilateralTap(cell, pixel)`.
 */
export const BILATERAL_FILL_WGSL = /* wgsl */ `
// ---- bilateralFill (core/bilateral/fill.ts) ----
struct BilateralSurface {
  position: vec3f,    // world
  normal: vec3f,      // world, unit
  roughness: f32,     // perceptual
  valid: bool,        // false: background / off screen (never taps, never filled)
};
struct BilateralTap {
  surface: BilateralSurface,
  radiance: vec4f,    // rgb + world ray length (the FFX radiance layout)
  hitDistance: f32,
  confidence: f32,
  source: u32,        // weight 0 unless bit 'source' of sourceMask is set
  spatial: f32,       // the includer's spatial weight (1 flat, bilinear for an upsample); 0 drops the tap
};
struct BilateralWeights {
  planeTolerance: f32,
  normalPower: f32,
  roughnessTolerance: f32,
  sourceMask: u32,
  minWeightSum: f32,
};
struct BilateralResult {
  radiance: vec4f,
  hitDistance: f32,
  confidence: f32,
  source: u32,        // the source code with the largest weight share
  weightSum: f32,     // compare with minWeightSum: below it, don't use the result
  taps: u32,          // taps with weight > 0
};

fn bilateralWeight(p: BilateralSurface, viewDistance: f32, q: BilateralTap, w: BilateralWeights) -> f32 {
  if (!q.surface.valid || q.spatial <= 0.0 || q.source >= ${BILATERAL_SOURCE_CODES}u) { return 0.0; }
  if (((w.sourceMask >> q.source) & 1u) == 0u) { return 0.0; }
  var weight = q.spatial;
  if (w.planeTolerance > 0.0) {
    let d = abs(dot(p.normal, q.surface.position - p.position));
    weight *= saturate(1.0 - d / max(w.planeTolerance * viewDistance, 1e-20));
  }
  if (w.normalPower > 0.0) {
    weight *= pow(saturate(dot(p.normal, q.surface.normal)), w.normalPower);
  }
  if (w.roughnessTolerance > 0.0) {
    weight *= saturate(1.0 - abs(p.roughness - q.surface.roughness) / w.roughnessTolerance);
  }
  return weight;
}

// The gather, split by coverage: class 1 = taps with confidence >= 0.5 (hits), class 0 = the rest
// (misses). Per class: sum w, sum w x radiance.rgb, sum w x confidence, and confidence-weighted
// sums of the ray length and hit distance (a miss's t is 0 by convention, not a distance).
struct BilateralClass {
  weight: f32,
  rgb: vec3f,
  confidence: f32,
  tWeight: f32,       // sum w x confidence
  rayLength: f32,     // sum w x confidence x radiance.w
  hitDistance: f32,   // sum w x confidence x hitDistance
  taps: u32,
  perSource: array<f32, ${BILATERAL_SOURCE_CODES}>,
};
struct BilateralClasses { c: array<BilateralClass, 2> };

fn bilateralGatherClasses(p: BilateralSurface, cameraPosition: vec3f, pixel: vec2i, originCell: vec2i, footprint: u32, w: BilateralWeights) -> BilateralClasses {
  var g: BilateralClasses;
  let viewDistance = length(p.position - cameraPosition);
  let lo = select(-1, 0, footprint == 2u);
  let hi = select(1, 2, footprint == 4u);
  for (var j = lo; j <= hi; j++) {
    for (var i = lo; i <= hi; i++) {
      let q = bilateralTap(originCell + vec2i(i, j), pixel);
      let wq = bilateralWeight(p, viewDistance, q, w);
      if (wq <= 0.0) { continue; }
      let k = select(0u, 1u, q.confidence >= 0.5);
      let wc = wq * q.confidence;
      g.c[k].weight += wq;
      g.c[k].rgb += wq * q.radiance.rgb;
      g.c[k].confidence += wc;
      g.c[k].tWeight += wc;
      g.c[k].rayLength += wc * q.radiance.w;
      g.c[k].hitDistance += wc * q.hitDistance;
      g.c[k].taps += 1u;
      g.c[k].perSource[q.source] += wq;
    }
  }
  return g;
}

// One class (or both merged) to a result: rgb and confidence by weight, ray length and hit distance
// by weight x confidence, the source with the largest weight share.
fn bilateralResolve(a: BilateralClass, b: BilateralClass) -> BilateralResult {
  var r: BilateralResult;
  r.weightSum = a.weight + b.weight;
  r.taps = a.taps + b.taps;
  if (r.weightSum > 0.0) {
    r.radiance = vec4f((a.rgb + b.rgb) / r.weightSum, 0.0);
    r.confidence = (a.confidence + b.confidence) / r.weightSum;
  }
  let tw = a.tWeight + b.tWeight;
  if (tw > 0.0) {
    r.radiance.w = (a.rayLength + b.rayLength) / tw;
    r.hitDistance = (a.hitDistance + b.hitDistance) / tw;
  }
  var best = 0.0;
  for (var s = 0u; s < ${BILATERAL_SOURCE_CODES}u; s++) {
    let v = a.perSource[s] + b.perSource[s];
    if (v > best) { best = v; r.source = s; }
  }
  return r;
}

// Linear: every tap. Radiance and confidence are the weighted means; the ray length and hit distance
// are means over the taps' hits (weighted by confidence), so two hits and two misses give confidence
// 0.5 at the hits' distance, not at half of it.
fn bilateralFill(p: BilateralSurface, cameraPosition: vec3f, pixel: vec2i, originCell: vec2i, footprint: u32, w: BilateralWeights) -> BilateralResult {
  var g = bilateralGatherClasses(p, cameraPosition, pixel, originCell, footprint, w); // var: runtime class index
  return bilateralResolve(g.c[0], g.c[1]);
}

// Majority coverage: the class (hits or misses) with the larger weight wins and the result is that
// class alone, so mixed neighbours never produce a partial confidence (which a depth-aware blend
// such as the three composite's D2400 reads as a thickness falloff) and the source is that class's.
// weightSum is the total over both classes (the minWeightSum gate), taps the winner's.
fn bilateralFillMajority(p: BilateralSurface, cameraPosition: vec3f, pixel: vec2i, originCell: vec2i, footprint: u32, w: BilateralWeights) -> BilateralResult {
  var g = bilateralGatherClasses(p, cameraPosition, pixel, originCell, footprint, w); // var: runtime class index
  var empty: BilateralClass;
  let k = select(0u, 1u, g.c[1].weight >= g.c[0].weight);
  var r = bilateralResolve(g.c[k], empty);
  r.weightSum = g.c[0].weight + g.c[1].weight;
  return r;
}
`;


/** u32 words of `BilateralWeights` in a uniform block, in struct order (5 words). */
export function bilateralFillWeightWords(w: BilateralFillWeights, f: Float32Array, u: Uint32Array, at: number): void {
  f[at] = w.planeTolerance;
  f[at + 1] = w.normalPower;
  f[at + 2] = w.roughnessTolerance;
  u[at + 3] = w.sourceMask;
  f[at + 4] = w.minWeightSum;
}
