// Environment radiance from a baked ReflectionProbes set: a thin TSL wrapper over the core probe
// lookup (packages/core/src/probes/lookup.ts, SPEC phase 2). The lookup itself (influence weights,
// priority, blending, box projection, roughness-to-mip mapping, environment fallback, and the
// optional dominant direction and re-fit) is core WGSL, called through `wgslFn`; this node only
// gathers its inputs from three (the material's fragment, reflection vector and roughness, or
// explicit ones), packs the volume table from the ReflectionProbe objects, and binds three's textures.
//
// Port of ReflectionProbesNode.js from three.js PR #35046 (Ben Houston), same weights, priority,
// projection and capture behaviour as before phase 2. The atlas is a CubeArrayTexture (core layout
// `cube-hw`, bound through `cubeTexture()`, W20) when `probes.bakedLayout` is 'cube-array', else
// three's 2D array of 6 x N layers (stock r187 can't bind cube arrays, D1), layout `cube2d-warp` or
// `cube2d-none` after `probes.bakedSeamFix`; three's cube captures are x-mirrored, so the lookup
// mirrors x (`mirrorX`).
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
//                                                  radiance, coverage ), no environment fallback.
// Extra lookup options (each off by default, see ProbeLookupOptions): the shading `normal` (Lagarde's
// dominant direction), `ao` (Lagarde's specular occlusion), `frameIrradiance` (the re-fit); and two
// that default to the set's own setting, so a material and the composite agree: `distanceRoughness`
// (on by default) and `roughnessLerp` (off) (Lagarde's SSR-to-probe seam techniques, D53). With
// distance roughness on, the lookup is no longer #35046's (D2700).
//
// The volume table is a storage buffer (one per probe set, shared by its nodes) written with
// queue.writeBuffer before every render (updateBefore), not a uniform in a per-object group: r186/r187 re-upload per-object uniforms
// only for render objects they see change, so probe moves and `boxProjection` would never reach
// static meshes (D500). A bake that replaces the texture bumps the node (see ReflectionProbes.bake),
// and the texture id is in the cache key, so every render object rebinds (D501).

import * as THREE from 'three/webgpu';
import { bool, cameraPosition, code, cubeTexture, float, mat4, materialEnvRotation, nodeObject, normalWorld, positionWorld, reflectVector, sampler, storage, texture, vec3, vec4, wgslFn } from 'three/tsl';
import {
  PROBE_HEADER_ROWS, PROBE_ROWS_PER_VOLUME, createProbeLayout, packProbeTable, probeLookupFunctionWgsl, probeLookupIncludesWgsl, probeProxyShareFunctionWgsl,
  probeIrradianceRow, probeTableRows, type ProbeLayout, type ProbeLodMapping, type ProbeLookupOptions as CoreLookupOptions, type ProbeVolume,
} from '@pmndrs/reflections-core';
import { probeOrigin, probeWorldScale, type ReflectionProbes } from './ReflectionProbes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any; // TSL's node typings are too strict for hand-written shader maths

const _p = new THREE.Vector3(), _o = new THREE.Vector3(), _s = new THREE.Vector3();

/** Explicit lookup inputs (see {@link sampleReflectionProbes}); absent, the material provides them. */
export interface ProbeLookupInputs { position: N; direction: N; roughness: N }

/**
 * Options of {@link ReflectionProbesNode}: #35046's `{ position, direction, roughness }` (each
 * optional; a missing one comes from the material) plus `coverage` and the phase 2 lookup options.
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
  /**
   * World shading normal. Given, the lookup bends the direction to Lagarde's specular dominant
   * direction, `mix( N, R, s * ( sqrt( s ) + a ) )`, s = 1 - a, a = roughness² (D57). Leave it out on
   * the material path: three already bends its reflection vector toward the normal by roughness⁴.
   */
  normal?: N;
  /**
   * Ambient occlusion in [0, 1]: scales the result (rgb only for the coverage form) by Lagarde's
   * specular occlusion `saturate( pow( NdotV + ao, exp2( -16 a - 1 ) ) - 1 + ao )` (D66). Needs `view`
   * on explicit lookups (the material path uses the camera). Default none.
   */
  ao?: N;
  /** World direction from the surface to the eye, for `ao` on explicit lookups. Default: from the camera. */
  view?: N;
  /**
   * The frame's irradiance at the surface (a vec3 node, e.g. from three's LightProbeGrid): re-fits
   * each probe's radiance by `clamp( frameIrradiance / probeIrradiance( N ), 0, probes.refitClamp )`,
   * with probeIrradiance the probe's L1 SH from its own capture (SPEC "Probe re-fit"). Needs the
   * probes baked with `irradiance: true` (the default). Uses `normal`, or the material's normal.
   */
  frameIrradiance?: N;
  /**
   * Lagarde 2014's distance-based roughness on box-projected probes (D53): sharp near the projection
   * box, the set's roughness from the capture point's distance on. Default: the set's
   * {@link ReflectionProbes.distanceRoughness}. Override it on a material only together with the
   * composite's lookup, or lit and composite disagree.
   */
  distanceRoughness?: boolean;
  /**
   * Lagarde 2014's lerp of the box-projected direction back toward the unprojected one by roughness
   * (D53). Default: the set's {@link ReflectionProbes.roughnessLerp}.
   */
  roughnessLerp?: boolean;
  /**
   * Roughness to mip ('alpha' or three r187's 'r187', D101). Default: the set's
   * {@link ReflectionProbes.lodMapping} ('alpha').
   */
  lodMapping?: ProbeLodMapping;
}

// One wgslFn and include per lookup variant, shared by every node and material: three emits a
// CodeNode once per shader only when it is the same node instance.
// The includes depend only on the layout (and mirrorX, always true here); the function on the rest.
const _includes = new Map<string, N>();
const _lookups = new Map<string, { fn: N; includes: N }>();
function lookupFor(options: CoreLookupOptions): { fn: N; includes: N } {
  // keyed by the code itself: layouts whose WGSL doesn't depend on maxLod share one include
  const source = probeLookupIncludesWgsl({ layout: options.layout, mirrorX: true });
  let includes = _includes.get(source);
  if (!includes) _includes.set(source, (includes = code(source) as N));
  const layoutKey = `${options.layout.id}:${options.layout.mipLevelCount}`;
  const key = `${layoutKey}:${options.lodMapping}:${options.dominantDirection === true}:${options.refit === true}:${options.distanceRoughness === true}:${options.roughnessLerp === true}:${options.count ?? -1}`;
  let entry = _lookups.get(key);
  if (!entry) {
    entry = { fn: wgslFn(probeLookupFunctionWgsl({ ...options, mirrorX: true }, 'probesLookup'), [includes]) as N, includes };
    _lookups.set(key, entry);
  }
  return entry;
}

/**
 * One volume table per probe set, shared by every node that samples it (a material, a composite with
 * several lookups): one storage binding per set, one upload per render.
 */
interface SetTable { attribute: THREE.StorageBufferAttribute; node: N; rows: number; renderId: number; irradianceVersion: number; packed: Float32Array<ArrayBuffer> }
const _tables = new WeakMap<ReflectionProbes, SetTable>();
function tableFor(probes: ReflectionProbes): SetTable {
  const count = probes.bakedProbes.length;
  const rows = probeTableRows(count, count + 1);
  let t = _tables.get(probes);
  if (t === undefined || t.rows !== rows) {
    const attribute = new THREE.StorageBufferAttribute(new Float32Array(rows * 4), 4);
    t = { attribute, node: storage(attribute, 'vec4', rows).toReadOnly(), rows, renderId: -1, irradianceVersion: -1, packed: new Float32Array((PROBE_HEADER_ROWS + count * PROBE_ROWS_PER_VOLUME) * 4) };
    _tables.set(probes, t);
  }
  return t;
}

/** The volumes of the last bake, in lookup order (smallest first), as core's table wants them. */
function volumeList(probes: ReflectionProbes): ProbeVolume[] {
  return probes.bakedProbes.map((probe, slot) => {
    probe.getWorldPosition(_p);
    probeOrigin(probe, _o);
    probeWorldScale(probe, _s);
    const half = probe.influenceSize.clone().multiply(_s).multiplyScalar(0.5);
    const projection = (probe.projectionSize ?? probe.influenceSize).clone().multiply(_s);
    const offset = probe.projectionOffset.clone().multiply(_s);
    return {
      slot, center: [_p.x, _p.y, _p.z], halfSize: [half.x, half.y, half.z], fade: probe.blendDistance,
      projectionSize: [projection.x, projection.y, projection.z], projectionOffset: [offset.x, offset.y, offset.z],
      origin: [_o.x, _o.y, _o.z], boxProjection: probes.boxProjection,
    };
  });
}

/**
 * Packs the set's table (core packProbeTable) and uploads it with queue.writeBuffer, once per render
 * (`renderId`, -1: always); copies the bake's L1 SH into the irradiance rows when it changed.
 */
function writeTable(probes: ReflectionProbes, t: SetTable, renderer: THREE.WebGPURenderer, renderId: number) {
  if (renderId !== -1 && t.renderId === renderId) return;
  t.renderId = renderId;
  const count = probes.bakedProbes.length;
  // captures see only the environment, so baking doesn't feed back into itself
  t.packed = packProbeTable({
    maxLod: probes.texture!.mipmaps.length - 1, enabled: !probes.capturing, environmentSlot: count,
    irradianceRow: probeIrradianceRow(count), refitClamp: probes.refitClamp,
  }, volumeList(probes), t.packed);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backend = renderer.backend as any;
  const buffer: GPUBuffer | undefined = backend.get(t.attribute).buffer;
  if (buffer === undefined) {
    // not created yet: three uploads the array when it first binds the table
    (t.attribute.array as Float32Array).set(t.packed);
    return;
  }
  const device: GPUDevice = backend.device;
  device.queue.writeBuffer(buffer, 0, t.packed);
  const irradiance = probes.irradiance;
  if (irradiance !== null && probes.irradianceVersion !== t.irradianceVersion) {
    const offset = probeIrradianceRow(count) * 16;
    const encoder = device.createCommandEncoder({ label: 'ReflectionProbes.table.irradiance' });
    encoder.copyBufferToBuffer(irradiance, 0, buffer, offset, Math.min(irradiance.size, buffer.size - offset));
    device.queue.submit([encoder.finish()]);
    t.irradianceVersion = probes.irradianceVersion;
  }
}

/** The atlas layout three's bake writes (`cube-hw` for a cube array; for a 2D array the seam fix picks the variant). */
export function probeLayoutFor(probes: ReflectionProbes): ProbeLayout {
  const tex = probes.texture!;
  const id = probes.bakedLayout === 'cube-array' ? 'cube-hw' : probes.bakedSeamFix === 'warp' ? 'cube2d-warp' : 'cube2d-none';
  return createProbeLayout(id, { maxLod: tex.mipmaps.length - 1 });
}

/** The texture node a lookup binds the atlas with: `cubeTexture()` for a cube array (cube-array view), else `texture()`. */
function atlasNode(probes: ReflectionProbes): N {
  // an explicit (unused) uv: the default, reflectVector, needs a camera, which compute shaders lack
  const node: N = probes.bakedLayout === 'cube-array' ? cubeTexture(probes.texture as N, vec3(0, 0, 1)) : texture(probes.texture!);
  node.mergeable = false;
  return node;
}

/** Box-projected direction (Lagarde's BPCEM, the guarded form from #35046), core's `pr_parallax`. */
export const parallaxCorrect = (P: N, dir: N, boxSize: N, boxPos: N, origin: N): N => {
  const { includes } = lookupFor({ layout: createProbeLayout('cube2d-warp', { maxLod: 4 }) });
  return (wgslFn('fn probesParallax(P: vec3f, dir: vec3f, boxSize: vec3f, boxPos: vec3f, origin: vec3f) -> vec3f { return pr_parallax(P, dir, boxSize, boxPos, origin); }', [includes]) as N)({ P, dir, boxSize, boxPos, origin });
};

/**
 * Cube face and face uv of a direction, by WebGPU's cube face rules, in three's cube convention
 * (x mirrored, as CubeTextureNode samples): vec3( u, v, face ). Core's `pl_cubeFaceUV`.
 */
export const cubeFaceUV = (dir: N): N => {
  const { includes } = lookupFor({ layout: createProbeLayout('cube2d-warp', { maxLod: 4 }) });
  return (wgslFn('fn probesCubeFaceUV(dir: vec3f) -> vec3f { return pl_cubeFaceUV(vec3f(-dir.x, dir.y, dir.z)); }', [includes]) as N)({ dir });
};

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
  protected array: N;
  /** Explicit lookup inputs; null ones come from the material (environment node). */
  readonly positionNode: N = null;
  readonly directionNode: N = null;
  readonly roughnessNode: N = null;
  readonly normalNode: N = null;
  readonly aoNode: N = null;
  readonly viewNode: N = null;
  readonly frameIrradianceNode: N = null;
  /** Whether the output is `vec4( radiance, coverage )` without environment fallback. */
  readonly coverage: boolean;
  /** The lookup's own `distanceRoughness` / `roughnessLerp`; undefined: the set's. */
  readonly distanceRoughness: boolean | undefined;
  readonly roughnessLerp: boolean | undefined;
  /** The lookup's own `lodMapping`; undefined: the set's. */
  readonly lodMapping: ProbeLodMapping | undefined;
  private table: SetTable | null = null;
  private renderer: THREE.WebGPURenderer | null = null;
  private volumes = 0;
  private seamFix = 'warp';
  private storage = 'cube2d';

  constructor(probes: ReflectionProbes, options: ProbeLookupOptions | null = null) {
    super(options?.coverage === true ? 'vec4' : 'vec3');
    if (!probes.texture) throw new Error('ReflectionProbesNode: bake the probes first.');
    this.probes = probes;
    this.coverage = options?.coverage === true;
    this.distanceRoughness = options?.distanceRoughness;
    this.roughnessLerp = options?.roughnessLerp;
    this.lodMapping = options?.lodMapping;
    if (options) {
      if (options.position != null) this.positionNode = nodeObject(options.position);
      if (options.direction != null) this.directionNode = nodeObject(options.direction);
      if (options.roughness != null) this.roughnessNode = nodeObject(options.roughness);
      if (options.normal != null) this.normalNode = nodeObject(options.normal);
      if (options.ao != null) this.aoNode = nodeObject(options.ao);
      if (options.view != null) this.viewNode = nodeObject(options.view);
      if (options.frameIrradiance != null) this.frameIrradianceNode = nodeObject(options.frameIrradiance);
    }
    this.updateBeforeType = THREE.NodeUpdateType.RENDER;
    this.array = atlasNode(probes);
    this.storage = probes.bakedLayout;
    probes.track(this);
  }

  customCacheKey() {
    // the probe count and the seam handling are compiled into the shader; the node's own id keeps
    // separate probe sets from sharing a program (#35046 6837c32abc); the texture id makes render
    // objects rebind after a bake that replaced the texture
    const probes = this.probes;
    const { distanceRoughness, roughnessLerp, lodMapping } = this.seamOptions();
    return THREE.NodeUtils.hash(super.customCacheKey(), probes.bakedProbes.length, probes.bakedSeamFix === 'warp' ? 1 : 0, probes.bakedLayout === 'cube-array' ? 1 : 0, probes.texture?.id ?? 0,
      distanceRoughness ? 1 : 0, roughnessLerp ? 1 : 0, lodMapping === 'r187' ? 1 : 0);
  }

  /** The set-wide lookup options this lookup uses: its own, else the set's (seam options D53, lod mapping D101). */
  seamOptions() {
    return {
      distanceRoughness: this.distanceRoughness ?? this.probes.distanceRoughness, roughnessLerp: this.roughnessLerp ?? this.probes.roughnessLerp,
      lodMapping: this.lodMapping ?? this.probes.lodMapping,
    };
  }

  updateBefore(frame?: { renderId: number }): undefined {
    const probes = this.probes;
    // another storage needs another texture node (and binding type): rebuild first
    if (probes.bakedLayout !== this.storage) { this.needsUpdate = true; return; }
    // a bake that changes the layout disposes the previous texture, so switch even before a recompile
    this.array.value = probes.texture!;
    // (a change of the set's seam options bumps its nodes itself: ReflectionProbes.touchUsers)
    if (probes.bakedProbes.length !== this.volumes || probes.bakedSeamFix !== this.seamFix) {
      this.needsUpdate = true;
      return;
    }
    if (this.renderer !== null && this.table !== null) writeTable(probes, this.table, this.renderer, frame?.renderId ?? -1);
  }

  setup(builder: N) {
    const probes = this.probes;
    this.renderer = builder.renderer;
    if (probes.bakedLayout !== this.storage) { this.array = atlasNode(probes); this.storage = probes.bakedLayout; }
    this.seamFix = probes.bakedSeamFix;
    this.volumes = probes.bakedProbes.length;
    const seam = this.seamOptions();
    this.table = tableFor(probes);
    this.updateBefore();

    // missing inputs come from the material: its fragment, reflection vector and roughness
    const { context } = builder;
    const position: N = this.positionNode ?? positionWorld;
    const direction: N = this.directionNode ?? (context.getUV ? context.getUV(this, builder) : reflectVector);
    const roughness: N = float(this.roughnessNode ?? (context.getTextureLevel ? context.getTextureLevel(this) : 0)).clamp();
    const refit = this.frameIrradianceNode !== null;
    const dominant = this.normalNode !== null;
    const normal: N = this.normalNode ?? (refit ? normalWorld : direction);
    // the environment slot is unrotated: the material's direction gets its environment rotation,
    // an explicit direction is looked up as given; core bends the direction first (dominant
    // direction) and rotates the bent one, so volumes and environment agree
    const envRotation: N = this.directionNode === null ? materialEnvRotation : mat4(new THREE.Matrix4());
    const { fn } = lookupFor({ layout: probeLayoutFor(probes), mirrorX: true, dominantDirection: dominant, refit, ...seam, count: this.volumes });
    const result: N = fn({
      atlas: this.array, samp: sampler(this.array), table: this.table.node,
      P: vec3(position), N: vec3(normal), R: vec3(direction), roughness, envRotation,
      frameIrr: refit ? vec3(this.frameIrradianceNode) : vec3(-1), withEnv: bool(!this.coverage),
    }).toVar();
    if (this.aoNode === null) return this.coverage ? result : result.rgb;
    const { includes } = lookupFor({ layout: probeLayoutFor(probes), mirrorX: true, dominantDirection: dominant, refit });
    const occlusion = wgslFn('fn probesSpecularOcclusion(NdotV: f32, ao: f32, roughness: f32) -> f32 { return probeSpecularOcclusion(NdotV, ao, roughness); }', [includes]) as N;
    const V: N = this.viewNode ?? cameraPosition.sub(position).normalize();
    const n: N = this.normalNode ?? normalWorld;
    const so: N = occlusion({ NdotV: vec3(n).dot(vec3(V)).clamp(), ao: float(this.aoNode), roughness });
    return this.coverage ? vec4(result.rgb.mul(so), result.a) : result.rgb.mul(so);
  }
}

/** TSL function: environment radiance from a baked probe set, for `scene.environmentNode`. */
export const reflectionProbes = (probes: ReflectionProbes, options: Omit<ProbeLookupOptions, 'position' | 'direction' | 'roughness' | 'coverage'> = {}) =>
  nodeObject(new ReflectionProbesNode(probes, options));

/**
 * TSL function: radiance from a baked probe set at world position `position`, along world direction
 * `direction`, prefiltered for `roughness` (0 = mirror, 1 = fully rough). Same influence, blending,
 * priority, box projection and environment fallback as {@link reflectionProbes}, for any shader
 * (a full-screen pass, a traced ray's miss, a hit point). Not in #35046.
 */
export const sampleReflectionProbes = (probes: ReflectionProbes, position: N, direction: N, roughness: N, options: Omit<ProbeLookupOptions, 'position' | 'direction' | 'roughness' | 'coverage'> = {}): N =>
  nodeObject(new ReflectionProbesNode(probes, { ...options, position, direction, roughness }));

/**
 * TSL function: local probe radiance and coverage, without environment fallback (what
 * `reflectionProbes()` returns in #35046 head, 77bbaaaa05). rgb is the probes' radiance normalized
 * by their total weight, a is that weight (0 outside every influence volume and during a bake, 1
 * well inside one). Compose a fallback with the uncovered fraction, e.g.
 * `mix( environment, local.rgb, local.a )`; `scene.environmentNode = local.rgb.mul( local.a )` is
 * #35046's example. Material inputs, like {@link reflectionProbes}.
 */
export const reflectionProbesLocal = (probes: ReflectionProbes, options: Omit<ProbeLookupOptions, 'position' | 'direction' | 'roughness' | 'coverage'> = {}) =>
  nodeObject(new ReflectionProbesNode(probes, { ...options, coverage: true }));

/**
 * TSL function: {@link reflectionProbesLocal} at an explicit world position, direction and roughness,
 * like {@link sampleReflectionProbes}: `vec4( radiance, coverage )`, no environment fallback.
 */
export const sampleReflectionProbesLocal = (probes: ReflectionProbes, position: N, direction: N, roughness: N, options: Omit<ProbeLookupOptions, 'position' | 'direction' | 'roughness' | 'coverage'> = {}): N =>
  nodeObject(new ReflectionProbesNode(probes, { ...options, position, direction, roughness, coverage: true }));

const _proxyFns = new Map<string, N>();
/**
 * The share of a probe set's term at a world position along a direction (volumes by weight, then the
 * environment, as {@link sampleReflectionProbes} blends them) whose box-projected surface lies
 * nearer than `near`, fading to 0 at `far` (core's `probeProxyShareFunctionWgsl`, W22 / D2400). The
 * environment and volumes without box projection are infinitely far. A float node; 0 during a bake.
 */
export class ReflectionProbesProxyNode extends THREE.Node {
  static get type() { return 'ReflectionProbesProxyNode'; }
  readonly probes: ReflectionProbes;
  readonly positionNode: N;
  readonly directionNode: N;
  readonly nearNode: N;
  readonly farNode: N;
  private table: SetTable | null = null;
  private renderer: THREE.WebGPURenderer | null = null;
  private volumes = 0;

  constructor(probes: ReflectionProbes, position: N, direction: N, near: N, far: N) {
    super('float');
    if (!probes.texture) throw new Error('ReflectionProbesProxyNode: bake the probes first.');
    this.probes = probes;
    this.positionNode = nodeObject(position);
    this.directionNode = nodeObject(direction);
    this.nearNode = nodeObject(near);
    this.farNode = nodeObject(far);
    this.updateBeforeType = THREE.NodeUpdateType.RENDER;
    probes.track(this);
  }

  customCacheKey() {
    return THREE.NodeUtils.hash(super.customCacheKey(), this.probes.bakedProbes.length);
  }

  updateBefore(frame?: { renderId: number }): undefined {
    if (this.probes.bakedProbes.length !== this.volumes) { this.needsUpdate = true; return; }
    if (this.renderer !== null && this.table !== null) writeTable(this.probes, this.table, this.renderer, frame?.renderId ?? -1);
  }

  setup(builder: N) {
    const probes = this.probes;
    this.renderer = builder.renderer;
    this.volumes = probes.bakedProbes.length;
    this.table = tableFor(probes);
    this.updateBefore();
    const { includes } = lookupFor({ layout: probeLayoutFor(probes) });
    const key = `${this.volumes}`;
    let fn = _proxyFns.get(key);
    if (!fn) _proxyFns.set(key, (fn = wgslFn(probeProxyShareFunctionWgsl({ count: this.volumes }, 'probesProxyShare'), [includes]) as N));
    return fn({ table: this.table.node, P: vec3(this.positionNode), dir: vec3(this.directionNode), near: float(this.nearNode), far: float(this.farNode) });
  }
}

/** TSL function: {@link ReflectionProbesProxyNode}. */
export const sampleReflectionProbesProxyShare = (probes: ReflectionProbes, position: N, direction: N, near: N, far: N): N =>
  nodeObject(new ReflectionProbesProxyNode(probes, position, direction, near, far));
