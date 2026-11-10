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
//   - three can't bind `texture_cube_array` yet (#35045 was reverted; #35053 is open), so the cubes live
//     in a 2D array texture, layer = probe * 6 + face, mip = roughness level. Same layers and mips
//     as #35046's CubeArrayTexture (with 'warp', texel centres differ); the node picks face and uv
//     itself instead of the sampler.
//   - r187's PMREMGenerator writes cube mips, but per probe into its own render target and in render
//     passes; the prefilter is our own compute pass with r187's algorithm, writing straight into the
//     array layers (core: probes/prefilter.ts).
//   - `seamFix` (new): a manual face lookup has no seamless cube filtering. 'none' clamps at face
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
// from three/addons instead, drop `seamFix` / `bakedSeamFix`, and move any probe with an
// `originOffset` to its box centre (or keep that one extension); `texture` becomes a CubeArrayTexture
// (nothing outside the node should sample it directly). Everything else (constructor, influenceSize,
// projectionSize, projectionOffset, blendDistance, boxProjection, bake( renderer, scene, { resolution,
// near, far } ), texture, bakedProbes, capturing, dispose) has the same name and meaning. #35046 head's
// vec4 `reflectionProbes()` is our `reflectionProbesLocal()`; ours keeps the vec3 form with the
// environment fallback (docs/DIVERGES.md D20).

import * as THREE from 'three/webgpu';
import { PROBE_IRRADIANCE_ROWS, ProbeIrradiance, ProbePrefilter, createProbeLayout, maxLodFor } from '@pmndrs/reflections-core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Renderer = THREE.WebGPURenderer & { backend: any };

const _position = new THREE.Vector3();
const _size = new THREE.Vector3();
const _clear = new THREE.Color();

/**
 * A local reflection volume. Add it to a {@link ReflectionProbes} container. The volumes are
 * axis-aligned boxes centred on the probe; they follow its world position and scale, rotation is
 * ignored.
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
    return this;
  }
}

export interface BakeOptions {
  /** Cube face size, rounded down to a power of two, at least 64. Default 128. */
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
   * Compute each slot's L1 SH irradiance from its capture after the bake (core ProbeIrradiance), for
   * the re-fit (`frameIrradiance` lookup option). One small dispatch per slot. Default true.
   */
  irradiance?: boolean;
}

export type SeamFix = 'warp' | 'none';

/**
 * A set of {@link ReflectionProbe} children baked into one texture. Assign
 * `reflectionProbes( probes )` to `scene.environmentNode`. Smaller volumes take priority over
 * larger ones; uncovered surfaces fall back to `scene.environment`. WebGPU backend only.
 */
export class ReflectionProbes extends THREE.Object3D {
  readonly isReflectionProbes = true;
  /** Whether the probes use box projection. */
  boxProjection = true;
  /** Face-edge handling of the manual cube lookup (not in #35046, see the file header). Re-bake after changing it. */
  seamFix: SeamFix = 'warp';
  /** The baked 2D array texture: 6 layers per probe, then 6 for the environment; mips = roughness. */
  texture: THREE.Texture | null = null;
  /** The probes in baked order, smallest volume first. */
  bakedProbes: ReflectionProbe[] = [];
  /** The seam fix the current `texture` was baked with (the node samples to match). */
  bakedSeamFix: SeamFix = 'warp';
  /** Whether a bake is in progress. Probes then contribute only the environment. */
  capturing = false;
  /** Upper bound of the re-fit ratio frameIrradiance / probeIrradiance (lookups with `frameIrradiance`). */
  refitClamp = 4;
  /** L1 SH radiance coefficients per slot (3 vec4 rows each, core's table layout), from the last bake; null before. */
  irradiance: GPUBuffer | null = null;
  /** Bumped when `irradiance` is recomputed. */
  irradianceVersion = 0;

  private renderTarget: THREE.RenderTarget | null = null;
  private cubeTarget: THREE.CubeRenderTarget | null = null;
  private cubeCamera: THREE.CubeCamera | null = null;
  private prefilter: ProbePrefilter | null = null;
  private irradianceFilter: ProbeIrradiance | null = null;
  private readonly environment = new THREE.Scene();
  /** The environment the fallback slot holds (null: black), and its versions when captured. */
  private environmentTexture: THREE.Texture | null = null;
  private environmentVersion = -1;
  private environmentPMREMVersion = -1;
  /** Nodes sampling this set, rebuilt when a bake replaces the texture (see {@link track}). */
  private readonly users = new Set<WeakRef<THREE.Node>>();

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
    // rounded down like #35046 (2712ba1b23), but from 64: our prefilter has no 256 floor (D23)
    const resolution = Math.max(64, THREE.MathUtils.floorPowerOfTwo(options.resolution ?? 128));

    this.updateWorldMatrix(true, true);
    const probes = (this.children.filter((c) => (c as ReflectionProbe).isReflectionProbe) as ReflectionProbe[]).sort((a, b) => volume(a) - volume(b));
    const maxLod = maxLodFor(resolution);
    const depth = (probes.length + 1) * 6;
    const warp = this.seamFix === 'warp';
    const device0: GPUDevice = r.backend.device;
    // 6 layers per slot: the default limit (256 layers) holds 41 probes plus the environment
    if (depth > device0.limits.maxTextureArrayLayers) {
      throw new Error(`ReflectionProbes: ${probes.length} probes need ${depth} array layers (6 per probe + 6 for the environment), `
        + `but this device allows ${device0.limits.maxTextureArrayLayers}. Create the renderer with a larger limit `
        + `(new WebGPURenderer({ requiredLimits: { maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers } })) or use fewer probes per set.`);
    }

    let renderTarget = this.renderTarget;
    let previous: THREE.RenderTarget | null = null;
    // a new array, or every slot to be filtered again (the seam fix changed)
    const layoutChanged = renderTarget === null || renderTarget.width !== resolution || renderTarget.depth !== depth || this.bakedSeamFix !== this.seamFix;
    if (renderTarget === null || renderTarget.width !== resolution || renderTarget.depth !== depth) {
      // materials keep sampling the previous array while the probes are captured
      previous = renderTarget;
      renderTarget = new THREE.RenderTarget(resolution, resolution, {
        depth, type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      });
      renderTarget.texture.name = 'ReflectionProbes';
      for (let lod = 0; lod <= maxLod; lod++) renderTarget.texture.mipmaps.push({ width: resolution >> lod, height: resolution >> lod } as never);
      r.initRenderTarget(renderTarget);
    }
    if (this.cubeTarget === null || this.cubeTarget.width !== resolution) {
      this.cubeTarget?.dispose();
      this.cubeTarget = new THREE.CubeRenderTarget(resolution, { type: THREE.HalfFloatType, generateMipmaps: false });
      this.cubeCamera = new THREE.CubeCamera(near, far, this.cubeTarget);
    }
    if (this.prefilter === null || this.prefilter.size !== resolution || this.prefilter.warp !== warp) {
      this.prefilter?.dispose();
      this.prefilter = new ProbePrefilter(r.backend.device, resolution, warp);
    }

    const cubeCamera = this.cubeCamera!;
    for (const cam of cubeCamera.children as THREE.PerspectiveCamera[]) {
      if (cam.near !== near || cam.far !== far) { cam.near = near; cam.far = far; cam.updateProjectionMatrix(); }
    }
    // Capturing only some probes keeps the other slots, so it needs the slots of the last bake.
    const sameProbes = probes.length === this.bakedProbes.length && probes.every((probe, i) => probe === this.bakedProbes[i]);
    const captured = options.probes !== undefined && !layoutChanged && sameProbes ? probes.filter((probe) => options.probes!.includes(probe)) : probes;

    // The environment is captured again only when it changed. A new array starts black, which is
    // what no environment looks like; a reused one still holds the last environment, so that slot
    // is cleared when the environment goes away.
    const environmentTexture = environmentOption === false ? null : scene.environment;
    const environmentChanged = environmentTexture !== this.environmentTexture || (environmentTexture !== null
      && (environmentTexture.version !== this.environmentVersion || environmentTexture.pmremVersion !== this.environmentPMREMVersion));
    const captureEnvironment = environmentTexture !== null && (layoutChanged || environmentChanged || environmentOption === 'always');
    const clearEnvironment = environmentTexture === null && this.environmentTexture !== null && renderTarget === this.renderTarget;
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
    const target: GPUTexture = r.backend.get(renderTarget.texture).texture;
    const captureSlot = (source: THREE.Scene, position: THREE.Vector3, slot: number) => {
      cubeCamera.position.copy(position);
      cubeCamera.updateMatrixWorld(true);
      cubeCamera.update(r, source);
      // three submitted the six face renders; the prefilter goes after them on the same queue
      const encoder = device.createCommandEncoder({ label: 'ReflectionProbes.bake' });
      this.prefilter!.encode(encoder, r.backend.get(this.cubeTarget!.texture).texture, target, slot);
      device.queue.submit([encoder.finish()]);
    };

    this.capturing = true;
    try {
      if (clearEnvironment) clearSlot(device, target, probes.length);
      // the environment goes first: the probe captures reflect it
      if (captureEnvironment) captureSlot(environment, _position.set(0, 0, 0), probes.length);
      for (const probe of captured) captureSlot(scene, probeOrigin(probe, _position), probes.indexOf(probe));
    } finally {
      for (const shadow of shadows) shadow.autoUpdate = true;
      this.capturing = false;
      scene.background = background;
      Object.assign(r, { autoClear, autoClearColor, autoClearDepth, autoClearStencil });
    }

    if (options.irradiance !== false) this.computeIrradiance(device, target, probes.length + 1);

    this.environmentTexture = environmentTexture;
    this.environmentVersion = environmentTexture?.version ?? -1;
    this.environmentPMREMVersion = environmentTexture?.pmremVersion ?? -1;

    previous?.dispose();
    this.renderTarget = renderTarget;
    this.texture = renderTarget.texture;
    this.bakedProbes = probes;
    this.bakedSeamFix = this.seamFix;
    if (layoutChanged) {
      // the cache key of each node changes with the texture and probe count; bump the nodes so the
      // next frame sees it before drawing anything (updateBefore would be one frame late)
      for (const ref of this.users) {
        const node = ref.deref();
        if (node === undefined) this.users.delete(ref);
        else node.needsUpdate = true;
      }
    }
  }

  /** L1 SH of every slot into `irradiance` (core ProbeIrradiance on three's 2D-array atlas, x mirrored). */
  private computeIrradiance(device: GPUDevice, target: GPUTexture, slots: number) {
    const layout = createProbeLayout(this.seamFix === 'warp' ? 'cube2d-warp' : 'cube2d-none', { maxLod: target.mipLevelCount - 1 });
    if (this.irradianceFilter === null || this.irradianceFilter.layout.id !== layout.id || this.irradianceFilter.layout.mipLevelCount !== layout.mipLevelCount) {
      this.irradianceFilter?.dispose();
      this.irradianceFilter = new ProbeIrradiance(device, layout, { mirrorX: true });
    }
    const size = slots * PROBE_IRRADIANCE_ROWS * 16;
    if (this.irradiance === null || this.irradiance.size !== size) {
      this.irradiance?.destroy();
      this.irradiance = device.createBuffer({ label: 'ReflectionProbes.irradiance', size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    }
    const encoder = device.createCommandEncoder({ label: 'ReflectionProbes.irradiance' });
    this.irradianceFilter.encode(encoder, target.createView({ dimension: '2d-array' }), this.irradiance, 0, Array.from({ length: slots }, (_, i) => i));
    device.queue.submit([encoder.finish()]);
    this.irradianceVersion++;
  }

  /** Frees the GPU resources allocated by this instance. */
  dispose() {
    this.irradianceFilter?.dispose();
    this.irradiance?.destroy();
    this.irradianceFilter = null;
    this.irradiance = null;
    this.renderTarget?.dispose();
    this.cubeTarget?.dispose();
    this.prefilter?.dispose();
    this.renderTarget = this.cubeTarget = this.cubeCamera = this.prefilter = null;
    this.texture = null;
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

/** World-space capture point of a probe: its position plus its scaled `originOffset`. */
export function probeOrigin(probe: ReflectionProbe, target: THREE.Vector3) {
  probe.getWorldScale(_size).multiply(probe.originOffset);
  return probe.getWorldPosition(target).add(_size);
}

function volume(probe: ReflectionProbe) {
  probe.getWorldScale(_size).multiply(probe.influenceSize);
  return _size.x * _size.y * _size.z;
}
