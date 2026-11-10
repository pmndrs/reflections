// The adapter-owned G-buffer pass (D2000): pixi.js has no 3-D G-buffer, so this pass draws a
// ReflectionScene (./scene.ts) on pixi's GPUDevice into contract-shaped targets in one MRT render:
//
//   color     rgba16float  linear HDR: emissive + sun (diffuse + GGX specular, shadowed) + hemisphere
//                          diffuse ambient. No indirect specular: sceneColorSpecular 'direct'.
//   normal    rgba16float  world normal (raw float: unpack 1, 0), w = perceptual roughness
//   material  rgba16float  base colour rgb, w = metalness
//   motion    rgba16float  xy = uv-space current - previous (motionVectorScale [1, 1]), z = N.V, w = coverage
//   depth     depth32float standard Z (0 near, 1 far): depthInverted false
//
// 32 bytes per sample, the default maxColorAttachmentBytesPerSample, so it runs on pixi's own device.
// The colour / normal / material / motion targets are pixi TextureSources (./internal/pixiWebGPU.ts),
// so pixi Sprites and Filters sample them directly.
//
// The same shaders render colour-only cube faces for probe captures (./probes.ts) and the sun's
// shadow map. The lighting is the adapter's own small PBR (pixi has none to reuse); the reflection
// maths (tracing, probes, prefilter, lookups) is all core's.
import type { Renderer, Texture } from 'pixi.js';
import { VERTEX_STRIDE } from './geometry';
import { createPixiTarget, getDevice, getGPUTexture } from './internal/pixiWebGPU';
import { CUBE_FACE_BASES, mat4FromBasis, mat4Invert, mat4LookAt, mat4Mul, mat4Ortho, mat4Perspective, mat4Transpose, normalize3, type Vec3 } from './math';
import type { ReflectionCamera, ReflectionMaterial, ReflectionMesh, ReflectionScene } from './scene';

const FRAME_SLOT = 512; // bytes per frame-uniform slot (dynamic offset)
const OBJECT_SLOT = 256;
const SLOT_MAIN = 0, SLOT_FACE0 = 1, SLOT_SHADOW = 7, FRAME_SLOTS = 8;

export const GBUFFER_WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  prevViewProj: mat4x4f,
  invViewProj: mat4x4f,
  shadowViewProj: mat4x4f,
  cameraPos: vec4f,
  sunDir: vec4f,
  sunColor: vec4f,
  skyZenith: vec4f,
  skyHorizon: vec4f,
  skyGround: vec4f,
  sunDisc: vec4f,      // rgb, w = angular radius
  ambientSky: vec4f,
  ambientGround: vec4f,
  shadow: vec4f,       // x enabled, y depth bias, z 1 / map size, w normal offset
};
struct Object {
  model: mat4x4f,
  prevModel: mat4x4f,
  normalMat: mat4x4f,
  color: vec4f,
  emissive: vec4f,
  params: vec4f,       // roughness, metalness, uv scale xy
  pad: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(1) @binding(0) var<uniform> obj: Object;
@group(2) @binding(0) var mapTex: texture_2d<f32>;
@group(2) @binding(1) var roughnessTex: texture_2d<f32>;
@group(2) @binding(2) var emissiveTex: texture_2d<f32>;
@group(2) @binding(3) var mapSampler: sampler;

const PI = 3.14159265359;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) clip: vec4f,
  @location(4) prevClip: vec4f,
};

@vertex fn vsMain(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  let w = obj.model * vec4f(p, 1.0);
  o.pos = frame.viewProj * w;
  o.clip = o.pos;
  o.prevClip = frame.prevViewProj * (obj.prevModel * vec4f(p, 1.0));
  o.world = w.xyz;
  o.normal = (obj.normalMat * vec4f(n, 0.0)).xyz;
  o.uv = uv * obj.params.zw;
  return o;
}

@vertex fn vsShadow(@location(0) p: vec3f) -> @builtin(position) vec4f {
  return frame.viewProj * (obj.model * vec4f(p, 1.0));
}

fn srgbToLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn shadowFactor(P: vec3f, n: vec3f) -> f32 {
  if (frame.shadow.x < 0.5) { return 1.0; }
  let c = frame.shadowViewProj * vec4f(P + n * frame.shadow.w, 1.0);
  let s = c.xyz / c.w;
  let uv = vec2f(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || s.z > 1.0) { return 1.0; }
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * frame.shadow.z, s.z - frame.shadow.y);
    }
  }
  return sum / 9.0;
}

struct Surface { lit: vec3f, n: vec3f, albedo: vec3f, roughness: f32, metalness: f32, NdotV: f32 };

fn shade(i: VOut, front: bool) -> Surface {
  let base = obj.color.rgb * srgbToLinear(textureSample(mapTex, mapSampler, i.uv).rgb);
  let mr = textureSample(roughnessTex, mapSampler, i.uv);
  let em = obj.emissive.rgb * srgbToLinear(textureSample(emissiveTex, mapSampler, i.uv).rgb);
  var n = normalize(i.normal);
  if (!front) { n = -n; }
  let V = normalize(frame.cameraPos.xyz - i.world);
  let roughness = clamp(obj.params.x * mr.g, 0.0, 1.0);
  let metalness = clamp(obj.params.y * mr.b, 0.0, 1.0);
  let L = normalize(frame.sunDir.xyz);
  let H = normalize(L + V);
  let NdotL = max(dot(n, L), 0.0);
  let NdotV = max(dot(n, V), 1e-4);
  let NdotH = max(dot(n, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);
  // punctual GGX at a floor of alpha 0.03 (a mirror's sun highlight stays inside f16)
  let a = max(roughness * roughness, 0.03);
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * d * d);
  let vis = 0.5 / max(NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2) + NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2), 1e-5);
  let F0 = mix(vec3f(0.04), base, metalness);
  let F = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
  let diffuse = base * (1.0 - metalness);
  let shadow = shadowFactor(i.world, n);
  let direct = NdotL * shadow * frame.sunColor.rgb * (diffuse / PI + F * D * vis);
  let ambient = mix(frame.ambientGround.rgb, frame.ambientSky.rgb, n.y * 0.5 + 0.5) * diffuse;
  var s: Surface;
  s.lit = min(direct + ambient + em, vec3f(60000.0));
  s.n = n;
  s.albedo = base;
  s.roughness = roughness;
  s.metalness = metalness;
  s.NdotV = NdotV;
  return s;
}

struct GOut {
  @location(0) color: vec4f,
  @location(1) normal: vec4f,
  @location(2) material: vec4f,
  @location(3) motion: vec4f,
};

fn ndcToUv(ndc: vec2f) -> vec2f { return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5); }

@fragment fn fsGBuffer(i: VOut, @builtin(front_facing) front: bool) -> GOut {
  let s = shade(i, front);
  var o: GOut;
  o.color = vec4f(s.lit, 1.0);
  o.normal = vec4f(s.n, s.roughness);
  o.material = vec4f(s.albedo, s.metalness);
  let uv = ndcToUv(i.clip.xy / i.clip.w);
  let prevUv = ndcToUv(i.prevClip.xy / i.prevClip.w);
  o.motion = vec4f(uv - prevUv, s.NdotV, 1.0);
  return o;
}

@fragment fn fsColor(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return vec4f(shade(i, front).lit, 1.0);
}

fn skyRadiance(d: vec3f) -> vec3f {
  let y = d.y;
  var c = mix(frame.skyHorizon.rgb, frame.skyZenith.rgb, pow(clamp(y, 0.0, 1.0), 0.45));
  if (y < 0.0) { c = mix(frame.skyHorizon.rgb, frame.skyGround.rgb, pow(clamp(-y, 0.0, 1.0), 0.3)); }
  let L = normalize(frame.sunDir.xyz);
  let cosA = dot(d, L);
  let size = frame.sunDisc.w;
  c += frame.sunDisc.rgb * smoothstep(cos(size * 1.15), cos(size), cosA);
  c += frame.sunDisc.rgb * 0.004 * pow(max(cosA, 0.0), 64.0);
  return c;
}

struct SkyOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vsSky(@builtin(vertex_index) v: u32) -> SkyOut {
  let p = vec2f(f32((v << 1u) & 2u), f32(v & 2u)) * 2.0 - 1.0;
  var o: SkyOut;
  o.pos = vec4f(p, 1.0, 1.0);
  o.ndc = p;
  return o;
}
fn skyDir(ndc: vec2f) -> vec3f {
  let far = frame.invViewProj * vec4f(ndc, 1.0, 1.0);
  return normalize(far.xyz / far.w - frame.cameraPos.xyz);
}
@fragment fn fsSkyGBuffer(i: SkyOut) -> GOut {
  var o: GOut;
  o.color = vec4f(skyRadiance(skyDir(i.ndc)), 1.0);
  o.normal = vec4f(0.0);
  o.material = vec4f(0.0);
  o.motion = vec4f(0.0);
  return o;
}
@fragment fn fsSkyColor(i: SkyOut) -> @location(0) vec4f {
  return vec4f(skyRadiance(skyDir(i.ndc)), 1.0);
}
`;

/** The G-buffer of one view: pixi textures (sample them in Sprites / Filters) and the raw handles. */
export class GBufferTargets {
  readonly width: number;
  readonly height: number;
  readonly color: ReturnType<typeof createPixiTarget>;
  readonly normal: ReturnType<typeof createPixiTarget>;
  readonly material: ReturnType<typeof createPixiTarget>;
  readonly motion: ReturnType<typeof createPixiTarget>;
  readonly depth: GPUTexture;

  constructor(renderer: Renderer, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.color = createPixiTarget(renderer, 'reflections: scene colour', width, height, 'rgba16float');
    this.normal = createPixiTarget(renderer, 'reflections: normal + roughness', width, height, 'rgba16float');
    this.material = createPixiTarget(renderer, 'reflections: albedo + metalness', width, height, 'rgba16float');
    this.motion = createPixiTarget(renderer, 'reflections: motion + N.V + coverage', width, height, 'rgba16float');
    this.depth = getDevice(renderer).createTexture({
      label: 'reflections: depth', size: [width, height], format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
  }

  destroy() {
    for (const t of [this.color, this.normal, this.material, this.motion]) t.destroy();
    this.depth.destroy();
  }
}

interface MaterialBinding { key: string; group: GPUBindGroup }

export class GBufferRenderer {
  readonly renderer: Renderer;
  readonly device: GPUDevice;
  private readonly frameBuffer: GPUBuffer;
  private objectBuffer: GPUBuffer;
  private objectCapacity = 0;
  private readonly frameLayout: GPUBindGroupLayout;
  private readonly frameOnlyLayout: GPUBindGroupLayout;
  private readonly objectLayout: GPUBindGroupLayout;
  private readonly materialLayout: GPUBindGroupLayout;
  private readonly gbufferPipe: GPURenderPipeline;
  private readonly colorPipe: GPURenderPipeline;
  private readonly skyGBufferPipe: GPURenderPipeline;
  private readonly skyColorPipe: GPURenderPipeline;
  private readonly shadowPipe: GPURenderPipeline;
  private objectGroup!: GPUBindGroup;
  private frameGroup!: GPUBindGroup;
  private readonly frameOnlyGroup: GPUBindGroup;
  private shadowMap: GPUTexture;
  private readonly compareSampler: GPUSampler;
  private readonly mapSampler: GPUSampler;
  private readonly white: GPUTexture;
  private readonly materials = new WeakMap<ReflectionMaterial, MaterialBinding>();
  private readonly textureIds = new WeakMap<GPUTexture, number>();
  private nextTextureId = 1;
  private drawList: ReflectionMesh[] = [];
  private readonly frameData = new Float32Array(FRAME_SLOT / 4);
  private readonly objectScratch = new Float32Array(OBJECT_SLOT / 4);

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    const device = (this.device = getDevice(renderer));
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.frameBuffer = device.createBuffer({ label: 'reflections gbuffer: frame', size: FRAME_SLOT * FRAME_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.objectBuffer = device.createBuffer({ label: 'reflections gbuffer: objects', size: OBJECT_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const frameEntry: GPUBindGroupLayoutEntry = { binding: 0, visibility: VF, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: FRAME_SLOT } };
    this.frameLayout = device.createBindGroupLayout({
      label: 'reflections gbuffer: frame', entries: [frameEntry,
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } }],
    });
    this.frameOnlyLayout = device.createBindGroupLayout({ label: 'reflections gbuffer: frame (shadow pass)', entries: [frameEntry] });
    this.objectLayout = device.createBindGroupLayout({
      label: 'reflections gbuffer: object',
      entries: [{ binding: 0, visibility: VF, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: OBJECT_SLOT } }],
    });
    const tex = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
    this.materialLayout = device.createBindGroupLayout({
      label: 'reflections gbuffer: material',
      entries: [tex(0), tex(1), tex(2), { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }],
    });
    const module = device.createShaderModule({ label: 'reflections gbuffer', code: GBUFFER_WGSL });
    const meshLayout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.objectLayout, this.materialLayout] });
    const vertex: GPUVertexState = {
      module, entryPoint: 'vsMain',
      buffers: [{ arrayStride: VERTEX_STRIDE, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' }] }],
    };
    const depthStencil: GPUDepthStencilState = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' };
    const skyDepth: GPUDepthStencilState = { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less-equal' };
    const gTargets: GPUColorTargetState[] = [0, 1, 2, 3].map(() => ({ format: 'rgba16float' as const }));
    const primitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'none' };
    this.gbufferPipe = device.createRenderPipeline({
      label: 'reflections gbuffer: meshes', layout: meshLayout, vertex, primitive, depthStencil,
      fragment: { module, entryPoint: 'fsGBuffer', targets: gTargets },
    });
    this.colorPipe = device.createRenderPipeline({
      label: 'reflections gbuffer: capture meshes', layout: meshLayout, vertex, primitive, depthStencil,
      fragment: { module, entryPoint: 'fsColor', targets: [{ format: 'rgba16float' }] },
    });
    const skyLayout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] });
    this.skyGBufferPipe = device.createRenderPipeline({
      label: 'reflections gbuffer: sky', layout: skyLayout, vertex: { module, entryPoint: 'vsSky' }, depthStencil: skyDepth,
      fragment: { module, entryPoint: 'fsSkyGBuffer', targets: gTargets },
    });
    this.skyColorPipe = device.createRenderPipeline({
      label: 'reflections gbuffer: capture sky', layout: skyLayout, vertex: { module, entryPoint: 'vsSky' }, depthStencil: skyDepth,
      fragment: { module, entryPoint: 'fsSkyColor', targets: [{ format: 'rgba16float' }] },
    });
    this.shadowPipe = device.createRenderPipeline({
      label: 'reflections gbuffer: shadow map',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.frameOnlyLayout, this.objectLayout] }),
      vertex: { module, entryPoint: 'vsShadow', buffers: [{ arrayStride: VERTEX_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      primitive, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    });
    this.compareSampler = device.createSampler({ label: 'reflections gbuffer: shadow', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.mapSampler = device.createSampler({
      label: 'reflections gbuffer: maps', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8,
    });
    this.white = device.createTexture({ label: 'reflections gbuffer: white', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.shadowMap = this.createShadowMap(1);
    this.frameOnlyGroup = device.createBindGroup({ layout: this.frameOnlyLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuffer, size: FRAME_SLOT } }] });
    this.rebuildFrameGroup();
    this.ensureObjects(16);
  }

  private createShadowMap(size: number) {
    return this.device.createTexture({ label: 'reflections gbuffer: shadow map', size: [size, size], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  }

  private rebuildFrameGroup() {
    this.frameGroup = this.device.createBindGroup({
      label: 'reflections gbuffer: frame', layout: this.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer, size: FRAME_SLOT } },
        { binding: 1, resource: this.shadowMap.createView() },
        { binding: 2, resource: this.compareSampler },
      ],
    });
  }

  private ensureObjects(n: number) {
    if (n <= this.objectCapacity) return;
    const cap = Math.max(n, this.objectCapacity * 2, 16);
    this.objectBuffer.destroy();
    this.objectBuffer = this.device.createBuffer({ label: 'reflections gbuffer: objects', size: cap * OBJECT_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.objectCapacity = cap;
    this.objectGroup = this.device.createBindGroup({
      label: 'reflections gbuffer: objects', layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer, size: OBJECT_SLOT } }],
    });
  }

  private textureId(t: GPUTexture) {
    let id = this.textureIds.get(t);
    if (!id) this.textureIds.set(t, (id = this.nextTextureId++));
    return id;
  }

  private gpuTexture(t: Texture | null): GPUTexture {
    return t ? getGPUTexture(this.renderer, t) : this.white;
  }

  private materialGroup(m: ReflectionMaterial): GPUBindGroup {
    const texs = [this.gpuTexture(m.map), this.gpuTexture(m.roughnessMap), this.gpuTexture(m.emissiveMap)];
    const key = texs.map((t) => this.textureId(t)).join(',');
    const cached = this.materials.get(m);
    if (cached?.key === key) return cached.group;
    const group = this.device.createBindGroup({
      label: 'reflections gbuffer: material', layout: this.materialLayout,
      entries: [...texs.map((t, i) => ({ binding: i, resource: t.createView({ dimension: '2d' as const, baseArrayLayer: 0, arrayLayerCount: 1 }) })),
        { binding: 3, resource: this.mapSampler }],
    });
    this.materials.set(m, { key, group });
    return group;
  }

  /** Uploads every visible mesh's transform and material (one uniform slot each). */
  private prepare(scene: ReflectionScene) {
    this.drawList = scene.meshes.filter((m) => m.visible);
    this.ensureObjects(this.drawList.length);
    const data = new Float32Array((this.drawList.length * OBJECT_SLOT) / 4);
    const o = this.objectScratch;
    this.drawList.forEach((mesh, i) => {
      const model = mesh.modelMatrix();
      const mat = mesh.material;
      o.fill(0);
      o.set(model, 0);
      o.set(mesh.prevModel ?? model, 16);
      o.set(mat4Transpose(mat4Invert(model)), 32);
      o.set([...mat.color, 1], 48);
      o.set([mat.emissive[0] * mat.emissiveIntensity, mat.emissive[1] * mat.emissiveIntensity, mat.emissive[2] * mat.emissiveIntensity, 1], 52);
      o.set([mat.roughness, mat.metalness, mat.uvScale[0], mat.uvScale[1]], 56);
      data.set(o, (i * OBJECT_SLOT) / 4);
    });
    if (data.length) this.device.queue.writeBuffer(this.objectBuffer, 0, data);
  }

  private writeFrame(slot: number, scene: ReflectionScene, view: ArrayLike<number>, projection: ArrayLike<number>, eye: Vec3, prevViewProj?: ArrayLike<number>, shadowViewProj?: ArrayLike<number>) {
    const f = this.frameData;
    f.fill(0);
    const vp = mat4Mul(projection, view);
    f.set(vp, 0);
    f.set(prevViewProj ?? vp, 16);
    f.set(mat4Invert(vp), 32);
    if (shadowViewProj) f.set(shadowViewProj, 48);
    const s = scene.sky, sun = scene.sun;
    const shadow = sun.shadow;
    const shadowSize = this.shadowMap.width;
    f.set([eye[0], eye[1], eye[2], 1], 64);
    f.set([...normalize3(sun.direction), 0], 68);
    f.set([...sun.color, 0], 72);
    f.set([...s.zenith, 0], 76);
    f.set([...s.horizon, 0], 80);
    f.set([...s.ground, 0], 84);
    f.set([...s.sunDisc, s.sunSize], 88);
    f.set([...scene.ambient.sky, 0], 92);
    f.set([...scene.ambient.ground, 0], 96);
    f.set([shadow && shadowViewProj ? 1 : 0, shadow?.bias ?? 0.0015, 1 / shadowSize, shadow ? (shadow.radius * 2) / shadowSize : 0], 100);
    this.device.queue.writeBuffer(this.frameBuffer, slot * FRAME_SLOT, f);
  }

  /** Renders the sun's shadow map (when `scene.sun.shadow` is set); returns its view-projection. */
  private renderShadow(encoder: GPUCommandEncoder, scene: ReflectionScene): Float32Array | undefined {
    const sh = scene.sun.shadow;
    if (!sh) return undefined;
    const size = sh.size ?? 2048;
    if (this.shadowMap.width !== size) {
      this.shadowMap.destroy();
      this.shadowMap = this.createShadowMap(size);
      this.rebuildFrameGroup();
    }
    const L = normalize3(scene.sun.direction);
    const r = sh.radius;
    const eye: Vec3 = [sh.center[0] + L[0] * r * 2, sh.center[1] + L[1] * r * 2, sh.center[2] + L[2] * r * 2];
    const view = mat4LookAt(eye, sh.center, Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
    const proj = mat4Ortho(-r, r, -r, r, 0.01, r * 4);
    this.writeFrame(SLOT_SHADOW, scene, view, proj, eye);
    const pass = encoder.beginRenderPass({
      label: 'reflections gbuffer: shadow map', colorAttachments: [],
      depthStencilAttachment: { view: this.shadowMap.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(this.shadowPipe);
    pass.setBindGroup(0, this.frameOnlyGroup, [SLOT_SHADOW * FRAME_SLOT]);
    this.drawList.forEach((mesh, i) => {
      if (!mesh.castShadow) return;
      const { vertex, index } = mesh.geometry.buffers(this.device);
      pass.setBindGroup(1, this.objectGroup, [i * OBJECT_SLOT]);
      pass.setVertexBuffer(0, vertex);
      pass.setIndexBuffer(index, 'uint32');
      pass.drawIndexed(mesh.geometry.indexCount);
    });
    pass.end();
    return mat4Mul(proj, view);
  }

  private drawMeshes(pass: GPURenderPassEncoder, slot: number, captures: boolean) {
    pass.setBindGroup(0, this.frameGroup, [slot * FRAME_SLOT]);
    this.drawList.forEach((mesh, i) => {
      if (captures && !mesh.inCaptures) return;
      const { vertex, index } = mesh.geometry.buffers(this.device);
      pass.setBindGroup(1, this.objectGroup, [i * OBJECT_SLOT]);
      pass.setBindGroup(2, this.materialGroup(mesh.material));
      pass.setVertexBuffer(0, vertex);
      pass.setIndexBuffer(index, 'uint32');
      pass.drawIndexed(mesh.geometry.indexCount);
    });
  }

  /**
   * Records the shadow map and the G-buffer of `scene` seen by `camera` into `targets`.
   * `prevViewProj` (last frame's projection x view) drives the motion vectors; each mesh's own
   * previous transform is tracked here (`commitHistory`).
   */
  render(encoder: GPUCommandEncoder, scene: ReflectionScene, view: ArrayLike<number>, projection: ArrayLike<number>, eye: Vec3, targets: GBufferTargets, prevViewProj?: ArrayLike<number>) {
    this.prepare(scene);
    const shadowVP = this.renderShadow(encoder, scene);
    this.writeFrame(SLOT_MAIN, scene, view, projection, eye, prevViewProj, shadowVP);
    const att = (t: GPUTexture): GPURenderPassColorAttachment => ({ view: t.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' });
    const pass = encoder.beginRenderPass({
      label: 'reflections gbuffer',
      colorAttachments: [att(targets.color.gpu), att(targets.normal.gpu), att(targets.material.gpu), att(targets.motion.gpu)],
      depthStencilAttachment: { view: targets.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(this.gbufferPipe);
    this.drawMeshes(pass, SLOT_MAIN, false);
    pass.setPipeline(this.skyGBufferPipe);
    pass.setBindGroup(0, this.frameGroup, [SLOT_MAIN * FRAME_SLOT]);
    pass.draw(3);
    pass.end();
  }

  /** Stores this frame's model matrices as next frame's previous ones (call after `render`). */
  commitHistory(scene: ReflectionScene) {
    for (const mesh of scene.meshes) {
      mesh.prevModel ??= new Float32Array(16);
      mesh.prevModel.set(mesh.modelMatrix());
    }
  }

  /** Forget the meshes' previous transforms (camera cut / teleport). */
  resetHistory(scene: ReflectionScene) { for (const mesh of scene.meshes) mesh.prevModel = null; }

  /**
   * Records a colour-only cube capture of `scene` from `position` into `cube` (rgba16float, 6 array
   * layers, WebGPU's face order and orientation: what core's ProbeSet.capture takes, no mirroring).
   * `skyOnly` draws just the sky (the environment slot). Shadows come from this frame's shadow map.
   */
  capture(encoder: GPUCommandEncoder, scene: ReflectionScene, position: Vec3, cube: GPUTexture, depth: GPUTexture, options: { skyOnly?: boolean; near?: number; far?: number } = {}) {
    this.prepare(scene);
    const shadowVP = options.skyOnly ? undefined : this.renderShadow(encoder, scene);
    const proj = mat4Perspective(Math.PI / 2, 1, options.near ?? 0.05, options.far ?? 100);
    CUBE_FACE_BASES.forEach((face, f) => {
      const back: Vec3 = [-face.forward[0], -face.forward[1], -face.forward[2]];
      this.writeFrame(SLOT_FACE0 + f, scene, mat4FromBasis(position, face.right, face.up, back), proj, position, undefined, shadowVP);
      const pass = encoder.beginRenderPass({
        label: `reflections capture face ${f}`,
        colorAttachments: [{ view: cube.createView({ dimension: '2d', baseArrayLayer: f, arrayLayerCount: 1, baseMipLevel: 0, mipLevelCount: 1 }), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      if (!options.skyOnly) {
        pass.setPipeline(this.colorPipe);
        this.drawMeshes(pass, SLOT_FACE0 + f, true);
      }
      pass.setPipeline(this.skyColorPipe);
      pass.setBindGroup(0, this.frameGroup, [(SLOT_FACE0 + f) * FRAME_SLOT]);
      pass.draw(3);
      pass.end();
    });
  }

  /** The camera matrices `render` takes, from a ReflectionCamera and an aspect ratio. */
  static cameraMatrices(camera: ReflectionCamera, aspect: number) {
    return { view: camera.view(), projection: camera.projection(aspect), eye: camera.position as Vec3 };
  }

  dispose() {
    this.frameBuffer.destroy();
    this.objectBuffer.destroy();
    this.shadowMap.destroy();
    this.white.destroy();
  }
}
