// Cube-array textures on stock three r187 (WebGPU): a runtime port of the renderer side of three.js
// pull request #35053 (Ben Houston, "CubeArrayTexture: General-purpose cube arrays with WebGPU
// support", head 398963161f). three.js is MIT licensed, Copyright (c) 2010-2026 three.js authors
// (see NOTICE).
//
// r187 picks a texture's view dimension and WGSL type only from `isCubeTexture` / `isArrayTexture`,
// so a `texture_cube_array` can't be bound from TSL. #35053 adds `isCubeArrayTexture` branches to
// four renderer internals. `installCubeArraySupport( renderer )` adds the same branches at runtime,
// by wrapping methods on the prototypes of the live renderer's own instances (so it patches the
// three copy that renderer was built from, not whichever one this package resolved). Every wrapper
// passes through unchanged unless the texture is a cube array.
//
//   renderers/common/Textures.js (renderer._textures)
//     getSize                  #35053: a cube array's size (faces x cubes, or its allocation descriptor)
//     getMipLevels             #35053's `options.levels ++` for uploaded cube arrays with explicit mips
//                              (the PR does it in updateTexture right after getMipLevels; same result)
//   renderers/webgpu/utils/WebGPUTextureUtils.js (backend.textureUtils)
//     createDefaultTexture     #35053: a 1 x 1 x 6 cube-array placeholder (`_getDefaultCubeTextureGPU( format, true )`)
//     createTexture            #35053: `textureBindingViewDimension = 'cube-array'` (set on the descriptor
//                              as it reaches device.createTexture, the only place the wrapper can reach it)
//     updateTexture            #35053's `_copyCubeArrayToTexture`: each cube to six consecutive layers, all mips
//   renderers/webgpu/utils/WebGPUBindingUtils.js (backend.bindingUtils)
//     _createLayoutEntries     #35053: viewDimension 'cube-array' in the bind group layout
//     createBindGroup          #35053: the texture view with dimension 'cube-array' (created into the view
//                              cache r187 reads, under the key it computes, before the original runs)
//   renderers/webgpu/nodes/WGSLNodeBuilder.js (prototype of backend.createNodeBuilder()'s result)
//     generateTextureLod       #35053: textureSampleLevel with the array index
//     getUniformFromNode       #35053: cube arrays always get a sampler (r187's `isCubeTexture` test,
//     getUniforms              run with the flag raised for the call), and `texture_cube_array<f32>`
//
// Drop this file when three ships #35053: ReflectionProbes then uses three's own CubeArrayTexture
// (`installCubeArraySupport` already reports native support and patches nothing).

import * as THREE from 'three/webgpu';
import { Fn, cubeTexture, int, screenCoordinate, uint, vec3, vec4, wgslFn } from 'three/tsl';
import { CubeArrayTexture as VendoredCubeArrayTexture } from './CubeArrayTexture';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fun = (this: any, ...args: any[]) => any;

/** three revisions the shim was tested on (patches are tied to these internals). */
export const CUBE_ARRAY_SHIM_REVISIONS: readonly string[] = ['187'];

export type CubeArraySupportMode = 'native' | 'shim' | 'none';

export interface CubeArraySupportStatus {
  /** 'native': three has CubeArrayTexture; 'shim': patched and self-tested; 'none': not available. */
  mode: CubeArraySupportMode;
  /** Why it is 'none' (version gate, backend, self-test failure), or how 'shim' was verified. */
  reason: string;
}

export interface InstallCubeArrayOptions {
  /** Install on a three revision outside {@link CUBE_ARRAY_SHIM_REVISIONS} (the self-test still runs). Default false. */
  allowUntestedRevision?: boolean;
}

/** three's own CubeArrayTexture class, when the installed three has one (#35053 landed). */
export function nativeCubeArrayTexture(): typeof VendoredCubeArrayTexture | null {
  const native = (THREE as Record<string, unknown>)['CubeArrayTexture'];
  return typeof native === 'function' ? (native as typeof VendoredCubeArrayTexture) : null;
}

/** The CubeArrayTexture class to allocate: three's own when it has one, else the vendored #35053 class. */
export function cubeArrayTextureClass(): typeof VendoredCubeArrayTexture {
  return nativeCubeArrayTexture() ?? VendoredCubeArrayTexture;
}

const isWebGPU = (renderer: Any) => renderer?.backend?.isWebGPUBackend === true;

// ---- patch bookkeeping ------------------------------------------------------------------------

interface Patch { owner: Any; name: string; original: Fun; wrapper: Fun }
/** Installed patches (null: none). Prototype-wide, shared by every renderer that passed the self-test. */
let patches: Patch[] | null = null;
/** Renderers whose install resolved true (or is running its self-test). */
const users = new Set<object>();
const pending = new Map<object, Promise<boolean>>();
const status = new WeakMap<object, CubeArraySupportStatus>();

function ownerOf(object: Any, name: string): Any {
  for (let o = object; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    if (Object.prototype.hasOwnProperty.call(o, name)) return o;
  }
  return null;
}

function wrap(list: Patch[], instance: Any, name: string, make: (original: Fun) => Fun) {
  const owner = ownerOf(instance, name);
  if (owner === null || typeof owner[name] !== 'function') throw new Error(`cube-array shim: ${instance?.constructor?.name ?? 'object'}.${name} not found`);
  const original: Fun = owner[name];
  const wrapper = make(original);
  (wrapper as Any).cubeArrayShim = true; // marks a patched method (the checks count them)
  owner[name] = wrapper;
  list.push({ owner, name, original, wrapper });
}

function restore() {
  if (patches === null) return;
  // newest first, so two wrappers on one method unwind in order
  for (const p of [...patches].reverse()) if (p.owner[p.name] === p.wrapper) p.owner[p.name] = p.original;
  patches = null;
}

/** Runs `fn` with `isCubeTexture` raised on `texture` (an own property, removed after). */
function asCube<T>(texture: Any, fn: () => T): T {
  if (texture?.isCubeArrayTexture !== true || texture.isCubeTexture === true) return fn();
  Object.defineProperty(texture, 'isCubeTexture', { value: true, configurable: true, writable: true });
  try { return fn(); } finally { delete texture.isCubeTexture; }
}

const isRenderTargetTexture = (t: Any) => t.isRenderTargetTexture || t.isDepthTexture || t.isFramebufferTexture;

// Texture views the shim created (so a cached view that r187 made as 'cube' is replaced).
const cubeArrayViews = new WeakSet<GPUTextureView>();

function patchAll(renderer: Any): Patch[] {
  const list: Patch[] = [];
  const backend = renderer.backend;
  try {
    // ---- renderers/common/Textures.js --------------------------------------------------------
    const textures = renderer._textures;
    const size = { width: 1, height: 1, depth: 1 };
    wrap(list, textures, 'getSize', (original) => function (this: Any, texture: Any, target?: Any) {
      if (texture?.isCubeArrayTexture !== true) return original.call(this, texture, target);
      target ??= size;
      if (!Array.isArray(texture.image)) {
        target.width = texture.image.width;
        target.height = texture.image.height;
        target.depth = texture.image.depth;
      } else {
        let face = texture.image[0]?.[0];
        if (face?.isDataTexture) face = face.image;
        target.width = face?.width || 1;
        target.height = face?.height || 1;
        target.depth = Math.max(texture.depth, 1) * 6;
      }
      return target;
    });
    wrap(list, textures, 'getMipLevels', (original) => function (this: Any, texture: Any, width: number, height: number) {
      const levels = original.call(this, texture, width, height);
      // Uncompressed cube textures use their mipmap array only for mips (no base level)
      return texture?.isCubeArrayTexture === true && texture.mipmaps.length > 0 && !isRenderTargetTexture(texture) ? levels + 1 : levels;
    });

    // ---- renderers/webgpu/utils/WebGPUTextureUtils.js ----------------------------------------
    const textureUtils = backend.textureUtils;
    wrap(list, textureUtils, 'createDefaultTexture', (original) => function (this: Any, texture: Any) {
      if (texture?.isCubeArrayTexture !== true) return original.call(this, texture);
      // #35053 `_getDefaultCubeTextureGPU( format, true )`: one placeholder per format, keyed apart from cubes
      const key = `cube-array:${texture.format}:${texture.type}`;
      let placeholder = this.defaultCubeTexture[key];
      if (placeholder === undefined) {
        placeholder = new (cubeArrayTextureClass())();
        placeholder.minFilter = THREE.NearestFilter;
        placeholder.magFilter = THREE.NearestFilter;
        this.createTexture(placeholder, { width: 1, height: 1, depth: 6 });
        this.defaultCubeTexture[key] = placeholder;
      }
      this.backend.get(texture).texture = this.backend.get(placeholder).texture;
    });
    wrap(list, textureUtils, 'createTexture', (original) => function (this: Any, texture: Any, options?: Any) {
      if (texture?.isCubeArrayTexture !== true) return original.call(this, texture, options);
      const device = this.backend.device;
      const own = Object.prototype.hasOwnProperty.call(device, 'createTexture');
      const previous = device.createTexture;
      let first = true;
      device.createTexture = function (this: GPUDevice, descriptor: GPUTextureDescriptor) {
        // the first texture is the sampled one (MSAA companions follow it)
        if (first) { first = false; descriptor.textureBindingViewDimension = 'cube-array'; }
        return previous.call(this, descriptor);
      };
      try {
        return original.call(this, texture, options);
      } finally {
        if (own) device.createTexture = previous; else delete device.createTexture;
      }
    });
    const flipMap = [0, 1, 3, 2, 4, 5];
    wrap(list, textureUtils, 'updateTexture', (original) => function (this: Any, texture: Any, options?: Any) {
      const textureData = texture?.isCubeArrayTexture === true ? this.backend.get(texture) : null;
      if (textureData === null || texture.isRenderTargetTexture || textureData.textureDescriptorGPU === undefined || !Array.isArray(texture.images)) {
        return original.call(this, texture, options);
      }
      // #35053 _copyCubeArrayToTexture: each cubemap to six consecutive GPU face layers
      const descriptor = textureData.textureDescriptorGPU;
      const levels = [texture.images, ...texture.mipmaps.map((mip: Any) => mip.images)];
      for (let level = 0; level < levels.length; level++) {
        const cubes = levels[level];
        for (let cube = 0; cube < cubes.length; cube++) {
          for (let face = 0; face < 6; face++) {
            const image = cubes[cube][face];
            const layer = cube * 6 + (texture.flipY ? flipMap[face] : face);
            if (image.isDataTexture) this._copyBufferToTexture(image.image, textureData.texture, descriptor, layer, texture.flipY, 0, level);
            else this._copyImageToTexture(image, textureData.texture, descriptor, layer, texture.flipY, texture.premultiplyAlpha, level);
          }
        }
      }
      textureData.version = texture.version;
    });

    // ---- renderers/webgpu/utils/WebGPUBindingUtils.js ----------------------------------------
    const bindingUtils = backend.bindingUtils;
    wrap(list, bindingUtils, '_createLayoutEntries', (original) => function (this: Any, bindGroup: Any) {
      const entries = original.call(this, bindGroup);
      // one entry per binding, in order (r187: `entries.push( bindingGPU ); index ++`)
      bindGroup.bindings.forEach((binding: Any, i: number) => {
        if (binding.isSampledCubeTexture && binding.texture?.isCubeArrayTexture === true && entries[i]?.texture) entries[i].texture.viewDimension = 'cube-array';
      });
      return entries;
    });
    wrap(list, bindingUtils, 'createBindGroup', (original) => function (this: Any, bindGroup: Any, layoutGPU: Any) {
      for (const binding of bindGroup.bindings) {
        if (!(binding.isSampledTexture && binding.isSampledCubeTexture && binding.texture?.isCubeArrayTexture === true)) continue;
        const textureData = this.backend.get(binding.texture);
        const gpu: GPUTexture | undefined = textureData.texture;
        if (textureData.externalTexture !== undefined || gpu === undefined) continue;
        // r187's view cache key, so the original finds this view and doesn't make a 'cube' one
        const mipLevelCount = binding.store ? 1 : gpu.mipLevelCount;
        const baseMipLevel = binding.store ? binding.mipLevel : 0;
        let key = `view-${gpu.width}-${gpu.height}`;
        if (gpu.depthOrArrayLayers > 1) key += `-${gpu.depthOrArrayLayers}`;
        key += `-${mipLevelCount}-${baseMipLevel}`;
        const cached = textureData[key];
        if (cached !== undefined && cubeArrayViews.has(cached)) continue;
        const view = gpu.createView({ aspect: binding.texture.isDepthTexture ? 'depth-only' : 'all', dimension: 'cube-array', mipLevelCount, baseMipLevel });
        cubeArrayViews.add(view);
        textureData[key] = view;
      }
      return original.call(this, bindGroup, layoutGPU);
    });

    // ---- renderers/webgpu/nodes/WGSLNodeBuilder.js -------------------------------------------
    const builder = backend.createNodeBuilder(new THREE.Mesh(), renderer);
    wrap(list, builder, 'generateTextureLod', (original) => function (this: Any, texture: Any, textureProperty: string, uvSnippet: string, depthSnippet: string, offsetSnippet: string, levelSnippet = '0u', ...rest: Any[]) {
      if (texture?.isCubeArrayTexture !== true) return original.call(this, texture, textureProperty, uvSnippet, depthSnippet, offsetSnippet, levelSnippet, ...rest);
      // Cube textures cannot use textureLoad in WGSL, must use textureSampleLevel
      if (offsetSnippet) uvSnippet = `${uvSnippet} + vec3<f32>(${offsetSnippet})`;
      // Depth textures require integer level, regular textures use float
      const levelType = texture.isDepthTexture ? 'u32' : 'f32';
      const arrayIndex = `${depthSnippet || '0'}, `;
      return `textureSampleLevel( ${textureProperty}, ${textureProperty}_sampler, ${uvSnippet}, ${arrayIndex}${levelType}( ${levelSnippet} ) )`;
    });
    wrap(list, builder, 'getUniformFromNode', (original) => function (this: Any, node: Any, ...args: Any[]) {
      return asCube(node?.value, () => original.call(this, node, ...args));
    });
    wrap(list, builder, 'getUniforms', (original) => function (this: Any, shaderStage: string) {
      const cubeArrays: Any[] = (this.uniforms[shaderStage] ?? []).filter((u: Any) => u.type === 'cubeTexture' && u.node?.value?.isCubeArrayTexture === true);
      if (cubeArrays.length === 0) return original.call(this, shaderStage);
      const raise = (i: number): string => i === cubeArrays.length ? original.call(this, shaderStage) : asCube(cubeArrays[i].node.value, () => raise(i + 1));
      let code = raise(0);
      for (const u of cubeArrays) code = code.replace(`var ${u.name} : texture_cube<f32>;`, `var ${u.name} : texture_cube_array<f32>;`);
      return code;
    });
  } catch (e) {
    for (const p of list.reverse()) if (p.owner[p.name] === p.wrapper) p.owner[p.name] = p.original;
    throw e;
  }
  return list;
}

// ---- self-test --------------------------------------------------------------------------------

// Pixel i of a 48 x 1 target reads cube i / 24, face (i / 4) % 6, texel (i % 2, (i / 2) % 2) of a
// 2 x 2 face, along the direction through that texel's centre (WebGPU cube face rules), handed to
// cubeTexture() in three's convention (x negated; CubeTextureNode negates it back).
const TEST_CUBES = 2, TEST_FACE = 2, TEST_WIDTH = TEST_CUBES * 6 * TEST_FACE * TEST_FACE;
const testColor = (cube: number, face: number, x: number, y: number) => [(cube * 6 + face) * 20 + 10, 60 + 120 * x, 60 + 120 * y, 255];
let _testDirection: Any = null;
const testDirection = (): Any => (_testDirection ??= wgslFn(/* wgsl */ `
fn cubeArraySelfTestDirection(i: u32) -> vec4f {
  let face = (i / 4u) % 6u;
  let t = vec2f(f32(i % 2u), f32((i / 2u) % 2u));
  let uv = (t + 0.5) / 2.0 * 2.0 - 1.0;
  var d = vec3f(0.0);
  switch face {
    case 0u: { d = vec3f( 1.0, -uv.y, -uv.x); }
    case 1u: { d = vec3f(-1.0, -uv.y,  uv.x); }
    case 2u: { d = vec3f( uv.x,  1.0,  uv.y); }
    case 3u: { d = vec3f( uv.x, -1.0, -uv.y); }
    case 4u: { d = vec3f( uv.x, -uv.y,  1.0); }
    default: { d = vec3f(-uv.x, -uv.y, -1.0); }
  }
  return vec4f(-d.x, d.y, d.z, f32(i / 24u));
}`));

async function selfTest(renderer: Any): Promise<string | null> {
  const device: GPUDevice = renderer.backend.device;
  const Cube = cubeArrayTextureClass();
  const cubes = Array.from({ length: TEST_CUBES }, (_, cube) => Array.from({ length: 6 }, (_, face) => {
    const data = new Uint8Array(TEST_FACE * TEST_FACE * 4);
    for (let y = 0; y < TEST_FACE; y++) for (let x = 0; x < TEST_FACE; x++) data.set(testColor(cube, face, x, y), (y * TEST_FACE + x) * 4);
    return new THREE.DataTexture(data, TEST_FACE, TEST_FACE);
  }));
  const array = new Cube(cubes);
  // nearest + no mips: r187 treats it as unfilterable, so the lookup goes through generateTextureLod
  array.minFilter = array.magFilter = THREE.NearestFilter;
  array.generateMipmaps = false;
  array.needsUpdate = true;
  const target = new THREE.RenderTarget(TEST_WIDTH, 1, { depthBuffer: false, type: THREE.UnsignedByteType });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const d = testDirection()({ i: uint(screenCoordinate.x) }) as Any;
    return vec4((cubeTexture(array as Any, vec3(d.xyz)) as Any).depth(int(d.w)).level(0).rgb, 1);
  })();
  const quad = new THREE.QuadMesh(material);
  const previousTarget = renderer.getRenderTarget();
  try {
    device.pushErrorScope('validation');
    renderer.setRenderTarget(target);
    quad.render(renderer);
    renderer.setRenderTarget(previousTarget);
    const pixels: Uint8Array = await renderer.readRenderTargetPixelsAsync(target, 0, 0, TEST_WIDTH, 1);
    const error = await device.popErrorScope();
    if (error) return `validation error: ${error.message}`;
    for (let i = 0; i < TEST_WIDTH; i++) {
      const want = testColor(Math.floor(i / 24), Math.floor(i / 4) % 6, i % 2, Math.floor(i / 2) % 2);
      for (let c = 0; c < 4; c++) {
        if (Math.abs(pixels[i * 4 + c] - want[c]) > 1) return `pixel ${i} reads ${Array.from(pixels.slice(i * 4, i * 4 + 4))}, expected ${want} (layer/face orientation)`;
      }
    }
    return null;
  } catch (e) {
    try { await device.popErrorScope(); } catch { /* scope already popped */ }
    return `exception: ${(e as Error)?.message ?? e}`;
  } finally {
    renderer.setRenderTarget(previousTarget);
    quad.geometry?.dispose?.();
    material.dispose();
    target.dispose();
    array.dispose();
  }
}

// ---- public API -------------------------------------------------------------------------------

/**
 * Lets `renderer` bind three.js #35053's CubeArrayTexture (`texture_cube_array`) on a three that
 * lacks it, by patching four renderer internals at runtime (see the file header), then verifies the
 * patched path with a self-test: a 2-cube array uploaded through three, sampled in a TSL material
 * with `cubeTexture( array, dir ).depth( i )`, rendered and read back, every cube, face and texel
 * checked. On any failure it uninstalls and resolves false.
 *
 * Resolves true at once (patching nothing) when three has CubeArrayTexture natively. Resolves false
 * without patching on the WebGL backend or a three revision outside {@link CUBE_ARRAY_SHIM_REVISIONS}.
 * Idempotent per renderer (the same promise); undo with {@link uninstallCubeArraySupport}. Call after
 * `await renderer.init()`. {@link ReflectionProbes} with `layout: 'auto'` then bakes into a cube array.
 */
export function installCubeArraySupport(renderer: THREE.WebGPURenderer, options: InstallCubeArrayOptions = {}): Promise<boolean> {
  const existing = pending.get(renderer);
  if (existing !== undefined) return existing;
  const set = (s: CubeArraySupportStatus) => { status.set(renderer, s); return s.mode !== 'none'; };
  const run = (async () => {
    if (!isWebGPU(renderer)) return set({ mode: 'none', reason: 'not the WebGPU backend' });
    if (nativeCubeArrayTexture() !== null) return set({ mode: 'native', reason: `three r${THREE.REVISION} has CubeArrayTexture` });
    if (!CUBE_ARRAY_SHIM_REVISIONS.includes(THREE.REVISION) && options.allowUntestedRevision !== true) {
      return set({ mode: 'none', reason: `three r${THREE.REVISION} is outside the shim's tested revisions (${CUBE_ARRAY_SHIM_REVISIONS.join(', ')})` });
    }
    let installedHere = false;
    try {
      if (patches === null) { patches = patchAll(renderer); installedHere = true; }
      users.add(renderer);
      const failure = await selfTest(renderer);
      if (failure === null) return set({ mode: 'shim', reason: `three r${THREE.REVISION}, self-test passed (${TEST_CUBES} cubes x 6 faces x ${TEST_FACE * TEST_FACE} texels)` });
      users.delete(renderer);
      if (installedHere || users.size === 0) restore();
      return set({ mode: 'none', reason: `self-test failed: ${failure}` });
    } catch (e) {
      users.delete(renderer);
      if (installedHere || users.size === 0) restore();
      return set({ mode: 'none', reason: `install failed: ${(e as Error)?.message ?? e}` });
    }
  })();
  pending.set(renderer, run);
  // a failed install can be retried
  run.then((ok) => { if (!ok) pending.delete(renderer); });
  return run;
}

/**
 * Undoes {@link installCubeArraySupport} for `renderer`. The patches come off when no other renderer
 * uses them. Re-bake probe sets afterwards: a bake picks the layout again (2D array once the shim is gone).
 */
export function uninstallCubeArraySupport(renderer: THREE.WebGPURenderer) {
  pending.delete(renderer);
  if (status.get(renderer)?.mode === 'shim') status.set(renderer, { mode: 'none', reason: 'uninstalled' });
  if (users.delete(renderer) && users.size === 0) restore();
}

/** Whether `renderer` can bind CubeArrayTexture now: three's own, or the shim installed and self-tested on it. */
export function cubeArraySupported(renderer: THREE.WebGPURenderer): boolean {
  if (!isWebGPU(renderer)) return false;
  if (nativeCubeArrayTexture() !== null) return true;
  return patches !== null && users.has(renderer) && status.get(renderer)?.mode === 'shim';
}

/** What {@link installCubeArraySupport} found for `renderer` (mode 'none' with a reason before any install). */
export function cubeArraySupportStatus(renderer: THREE.WebGPURenderer): CubeArraySupportStatus {
  if (nativeCubeArrayTexture() !== null && isWebGPU(renderer)) return { mode: 'native', reason: `three r${THREE.REVISION} has CubeArrayTexture` };
  return status.get(renderer) ?? { mode: 'none', reason: 'installCubeArraySupport( renderer ) not called' };
}
