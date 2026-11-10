// Environment radiance from a baked ReflectionProbes set: per-pixel volume weights, box projection,
// and the cube lookup done by hand on a 2D array (three r187 can't bind cube arrays).
//
// Port of ReflectionProbesNode.js from three.js PR #35046 (Ben Houston). Same weights, priority,
// projection, roughness-to-mip mapping (maxLod * r * (2 - r)) and capture behaviour. The one
// difference is `sampleProbe`: #35046 does `cubeArray.sample( dir ).depth( i ).level( lod )` and
// the sampler picks the face and filters across face edges; here the node picks the face, samples
// layer `6 i + face` of the array, and handles edges per `probes.bakedSeamFix`:
//   'none'  one trilinear sample; the sampler's clamp-to-edge repeats each face's edge texel over
//           the last half texel (no blend with the neighbour face).
//   'warp'  the bake centred each face's edge texels on the edge, so neighbouring faces agree
//           there; uv is scaled by (size - 1) / size per mip, which needs the two mips sampled
//           separately (2 bilinear samples instead of 1 trilinear).
//
// Two ways in, two outputs, one lookup:
//   reflectionProbes( probes )                     scene.environmentNode: every physical material
//                                                  samples at its own fragment, reflection vector and
//                                                  roughness (#35046 as of 2026-10-16 to 10-22).
//   sampleReflectionProbes( probes, P, dir, rough ) any world position, direction and roughness, in
//                                                  any shader: a traced ray's miss, a full-screen
//                                                  composite, a hit point (not in #35046).
//   reflectionProbesLocal( probes ) and            the same lookups with the coverage output of
//   sampleReflectionProbesLocal( ... )             #35046 head (77bbaaaa05): vec4( conditional probe
//                                                  radiance, coverage ), no environment fallback. The
//                                                  hybrid resolve composes SSR, probes and environment
//                                                  from it.
// All are a ReflectionProbesNode; the explicit ones get their inputs instead of reading them from
// the material. Everything after that (influence, blending, priority, box projection) is the same
// code; the vec3 form adds the environment slot for whatever weight is left.
//
// Uniforms live in three's shared `renderGroup`, not the default per-object group: r186 re-uploads
// per-object uniforms only for render objects it sees change, so probe moves, `boxProjection` and
// the like never reached static meshes. A bake that replaces the texture bumps the node (see
// ReflectionProbes.bake), and the texture id is in the cache key, so every render object rebinds.

import * as THREE from 'three/webgpu';
import { float, Fn, If, int, materialEnvRotation, min, mix, nodeObject, normalize, positionWorld, reflectVector, renderGroup, step, uniform, vec2, vec3, vec4, texture } from 'three/tsl';
import { probeOrigin, type ReflectionProbes } from './ReflectionProbes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any; // TSL's node typings are too strict for hand-written shader maths

const _scale = new THREE.Vector3();

interface Slot { position: N; origin: N; extent: N; fade: N; projectionSize: N; projectionOffset: N }

/** A uniform in the shared per-render group (see the file header). */
const shared = (value: unknown): N => (uniform(value as never) as N).setGroup(renderGroup);

/** Explicit lookup inputs (see {@link sampleReflectionProbes}); absent, the material provides them. */
export interface ProbeLookupInputs { position: N; direction: N; roughness: N }

/**
 * Options of {@link ReflectionProbesNode}: #35046's `{ position, direction, roughness }` (each
 * optional; a missing one comes from the material) plus `coverage`.
 */
export interface ProbeLookupOptions {
  position?: N;
  direction?: N;
  roughness?: N;
  /**
   * Output `vec4( conditional probe radiance, coverage )` with no environment fallback, like
   * #35046 head, instead of `vec3` radiance with the environment for the uncovered rest. Default false.
   */
  coverage?: boolean;
}

/**
 * Box-projected direction (Lagarde's BPCEM, the guarded form from #35046): where the ray from `P`
 * along `dir` leaves the projection box (size `boxSize`, centre `boxPos`), as a direction from the
 * capture point `origin` (the box centre in #35046).
 */
export const parallaxCorrect = /* @__PURE__ */ Fn(([P, dir, boxSize, boxPos, origin]: N[]) => {
  const d = normalize(dir).toVar();
  // +1 / -1 per axis. (r186 TSL turns a bvec3 select into `if ( all( c ) )`, so no vector select here.)
  const side = step(0, d).mul(2).sub(1).toVar();
  // keep axis-aligned directions away from zero so the distances stay finite
  const safe = side.mul(d.abs().max(1e-6));
  const dist = side.mul(boxSize.mul(0.5)).add(boxPos).sub(P).div(safe).toVar();
  return P.add(d.mul(min(dist.x, dist.y, dist.z))).sub(origin);
}) as N;

/**
 * Cube face and face uv of a direction, by WebGPU's cube face rules, in three's cube convention
 * (x mirrored, as CubeTextureNode samples). Returns vec3( u, v, face ).
 */
export const cubeFaceUV = /* @__PURE__ */ Fn(([dir]: N[]) => {
  const h = vec3(dir.x.negate(), dir.y, dir.z).toVar();
  const a = h.abs().toVar();
  const xMajor = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
  const yMajor = xMajor.not().and(a.y.greaterThanEqual(a.z));
  const ma = xMajor.select(a.x, yMajor.select(a.y, a.z));
  const face = xMajor.select(h.x.lessThan(0).select(1, 0), yMajor.select(h.y.lessThan(0).select(3, 2), h.z.lessThan(0).select(5, 4)));
  const sc = xMajor.select(h.x.lessThan(0).select(h.z, h.z.negate()), yMajor.select(h.x, h.z.lessThan(0).select(h.x.negate(), h.x)));
  const tc = xMajor.select(h.y.negate(), yMajor.select(h.y.lessThan(0).select(h.z.negate(), h.z), h.y.negate()));
  const uv = vec2(sc, tc).div(ma).mul(0.5).add(0.5);
  return vec3(uv, float(face));
}) as N;

/**
 * Radiance from a baked {@link ReflectionProbes} set. Without inputs it is an environment node:
 * assign it to `scene.environmentNode`. With inputs it samples at the given world position,
 * direction and roughness (see {@link sampleReflectionProbes}). With `coverage: true` it returns
 * `vec4( radiance, coverage )` without environment fallback (see {@link reflectionProbesLocal}).
 * Bake the probes before creating it.
 */
export class ReflectionProbesNode extends THREE.Node {
  static get type() { return 'ReflectionProbesNode'; }
  readonly probes: ReflectionProbes;
  protected readonly array: N;
  protected readonly maxLod = shared(0);
  protected readonly size = shared(128);
  private readonly local = shared(1);
  private readonly boxProjection = shared(1);
  private slots: Slot[] = [];
  private seamFix = 'warp';
  /** Explicit lookup inputs; null ones come from the material (environment node). */
  readonly positionNode: N = null;
  readonly directionNode: N = null;
  readonly roughnessNode: N = null;
  /** Whether the output is `vec4( radiance, coverage )` without environment fallback. */
  readonly coverage: boolean;

  constructor(probes: ReflectionProbes, options: ProbeLookupOptions | null = null) {
    super(options?.coverage === true ? 'vec4' : 'vec3');
    if (!probes.texture) throw new Error('ReflectionProbesNode: bake the probes first.');
    this.probes = probes;
    this.coverage = options?.coverage === true;
    if (options) {
      if (options.position != null) this.positionNode = nodeObject(options.position);
      if (options.direction != null) this.directionNode = nodeObject(options.direction);
      if (options.roughness != null) this.roughnessNode = nodeObject(options.roughness);
    }
    this.updateBeforeType = THREE.NodeUpdateType.RENDER;
    this.array = texture(probes.texture);
    this.array.mergeable = false;
    probes.track(this);
  }

  customCacheKey() {
    // the probe count and the seam handling are compiled into the shader; the node's own id keeps
    // separate probe sets from sharing a program (#35046 6837c32abc); the texture id makes render
    // objects rebind after a bake that replaced the texture
    const probes = this.probes;
    return THREE.NodeUtils.hash(super.customCacheKey(), probes.bakedProbes.length, probes.bakedSeamFix === 'warp' ? 1 : 0, probes.texture?.id ?? 0);
  }

  updateBefore(): undefined {
    const probes = this.probes;
    const tex = probes.texture!;
    // a bake that changes the layout disposes the previous texture, so switch even before a recompile
    this.array.value = tex;
    this.maxLod.value = tex.mipmaps.length - 1;
    this.size.value = (tex.image as { width: number }).width;
    if (probes.bakedProbes.length !== this.slots.length || probes.bakedSeamFix !== this.seamFix) {
      this.needsUpdate = true;
      return;
    }
    // captures see only the environment, so baking doesn't feed back into itself
    this.local.value = probes.capturing ? 0 : 1;
    this.boxProjection.value = probes.boxProjection ? 1 : 0;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const probe = probes.bakedProbes[i];
      probe.getWorldPosition(slot.position.value);
      probeOrigin(probe, slot.origin.value);
      probe.getWorldScale(_scale);
      slot.extent.value.copy(probe.influenceSize).multiply(_scale).multiplyScalar(0.5);
      slot.fade.value = probe.blendDistance;
      slot.projectionSize.value.copy(probe.projectionSize ?? probe.influenceSize).multiply(_scale);
      slot.projectionOffset.value.copy(probe.projectionOffset).multiply(_scale);
    }
  }

  /** Radiance of probe slot `slot` (the environment is the last one) along `dir` at mip `lod`. */
  protected sampleProbe(slot: number, dir: N, lod: N): N {
    const f = cubeFaceUV(dir).toVar();
    const layer = int(f.z).add(slot * 6);
    if (this.seamFix !== 'warp') return this.array.sample(f.xy).depth(layer).level(lod).rgb;
    // edge-centred texels: uv' = uv * (s - 1) / s + 0.5 / s at face size s of each mip
    const lod0 = lod.floor().toVar();
    const lod1 = lod0.add(1).min(this.maxLod);
    const at = (l: N) => {
      const s = this.size.mul(l.negate().exp2());
      return this.array.sample(f.xy.mul(s.sub(1).div(s)).add(float(0.5).div(s))).depth(layer).level(l).rgb;
    };
    return mix(at(lod0), at(lod1), lod.sub(lod0));
  }

  setup(builder: N) {
    const probes = this.probes;
    this.seamFix = probes.bakedSeamFix;
    // keep the existing slots: every material program references the same uniforms (#35046 c4e4833e17)
    this.slots = probes.bakedProbes.map((_, i) => this.slots[i] ?? {
      position: shared(new THREE.Vector3()), origin: shared(new THREE.Vector3()), extent: shared(new THREE.Vector3()),
      fade: shared(0.5), projectionSize: shared(new THREE.Vector3()), projectionOffset: shared(new THREE.Vector3()),
    });
    this.updateBefore();

    // missing inputs come from the material: its fragment, reflection vector and roughness
    const { context } = builder;
    const position: N = this.positionNode ?? positionWorld;
    const direction: N = this.directionNode ?? (context.getUV ? context.getUV(this, builder) : reflectVector);
    const roughness: N = float(this.roughnessNode ?? (context.getTextureLevel ? context.getTextureLevel(this) : 0)).clamp();
    // the environment slot is unrotated: the material's direction gets its environment rotation,
    // an explicit direction is looked up as given
    return this.lookup(position, direction, roughness, this.directionNode === null ? materialEnvRotation : null);
  }

  /**
   * The probe lookup itself: influence weights (smallest volume first, each taking what the
   * previous ones left), box projection, and the environment for whatever weight is left (or, with
   * `coverage`, the probe radiance normalized by the weight it got, and that weight).
   * `envRotation` (a mat3, or null) rotates the direction for the environment slot.
   */
  protected lookup(position: N, direction: N, roughness: N, envRotation: N): N {
    return Fn(() => {
      // Build the inputs before any branch: r186 emits a node's dependencies (normalView, ...)
      // where it is first built, so building it inside one If leaves it unassigned in the others.
      const P = vec3(position).toVar();
      const dir = vec3(direction).toVar();
      // same roughness to mip mapping as three r187's PMREMNode
      const lod = this.maxLod.mul(roughness).mul(float(2).sub(roughness)).toVar();
      const radiance = vec3(0).toVar();
      const remaining = float(this.local).toVar();
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        const local = P.sub(slot.position);
        const d = slot.extent.sub(local.abs());
        // negative outside the box, so the clamped fade is zero there
        const distance = d.x.min(d.y).min(d.z);
        const weight = distance.div(slot.fade.max(1e-6)).clamp().mul(remaining).toVar();
        If(weight.greaterThan(0), () => {
          // the projection box is centred at position + projectionOffset; the capture point is origin
          const insideProjection = local.sub(slot.projectionOffset).abs().lessThanEqual(slot.projectionSize.mul(0.5)).all();
          const projected = parallaxCorrect(P, dir, slot.projectionSize, slot.position.add(slot.projectionOffset), slot.origin);
          const corrected = this.boxProjection.greaterThan(0).and(insideProjection).select(projected, dir);
          radiance.addAssign(this.sampleProbe(i, corrected, lod).mul(weight));
        });
        remaining.subAssign(weight);
      }
      if (this.coverage) {
        // #35046 head: conditional radiance and coverage; the caller composes any fallback
        const coverage = float(this.local).sub(remaining).toVar();
        return vec4(radiance.div(coverage.max(1e-6)), coverage);
      }
      const environmentWeight = remaining.add(this.local.oneMinus());
      const envDir = envRotation === null ? dir : envRotation.mul(dir);
      radiance.addAssign(this.sampleProbe(this.slots.length, envDir, lod).mul(environmentWeight));
      return radiance;
    })();
  }
}

/** TSL function: environment radiance from a baked probe set, for `scene.environmentNode`. */
export const reflectionProbes = (probes: ReflectionProbes) => nodeObject(new ReflectionProbesNode(probes));

/**
 * TSL function: radiance from a baked probe set at world position `position`, along world direction
 * `direction`, prefiltered for `roughness` (0 = mirror, 1 = fully rough). Same influence, blending,
 * priority, box projection and environment fallback as {@link reflectionProbes}, for any shader
 * (a full-screen pass, a traced ray's miss, a hit point). Not in #35046.
 */
export const sampleReflectionProbes = (probes: ReflectionProbes, position: N, direction: N, roughness: N): N =>
  nodeObject(new ReflectionProbesNode(probes, { position, direction, roughness }));

/**
 * TSL function: local probe radiance and coverage, without environment fallback (what
 * `reflectionProbes()` returns in #35046 head, 77bbaaaa05). rgb is the probes' radiance normalized
 * by their total weight, a is that weight (0 outside every influence volume and during a bake, 1
 * well inside one). Compose a fallback with the uncovered fraction, e.g.
 * `mix( environment, local.rgb, local.a )`; `scene.environmentNode = local.rgb.mul( local.a )` is
 * #35046's example. Material inputs, like {@link reflectionProbes}.
 */
export const reflectionProbesLocal = (probes: ReflectionProbes) => nodeObject(new ReflectionProbesNode(probes, { coverage: true }));

/**
 * TSL function: {@link reflectionProbesLocal} at an explicit world position, direction and roughness,
 * like {@link sampleReflectionProbes}: `vec4( radiance, coverage )`, no environment fallback.
 */
export const sampleReflectionProbesLocal = (probes: ReflectionProbes, position: N, direction: N, roughness: N): N =>
  nodeObject(new ReflectionProbesNode(probes, { position, direction, roughness, coverage: true }));
