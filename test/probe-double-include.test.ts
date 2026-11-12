import { describe, expect, it } from 'vitest';
import { createProbeLayout, dedupeWgslChunks, markedChunkWgsl, probeHitShading, probeLookupWgsl, PROBE_FALLBACK_WGSL } from '@pmndrs/reflections-core';
import { intersectWgsl } from '../packages/core/src/sssr/shaders';
import { screenSpaceHitShadingWgsl } from '../packages/core/src/sssr/sssr';
import { rtTraceWgsl } from '../packages/core/src/trace/shaders';

// D4901: one probe set as both the radiance fallback (the lookup at group 1) and the hit shading (the
// lookup at group 3) put the lookup's includes into one module twice ('redeclaration of
// pl_faceDirUV'). The includes are marked chunks the passes keep once (dedupeWgslChunks), and the hit
// shading's set-level names carry its own suffix. Checked here on the WGSL text (every module-scope
// name declared once); the GPU build and the radiance are checked by pnpm check (regressions 'sssr
// limits', probe-core 'sssr fallback + hit shading').

/** Module-scope names declared more than once (fn, const, var, struct, alias, override at column 0). */
function redeclared(code: string): string[] {
  const seen = new Map<string, number>();
  for (const line of code.split('\n')) {
    const m = /^(?:@\S+\s+)*(?:fn|const|var(?:<[^>]*>)?|struct|alias|override)\s+([A-Za-z_]\w*)/.exec(line);
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

/** A device that hands back placeholders (no GPU). */
const device = {
  createBindGroupLayout: (d: unknown) => ({ d }),
  createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, destroy() {} }),
  queue: { writeBuffer() {} },
} as unknown as GPUDevice;

describe('probe lookup as SSSR fallback and hit shading in one module (D4901)', () => {
  for (const id of ['cube-hw', 'cube2d-warp', 'octa'] as const) {
    for (const atlases of [1, 4]) {
      it(`${id}, ${atlases} atlas${atlases > 1 ? 'es' : ''}: every name once in the intersect and trace modules`, () => {
        const layout = createProbeLayout(id, { maxLod: 5 });
        const multi = atlases > 1 ? { atlases, atlasBinding: 3 } : {};
        // what probeRadianceFallback(set) and probeHitShading(device, set) emit for such a set
        const fallback = probeLookupWgsl({ layout, group: 1, ...multi }) + PROBE_FALLBACK_WGSL;
        const shading = probeHitShading(device, { layout, ...(atlases > 1 ? { atlases } : {}) });
        const intersect = intersectWgsl('workgroup', false, fallback, true, screenSpaceHitShadingWgsl(shading));
        // the bug: without the dedupe the lookup's includes are there twice
        expect(redeclared(intersect)).toContain('pr_lodAlpha');
        expect(redeclared(dedupeWgslChunks(intersect))).toEqual([]);
        const trace = rtTraceWgsl({ fallbackWgsl: fallback, providerWgsl: '', materialWgsl: '', anyHitWgsl: '', shadingNormalWgsl: '', hitShadingWgsl: shading.wgsl });
        expect(redeclared(dedupeWgslChunks(trace))).toEqual([]);
        // the fallback keeps its names (PROBE_FALLBACK_WGSL calls them); the hit shading has its own
        expect(fallback).toMatch(/fn probeRadianceWithEnvironment\(/);
        expect(shading.wgsl).toMatch(/fn probeRadianceWithEnvironment_g3\(/);
        expect(shading.wgsl).toMatch(/@group\(3\) @binding\(0\) var pr_atlas_g3:/);
      });
    }
  }

  it('dedupeWgslChunks keeps the first copy of each key, leaves unmarked text and throws on a conflict', () => {
    const a = markedChunkWgsl({ key: 'k_a', wgsl: 'fn a() {}' }), b = markedChunkWgsl({ key: 'k_b', wgsl: 'fn b() {}' });
    expect(dedupeWgslChunks(`x\n${a}y\n${b}${a}z\n`)).toBe(`x\n${a}y\n${b}z\n`);
    expect(dedupeWgslChunks('fn plain() {}\n')).toBe('fn plain() {}\n');
    expect(() => dedupeWgslChunks(a + markedChunkWgsl({ key: 'k_a', wgsl: 'fn a2() {}' }))).toThrow(/two different chunks named 'k_a'/);
  });

  it('one frame irradiance provider shared by both seams is emitted once', () => {
    const layout = createProbeLayout('cube-hw', { maxLod: 5 });
    const frameIrradianceWgsl = 'fn frameIrradiance(P: vec3f, N: vec3f) -> vec3f { return vec3f(1.0); }';
    const fallback = probeLookupWgsl({ layout, group: 1, frameIrradianceWgsl }) + PROBE_FALLBACK_WGSL;
    const shading = probeHitShading(device, { layout, frameIrradianceWgsl } as Parameters<typeof probeHitShading>[1]);
    const code = dedupeWgslChunks(intersectWgsl('workgroup', false, fallback, false, screenSpaceHitShadingWgsl(shading)));
    expect(code.match(/fn frameIrradiance\(/g)).toHaveLength(1);
    expect(redeclared(code)).toEqual([]);
  });
});
