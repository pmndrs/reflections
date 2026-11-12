// Box-projected reflection probes for three r187+ (WebGPU), a stand-in for three.js PR #35046.
//
// Same API and method as Ben Houston's ReflectionProbes (examples/jsm/lighting/ReflectionProbes.js
// in that PR): `ReflectionProbe` volumes (influence box, optional projection box, blend distance)
// inside a `ReflectionProbes` group, baked into ONE texture (one cube per probe, smallest volume
// first, then `scene.environment`), sampled by `reflectionProbes( probes )` installed as
// `scene.environmentNode`, so every physical material picks the probes up with its own roughness,
// normal and clearcoat.
//
// What three (r187, the floor) forces to differ (see ReflectionProbesNode.ts for the lookup side):
//   - stock r187 can't bind `texture_cube_array` (#35045 was reverted; #35053 is open). `layout`
//     (new) picks the storage: 'cube-array' bakes into a CubeArrayTexture (#35053's class, vendored
//     in ../compat), as #35046 does, sampled by the hardware cube sampler (core layout `cube-hw`);
//     it needs three with #35053, or `await installCubeArraySupport( renderer )` (../compat/cubeArray.ts,
//     a self-tested runtime port of #35053's renderer changes). 'cube2d' keeps the cubes in a 2D array
//     texture, layer = probe * 6 + face, mip = roughness level, and the node picks face and uv itself.
//     'auto' (default) takes the cube array when the renderer supports it. Same layers and mips either
//     way (with 'warp', texel centres differ). `bakedLayout` says which one the texture uses.
//   - r187's PMREMGenerator writes cube mips, but per probe into its own render target and in render
//     passes; the prefilter is our own compute pass with r187's algorithm, writing straight into the
//     array layers (core: probes/prefilter.ts).
//   - `seamFix` (new, 2D array only; a no-op on cube arrays, which filter seamlessly): a manual face
//     lookup has no seamless cube filtering. 'none' clamps at face
//     edges: measured against the hardware cube sampler on the same bake, the probe radiance is off
//     by up to 5-14 % (p99 4-6 %) in half-texel bands along the edges at roughness >= 0.5 (faces
//     of 8-16 px), which shows as a faint crease after tone mapping (1-3 / 255). 'warp' (default)
//     bakes and samples with edge-centred texels, so neighbouring faces agree at their edges: the
//     bands go away; cost ~0.06 ms per 1080p frame for 3 probes (two bilinear samples instead of
//     one trilinear), nothing in the bake.
//
//   - `originOffset` (new, per probe): captures from a point other than the volumes' centre.
//     `projectionOffset` (#35046) is the converse: it moves the projection box, not the capture point.
//   - `bake( ..., { environment: false | 'always' } )` (new): skip the environment slot, or capture
//     it every bake; by default it is captured only when `scene.environment` changed (the
//     maintainer's fork, 351167b7d1).
//   - `bake( ..., { probes } )` (the fork, 37bf331235): capture only some probes, to spread a live
//     update over several frames.
//
// Swapping to #35046 once it lands: import ReflectionProbe / ReflectionProbes / reflectionProbes
// from three/addons instead, drop `seamFix` / `bakedSeamFix` / `layout` / `bakedLayout`, and move any
// probe with an `originOffset` to its box centre (or keep that one extension); `texture` is then always
// a CubeArrayTexture, as it already is here with `bakedLayout === 'cube-array'` (nothing outside the
// node should sample it directly). Everything else (constructor, influenceSize,
// projectionSize, projectionOffset, blendDistance, boxProjection, bake( renderer, scene, { resolution,
// near, far } ), texture, bakedProbes, capturing, dispose) has the same name and meaning. #35046 head's
// vec4 `reflectionProbes()` is our `reflectionProbesLocal()`; ours keeps the vec3 form with the
// environment fallback (docs/DIVERGES.md D20).

import * as THREE from 'three/webgpu';
import { DEFAULT_PROBE_LOD_MAPPING, PROBE_IRRADIANCE_ROWS, ProbeIrradiance, ProbePrefilter, createProbeLayout, maxLodFor, planProbeAtlases, type ProbeLodMapping } from '@pmndrs/reflections-core';
import { cubeArraySupported, cubeArraySupportStatus, cubeArrayTextureClass } from '../compat/cubeArray';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Renderer = THREE.WebGPURenderer & { backend: any };

const _position = new THREE.Vector3();
const _size = new THREE.Vector3();
const _clear = new THREE.Color();

/**
 * A local reflection volume. Add it to a {@link ReflectionProbes} container. The volumes are
 * world-axis-aligned boxes centred on the probe; they follow its world position and scale
 * ({@link probeWorldScale}). Rotation is ignored, the probe's own and its parents': the boxes stay
 * aligned with the world axes. Each size (x, y, z) is scaled by the world length of the probe's
 * local axis of the same name, so a probe turned 90 degrees under a non-uniformly scaled parent
 * gets that parent's scale along the axis it now points at, not along the world axis it lies on.
 */
export class ReflectionProbe extends THREE.Object3D {
  readonly isReflectionProbe = true;
  /** Size of the influence volume. Surfaces inside it use this probe. */
  readonly influenceSize: THREE.Vector3;
  /** Size of the box reflections are projected onto, usually the room's walls. `null` uses `influenceSize`. */
  projectionSize: THREE.Vector3 | null = null;
  /**
   * Offset of the projection box's centre from the probe (#35046), scaled with the probe like the
   * volume sizes; rotation is ignored. Use it when the capture point isn't at the room's centre: the
   * probe (and its influence volume) stays where it captures, the box moves onto the walls.
   * {@link originOffset} is the converse: the volumes stay, the capture point moves. Both can be set.
   */
  readonly projectionOffset = new THREE.Vector3();
  /** Distance over which the influence fades in from the volume's faces. */
  blendDistance = 0.5;
  /**
   * Where the probe captures from, relative to the centre of its volumes (not in #35046; Godot's
   * `origin_offset`). Default zero: capture from the centre. Box projection still uses the volumes
   * as placed, so a room's box can stay on its walls while the capture point moves to where it
   * sees the most of the room. Scaled with the probe like the volume sizes; rotation is ignored.
   */
  readonly originOffset = new THREE.Vector3();
  /**
   * This probe's cube face size (not in #35046; D4700): null (default) takes the set's
   * {@link BakeOptions.resolution}. Rounded down to a power of two, at least 64, like it. Probes of
   * each size share one atlas (a set holds up to 4 sizes, the set default's atlas first): a 512 px
   * probe for a polished floor beside 256 px room probes costs one 512 px cube, not 4x the set.
   * Sizing: the sharpest surface that samples the probe, the detail it must hold (a thin emissive,
   * a sign) and how near it is; see {@link BakeOptions.resolution} for memory and bake time.
   * Changing it re-bakes the set on the next bake.
   */
  resolution: number | null = null;

  constructor(width = 1, height = 1, depth = 1) {
    super();
    (this as { type: string }).type = 'ReflectionProbe';
    this.influenceSize = new THREE.Vector3(width, height, depth);
  }

  copy(source: this, recursive?: boolean) {
    super.copy(source, recursive);
    this.influenceSize.copy(source.influenceSize);
    this.projectionSize = source.projectionSize === null ? null : source.projectionSize.clone();
    this.projectionOffset.copy(source.projectionOffset);
    this.blendDistance = source.blendDistance;
    this.originOffset.copy(source.originOffset);
    this.resolution = source.resolution;
    return this;
  }
}

export interface BakeOptions {
  /**
   * Cube face size, rounded down to a power of two, at least 64. Default 256 (as #35046; D23, D62).
   *
   * Sizing: the sharpest material that samples a probe sets its size. 256 for mirror-grade probes
   * (polished floors, mirrors, metal below roughness ~0.2: Lagarde 2014's minimum for mirror-like
   * surfaces, Godot's default); 128 when many probes share the scene or on mobile (a quarter of the
   * memory and bake time; Godot's mobile size), and for probes that only glossy or rough surfaces
   * see. Memory per probe (rgba16f, 6 faces, all mips): ~16.8 MB at 512, ~4.2 MB at 256, ~1.0 MB
   * at 128. Bake time grows about 2x from 128 to 256 (W31: 3 probes ~2.3 -> ~4 ms). Whether many
   * small probes beat a few large ones at equal memory is open (docs/HANDOFF.md fine-tune backlog,
   * "Probe count vs resolution").
   *
   * This is the set's default: a probe's own {@link ReflectionProbe.resolution} overrides it
   * (D4700), so one probe that holds fine detail (a floor under a thin emissive, a mirror) can be
   * 512 while the rest stay 256. The environment slot always takes this size.
   */
  resolution?: number;
  /** Near plane of the capture camera. Default 0.1. */
  near?: number;
  /** Far plane of the capture camera. Default 100. */
  far?: number;
  /**
   * The fallback slot (not in #35046). `true` (default): capture `scene.environment` when it changed
   * since the last bake (another texture, or its `version` / `pmremVersion` moved) or the layout
   * changed. `'always'`: capture it every bake, for an environment whose content changes without a
   * version bump (a render target's texture). `false`: leave the slot black; use it when the probes'
   * influence covers every surface that samples them.
   */
  environment?: boolean | 'always';
  /**
   * Capture only these probes and keep the others' slots, for example to spread a live update over
   * several frames (the maintainer's fork, 37bf331235). Ignored, and every probe captured, when the
   * bake changes the layout (resolution, seam fix, or the set or order of probes).
   */
  probes?: ReflectionProbe[];
  /**
   * Objects hidden from the captures and restored after (not in #35046; Unity's culling mask, UE's
   * "visible in reflection captures"). Put moving mirrors and other sharp reflectors here when baking
   * live: a mirror captured into the probes reflects the probes back, and that loop flickers.
   * Objects with `userData.reflectionProbeExclude = true` are hidden too.
   */
  exclude?: THREE.Object3D[];
  /**
   * Compute each slot's L1 SH irradiance from its capture after the bake (core ProbeIrradiance), for
   * the re-fit (`frameIrradiance` lookup option). One small dispatch per slot. Default true.
   */
  irradiance?: boolean;
  /**
   * Capture passes (not in #35046; the interior branch's `bounces`, D25). 2 (default, D4300): a
   * first pass whose captures see the scene lit without local probes (`capturing` switches them
   * off), then one more pass over the captured probes rendered with every probe looking up the first
   * pass's atlas, so a captured wall gets the room's bounce light and a captured mirror or glossy
   * surface reflects the room instead of the environment slot (a frozen copy: each pass prefilters
   * into a scratch texture and copies it in when the pass is done, so the result doesn't depend on
   * probe order). n > 2 adds passes the same way. Each pass costs one bake of those probes, so 2
   * doubles the bake: scenes without mirrors or glossy surfaces facing each other (and live,
   * per-frame bakes) can use 1 to halve it; their probes then lack the interreflection
   * (D3200: 1 -> 2 changes the rooms by mean 5.6-6.4 / 255, p99 42-49). With {@link probes} (a
   * time-sliced bake), every pass covers only the slice, so a sliced 2-bounce bake differs from a
   * full one (the slice's second pass sees the other probes' last bake): slice with 1.
   */
  bounces?: number;
}

/**
 * Defaults of {@link ReflectionProbes.distanceRoughness} / {@link ReflectionProbes.roughnessLerp} (W26,
 * D53): distance roughness on (closer to a path-traced reference on every showcase stage and a
 * narrower SSR-to-probe step on glossy floors); the lerp off (it moved every stage away from the reference).
 */
const DEFAULT_DISTANCE_ROUGHNESS = true;
/** Default {@link BakeOptions.resolution} (D23, decided 2026-11-11: #35046's 256). */
const DEFAULT_RESOLUTION = 256;
/** A face size as the bake takes it: rounded down to a power of two like #35046 (2712ba1b23), but from 64 (D23). */
const faceSize = (resolution: number) => Math.max(64, THREE.MathUtils.floorPowerOfTwo(resolution));
const DEFAULT_ROUGHNESS_LERP = false;
/** Devices already warned about a set's atlas count against their sampled-texture limit (D4900). */
const warnedSampledTextures = new WeakSet<GPUDevice>();
/** Default {@link BakeOptions.bounces} (D4300, decided 2026-11-11, maintainer Q1: 2, tunable). */
const DEFAULT_BOUNCES = 2;

export type SeamFix = 'warp' | 'none';
/** How a probe set stores its cubes: a real cube array, or a 2D array of 6 layers per cube. */
export type ProbeStorage = 'cube-array' | 'cube2d';
/** {@link ReflectionProbes.layout}: a storage, or 'auto' (a cube array when the renderer supports it). */
export type ProbeStorageOption = 'auto' | ProbeStorage;

/**
 * A set of {@link ReflectionProbe} children baked into one texture. Assign
 * `reflectionProbes( probes )` to `scene.environmentNode`. Smaller volumes take priority over
 * larger ones; uncovered surfaces fall back to `scene.environment`. WebGPU backend only.
 */
export class ReflectionProbes extends THREE.Object3D {
  readonly isReflectionProbes = true;
  /** Whether the probes use box projection. */
  boxProjection = true;
  /**
   * Face-edge handling of the manual cube lookup on the 2D-array storage (not in #35046, see the file
   * header). A no-op on cube arrays (hardware filtering is seamless). Re-bake after changing it.
   */
  seamFix: SeamFix = 'warp';
  /**
   * Storage of the next bake (not in #35046, which always uses a cube array): 'auto' (default) a
   * CubeArrayTexture when the renderer can bind one (three with #35053, or after
   * `await installCubeArraySupport( renderer )`), else the 2D array; 'cube-array' requires it (the bake
   * throws without it); 'cube2d' always the 2D array. {@link bakedLayout} is what the bake chose.
   */
  layout: ProbeStorageOption = 'auto';
  /**
   * The baked texture: one cube per probe, then one for the environment; mips = roughness. A
   * CubeArrayTexture when {@link bakedLayout} is 'cube-array', else a 2D array texture of 6 layers per cube.
   * With probes of several resolutions (D4700) this is the set default's atlas (its probes and the
   * environment), `textures[0]`; the others are in {@link textures}.
   */
  texture: THREE.Texture | null = null;
  /**
   * Every atlas of the last bake, one per probe resolution (D4700): `[texture]` when every probe
   * uses the set default. Same storage and seam fix for all; each has its own size and mips.
   */
  textures: THREE.Texture[] = [];
  /** Face size of each of {@link textures}. */
  bakedResolutions: number[] = [];
  /** The probes in baked order, smallest volume first. */
  bakedProbes: ReflectionProbe[] = [];
  /** Per baked probe: the index in {@link textures} of the atlas holding it (D4700). */
  bakedAtlases: number[] = [];
  /** Per baked probe: its slot (cube index) within that atlas. */
  bakedSlots: number[] = [];
  /** The environment's slot in `textures[0]` (after the probes that live there). */
  bakedEnvironmentSlot = 0;
  /** The seam fix the current `texture` was baked with (the node samples to match); 'none' on cube arrays. */
  bakedSeamFix: SeamFix = 'warp';
  /** The storage the current `texture` uses ('cube2d' before the first bake). */
  bakedLayout: ProbeStorage = 'cube2d';
  /** Whether a bake is in progress. Probes then contribute only the environment. */
  capturing = false;
  /** Upper bound of the re-fit ratio frameIrradiance / probeIrradiance (lookups with `frameIrradiance`). */
  refitClamp = 4;
  private _distanceRoughness = DEFAULT_DISTANCE_ROUGHNESS;
  private _roughnessLerp = DEFAULT_ROUGHNESS_LERP;
  private _lodMapping: ProbeLodMapping = DEFAULT_PROBE_LOD_MAPPING;
  /**
   * Roughness to mip for every lookup of this set (core's `lodMapping`, D101): 'alpha' (default)
   * blends linearly in roughness^2 between the sharp mips (both below r = 0.3), which halves the
   * error against a GGX reference there (p99 at r .05: 44.5 -> 19.7 / 255 at 128 px, 35.4 -> 21.9
   * at 256 px, W7); above, the same as 'r187', three r187's PMREM mapping `maxLod * r * (2 - r)`
   * everywhere (#35046's, so set 'r187' for #35046's look). A lookup's own `lodMapping` option
   * overrides it. Changing it rebuilds the set's nodes, like {@link distanceRoughness}.
   */
  get lodMapping() { return this._lodMapping; }
  set lodMapping(v: ProbeLodMapping) { if (v !== this._lodMapping) { this._lodMapping = v; this.touchUsers(); } }
  /**
   * Lagarde 2014's distance-based roughness on box-projected probes (not in #35046, D53): a glossy
   * lookup is sharp where the surface is near the projection box and keeps its roughness from the
   * capture point's distance on, `r' = mix( clamp( dHit / dCapture * r, 0, r ), r, r )`, as an SSR
   * hit there would be. Default true. The default of every lookup of this set (`reflectionProbes()`,
   * `sampleReflectionProbes()`, the hybrid composite), so lit and composite agree; a lookup's own
   * `distanceRoughness` option overrides it. Changing it rebuilds the set's nodes (an environment
   * node at once; a composite on its next rebuild). Not in #35046 (set it false for #35046's look).
   */
  get distanceRoughness() { return this._distanceRoughness; }
  set distanceRoughness(v: boolean) { if (v !== this._distanceRoughness) { this._distanceRoughness = v; this.touchUsers(); } }
  /**
   * Lagarde 2014's lerp of the box-projected direction back toward the unprojected one by roughness
   * (Appendix F, D53): rough lookups lose the parallax a centre-convolved probe can't honour. The
   * set-wide default, like {@link distanceRoughness}. Default false: it narrowed the SSR-to-probe
   * step on glossy floors but moved every showcase stage away from the path-traced reference (W26).
   */
  get roughnessLerp() { return this._roughnessLerp; }
  set roughnessLerp(v: boolean) { if (v !== this._roughnessLerp) { this._roughnessLerp = v; this.touchUsers(); } }
  /** L1 SH radiance coefficients per slot (3 vec4 rows each, core's table layout), from the last bake; null before. */
  irradiance: GPUBuffer | null = null;
  /** Bumped when `irradiance` is recomputed. */
  irradianceVersion = 0;

  /** One atlas per probe resolution, `textures[k]`'s render target (D4700). */
  private renderTargets: THREE.RenderTarget[] = [];
  /** Capture cube, camera and prefilter per face size. */
  private readonly captures = new Map<number, { cubeTarget: THREE.CubeRenderTarget; cubeCamera: THREE.CubeCamera; prefilter: ProbePrefilter | null }>();
  /** One irradiance filter per atlas layout (id and mip count). */
  private readonly irradianceFilters = new Map<string, ProbeIrradiance>();
  private readonly environment = new THREE.Scene();
  /** The environment the fallback slot holds (null: black), and its versions when captured. */
  private environmentTexture: THREE.Texture | null = null;
  private environmentVersion = -1;
  private environmentPMREMVersion = -1;
  /** Nodes sampling this set, rebuilt when a bake replaces the texture (see {@link track}). */
  private readonly users = new Set<WeakRef<THREE.Node>>();
  /** In a bounce pass (D25): lookups stay on during the captures, which go to {@link bounceScratch}. */
  private bouncePass = false;
  private bounceScratch: (GPUTexture | null)[] = [];

  constructor() {
    super();
    (this as { type: string }).type = 'ReflectionProbes';
  }

  /**
   * Registers a node that samples this set. A bake that replaces the texture (a new layout) marks it
   * for rebuild, so static meshes rebind the new texture on the next frame; r186/r187 don't rebind
   * unchanged render objects on its own. Called by {@link ReflectionProbesNode}.
   */
  track(node: THREE.Node) {
    this.users.add(new WeakRef(node));
  }

  /** Marks every tracked node for rebuild (its cache key changed). */
  private touchUsers() {
    for (const ref of this.users) {
      const node = ref.deref();
      if (node === undefined) this.users.delete(ref);
      else node.needsUpdate = true;
    }
  }

  /**
   * Captures the probes and `scene.environment` into the array (see {@link BakeOptions} for which
   * ones). Hide helpers and objects that should not appear in reflections first. Reuses the array,
   * the capture cube and the prefilter between bakes of the same layout, so re-baking every frame
   * neither allocates nor changes the texture materials sample.
   */
  bake(renderer: THREE.WebGPURenderer, scene: THREE.Scene, options: BakeOptions = {}) {
    const r = renderer as Renderer;
    if (r.backend.isWebGPUBackend !== true) throw new Error('ReflectionProbes: .bake() requires the WebGPU backend.');
    const { near = 0.1, far = 100, environment: environmentOption = true } = options;
    // default 256 and rounded down like #35046 (2712ba1b23), but from 64: our prefilter has no 256 floor (D23)
    const resolution = faceSize(options.resolution ?? DEFAULT_RESOLUTION);

    this.updateWorldMatrix(true, true);
    const probes = (this.children.filter((c) => (c as ReflectionProbe).isReflectionProbe) as ReflectionProbe[]).sort((a, b) => volume(a) - volume(b));
    // one atlas per probe resolution, the set default's first with the environment slot (D4700);
    // with every probe at the default this is the one atlas of (probes + 1) cubes it always was
    const plan = planProbeAtlases(probes.map((p) => (p.resolution == null ? null : faceSize(p.resolution))), resolution);
    const storage = this.storageFor(r);
    const cubeArray = storage === 'cube-array';
    // cube arrays filter across face edges in hardware, so they take plain texel centres ('none')
    const seamFix: SeamFix = cubeArray ? 'none' : this.seamFix;
    const warp = seamFix === 'warp';
    const device0: GPUDevice = r.backend.device;
    // each size is one more sampled texture wherever the set is looked up (D4700, D4900): materials
    // and three's composite (12 + 1 per size in examples/ssr). At WebGPU's default 16 a three- or
    // four-size set leaves a heavy material or an extra G-buffer target little room: say so once
    const sampledLimit: number = r.backend.device.limits.maxSampledTexturesPerShaderStage;
    if (plan.resolutions.length >= 3 && sampledLimit <= 16 && !warnedSampledTextures.has(r.backend.device)) {
      warnedSampledTextures.add(r.backend.device);
      console.warn(`ReflectionProbes: ${plan.resolutions.length} probe sizes (${plan.resolutions.join(', ')} px) are ${plan.resolutions.length} sampled textures in every shader that samples the set; `
        + `this device allows ${sampledLimit} per stage. If a material or pass stops drawing, create the renderer with `
        + `new WebGPURenderer({ requiredLimits: reflectionsRequiredLimits(adapter) }) (asks for up to 32), or use fewer sizes.`);
    }
    // 6 layers per slot: the default limit (256 layers) holds 41 probes plus the environment per atlas
    plan.slots.forEach((slots, a) => {
      if (slots * 6 > device0.limits.maxTextureArrayLayers) {
        throw new Error(`ReflectionProbes: ${slots} cubes of ${plan.resolutions[a]} px need ${slots * 6} array layers (6 per probe${a === 0 ? ' + 6 for the environment' : ''}), `
          + `but this device allows ${device0.limits.maxTextureArrayLayers}. Create the renderer with a larger limit `
          + `(new WebGPURenderer({ requiredLimits: { maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers } })) or use fewer probes per set.`);
      }
    });

    let renderTargets = this.renderTargets;
    let previous: THREE.RenderTarget[] = [];
    // new arrays (a size, a slot count or the storage changed), or every slot to be filtered again
    // (the seam fix changed, or probes moved between atlases)
    const newTarget = renderTargets.length !== plan.resolutions.length || this.bakedLayout !== storage
      || plan.resolutions.some((res, a) => renderTargets[a].width !== res || renderTargets[a].depth !== plan.slots[a] * 6);
    const sameAssignment = plan.atlas.length === this.bakedAtlases.length && plan.atlas.every((a, i) => a === this.bakedAtlases[i] && plan.slot[i] === this.bakedSlots[i]);
    const layoutChanged = newTarget || this.bakedSeamFix !== seamFix || !sameAssignment;
    if (newTarget) {
      // materials keep sampling the previous arrays while the probes are captured
      previous = renderTargets;
      renderTargets = plan.resolutions.map((res, a) => {
        const maxLod = maxLodFor(res);
        const target = new THREE.RenderTarget(res, res, {
          depth: plan.slots[a] * 6, type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
          minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
          ...(cubeArray ? { mapping: THREE.CubeReflectionMapping } : {}),
        });
        // six face layers per cube, as #35046 allocates its CubeArrayTexture (depth counts cubes)
        if (cubeArray) target.texture = new (cubeArrayTextureClass())().copy(target.texture);
        target.texture.name = a === 0 ? 'ReflectionProbes' : `ReflectionProbes.${res}`;
        for (let lod = 0; lod <= maxLod; lod++) target.texture.mipmaps.push({ width: res >> lod, height: res >> lod } as never);
        r.initRenderTarget(target);
        return target;
      });
    }
    // a capture cube, camera and prefilter per face size in use
    for (const [res, c] of this.captures) {
      if (plan.resolutions.includes(res)) continue;
      c.cubeTarget.dispose(); c.prefilter?.dispose();
      this.captures.delete(res);
    }
    for (const res of plan.resolutions) {
      let c = this.captures.get(res);
      if (c === undefined) {
        const cubeTarget = new THREE.CubeRenderTarget(res, { type: THREE.HalfFloatType, generateMipmaps: false });
        this.captures.set(res, (c = { cubeTarget, cubeCamera: new THREE.CubeCamera(near, far, cubeTarget), prefilter: null }));
      }
      if (c.prefilter === null || c.prefilter.warp !== warp) {
        c.prefilter?.dispose();
        c.prefilter = new ProbePrefilter(r.backend.device, res, warp);
      }
      for (const cam of c.cubeCamera.children as THREE.PerspectiveCamera[]) {
        if (cam.near !== near || cam.far !== far) { cam.near = near; cam.far = far; cam.updateProjectionMatrix(); }
      }
    }

    // Capturing only some probes keeps the other slots, so it needs the slots of the last bake.
    const sameProbes = probes.length === this.bakedProbes.length && probes.every((probe, i) => probe === this.bakedProbes[i]);
    const envSlot = plan.environmentSlot;
    const captured = options.probes !== undefined && !layoutChanged && sameProbes ? probes.filter((probe) => options.probes!.includes(probe)) : probes;

    // The environment is captured again only when it changed. A new array starts black, which is
    // what no environment looks like; a reused one still holds the last environment, so that slot
    // is cleared when the environment goes away.
    const environmentTexture = environmentOption === false ? null : scene.environment;
    const environmentChanged = environmentTexture !== this.environmentTexture || (environmentTexture !== null
      && (environmentTexture.version !== this.environmentVersion || environmentTexture.pmremVersion !== this.environmentPMREMVersion));
    const captureEnvironment = environmentTexture !== null && (layoutChanged || environmentChanged || environmentOption === 'always');
    const clearEnvironment = environmentTexture === null && this.environmentTexture !== null && !newTarget;
    const environment = this.environment;
    environment.background = environmentTexture;

    // clear every captured face, whatever the application's clear settings
    const { autoClear, autoClearColor, autoClearDepth, autoClearStencil } = r;
    const background = scene.background;
    r.autoClear = r.autoClearColor = r.autoClearDepth = r.autoClearStencil = true;
    if (background === null) scene.background = r.getClearColor(_clear).clone();

    // The bake gets a node frame of its own. three renders a shadow map at most once per camera per
    // frame (ShadowNode's camera-frame check, which also blocks `needsUpdate`), and the map is shared:
    // a bake in the frame of an earlier render overwrote the map with the capture's visibility while
    // the view camera, already done for the frame, skipped re-rendering it, so the next render of
    // that frame drew stale shadows (a sliced bake between renders; with the loop stopped, the checks
    // flaked at 75/255 whenever no rAF tick advanced the frame in between). D802.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any)._nodes.nodeFrame.update();

    // Shadow maps don't depend on the camera, so render each one once for the whole bake instead of
    // once per captured face (#35046, 2b95820110). Restored in `finally`.
    const shadows: THREE.LightShadow[] = [];
    scene.traverse((object) => {
      const light = object as THREE.Light & { shadow?: THREE.LightShadow };
      if (light.castShadow === true && light.shadow !== undefined && light.shadow.autoUpdate === true
        && ((light as THREE.PointLight).isPointLight === true || (light as THREE.SpotLight).isSpotLight === true || (light as THREE.DirectionalLight).isDirectionalLight === true)) {
        shadows.push(light.shadow);
        light.shadow.autoUpdate = false;
        light.shadow.needsUpdate = true;
      }
    });

    const device: GPUDevice = r.backend.device;
    const targets: GPUTexture[] = renderTargets.map((t) => r.backend.get(t.texture).texture);
    // a bounce pass prefilters into scratch copies of the atlases: the captures keep sampling the
    // previous pass's probes, and the pass lands at once below
    const outs = this.bouncePass ? targets.map((t, a) => this.scratchFor(device, t, a)) : targets;
    const captureSlot = (source: THREE.Scene, position: THREE.Vector3, atlas: number, slot: number) => {
      const c = this.captures.get(plan.resolutions[atlas])!;
      c.cubeCamera.position.copy(position);
      c.cubeCamera.updateMatrixWorld(true);
      c.cubeCamera.update(r, source);
      // three submitted the six face renders; the prefilter goes after them on the same queue
      const encoder = device.createCommandEncoder({ label: 'ReflectionProbes.bake' });
      c.prefilter!.encode(encoder, r.backend.get(c.cubeTarget.texture).texture, outs[atlas], slot);
      device.queue.submit([encoder.finish()]);
    };

    // hide excluded objects (the option plus userData.reflectionProbeExclude), restored in `finally`
    const hidden: THREE.Object3D[] = [];
    const hide = (o: THREE.Object3D) => { if (o.visible) { o.visible = false; hidden.push(o); } };
    for (const o of options.exclude ?? []) hide(o);
    scene.traverse((o) => { if (o.userData.reflectionProbeExclude) hide(o); });

    // captures see only the environment, except in a bounce pass (D25)
    this.capturing = !this.bouncePass;
    try {
      if (clearEnvironment) clearSlot(device, targets[0], envSlot);
      // the environment goes first: the probe captures reflect it
      if (captureEnvironment) captureSlot(environment, _position.set(0, 0, 0), 0, envSlot);
      for (const probe of captured) {
        const i = probes.indexOf(probe);
        captureSlot(scene, probeOrigin(probe, _position), plan.atlas[i], plan.slot[i]);
      }
    } finally {
      for (const o of hidden) o.visible = true;
      for (const shadow of shadows) shadow.autoUpdate = true;
      this.capturing = false;
      scene.background = background;
      Object.assign(r, { autoClear, autoClearColor, autoClearDepth, autoClearStencil });
    }
    if (outs !== targets) {
      const encoder = device.createCommandEncoder({ label: 'ReflectionProbes.bounce' });
      for (const probe of captured) {
        const i = probes.indexOf(probe), slot = plan.slot[i], target = targets[plan.atlas[i]], out = outs[plan.atlas[i]];
        for (let mip = 0; mip < target.mipLevelCount; mip++) {
          const s = Math.max(1, target.width >> mip);
          encoder.copyTextureToTexture({ texture: out, mipLevel: mip, origin: [0, 0, slot * 6] }, { texture: target, mipLevel: mip, origin: [0, 0, slot * 6] }, [s, s, 6]);
        }
      }
      device.queue.submit([encoder.finish()]);
    }

    if (options.irradiance !== false) this.computeIrradiance(device, targets, plan.slots, plan.irradianceBases, cubeArray ? 'cube-hw' : warp ? 'cube2d-warp' : 'cube2d-none');

    this.environmentTexture = environmentTexture;
    this.environmentVersion = environmentTexture?.version ?? -1;
    this.environmentPMREMVersion = environmentTexture?.pmremVersion ?? -1;

    for (const t of previous) t.dispose();
    this.renderTargets = renderTargets;
    this.textures = renderTargets.map((t) => t.texture);
    this.texture = this.textures[0];
    this.bakedResolutions = plan.resolutions;
    this.bakedAtlases = plan.atlas;
    this.bakedSlots = plan.slot;
    this.bakedEnvironmentSlot = envSlot;
    this.bakedProbes = probes;
    this.bakedSeamFix = seamFix;
    this.bakedLayout = storage;
    if (layoutChanged) {
      // the cache key of each node changes with the texture and probe count; bump the nodes so the
      // next frame sees it before drawing anything (updateBefore would be one frame late)
      this.touchUsers();
    }
    // The captures above were lit through the previous array (materials sample it until the bake
    // ends), whose environment slot still holds the old environment: when both changed, capture
    // the probes once more, now through this array (F2).
    if (previous.length > 0 && captureEnvironment && captured.length > 0) {
      this.bake(renderer, scene, { ...options, probes: captured, environment: environmentOption === false ? false : true, bounces: 1 });
    }
    // D25: further passes in which the captures see the previous pass's probes
    const bounces = Math.max(1, Math.floor(options.bounces ?? DEFAULT_BOUNCES));
    if (!this.bouncePass && bounces > 1 && captured.length > 0) {
      this.bouncePass = true;
      try {
        for (let pass = 1; pass < bounces; pass++) {
          this.bake(renderer, scene, { ...options, probes: captured, environment: environmentOption === false ? false : true, bounces: 1 });
        }
      } finally {
        this.bouncePass = false;
      }
    }
  }

  /** A texture shaped like atlas `atlas`'s `target` (layers, mips, format) for a bounce pass (D25). */
  private scratchFor(device: GPUDevice, target: GPUTexture, atlas: number): GPUTexture {
    const s = this.bounceScratch[atlas];
    if (s && s.width === target.width && s.depthOrArrayLayers === target.depthOrArrayLayers && s.mipLevelCount === target.mipLevelCount && s.format === target.format) return s;
    s?.destroy();
    return (this.bounceScratch[atlas] = device.createTexture({
      label: 'ReflectionProbes.bounce', size: [target.width, target.height, target.depthOrArrayLayers], format: target.format,
      mipLevelCount: target.mipLevelCount, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    }));
  }

  /** The storage a bake on `renderer` uses (see {@link layout}). */
  storageFor(renderer: THREE.WebGPURenderer): ProbeStorage {
    if (this.layout === 'cube2d') return 'cube2d';
    const supported = cubeArraySupported(renderer);
    if (this.layout === 'cube-array' && !supported) {
      throw new Error(`ReflectionProbes: layout 'cube-array' needs a renderer that binds cube arrays: three with CubeArrayTexture (#35053), `
        + `or await installCubeArraySupport( renderer ) first (${cubeArraySupportStatus(renderer).reason}). Use layout 'auto' to fall back to the 2D array.`);
    }
    return supported ? 'cube-array' : 'cube2d';
  }

  /**
   * L1 SH of every slot into `irradiance` (core ProbeIrradiance, x mirrored), reading each atlas as
   * the layout it was baked in: a cube array through a 'cube-array' view (`cube-hw`), never as a 2D
   * array, which compatibility-mode WebGPU rejects (D2204); a 2D array through '2d-array'. Slots
   * are numbered across the atlases (atlas k's from `bases[k]`, core table rows 2 / 3, D4700).
   */
  private computeIrradiance(device: GPUDevice, targets: GPUTexture[], slots: number[], bases: number[], id: 'cube-hw' | 'cube2d-warp' | 'cube2d-none') {
    const size = slots.reduce((x, y) => x + y, 0) * PROBE_IRRADIANCE_ROWS * 16;
    if (this.irradiance === null || this.irradiance.size !== size) {
      this.irradiance?.destroy();
      this.irradiance = device.createBuffer({ label: 'ReflectionProbes.irradiance', size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    }
    const encoder = device.createCommandEncoder({ label: 'ReflectionProbes.irradiance' });
    targets.forEach((target, a) => {
      const layout = createProbeLayout(id, { maxLod: target.mipLevelCount - 1 });
      const key = `${layout.id}:${layout.mipLevelCount}`;
      let filter = this.irradianceFilters.get(key);
      if (filter === undefined) this.irradianceFilters.set(key, (filter = new ProbeIrradiance(device, layout, { mirrorX: true })));
      filter.encode(encoder, target, this.irradiance!, bases[a] * PROBE_IRRADIANCE_ROWS, Array.from({ length: slots[a] }, (_, i) => i));
    });
    device.queue.submit([encoder.finish()]);
    this.irradianceVersion++;
  }

  /** Frees the GPU resources allocated by this instance. */
  dispose() {
    for (const f of this.irradianceFilters.values()) f.dispose();
    this.irradianceFilters.clear();
    this.irradiance?.destroy();
    this.irradiance = null;
    for (const t of this.bounceScratch) t?.destroy();
    this.bounceScratch = [];
    for (const t of this.renderTargets) t.dispose();
    this.renderTargets = [];
    for (const c of this.captures.values()) { c.cubeTarget.dispose(); c.prefilter?.dispose(); }
    this.captures.clear();
    this.texture = null;
    this.textures = [];
    this.environmentTexture = null;
  }
}

/** Clears the six layers of slot `slot`, every mip, to black. */
function clearSlot(device: GPUDevice, texture: GPUTexture, slot: number) {
  const encoder = device.createCommandEncoder({ label: 'ReflectionProbes.clear' });
  for (let mip = 0; mip < texture.mipLevelCount; mip++) for (let face = 0; face < 6; face++) {
    const view = texture.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: slot * 6 + face, arrayLayerCount: 1 });
    encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }).end();
  }
  device.queue.submit([encoder.finish()]);
}

/**
 * The scale a probe's volumes and offsets take from its world matrix: the length of each world
 * basis axis, so a mirrored parent (negative determinant) gives positive sizes; (0, 0, 0) when the
 * matrix is singular (a zero-scale parent), which disables the probe. three's getWorldScale gives a
 * negative x for the first and (1, 1, 1) for the second (Matrix4.decompose).
 */
export function probeWorldScale(object: THREE.Object3D, target: THREE.Vector3) {
  object.updateWorldMatrix(true, false);
  const m = object.matrixWorld, e = m.elements;
  if (m.determinant() === 0) return target.set(0, 0, 0);
  return target.set(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
}

/** World-space capture point of a probe: its position plus its scaled `originOffset`. */
export function probeOrigin(probe: ReflectionProbe, target: THREE.Vector3) {
  probeWorldScale(probe, _size).multiply(probe.originOffset);
  return probe.getWorldPosition(target).add(_size);
}

function volume(probe: ReflectionProbe) {
  probeWorldScale(probe, _size).multiply(probe.influenceSize);
  return _size.x * _size.y * _size.z;
}
