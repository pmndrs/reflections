import { describe, expect, it } from 'vitest';
import { createProbeLayout, probeHitShading, probeLookupWgsl } from '@pmndrs/reflections-core';

// RT hit shading over a probe set with probes of several sizes (W47, D4702): core `probeHitShading`
// binds atlases 1.. after its uniform (4..), three's hit shading binds every atlas and packs the
// table for all of them. A one-atlas set compiles and packs as before. The shading itself is checked
// on the GPU (examples/probe-core 'rt probe hit shading: slot sizes', examples/ssr offscreen, pnpm check).

/** A device that records the layouts and bind groups it is asked for (no GPU). */
function fakeDevice() {
  const layouts: GPUBindGroupLayoutDescriptor[] = [], groups: GPUBindGroupDescriptor[] = [];
  const device = {
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return { d } as unknown as GPUBindGroupLayout; },
    createBindGroup: (d: GPUBindGroupDescriptor) => { groups.push(d); return { d } as unknown as GPUBindGroup; },
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, label: d.label, destroy() {} }) as unknown as GPUBuffer,
    createSampler: () => ({}) as GPUSampler,
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
  return { device, layouts, groups };
}
// node has no WebGPU globals; three's hit shading names buffer usages
(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
const bindings = (d: GPUBindGroupLayoutDescriptor | GPUBindGroupDescriptor) => [...d.entries].map((e) => e.binding);
const view = (name: string) => ({ name }) as unknown as GPUTextureView;

describe('core probeHitShading over several atlases (D4702)', () => {
  const layout = createProbeLayout('cube-hw', { maxLod: 5 });
  it('one atlas: the lookup as before, bindings 0..3', () => {
    const { device, layouts } = fakeDevice();
    const o = { layout, mirrorX: true, count: 3 };
    const s = probeHitShading(device, o);
    expect(s.wgsl.startsWith(probeLookupWgsl({ ...o, group: 3, binding: 0 }))).toBe(true);
    expect(s.wgsl).not.toMatch(/pr_atlas_1/);
    expect(bindings(layouts[0])).toEqual([0, 1, 2, 3]);
  });
  it('several atlases: atlases 1.. at 4.., past the uniform at 3', () => {
    const { device, layouts, groups } = fakeDevice();
    const s = probeHitShading(device, { layout, mirrorX: true, count: 3, atlases: 3, volumeAtlases: [0, 2, 1] });
    expect(s.wgsl).toContain('@group(3) @binding(4) var pr_atlas_1: texture_cube_array<f32>;');
    expect(s.wgsl).toContain('@group(3) @binding(5) var pr_atlas_2: texture_cube_array<f32>;');
    expect(s.wgsl).toContain('@group(3) @binding(3) var<uniform> hitEnv: HitEnv;');
    expect(s.wgsl.match(/@group\(3\) @binding\(3\)/g)).toHaveLength(1);
    expect(bindings(layouts[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.storageBufferCount).toBe(1);
    s.createBindGroup({ atlas: view('a0'), sampler: {} as GPUSampler, table: {} as GPUBuffer, atlases: [view('a1'), view('a2')] });
    expect(bindings(groups[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(([...groups[0].entries][5].resource as unknown as { name: string }).name).toBe('a2');
    expect(() => s.createBindGroup({ atlas: view('a0'), sampler: {} as GPUSampler, table: {} as GPUBuffer })).toThrow(/compiled for 3 atlases, got 1/);
  });
});

describe('three: RT hit shading binds every atlas of a mixed-size set (D4702)', async () => {
  const THREE = await import('three/webgpu');
  const { ReflectionProbe, ReflectionProbes } = await import('../packages/three/src/probes/ReflectionProbes');
  const { ThreeHitShading } = await import('../packages/three/src/trace/hitShading');
  const tex = (size: number) => { const t = new THREE.Texture(); for (let s = size; s >= 8; s >>= 1) t.mipmaps.push({ width: s, height: s } as never); return t; };
  // a set as a bake leaves it (cube array): probes 0 and 2 at the default (atlas 0), probe 1 at 512 (atlas 1)
  const makeSet = (mixed: boolean) => {
    const set = new ReflectionProbes();
    const probes = [0, 1, 2].map((i) => { const p = new ReflectionProbe(2, 2, 2); p.position.set(i * 10, 0, 0); set.add(p); return p; });
    const textures = mixed ? [tex(256), tex(512)] : [tex(256)];
    Object.assign(set, {
      bakedProbes: probes, textures, bakedAtlases: mixed ? [0, 1, 0] : [0, 0, 0], bakedSlots: mixed ? [0, 0, 1] : [0, 1, 2],
      bakedEnvironmentSlot: mixed ? 2 : 3, bakedResolutions: mixed ? [256, 512] : [256], bakedLayout: 'cube-array',
    });
    set.texture = textures[0];
    return set;
  };
  const gpuOf = new Map<THREE.Texture, GPUTexture>();
  const gpu = (t: THREE.Texture) => {
    let g = gpuOf.get(t);
    if (!g) gpuOf.set(t, (g = { createView: (d: GPUTextureViewDescriptor) => ({ of: t.id, d }) } as unknown as GPUTexture));
    return g;
  };
  it('a mixed set: compiled for 2 atlases, both bound, the table packed for all', () => {
    const { device, groups } = fakeDevice();
    const writes: Float32Array[] = [];
    (device.queue as unknown as { writeBuffer: (b: GPUBuffer, o: number, d: Float32Array) => void }).writeBuffer = (b, _o, d) => { if (b.label === 'rt hit probes table') writes.push(d.slice()); };
    const set = makeSet(true);
    const hs = new ThreeHitShading(device, gpu);
    expect(hs.prepare(new THREE.Texture(), set)).toBe(true);
    expect(hs.shading.wgsl).toContain('@group(3) @binding(4) var pr_atlas_1');
    hs.bindGroup(1, {});
    const g = groups[groups.length - 1];
    expect(bindings(g)).toEqual([0, 1, 2, 3, 4]);
    const ids = [...g.entries].filter((e) => e.binding === 0 || e.binding === 4).map((e) => (e.resource as unknown as { of: number }).of);
    expect(ids).toEqual(set.textures.map((t) => t.id));
    // header row 2: each atlas's maxLod (256: 5, 512: 6); volume 1 lives in atlas 1
    expect([...writes[0].subarray(8, 10)]).toEqual([5, 6]);
    // a re-bake that moves a probe to the other atlas recompiles (each volume's atlas is compiled in)
    Object.assign(set, { bakedAtlases: [1, 0, 0], bakedSlots: [0, 0, 1] });
    expect(hs.prepare(new THREE.Texture(), set)).toBe(true);
    expect(hs.prepare(new THREE.Texture(), set)).toBe(false);
  });
  it('a one-size set: the same WGSL as the one-atlas shading, bindings 0..3', async () => {
    const { device, groups } = fakeDevice();
    const { probeLayoutFor } = await import('../packages/three/src/probes/ReflectionProbesNode');
    const set = makeSet(false);
    const hs = new ThreeHitShading(device, gpu);
    hs.prepare(new THREE.Texture(), set);
    expect(hs.shading.wgsl).toBe(probeHitShading(fakeDevice().device, { layout: probeLayoutFor(set), mirrorX: true, count: 3 }).wgsl);
    hs.bindGroup(1, {});
    expect(bindings(groups[groups.length - 1])).toEqual([0, 1, 2, 3]);
  });
});
