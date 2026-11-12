import { describe, expect, it } from 'vitest';
import {
  PROBE_HEADER_ROWS, PROBE_MAX_ATLASES, PROBE_ROWS_PER_VOLUME, createProbeLayout, packProbeTable, planProbeAtlases, probeBytes,
  probeLookupFunctionWgsl, probeLookupWgsl, type ProbeVolume,
} from '@pmndrs/reflections-core';

// Per-probe resolution (W60, D4700): one atlas per face size. The pure parts: the plan (which
// atlas and slot each probe gets), the table rows it writes, and the WGSL the lookup emits for it.
// The lookups themselves are checked on the GPU (examples/probes `mixedResolution`, pnpm check).
describe('probe atlases per resolution (D4700)', () => {
  it('plans one atlas per size, the default first with the environment', () => {
    // all at the default: the one atlas of (probes + 1) slots, slot = index, environment last
    const one = planProbeAtlases([null, undefined, 256], 256);
    expect(one).toEqual({ resolutions: [256], atlas: [0, 0, 0], slot: [0, 1, 2], slots: [4], environmentSlot: 3, irradianceBases: [0] });
    // mixed: the default, then the other sizes ascending; input order within an atlas
    const mixed = planProbeAtlases([null, 512, 128, 512, null], 256);
    expect(mixed.resolutions).toEqual([256, 128, 512]);
    expect(mixed.atlas).toEqual([0, 2, 1, 2, 0]);
    expect(mixed.slot).toEqual([0, 0, 0, 1, 1]);
    expect(mixed.slots).toEqual([3, 1, 2]);
    expect(mixed.environmentSlot).toBe(2);
    // irradiance slots numbered across atlases: 256 (3 incl. environment), then 128 (1), then 512 (2)
    expect(mixed.irradianceBases).toEqual([0, 3, 4]);
    // no probe at the default: atlas 0 holds the environment alone
    expect(planProbeAtlases([512, 512], 256)).toMatchObject({ resolutions: [256, 512], atlas: [1, 1], slot: [0, 1], slots: [1, 2], environmentSlot: 0 });
    expect(planProbeAtlases([512], 256, { environment: false })).toMatchObject({ slots: [0, 1], environmentSlot: -1, irradianceBases: [0, 0] });
    expect(() => planProbeAtlases([64, 128, 512, 1024], 256)).toThrow(/at most 4/);
    expect(PROBE_MAX_ATLASES).toBe(4);
  });

  it('packs each atlas maxLod / irradiance base into header rows 2-3 and the atlas into +4.w', () => {
    const v: ProbeVolume[] = [
      { slot: 0, center: [0, 0, 0], halfSize: [1, 1, 1] },
      { slot: 1, atlas: 2, center: [5, 0, 0], halfSize: [1, 1, 1], origin: [5, 1, 0] },
    ];
    const one = packProbeTable({ maxLod: 5, environmentSlot: 1 }, [v[0]]);
    expect([...one.subarray(8, 16)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const t = packProbeTable({ maxLod: 5, environmentSlot: 1, atlases: [{ maxLod: 5, irradianceBase: 0 }, { maxLod: 4, irradianceBase: 2 }, { maxLod: 6, irradianceBase: 3 }] }, v);
    expect([...t.subarray(8, 12)]).toEqual([5, 4, 6, 0]);
    expect([...t.subarray(12, 16)]).toEqual([0, 2, 3, 0]);
    const at = (i: number, row: number) => [...t.subarray((PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME + row) * 4, (PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME + row + 1) * 4)];
    expect(at(0, 4)).toEqual([0, 0, 0, 0]);
    expect(at(1, 4)).toEqual([5, 1, 0, 2]);
    expect(at(1, 2)[3]).toBe(1);
    // a volume in an atlas the header doesn't have
    expect(() => packProbeTable({ maxLod: 5, environmentSlot: 1 }, v)).toThrow(/atlas 2/);
    expect(() => packProbeTable({ maxLod: 5, environmentSlot: 1, atlases: Array(5).fill({ maxLod: 5, irradianceBase: 0 }) }, [v[0]])).toThrow(/at most/);
  });

  it('emits extra atlas parameters / bindings only for several atlases', () => {
    const layout = createProbeLayout('cube-hw', { maxLod: 5 });
    const single = probeLookupFunctionWgsl({ layout, count: 2 }, 'f');
    expect(single).not.toMatch(/atlas_1|atl\b|va ==/);
    // compile-time atlases: each unrolled volume names its own texture, no branch
    const fixed = probeLookupFunctionWgsl({ layout, count: 3, atlases: 3, volumeAtlases: [0, 2, 1] }, 'f');
    expect(fixed).toMatch(/^fn f\(atlas: texture_cube_array<f32>, atlas_1: texture_cube_array<f32>, atlas_2: texture_cube_array<f32>, samp: sampler,/);
    expect(fixed).not.toMatch(/va ==/);
    expect(fixed).toContain('pl_cube_hw_sample(atlas_2, samp');
    expect(fixed).toContain('let vmax = atl.z;');
    // runtime loop: the atlas comes from the table, picked by a branch
    const loop = probeLookupFunctionWgsl({ layout, atlases: 2 }, 'f');
    expect(loop).toContain('let va = u32(r4.w);');
    expect(loop).toMatch(/if \(va == 0u\) \{ c = pl_cube_hw_sample\(atlas, samp.*\} else \{ c = pl_cube_hw_sample\(atlas_1, samp/);
    // module form: atlas k at atlasBinding + k - 1 (default binding + 3)
    const mod = probeLookupWgsl({ layout, group: 3, atlases: 3 });
    expect(mod).toContain('@group(3) @binding(3) var pr_atlas_1: texture_cube_array<f32>;');
    expect(mod).toContain('@group(3) @binding(4) var pr_atlas_2: texture_cube_array<f32>;');
    expect(probeLookupWgsl({ layout, group: 3, atlases: 2, atlasBinding: 7 })).toContain('@group(3) @binding(7) var pr_atlas_1');
    expect(() => probeLookupWgsl([{ layout, atlases: 2 }, { layout, suffix: 'B', binding: 3 }])).toThrow(/share a binding/);
    expect(() => probeLookupFunctionWgsl({ layout, atlases: 5 })).toThrow(/1 to 4/);
    expect(() => probeLookupFunctionWgsl({ layout, count: 2, atlases: 2, volumeAtlases: [0] })).toThrow(/one atlas per volume/);
    expect(() => probeLookupFunctionWgsl({ layout, count: 1, atlases: 2, volumeAtlases: [2] })).toThrow(/outside/);
  });

  it('memory per probe: 512 px is 4x 256 px is 4x 128 px (rgba16f, every mip)', () => {
    const mb = (size: number) => probeBytes(createProbeLayout('cube-hw', { maxLod: Math.log2(size) - 3 }), size, 'rgba16float') / 1e6;
    expect(mb(128)).toBeCloseTo(1.05, 2);
    expect(mb(256)).toBeCloseTo(4.19, 2);
    expect(mb(512)).toBeCloseTo(16.78, 2);
  });
});

describe('three: packReflectionProbesTable over a mixed-resolution set (D4700)', async () => {
  const THREE = await import('three/webgpu');
  const { ReflectionProbe, ReflectionProbes } = await import('../packages/three/src/probes/ReflectionProbes');
  const { packReflectionProbesTable } = await import('../packages/three/src/probes/ReflectionProbesNode');
  // a set as a bake leaves it: probes 0 and 2 at the default (atlas 0), probe 1 at 512 (atlas 1)
  const set = new ReflectionProbes();
  const probes = [0, 1, 2].map((i) => { const p = new ReflectionProbe(2, 2, 2); p.position.set(i * 10, 0, 0); set.add(p); return p; });
  const tex = (size: number) => { const t = new THREE.Texture(); for (let s = size; s >= 8; s >>= 1) t.mipmaps.push({ width: s, height: s } as never); return t; };
  Object.assign(set, { bakedProbes: probes, textures: [tex(256), tex(512)], bakedAtlases: [0, 1, 0], bakedSlots: [0, 0, 1], bakedEnvironmentSlot: 2, bakedResolutions: [256, 512] });
  set.texture = set.textures[0];
  const row = (t: Float32Array, i: number, r: number) => [...t.subarray((PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME + r) * 4, (PROBE_HEADER_ROWS + i * PROBE_ROWS_PER_VOLUME + r + 1) * 4)];
  it("'all': every volume with its atlas and slot, header rows 2-3 per atlas", () => {
    const t = packReflectionProbesTable(set, undefined, { atlases: 'all' });
    expect([...t.subarray(0, 4)]).toEqual([3, 5, 1, 2]);
    expect([...t.subarray(8, 12)]).toEqual([5, 6, 0, 0]);
    expect([...t.subarray(12, 16)]).toEqual([0, 3, 0, 0]);
    expect(row(t, 1, 4)[3]).toBe(1);
    expect(row(t, 2, 2)[3]).toBe(1);
  });
  it("'primary' (default): volumes of other atlases take no weight, for one-atlas consumers", () => {
    const t = packReflectionProbesTable(set);
    expect([...t.subarray(8, 16)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(row(t, 1, 1).slice(0, 3)).toEqual([-1, -1, -1]);
    expect(row(t, 1, 4)[3]).toBe(0);
    expect(row(t, 0, 1).slice(0, 3)).toEqual([1, 1, 1]);
    expect(row(t, 2, 2)[3]).toBe(1);
  });
});
