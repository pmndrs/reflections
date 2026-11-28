// Reflection probes for Babylon: the core ProbeSet (a cube-array atlas, the volume table, the WGSL
// lookup; packages/core/src/probes/set.ts) on Babylon's device, with the captures rendered by Babylon.
// SPEC "Capture stays in the adapter": Babylon renders the six faces (its own ReflectionProbe, a cube
// RenderTargetTexture), core does everything after (prefilter, atlas write, environment slot, lookup).
//
//   const probes = new BabylonProbeSet(scene, { capacity: 1, environment: [skybox] });
//   probes.setProbes([{ position: [0, 2, 0], influenceSize: [16, 4.2, 16], projectionSize: [16, 4.2, 12] }]);
//   await probes.bake();                      // renders the cubes, prefilters, uploads the table
//   new ScreenSpaceReflections({ engine, probes })   // misses and rough pixels take the probe lookup
//
// The environment slot is captured the same way, from a cube render of only the `environment` meshes
// (a skybox drawing scene.environmentTexture, or anything else that is "the sky"), so any Babylon
// environment (prefiltered .env, a raw cube, a procedural sky) reaches core in one format and size.
//
// Face orientation (D1805): on WebGPU, a ReflectionProbe's cube holds the world mirrored in Y under a
// plain `texture_cube` lookup (Babylon renders every target Y-flipped and swaps its ±Y face cameras to
// match its own samplers). Core's lookup only knows `mirrorX` (three's CubeCamera), so each capture
// goes through one compute pass that swaps ±Y and flips every face's rows before `ProbeSet.capture()`.
// The babylon example's orientation check (`__p.orientation()`, `pnpm check -- --only babylon`)
// measures this on every run.
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { ReflectionProbe } from '@babylonjs/core/Probes/reflectionProbe.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { ProbeSet, rotateByQuat, type ProbeQuaternion, type ProbeSetOptions, type ProbeVolume } from '@pmndrs/reflections-core';
import { asWebGPUEngine, getDevice, getGPUTexture } from './internal/babylonWebGPU';

type Vec3 = readonly [number, number, number];

const REORIENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = textureDimensions(dst).x;
  if (id.x >= n || id.y >= n) { return; }
  // world mirrored in y: +Y and -Y swap, every face's rows flip
  var face = id.z;
  if (face == 2u) { face = 3u; } else if (face == 3u) { face = 2u; }
  let c = textureLoad(src, vec2u(id.x, n - 1u - id.y), face, 0);
  textureStore(dst, vec2u(id.x, id.y), id.z, vec4f(c.rgb, 1.0));
}
`;

/**
 * Renders six-face captures with Babylon and returns them as rgba16float cubes (6 array layers) in
 * WebGPU's cube convention, the input core's ProbeSet takes. One instance per scene and face size;
 * each `capture()` reuses its ReflectionProbe and output texture (copy the result out, or hand it to
 * `ProbeSet.capture()` in the next submit, before capturing again).
 */
export class BabylonCubeCapture {
  readonly scene: Scene;
  readonly size: number;
  readonly device: GPUDevice;
  private probe: ReflectionProbe | null = null;
  private readonly output: GPUTexture;
  private readonly pipeline: GPUComputePipeline;

  constructor(scene: Scene, size: number) {
    this.scene = scene;
    this.size = size;
    this.device = getDevice(scene.getEngine());
    this.output = this.device.createTexture({
      label: 'babylon cube capture', size: [size, size, 6], format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.pipeline = this.device.createComputePipeline({
      label: 'babylon cube capture: reorient', layout: 'auto',
      compute: { module: this.device.createShaderModule({ label: 'babylon cube capture: reorient', code: REORIENT_WGSL }), entryPoint: 'main' },
    });
  }

  /**
   * Renders `meshes` from `position` (linear HDR, no image processing), flushes Babylon, and records
   * the reorientation into `encoder`. Returns the cube (valid once `encoder` is submitted).
   */
  capture(encoder: GPUCommandEncoder, position: Vec3, meshes: AbstractMesh[]): GPUTexture {
    if (!this.probe) {
      // no mips (core prefilters from mip 0), half float, linear space
      this.probe = new ReflectionProbe('reflections capture', this.size, this.scene, false, true, true);
      // rendered on demand only: keep it out of the scene's per-frame probe list
      const list = this.scene.reflectionProbes;
      const at = list.indexOf(this.probe);
      if (at >= 0) list.splice(at, 1);
    }
    const probe = this.probe;
    probe.position.set(position[0], position[1], position[2]);
    probe.renderList!.length = 0;
    probe.renderList!.push(...meshes);
    probe.cubeTexture.render();
    // Babylon's renders are recorded, not submitted: flush them before core reads the cube.
    asWebGPUEngine(this.scene.getEngine()).flushFramebuffer();
    const internal = probe.cubeTexture.getInternalTexture();
    if (!internal) throw new Error('BabylonCubeCapture: the capture has no texture');
    const babylonCube = getGPUTexture(internal);
    const pass = encoder.beginComputePass({ label: 'babylon cube capture: reorient' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: babylonCube.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 1, resource: this.output.createView({ dimension: '2d-array' }) },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(this.size / 8), Math.ceil(this.size / 8), 6);
    pass.end();
    return this.output;
  }

  dispose() {
    this.probe?.dispose();
    this.probe = null;
    this.output.destroy();
  }
}

/** One probe: where it captures and the box it lights (world space, Babylon's axes). */
export interface BabylonProbe {
  /** Influence-box centre, and the capture position unless `originOffset` moves it. */
  position: Vec3;
  /** Influence box size, centred on `position`. */
  influenceSize: Vec3;
  /** Box-projection size (parallax). Default: no box projection. */
  projectionSize?: Vec3;
  /** Projection box centre relative to `position` (three's `ReflectionProbe.projectionOffset`), in the box's frame when `rotation` is set. Default 0. */
  projectionOffset?: Vec3;
  /**
   * The boxes' orientation (T23, W108): a unit quaternion (x, y, z, w) taking the box's own axes to
   * world, as a Babylon `Quaternion` holds it (e.g. a mesh's `rotationQuaternion`, or
   * `Quaternion.FromEulerAngles(...)`). The influence and projection boxes and both offsets turn with
   * it; the capture stays a world-aligned cube. Default: axis-aligned.
   */
  rotation?: ProbeQuaternion;
  /**
   * Capture point relative to `position` (three's `ReflectionProbe.originOffset`; turned by `rotation`). Default 0. With the offsets an
   * influence box can reach below the floor (so the floor gets full weight, not the fade at its face) while the
   * capture point and the projection box stay where the room is.
   */
  originOffset?: Vec3;
  /** Influence fade distance (world units). Default 1. */
  fade?: number;
  priority?: number;
  /** Meshes the capture sees. Default: every enabled, visible mesh of the scene. */
  renderList?: AbstractMesh[];
}

export interface BabylonProbeSetOptions extends Partial<Pick<ProbeSetOptions, 'sourceSize' | 'format' | 'dominantDirection' | 'lodMapping' | 'slotSizes'>> {
  /** Probe slots. Default 4. */
  capacity?: number;
  /**
   * Meshes that are the environment (e.g. the skybox): captured from the origin into the
   * environment slot, which takes what no probe covers. Null (default): no environment slot (black).
   */
  environment?: AbstractMesh[] | null;
}

/** Where a probe captures: `position + originOffset` (the offset turned by `rotation`). */
const captureOrigin = (p: BabylonProbe): Vec3 => {
  const o = p.originOffset ?? [0, 0, 0];
  const w = p.rotation ? rotateByQuat(normalized(p.rotation), o) : o;
  return [p.position[0] + w[0], p.position[1] + w[1], p.position[2] + w[2]];
};
const normalized = (q: ProbeQuaternion): ProbeQuaternion => { const n = Math.hypot(...q) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };

export class BabylonProbeSet {
  readonly scene: Scene;
  readonly set: ProbeSet;
  private probes: BabylonProbe[] = [];
  private readonly environmentMeshes: AbstractMesh[] | null;
  /** One capture per face size (`slotSizes`, D4700). */
  private readonly capturers = new Map<number, BabylonCubeCapture>();

  constructor(scene: Scene, options: BabylonProbeSetOptions = {}) {
    this.scene = scene;
    const engine = scene.getEngine();
    asWebGPUEngine(engine);
    this.environmentMeshes = options.environment ?? null;
    this.set = new ProbeSet(getDevice(engine), {
      capacity: options.capacity ?? 4,
      sourceSize: options.sourceSize ?? 128,
      format: options.format,
      dominantDirection: options.dominantDirection,
      lodMapping: options.lodMapping,
      environment: this.environmentMeshes !== null,
      slotSizes: options.slotSizes,
    });
    this.capturerFor(this.set.sourceSize);
  }

  private capturerFor(size: number): BabylonCubeCapture {
    let c = this.capturers.get(size);
    if (c === undefined) this.capturers.set(size, (c = new BabylonCubeCapture(this.scene, size)));
    return c;
  }

  /** Local probes contribute (off: the environment slot only). */
  get enabled() { return this.set.enabled; }
  set enabled(on: boolean) {
    this.set.enabled = on;
    this.set.update();
  }

  /** Sets the probes; `bake()` captures them. */
  setProbes(probes: readonly BabylonProbe[]) {
    if (probes.length > this.set.capacity) throw new Error(`BabylonProbeSet: ${probes.length} probes, capacity ${this.set.capacity}`);
    this.probes = [...probes];
    const volumes: ProbeVolume[] = this.probes.map((p, slot) => ({
      slot, center: p.position, halfSize: [p.influenceSize[0] / 2, p.influenceSize[1] / 2, p.influenceSize[2] / 2],
      fade: p.fade ?? 1, priority: p.priority,
      ...(p.projectionSize ? { boxProjection: true, projectionSize: p.projectionSize, projectionOffset: p.projectionOffset } : { boxProjection: false }),
      ...(p.originOffset ? { origin: captureOrigin(p) } : {}),
      ...(p.rotation ? { rotation: p.rotation } : {}),
    }));
    this.set.setVolumes(volumes);
    this.set.update();
  }

  getProbes(): readonly BabylonProbe[] { return this.probes; }

  /**
   * Captures every probe and the environment, prefilters them into the atlas and uploads the table.
   * Needs `scene.activeCamera` (Babylon takes the capture's near / far planes from it). Materials
   * that take their irradiance from this set (`probeIrradiance`, ./irradiance.ts) see it disabled
   * while capturing (the environment slot only, core's `ProbeSet.enabled`), so a bake never sees the
   * probes themselves and a re-bake gives what the first did.
   */
  async bake(): Promise<void> {
    const device = this.set.device;
    if (!this.scene.activeCamera) throw new Error('BabylonProbeSet.bake: set scene.activeCamera first (captures take its near / far)');
    const all = this.scene.meshes.filter((m) => m.isEnabled() && m.isVisible);
    const jobs: { slot: number; position: Vec3; meshes: AbstractMesh[] }[] = this.probes.map((p, slot) => ({ slot, position: captureOrigin(p), meshes: p.renderList ?? all }));
    if (this.environmentMeshes) jobs.push({ slot: this.set.environmentSlot, position: [0, 0, 0], meshes: this.environmentMeshes });
    const enabled = this.set.enabled;
    this.set.enabled = false;
    this.set.update();
    try {
      // one capture texture: each job is captured, prefiltered and submitted before the next
      for (const job of jobs) {
        const encoder = device.createCommandEncoder({ label: `babylon probe capture ${job.slot}` });
        const cube = this.capturerFor(this.set.slotSize(job.slot)).capture(encoder, job.position, job.meshes);
        this.set.capture(encoder, job.slot, cube);
        device.queue.submit([encoder.finish()]);
      }
    } finally {
      this.set.enabled = enabled;
      this.set.update();
    }
    await device.queue.onSubmittedWorkDone();
  }

  dispose() {
    for (const c of this.capturers.values()) c.dispose();
    this.capturers.clear();
    this.set.dispose();
  }
}
