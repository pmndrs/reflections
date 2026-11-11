// How the three adapter shades traced hits (core's HitShading, group 3 of the traced pass), and
// from what: the scene's reflection probes when the scene is lit by them, its environment otherwise.
//
// - Probes (D901, W28): core `probeHitShading` over the ReflectionProbes' own atlas (the bake's
//   texture) and a volume table packed by the probe module's `packReflectionProbesTable` (the node's
//   own packing, D2900), so a hit's diffuse
//   term is the probe lookup at the hit along N at roughness 1, what three's EnvironmentNode gives
//   the same surface on screen when `scene.environmentNode = reflectionProbes(probes)`.
// - Environment: core `environmentHitShading` (cosine-weighted mean of `scene.environment`).
//
// Both add the scene's directional (shadowed) and hemisphere lights. The compiled shading depends
// on the source (equirect / cube / the probe atlas layout and count), so `prepare()` says when the
// traced pass must be rebuilt.
import * as THREE from 'three/webgpu';
import {
  environmentHitShading, probeHitShading, probeTableRows,
  type EnvironmentHitShading, type EnvironmentMapping, type HitLights, type HitShading, type ProbeHitShading,
} from '@pmndrs/reflections-core';
import { type ReflectionProbes } from '../probes/ReflectionProbes';
import { ReflectionProbesNode, packReflectionProbesTable, probeLayoutFor } from '../probes/ReflectionProbesNode';

/**
 * The probes three lights `scene` with: those of a plain `reflectionProbes(probes)` environment
 * node (no explicit position / direction, not the coverage form), else null.
 */
export function sceneLightingProbes(scene: THREE.Scene): ReflectionProbes | null {
  const node = (scene as unknown as { environmentNode?: unknown }).environmentNode;
  if (!(node instanceof ReflectionProbesNode) || node.coverage || node.positionNode !== null || node.directionNode !== null) return null;
  return node.probes.texture && node.probes.bakedProbes ? node.probes : null;
}

type Source = { kind: 'environment'; texture: THREE.Texture } | { kind: 'probes'; probes: ReflectionProbes };

export class ThreeHitShading {
  private env: EnvironmentHitShading | null = null;
  private probe: ProbeHitShading | null = null;
  private key = '';
  private group: GPUBindGroup | null = null;
  private groupFor: GPUTexture | null = null;
  private table: GPUBuffer | null = null;
  private packed: Float32Array<ArrayBuffer> = new Float32Array(0);
  private sampler: GPUSampler | null = null;
  private source: Source | null = null;

  constructor(private readonly device: GPUDevice, private readonly gpu: (t: THREE.Texture) => GPUTexture) {}

  /** The compiled shading (after `prepare`). */
  get shading(): HitShading { return (this.probe ?? this.env)!; }

  /** 'probes' or 'environment' (after `prepare`). */
  get kind(): 'probes' | 'environment' { return this.probe ? 'probes' : 'environment'; }

  /**
   * Pick this frame's source: `probes` if given (baked), else `environment`. Returns true when the
   * compiled shading changed, so the traced pass that compiled the old one must be rebuilt.
   */
  prepare(environment: THREE.Texture, probes: ReflectionProbes | null): boolean {
    let key: string;
    if (probes?.texture && probes.bakedProbes) {
      const layout = probeLayoutFor(probes);
      key = `probes:${layout.id}:${layout.mipLevelCount}:${probes.bakedProbes.length}`;
      this.source = { kind: 'probes', probes };
    } else {
      key = (environment as THREE.CubeTexture).isCubeTexture ? 'cube' : 'equirect';
      this.source = { kind: 'environment', texture: environment };
    }
    if (key === this.key) return false;
    this.destroyShading();
    this.key = key;
    if (this.source.kind === 'probes') {
      const p = this.source.probes;
      this.probe = probeHitShading(this.device, { layout: probeLayoutFor(p), mirrorX: true, count: p.bakedProbes.length });
    } else {
      this.env = environmentHitShading(this.device, key as EnvironmentMapping);
    }
    return true;
  }

  /** The group-3 bind group for this frame, with the lighting written. */
  bindGroup(intensity: number, lights: HitLights): GPUBindGroup {
    const src = this.source!;
    if (src.kind === 'probes') {
      const probes = src.probes, gpu = this.gpu(probes.texture!);
      const count = probes.bakedProbes.length;
      const rows = probeTableRows(count, count + 1);
      if (!this.table || this.table.size < rows * 16) {
        this.table?.destroy();
        this.table = this.device.createBuffer({ label: 'rt hit probes table', size: rows * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.group = null;
      }
      // every frame, as the probe node's own table (moved probes, `boxProjection`, a bake in progress)
      this.packed = packReflectionProbesTable(probes, this.packed);
      this.device.queue.writeBuffer(this.table, 0, this.packed);
      if (!this.group || this.groupFor !== gpu) {
        this.sampler ??= this.device.createSampler({ label: 'rt hit probes', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
        const atlas = gpu.createView({ dimension: probeLayoutFor(probes).viewDimension });
        this.group = this.probe!.createBindGroup({ atlas, sampler: this.sampler, table: this.table });
        this.groupFor = gpu;
      }
      this.probe!.setLighting(intensity, lights);
      return this.group;
    }
    const gpu = this.gpu(src.texture);
    if (!this.group || this.groupFor !== gpu) {
      const view = this.env!.mapping === 'cube' ? gpu.createView({ dimension: 'cube' }) : gpu.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1 });
      this.group = this.env!.createBindGroup(view);
      this.groupFor = gpu;
    }
    this.env!.setLighting(intensity, lights);
    return this.group;
  }

  private destroyShading() {
    this.env?.destroy(); this.env = null;
    this.probe?.destroy(); this.probe = null;
    this.group = null; this.groupFor = null;
  }

  destroy() {
    this.destroyShading();
    this.table?.destroy(); this.table = null;
    this.key = '';
  }
}
