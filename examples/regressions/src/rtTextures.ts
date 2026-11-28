// examples/regressions, W97: traced hits read their material's base colour texture.
//
//  rtTextures  A plane whose map has four coloured quadrants (a canvas texture: flipY, sRGB) is hit by four rays, one per
//              quadrant, through core's @pmndrs/raytracer provider built by createRaytracerTraceProviderFromObjects.
//              `traceHitMaterial` must give each quadrant's colour (x the material colour). Before W97 every hit got the
//              map's mean: on examples/features/rt/animated the mirror floor's traced reflection of the checker wall
//              behind the moving knot and ball came out as flat grey silhouettes of them.
import * as THREE from 'three/webgpu';
import { HIT_WGSL, type TraceProvider } from '@pmndrs/reflections/core';
import { createRaytracerTraceProviderFromObjects, getDevice } from '@pmndrs/reflections/three';
import { readBufferF32, trackErrors } from './util';

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** traceFirstHit + traceHitMaterial for each ray (origin, direction): t and albedo per ray. */
async function traceAlbedo(device: GPUDevice, provider: TraceProvider, rays: [number[], number[]][]) {
  const n = rays.length;
  const o = new Float32Array(n * 4), d = new Float32Array(n * 4);
  rays.forEach(([a, b], i) => { o.set(a, i * 4); d.set(b, i * 4); });
  const code = `${HIT_WGSL}
@group(0) @binding(0) var<storage, read> rayO: array<vec4f>;
@group(0) @binding(1) var<storage, read> rayD: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outM: array<vec4f>;
${provider.code({ group: 1, firstBinding: 0 })}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rayO)) { return; }
  let h = traceFirstHit(rayO[id.x].xyz, rayD[id.x].xyz, 100.0);
  var m = HitMaterial(vec3f(0.0), vec3f(0.0));
  if (h.t >= 0.0) { m = traceHitMaterial(h); }
  outM[id.x] = vec4f(m.albedo, h.t);
}`;
  const mk = (a: Float32Array<ArrayBuffer>) => { const b = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, a); return b; };
  const bo = mk(o), bd = mk(d);
  const out = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const bl0 = device.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 2 ? 'storage' as const : 'read-only-storage' as const } })) });
  const bl1 = device.createBindGroupLayout({ entries: provider.entries.map((e, binding) => ({ ...e, binding } as GPUBindGroupLayoutEntry)) });
  const pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bl0, bl1] }), compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: bl0, entries: [bo, bd, out].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
  pass.setBindGroup(1, device.createBindGroup({ layout: bl1, entries: provider.resources().map((resource, binding) => ({ binding, resource })) }));
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  const f = await readBufferF32(device, out);
  [bo, bd, out].forEach((b) => b.destroy());
  return rays.map((_, i) => ({ albedo: Array.from(f.subarray(i * 4, i * 4 + 3)), t: f[i * 4 + 3] }));
}

/**
 * traceFirstHit + traceHitMaterial / traceHitSpecular, and traceAny over [0, anyMax], per ray (origin, direction): t, albedo,
 * emissive, specular F0 and roughness, any-hit.
 */
async function traceAll(device: GPUDevice, provider: TraceProvider, rays: [number[], number[]][], anyMax = 100) {
  const n = rays.length;
  const o = new Float32Array(n * 4), d = new Float32Array(n * 4);
  rays.forEach(([a, b], i) => { o.set(a, i * 4); d.set(b, i * 4); });
  const code = `${HIT_WGSL}
@group(0) @binding(0) var<storage, read> rayO: array<vec4f>;
@group(0) @binding(1) var<storage, read> rayD: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outM: array<vec4f>;
${provider.code({ group: 1, firstBinding: 0 })}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rayO)) { return; }
  let h = traceFirstHit(rayO[id.x].xyz, rayD[id.x].xyz, 100.0);
  var m = HitMaterial(vec3f(0.0), vec3f(0.0));
  var s = HitSpecular(vec3f(0.0), 0.0, 0.0, 0.0);
  if (h.t >= 0.0) { m = traceHitMaterial(h); s = traceHitSpecular(h); }
  let blocked = traceAny(rayO[id.x].xyz, rayD[id.x].xyz, ${anyMax.toFixed(3)});
  outM[id.x * 4u] = vec4f(m.albedo, h.t);
  outM[id.x * 4u + 1u] = vec4f(m.emissive, select(0.0, 1.0, blocked));
  outM[id.x * 4u + 2u] = vec4f(s.color, s.roughness);
}`;
  const mk = (a: Float32Array<ArrayBuffer>) => { const b = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, a); return b; };
  const bo = mk(o), bd = mk(d);
  const out = device.createBuffer({ size: n * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const bl0 = device.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 2 ? 'storage' as const : 'read-only-storage' as const } })) });
  const bl1 = device.createBindGroupLayout({ entries: provider.entries.map((e, binding) => ({ ...e, binding } as GPUBindGroupLayoutEntry)) });
  const pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bl0, bl1] }), compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: bl0, entries: [bo, bd, out].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
  pass.setBindGroup(1, device.createBindGroup({ layout: bl1, entries: provider.resources().map((resource, binding) => ({ binding, resource })) }));
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  const f = await readBufferF32(device, out);
  [bo, bd, out].forEach((b) => b.destroy());
  const r3 = (a: ArrayLike<number>) => Array.from(a).map((v) => +v.toFixed(3));
  return rays.map((_, i) => ({
    t: +f[i * 16 + 3].toFixed(3), albedo: r3(f.subarray(i * 16, i * 16 + 3)), emissive: r3(f.subarray(i * 16 + 4, i * 16 + 7)),
    blocked: f[i * 16 + 7] > 0.5, f0: r3(f.subarray(i * 16 + 8, i * 16 + 11)), roughness: +f[i * 16 + 11].toFixed(3),
  }));
}

/** A canvas texture of four quadrants as the image shows them (tl, tr, bl, br; rgba 0-255). */
function quadTexture(q: { tl: number[]; tr: number[]; bl: number[]; br: number[] }, colorSpace: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d')!;
  const fill = (c: number[], x: number, y: number) => { g.clearRect(x, y, 32, 32); g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`; g.fillRect(x, y, 32, 32); };
  fill(q.tl, 0, 0); fill(q.tr, 32, 0); fill(q.bl, 0, 32); fill(q.br, 32, 32);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = colorSpace as THREE.ColorSpace;
  return t;
}

/**
 * W110 (T18): the other material textures at traced hits, on 2 x 2 planes at z = 0 facing +z hit by one ray per quadrant
 * (origin z = 3, straight down -z; a green backstop plane at z = -1):
 *  - alpha test: a map whose left half has alpha 0, `alphaTest` 0.5: rays through the left half find the backstop (t 4) and
 *    any-hit rays stopping short of it (tMax 3.5) are not blocked; the right half is hit (t 3) and blocks. Then the same with
 *    three's `alphaMap` (green 0 on the left, no map), and with `textures.alphaTest: false` (every ray stops at t 3, as before);
 *  - roughness / metalness: a linear map (g, b) per quadrant x the material's factors (0.8, 1): traceHitSpecular's roughness and
 *    F0 per quadrant (glTF's one texture, and three's two maps);
 *  - emissive (`textures.emissive: true`; default off: the map's mean): an sRGB emissive map per quadrant x emissive x intensity.
 */
async function materialMapChecks(device: GPUDevice) {
  const at = (x: number, y: number): [number[], number[]] => [[x, y, 3, 0], [0, 0, -1, 0]];
  const quads = [at(-0.5, 0.5), at(0.5, 0.5), at(-0.5, -0.5), at(0.5, -0.5)];
  const backstop = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ color: 0x00ff00, roughness: 1 }));
  backstop.position.z = -1;
  const plane = (material: THREE.Material) => new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const run = async (objects: THREE.Object3D[], options: Record<string, unknown> = {}) => {
    for (const o of objects) o.updateMatrixWorld(true);
    const { provider } = await createRaytracerTraceProviderFromObjects(device, objects, options);
    const info = { ...(provider as unknown as { info: Record<string, unknown> }).info };
    const hits = await traceAll(device, provider, quads, 3.5);
    (provider as { destroy?(): void }).destroy?.();
    return { hits, alphaTestRuns: info.alphaTestRuns, alphaTestTriangles: info.alphaTestTriangles, textures: info.textures, textureBytes: info.textureBytes };
  };
  // alpha: left half transparent (tl, bl), right half opaque red
  const cut = quadTexture({ tl: [255, 255, 255, 0], tr: [230, 40, 40, 255], bl: [255, 255, 255, 0], br: [230, 40, 40, 255] }, THREE.SRGBColorSpace);
  const leaves = new THREE.MeshStandardMaterial({ map: cut, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 });
  const alpha = await run([plane(leaves), backstop]);
  const alphaOff = await run([plane(leaves), backstop], { textures: { alphaTest: false } });
  const mask = quadTexture({ tl: [0, 0, 0, 255], tr: [0, 255, 0, 255], bl: [0, 0, 0, 255], br: [0, 255, 0, 255] }, THREE.NoColorSpace);
  const alphaMap = await run([plane(new THREE.MeshStandardMaterial({ color: 0xff0000, alphaMap: mask, alphaTest: 0.5, roughness: 1 })), backstop]);
  // roughness (g) / metalness (b) per quadrant, linear; factors roughness 0.8, metalness 1
  const rmQuads = { tl: [0, 255, 0, 255], tr: [0, 128, 255, 255], bl: [0, 64, 0, 255], br: [0, 32, 255, 255] };
  const rm = quadTexture(rmQuads, THREE.NoColorSpace);
  const base = [0.9, 0.5, 0.2];
  const rmMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...base), roughness: 0.8, metalness: 1, roughnessMap: rm, metalnessMap: rm });
  const rough = await run([plane(rmMat)]);
  const rough2 = await run([plane(new THREE.MeshStandardMaterial({ color: new THREE.Color(...base), roughness: 0.8, metalness: 1, roughnessMap: rm, metalnessMap: quadTexture(rmQuads, THREE.NoColorSpace) }))]);
  const roughOff = await run([plane(rmMat)], { textures: { roughnessMetalness: false } });
  // emissive per quadrant (sRGB) x emissive 1, 0.5, 0.25 x intensity 2
  const emQuads = { tl: [255, 255, 255], tr: [255, 0, 0], bl: [0, 0, 0], br: [0, 128, 255] };
  const em = quadTexture(emQuads, THREE.SRGBColorSpace);
  const emissive = await run([plane(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.5, 0.25), emissiveIntensity: 2, emissiveMap: em }))], { textures: { emissive: true } });
  const emissiveDefault = await run([plane(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.5, 0.25), emissiveIntensity: 2, emissiveMap: em }))]);
  const names = ['tl', 'tr', 'bl', 'br'] as const;
  const wantRough = names.map((k) => +(0.8 * rmQuads[k][1] / 255).toFixed(3));
  const wantF0 = names.map((k) => { const m = rmQuads[k][2] / 255; return base.map((b) => +(0.04 + (b - 0.04) * m).toFixed(3)); });
  const wantEm = names.map((k) => emQuads[k].map((c, j) => +(srgbToLinear(c / 255) * [1, 0.5, 0.25][j] * 2).toFixed(3)));
  return { alpha, alphaOff, alphaMap, rough, rough2, roughOff, emissive, emissiveDefault, wantRough, wantF0, wantEm };
}

export async function rtTextureChecks() {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  await renderer.init();
  const device = getDevice(renderer);
  const gpuErrors: string[] = [];
  trackErrors(device, gpuErrors);
  // four quadrants as the image shows them: top-left red, top-right green, bottom-left blue, bottom-right white
  const quad = { tl: [230, 40, 40], tr: [40, 200, 60], bl: [40, 60, 220], br: [250, 250, 250] };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d')!;
  const fill = (c: number[], x: number, y: number) => { g.fillStyle = `rgb(${c.join(',')})`; g.fillRect(x, y, 32, 32); };
  fill(quad.tl, 0, 0); fill(quad.tr, 32, 0); fill(quad.bl, 0, 32); fill(quad.br, 32, 32);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const tint = [1, 0.8, 0.6];
  // a 2 x 2 plane at z = 0 facing +z: three draws the image's top-left at the plane's top-left (uv (0, 1), flipY)
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial({ map, color: new THREE.Color(...tint), roughness: 0.5 }));
  plane.updateMatrixWorld(true);
  const { provider } = await createRaytracerTraceProviderFromObjects(device, [plane]);
  const at = (x: number, y: number): [number[], number[]] => [[x, y, 3, 0], [0, 0, -1, 0]];
  const names = ['tl', 'tr', 'bl', 'br'] as const;
  const got = await traceAlbedo(device, provider, [at(-0.5, 0.5), at(0.5, 0.5), at(-0.5, -0.5), at(0.5, -0.5)]);
  const quadrants = names.map((k, i) => {
    const want = quad[k].map((c, j) => srgbToLinear(c / 255) * tint[j]);
    const err = Math.max(...want.map((w, j) => Math.abs(got[i].albedo[j] - w)));
    return { quadrant: k, t: got[i].t, want: want.map((v) => +v.toFixed(3)), got: got[i].albedo.map((v) => +v.toFixed(3)), err: +err.toFixed(4) };
  });
  (provider as { destroy?(): void }).destroy?.();
  const maps = await materialMapChecks(device);
  renderer.dispose();
  return { quadrants, maps, gpuErrors };
}
