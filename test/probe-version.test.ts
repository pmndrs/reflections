// W109 (T43): ReflectionProbes.updateVersion moves exactly when the volume table's inputs do, so the probe
// nodes skip the re-pack and upload on frames where nothing changed.
import { describe, expect, it } from 'vitest';
import { ReflectionProbe, ReflectionProbes } from '../packages/three/src/probes/ReflectionProbes';

function baked() {
  const set = new ReflectionProbes();
  const a = new ReflectionProbe(4, 3, 4), b = new ReflectionProbe(2, 2, 2);
  b.position.set(1, 0, 0);
  set.add(a, b);
  // what a bake leaves behind, without a renderer
  set.bakedProbes = [b, a]; set.bakedAtlases = [0, 0]; set.bakedSlots = [0, 1]; set.bakedEnvironmentSlot = 2;
  return { set, a, b };
}

describe('ReflectionProbes.updateVersion (T43)', () => {
  it('holds while nothing changes', () => {
    const { set } = baked();
    const v = set.updateVersion();
    expect(set.updateVersion()).toBe(v);
    expect(set.updateVersion()).toBe(v);
  });
  it('moves with every input of the table', () => {
    const { set, a, b } = baked();
    const edits: [string, () => void][] = [
      ['probe moved', () => b.position.x += 0.5],
      ['parent moved', () => set.position.y += 1],
      ['probe rotated', () => a.rotation.y += 0.3],
      ['influence size', () => a.influenceSize.x += 1],
      ['projection size', () => { a.projectionSize = a.influenceSize.clone(); }],
      ['projection offset', () => a.projectionOffset.z = 0.2],
      ['origin offset', () => b.originOffset.y = 0.1],
      ['blend distance', () => b.blendDistance = 0.25],
      ['oriented', () => a.oriented = true],
      ['box projection', () => set.boxProjection = false],
      ['capturing', () => set.capturing = true],
      ['refit clamp', () => set.refitClamp = 2],
      ['environment slot', () => set.bakedEnvironmentSlot = 3],
      ['slots', () => set.bakedSlots = [1, 0]],
      ['baked probes', () => set.bakedProbes = [a, b]],
    ];
    for (const [what, edit] of edits) {
      const v = set.updateVersion();
      edit();
      expect(set.updateVersion(), what).toBe(v + 1);
      expect(set.updateVersion(), `${what}, again`).toBe(v + 1);
    }
  });
});
