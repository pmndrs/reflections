// CubeArrayTexture, vendored from three.js pull request #35053 (Ben Houston, "CubeArrayTexture:
// General-purpose cube arrays with WebGPU support", head 398963161f), src/textures/CubeArrayTexture.js.
// three.js is MIT licensed, Copyright (c) 2010-2026 three.js authors (see NOTICE).
//
// Same constructor, flags and accessors as the PR, so moving to three's own class once #35053
// lands is an import change (`import { CubeArrayTexture } from 'three/webgpu'`). On stock three
// (r187) the renderer only samples it as a cube array after `installCubeArraySupport(renderer)`
// (./cubeArray.ts), which patches the renderer internals the PR changes.

import * as THREE from 'three/webgpu';

/** A face of a cube: anything three can upload as one layer (an image, canvas, ImageBitmap or DataTexture). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CubeArrayFace = any;

/**
 * An array of cubemaps. Each entry contains six faces in +X, -X, +Y, -Y, +Z, -Z order,
 * like the images of a CubeTexture. All faces must be square and have the same size.
 * Sample a cube with `cubeTexture( texture, direction ).depth( cubeIndex )`.
 *
 * Set `needsUpdate` after all faces have loaded. Like CubeTexture, explicit
 * mipmaps are supplied as `{ images: cubemaps }` entries excluding the base level.
 * Each mip level must contain the same cubes, with face dimensions halved per level.
 * DataTexture faces must match the array type, format and color space.
 * Dispose the texture before changing its dimensions or number of cubes.
 *
 * Only supported by the WebGPU backend of WebGPURenderer (on stock three r187: after
 * `installCubeArraySupport( renderer )`).
 */
export class CubeArrayTexture extends THREE.Texture {
  /** Type flag (`true`), set in the constructor as in #35053. */
  declare readonly isCubeArrayTexture: true;

  /**
   * @param images The cubemaps, each with six faces.
   * @param mapping The texture mapping. Default CubeReflectionMapping.
   */
  constructor(
    images: CubeArrayFace[][] = [], mapping: THREE.AnyMapping = THREE.CubeReflectionMapping,
    wrapS?: THREE.Wrapping, wrapT?: THREE.Wrapping, magFilter?: THREE.MagnificationTextureFilter, minFilter?: THREE.MinificationTextureFilter,
    format?: THREE.PixelFormat, type?: THREE.TextureDataType, anisotropy?: number, colorSpace?: THREE.ColorSpace,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(images as any, mapping as THREE.Mapping, wrapS, wrapT, magFilter, minFilter, format, type, anisotropy, colorSpace);
    (this as { isCubeArrayTexture: boolean }).isCubeArrayTexture = true;
    this.flipY = false;
  }

  /** The cubemap images. Render-target textures instead use an allocation descriptor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get images(): any {
    return this.image;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set images(value: any) {
    this.image = value;
  }

  /** The number of cubemaps. Render-target allocation descriptors count face layers. */
  get depth(): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const image = this.image as any;
    return Array.isArray(image) ? image.length : image.depth / 6;
  }
}
