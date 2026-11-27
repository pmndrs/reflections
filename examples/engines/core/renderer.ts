// The smallest renderer that fills the frame contract (docs/site/concepts/frame-contract.mdx) for the two rooms, on a
// bare GPUDevice. It is the "engine" here, and it is what an adapter maps instead: depth, world normal + roughness,
// base colour + metalness, motion, and the scene colour (direct light with its specular, shadows, and the probes'
// diffuse as bounce light; no reflections, which core adds). One forward pass with four colour targets, a depth pass
// per cube face for the point lights' shadows, a 90-degree pass per probe face for the captures, and the composite.
import { splitSumDFGWgsl, type ProbeSet } from '@pmndrs/reflections/core';
import { CUBE_FACES, perspective, viewMatrix, type M4, type SceneMesh, type V3 } from './scene';
import { mat4Multiply } from '@pmndrs/reflections/core';

export const VIEW_STRIDE = 256;
const MESH_STRIDE = 256;
const SHADOW_SIZE = 256;
const SHADOW_NEAR = 0.05, SHADOW_FAR = 30;
export const GBUFFER = { color: 'rgba16float', normal: 'rgba16float', albedo: 'rgba8unorm', motion: 'rgba16float' } as const;

const SHADER = (probeWgsl: string) => /* wgsl */ `
struct View { viewProj: mat4x4f, prevViewProj: mat4x4f, eye: vec4f }
struct Mesh { model: mat4x4f, prevModel: mat4x4f, color: vec4f, params: vec4f } // color.a roughness; params metalness, receive
struct Lights { position: array<vec4f, 2>, color: array<vec4f, 2>, shadow: vec4f } // shadow: near, far
@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var<uniform> mesh: Mesh;
@group(2) @binding(0) var<uniform> lights: Lights;
@group(2) @binding(1) var shadowMap: texture_depth_cube_array;
@group(2) @binding(2) var shadowSampler: sampler_comparison;
${probeWgsl}
${splitSumDFGWgsl()}
const PI = 3.141592653589793;

struct VOut { @builtin(position) clip: vec4f, @location(0) P: vec3f, @location(1) N: vec3f, @location(2) cur: vec4f, @location(3) prev: vec4f }
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f) -> VOut {
  let P = mesh.model * vec4f(position, 1.0);
  var o: VOut;
  o.clip = view.viewProj * P;
  o.P = P.xyz;
  o.N = (mesh.model * vec4f(normal, 0.0)).xyz;
  o.cur = o.clip;
  o.prev = view.prevViewProj * (mesh.prevModel * vec4f(position, 1.0));
  return o;
}
@vertex fn vsDepth(@location(0) position: vec3f) -> @builtin(position) vec4f { return view.viewProj * mesh.model * vec4f(position, 1.0); }

// three's point-light shadow: the distance along the face's axis as that face's depth, a few comparison taps
fn shadow(light: u32, P: vec3f, N: vec3f) -> f32 {
  let d = P + N * 0.04 - lights.position[light].xyz;
  let a = abs(d);
  let m = max(a.x, max(a.y, a.z));
  let n = lights.shadow.x; let f = lights.shadow.y;
  let zRef = (f / (n - f) * -m + f * n / (n - f)) / m - 0.0005;
  let t = normalize(cross(d, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), a.y > a.x && a.y > a.z)));
  let b = cross(normalize(d), t);
  let r = m * 0.012;
  var s = 0.0;
  for (var k = 0; k < 8; k++) {
    let ang = f32(k) * 0.785398 + 0.39; let rad = select(1.0, 0.5, (k & 1) == 1);
    s += textureSampleCompareLevel(shadowMap, shadowSampler, d + (t * cos(ang) + b * sin(ang)) * r * rad, i32(light), zRef);
  }
  return s / 8.0;
}
fn D_GGX(a: f32, NdotH: f32) -> f32 { let a2 = a * a; let d = NdotH * NdotH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
fn V_Smith(a: f32, NdotL: f32, NdotV: f32) -> f32 {
  let a2 = a * a;
  let gv = NdotL * sqrt(a2 + (1.0 - a2) * NdotV * NdotV); let gl = NdotV * sqrt(a2 + (1.0 - a2) * NdotL * NdotL);
  return 0.5 / max(gv + gl, 1e-6);
}
struct Surface { P: vec3f, N: vec3f, V: vec3f, albedo: vec3f, roughness: f32, metalness: f32 }
fn surface(v: VOut, front: bool) -> Surface {
  var N = normalize(v.N);
  if (!front) { N = -N; }
  return Surface(v.P, N, normalize(view.eye.xyz - v.P), mesh.color.rgb, mesh.color.a, mesh.params.x);
}
// Direct light (diffuse + GGX specular, shadowed) and the probes' irradiance as bounce light: the frame contract's
// scene colour ('direct': no indirect specular).
fn shade(s: Surface) -> vec3f {
  let diffuse = s.albedo * (1.0 - s.metalness);
  let F0 = mix(vec3f(0.04), s.albedo, s.metalness);
  let a = max(s.roughness, 0.0525) * max(s.roughness, 0.0525);
  let NdotV = max(dot(s.N, s.V), 1e-4);
  var c = vec3f(0.0);
  for (var i = 0u; i < 2u; i++) {
    let Lv = lights.position[i].xyz - s.P;
    let L = normalize(Lv);
    let NdotL = max(dot(s.N, L), 0.0);
    if (NdotL <= 0.0) { continue; }
    let H = normalize(L + s.V);
    let vis = select(1.0, shadow(i, s.P, s.N), mesh.params.y > 0.5);
    let E = lights.color[i].rgb / max(dot(Lv, Lv), 0.01) * NdotL * vis;
    let F = F0 + (1.0 - F0) * pow(1.0 - max(dot(s.V, H), 0.0), 5.0);
    c += E * (diffuse / PI + F * D_GGX(a, max(dot(s.N, H), 0.0)) * V_Smith(a, NdotL, NdotV));
  }
  // the bounce light, less what the specular lobe reflects (three's (1 - E_spec) on its indirect diffuse)
  let ab = splitSumDFG(NdotV, s.roughness);
  return c + diffuse * (1.0 - (F0 * ab.x + ab.y)) * probeRadianceWithEnvironment(s.P, s.N, 1.0);
}

struct GBuffer { @location(0) color: vec4f, @location(1) normal: vec4f, @location(2) albedo: vec4f, @location(3) motion: vec4f }
@fragment fn fsGBuffer(v: VOut, @builtin(front_facing) front: bool) -> GBuffer {
  let s = surface(v, front);
  let uv = (v.cur.xy / v.cur.w) * vec2f(0.5, -0.5) + 0.5;
  let uvPrev = (v.prev.xy / v.prev.w) * vec2f(0.5, -0.5) + 0.5;
  // motion: uv-space current - previous (motionVectorScale [1, 1]); z: N.V for the composite; w: geometry
  return GBuffer(vec4f(shade(s), 1.0), vec4f(s.N, s.roughness), vec4f(s.albedo, s.metalness), vec4f(uv - uvPrev, max(dot(s.N, s.V), 0.0), 1.0));
}
// A probe capture: the scene colour, plus (second bounce) the probes' specular, so a captured glossy floor reflects the room.
@fragment fn fsCapture(v: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let s = surface(v, front);
  let NdotV = max(dot(s.N, s.V), 1e-4);
  let ab = splitSumDFG(NdotV, s.roughness);
  let spec = (mix(vec3f(0.04), s.albedo, s.metalness) * ab.x + ab.y) * probeRadianceWithEnvironment(s.P, reflect(-s.V, s.N), s.roughness);
  return vec4f(shade(s) + spec, 1.0);
}
`;

const COMPOSITE = /* wgsl */ `
@group(0) @binding(0) var color: texture_2d<f32>;
@group(0) @binding(1) var normal: texture_2d<f32>;
@group(0) @binding(2) var albedo: texture_2d<f32>;
@group(0) @binding(3) var motion: texture_2d<f32>;
@group(0) @binding(4) var radiance: texture_2d<f32>;
@group(0) @binding(5) var<uniform> mode: vec4f; // x: 0 final, 1 lit, 2 reflection
${splitSumDFGWgsl()}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(vec2f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0), 0.0, 1.0);
}
// three's ACESFilmicToneMapping (the same fit Babylon uses, after a 1 / 0.6 exposure) and the sRGB transfer
fn aces(x: vec3f) -> vec3f {
  let i = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383), vec3f(0.04823, 0.01566, 0.83777));
  let o = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276), vec3f(-0.07367, -0.00605, 1.07602));
  let v = i * (x / 0.6);
  return clamp(o * ((v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081)), vec3f(0.0), vec3f(1.0));
}
fn srgb(c: vec3f) -> vec3f { return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308)); }
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let px = vec2i(p.xy);
  let lit = textureLoad(color, px, 0).rgb;
  let n = textureLoad(normal, px, 0);
  let a = textureLoad(albedo, px, 0);
  let m = textureLoad(motion, px, 0);
  // final = lit + split-sum weight x radiance (core's lerp(probes, screen hit, confidence), denoised)
  let ab = splitSumDFG(m.z, n.w);
  let reflection = select(vec3f(0.0), (mix(vec3f(0.04), a.rgb, a.a) * ab.x + ab.y) * textureLoad(radiance, px, 0).rgb, m.w > 0.5);
  let c = select(select(reflection, lit, mode.x == 1.0), lit + reflection, mode.x == 0.0);
  return vec4f(srgb(aces(c)), 1.0);
}
`;

interface GpuMesh { mesh: SceneMesh; vertices: GPUBuffer; indices: GPUBuffer; count: number; offset: number; prev: M4 }

export class RoomsRenderer {
  readonly views: GPUBuffer;
  readonly shadowMap: GPUTexture;
  private readonly meshes: GpuMesh[];
  private readonly meshBuffer: GPUBuffer;
  private readonly meshGroup: GPUBindGroup;
  private readonly viewGroup: GPUBindGroup;
  private readonly lightGroup: GPUBindGroup;
  private readonly gbufferPipe: GPURenderPipeline;
  private readonly capturePipe: GPURenderPipeline;
  private readonly depthPipe: GPURenderPipeline;
  private readonly compositePipe: GPURenderPipeline;
  private readonly modeBuffer: GPUBuffer;
  targets: Record<'color' | 'normal' | 'albedo' | 'motion' | 'depth', GPUTexture> | null = null;
  private compositeGroups = new Map<GPUTexture, GPUBindGroup>();

  constructor(readonly device: GPUDevice, meshes: SceneMesh[], private readonly lights: { position: V3; color: V3 }[], private readonly probes: ProbeSet, readonly format: GPUTextureFormat) {
    const U = GPUBufferUsage, V = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const dyn = (visibility: number) => device.createBindGroupLayout({ entries: [{ binding: 0, visibility, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
    const viewLayout = dyn(V), meshLayout = dyn(V);
    const lightLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: 'cube-array' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
    ] });
    // one view slot per camera: the main one, 3 probes x 6 faces, 2 lights x 6 faces
    this.views = device.createBuffer({ size: VIEW_STRIDE * 31, usage: U.UNIFORM | U.COPY_DST });
    this.meshBuffer = device.createBuffer({ size: MESH_STRIDE * meshes.length, usage: U.UNIFORM | U.COPY_DST });
    this.meshes = meshes.map((mesh, k) => {
      const buf = (data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number) => {
        const b = device.createBuffer({ size: data.byteLength, usage: usage | U.COPY_DST });
        device.queue.writeBuffer(b, 0, data);
        return b;
      };
      return { mesh, vertices: buf(mesh.geometry.vertices, U.VERTEX), indices: buf(mesh.geometry.indices, U.INDEX), count: mesh.geometry.indices.length, offset: k * MESH_STRIDE, prev: mesh.model };
    });
    this.viewGroup = device.createBindGroup({ layout: viewLayout, entries: [{ binding: 0, resource: { buffer: this.views, size: 144 } }] });
    this.meshGroup = device.createBindGroup({ layout: meshLayout, entries: [{ binding: 0, resource: { buffer: this.meshBuffer, size: 160 } }] });
    this.shadowMap = device.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE, 12], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const lightData = new Float32Array(20);
    lights.forEach((l, i) => { lightData.set([...l.position, 1], i * 4); lightData.set([...l.color, 1], 8 + i * 4); });
    lightData.set([SHADOW_NEAR, SHADOW_FAR], 16);
    const lightBuffer = device.createBuffer({ size: lightData.byteLength, usage: U.UNIFORM | U.COPY_DST });
    device.queue.writeBuffer(lightBuffer, 0, lightData);
    this.lightGroup = device.createBindGroup({ layout: lightLayout, entries: [
      { binding: 0, resource: { buffer: lightBuffer } },
      { binding: 1, resource: this.shadowMap.createView({ dimension: 'cube-array' }) },
      { binding: 2, resource: device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' }) },
    ] });

    const module = device.createShaderModule({ code: SHADER(probes.wgsl({ group: 3 })) });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [viewLayout, meshLayout, lightLayout, probes.bindGroupLayout] });
    const vertex: GPUVertexState = { module, entryPoint: 'vs', buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }] };
    const depthStencil: GPUDepthStencilState = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' };
    // three's FrontSide: back faces culled (the shell's walls face inward, so the camera sees into the rooms from outside).
    // The cube faces' cameras are mirrored (WebGPU's cube convention), which turns the winding: 'cw' there. Shadows: both sides.
    const primitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' };
    this.gbufferPipe = device.createRenderPipeline({
      layout, vertex, primitive, depthStencil,
      fragment: { module, entryPoint: 'fsGBuffer', targets: Object.values(GBUFFER).map((format) => ({ format })) },
    });
    this.capturePipe = device.createRenderPipeline({ layout, vertex, primitive: { ...primitive, frontFace: 'cw' }, depthStencil, fragment: { module, entryPoint: 'fsCapture', targets: [{ format: 'rgba16float' }] } });
    this.depthPipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout, meshLayout] }), primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil,
      vertex: { module, entryPoint: 'vsDepth', buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
    });
    const composite = device.createShaderModule({ code: COMPOSITE });
    this.compositePipe = device.createRenderPipeline({ layout: 'auto', vertex: { module: composite, entryPoint: 'vs' }, fragment: { module: composite, entryPoint: 'fs', targets: [{ format }] } });
    this.modeBuffer = device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
    // the light faces' cameras never move
    lights.forEach((l, i) => CUBE_FACES.forEach((f, k) => this.writeView(19 + i * 6 + k, mat4Multiply(perspective(Math.PI / 2, 1, SHADOW_NEAR, SHADOW_FAR), viewMatrix(l.position, ...f)), l.position)));
  }

  /** Writes view slot `slot` (viewProj, the previous one, the eye). */
  writeView(slot: number, viewProj: M4, eye: V3, prevViewProj: M4 = viewProj) {
    const data = new Float32Array(36);
    data.set(viewProj, 0); data.set(prevViewProj, 16); data.set([...eye, 1], 32);
    this.device.queue.writeBuffer(this.views, slot * VIEW_STRIDE, data);
  }

  /** Uploads every mesh's model (and last frame's, for motion) and material. */
  updateMeshes() {
    for (const g of this.meshes) {
      const m = g.mesh, data = new Float32Array(40);
      data.set(m.model, 0); data.set(g.prev, 16); data.set([...m.color, m.roughness, m.metalness, m.receiveShadow ? 1 : 0], 32);
      this.device.queue.writeBuffer(this.meshBuffer, g.offset, data);
      g.prev = m.model;
    }
  }

  private draw(pass: GPURenderPassEncoder, viewSlot: number, filter: (m: SceneMesh) => boolean) {
    for (const g of this.meshes) {
      if (!filter(g.mesh)) continue;
      pass.setBindGroup(0, this.viewGroup, [viewSlot * VIEW_STRIDE]);
      pass.setBindGroup(1, this.meshGroup, [g.offset]);
      pass.setVertexBuffer(0, g.vertices);
      pass.setIndexBuffer(g.indices, 'uint32');
      pass.drawIndexed(g.count);
    }
  }

  /** The point lights' cube shadow maps (12 faces). */
  shadows(encoder: GPUCommandEncoder) {
    for (let layer = 0; layer < 12; layer++) {
      const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
        view: this.shadowMap.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
      } });
      pass.setPipeline(this.depthPipe);
      this.draw(pass, 19 + layer, (m) => m.castShadow);
      pass.end();
    }
  }

  private lit(pass: GPURenderPassEncoder, pipe: GPURenderPipeline, viewSlot: number, filter: (m: SceneMesh) => boolean) {
    pass.setPipeline(pipe);
    pass.setBindGroup(2, this.lightGroup);
    pass.setBindGroup(3, this.probes.bindGroup);
    this.draw(pass, viewSlot, filter);
  }

  /** (Re)allocates the G-buffer for a size. */
  resize(width: number, height: number) {
    for (const t of Object.values(this.targets ?? {})) t.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const make = (format: GPUTextureFormat) => this.device.createTexture({ size: [width, height], format, usage });
    this.targets = { color: make(GBUFFER.color), normal: make(GBUFFER.normal), albedo: make(GBUFFER.albedo), motion: make(GBUFFER.motion), depth: make('depth32float') };
    this.compositeGroups.clear();
  }

  /** The main view's G-buffer (view slot 0). */
  gbuffer(encoder: GPUCommandEncoder) {
    const t = this.targets!;
    const clear = (texture: GPUTexture, v: number[]): GPURenderPassColorAttachment => ({ view: texture.createView(), clearValue: v, loadOp: 'clear', storeOp: 'store' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [clear(t.color, [0.0056, 0.0056, 0.0056, 1]), clear(t.normal, [0, 0, 1, 1]), clear(t.albedo, [0, 0, 0, 0]), clear(t.motion, [0, 0, 0, 0])],
      depthStencilAttachment: { view: t.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    this.lit(pass, this.gbufferPipe, 0, () => true);
    pass.end();
  }

  /** Renders the six faces of a probe capture (view slots `firstSlot`...) into `cube` (rgba16float, 6 layers). */
  capture(encoder: GPUCommandEncoder, cube: GPUTexture, depth: GPUTexture, firstSlot: number) {
    for (let face = 0; face < 6; face++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: cube.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1 }), clearValue: [0.0056, 0.0056, 0.0056, 1], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      this.lit(pass, this.capturePipe, firstSlot + face, (m) => m.inProbes);
      pass.end();
    }
  }

  /** lit + weight x `radiance` to `target`, tone-mapped (mode 0 final, 1 lit only, 2 the reflection alone). */
  composite(encoder: GPUCommandEncoder, radiance: GPUTexture, target: GPUTextureView, mode: number) {
    const t = this.targets!;
    let group = this.compositeGroups.get(radiance);
    if (!group) {
      group = this.device.createBindGroup({ layout: this.compositePipe.getBindGroupLayout(0), entries: [
        ...[t.color, t.normal, t.albedo, t.motion, radiance].map((tex, binding) => ({ binding, resource: tex.createView() })),
        { binding: 5, resource: { buffer: this.modeBuffer } },
      ] });
      this.compositeGroups.set(radiance, group);
    }
    this.device.queue.writeBuffer(this.modeBuffer, 0, new Float32Array([mode, 0, 0, 0]));
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(this.compositePipe);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }
}
