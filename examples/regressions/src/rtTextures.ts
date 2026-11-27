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
  renderer.dispose();
  return { quadrants, gpuErrors };
}
