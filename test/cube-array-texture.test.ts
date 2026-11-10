import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { CubeArrayTexture } from '../packages/three/src/compat/CubeArrayTexture';

// The vendored class keeps three.js #35053's API (its test/unit/src/textures/CubeArrayTexture.tests.js).
describe('CubeArrayTexture (vendored from three.js #35053)', () => {
  it('extends Texture', () => {
    expect(new CubeArrayTexture()).toBeInstanceOf(THREE.Texture);
  });

  it('instancing: flags, images, depth', () => {
    const object = new CubeArrayTexture();
    expect(object.isCubeArrayTexture).toBe(true);
    expect(object.flipY).toBe(false);
    expect(object.images).toEqual([]);
    expect(object.depth).toBe(0);
    expect(object.mapping).toBe(THREE.CubeReflectionMapping);
    expect((object as unknown as { isCubeTexture?: boolean }).isCubeTexture).toBeUndefined();
    expect(object.isArrayTexture).toBe(false);
  });

  it('depth counts cubes: nested images, or a render target allocation of 6 layers per cube', () => {
    const face = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    expect(new CubeArrayTexture([Array(6).fill(face), Array(6).fill(face)]).depth).toBe(2);
    const target = new THREE.RenderTarget(8, 8, { depth: 18, depthBuffer: false });
    const copy = new CubeArrayTexture().copy(target.texture);
    expect(copy.depth).toBe(3);
    expect(copy.isCubeArrayTexture).toBe(true);
    expect(copy.isRenderTargetTexture).toBe(true);
  });
});
