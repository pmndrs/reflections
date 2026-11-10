// What the adapter knows about pixi-3d (`@pixi/3d`, closed beta), without importing it: the beta is
// not on npm and must never be bundled, so the published adapter (and the root typecheck) only ever
// see the structural shapes below. A pixi-3d app passes its own objects in; they satisfy these
// shapes as they are.
//
// pixi-3d provides, as public API (0.1.0-beta.2 with the temporal branch):
//   scene colour  render the View3D into an rgba16float RenderTexture, `toneMapping: 'custom'` (linear HDR)
//   depth         DepthOutputPass: view-sized depth24plus-stencil8, standard Z (0 near)
//   motion        MotionVectorPass: view-sized rg16float, currentNdc - previousNdc (y up), unjittered
//   camera        Camera3D: view, unjitteredProjection (GL clip z), near, far
// and not (the gaps, docs/research/pixi3d-needs.md):
//   normals, roughness, metalness, albedo   no G-buffer output; custom passes can't read the material
//                                            struct. REFLECTIONS_GBUFFER below redraws the opaque meshes
//                                            once with a shader that reads the two material texels it
//                                            needs from the store (D2101).
//   lit without the environment's specular  REFLECTIONS_SCENE_COLOR_BIT, a Material3D `extraBits`
//                                            entry, takes iblBit's specular term back out (D2102).

/** A column-major 4x4 matrix as pixi-3d's `Matrix4` holds it. */
export interface Matrix4Like {
  readonly elements: ArrayLike<number>;
}

/** The parts of a pixi-3d `Camera3D` the frame contract needs (read after the view rendered). */
export interface Pixi3DCameraLike {
  /** World to camera. */
  readonly view: Matrix4Like;
  /** Camera to clip without jitter, GL clip z ([-1, 1]); the adapter remaps it to WebGPU's [0, 1]. */
  readonly unjitteredProjection: Matrix4Like;
  /** Camera to clip as rasterised (jitter included). */
  readonly projection: Matrix4Like;
  readonly near: number;
  readonly far: number;
  /** Sub-pixel jitter in target pixels (x right, y down). */
  readonly jitter?: { readonly x: number; readonly y: number };
}

/**
 * A pixi-3d `ShaderBit` as plain data (the subset these bits use). pixi-3d's own type is
 * stricter (vertex formats, slot names), so a pixi-3d app casts it once: `bit as unknown as ShaderBit`.
 */
export interface Pixi3DShaderBitLike {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly interStage?: Readonly<Record<string, string>>;
  readonly gpu?: {
    readonly header?: string;
    readonly vertex?: Readonly<Record<string, string>>;
    readonly fragment?: Readonly<Record<string, string>>;
  };
}

/** A pixi-3d `ShaderBitTemplate` as plain data. */
export interface Pixi3DShaderTemplateLike {
  readonly bindGroups: readonly string[];
  readonly gpu: string;
}

/**
 * Material3D `extraBits` entry: removes the view environment's specular reflection from the lit
 * colour, so a View3D rendered with it is the frame contract's `sceneColor` with
 * `sceneColorSpecular: 'direct'` (punctual lights keep their specular; the reflections pass adds the
 * environment's back, traced or from the probes). It recomputes iblBit's single-scatter term
 * (Karis split-sum: `k_S * lut.x + f90 * lut.y` times the prefiltered radiance, times occlusion) from
 * the same locals and subtracts it in the lighting bit's post-lighting slot. The multiple-scattering
 * compensation (`FmsEms`, lit by the irradiance) stays: it is energy the single-scatter lobe loses,
 * not a reflection of the scene.
 *
 * Needs a view with an `environment` (that is what adds iblBit and its BRDF table). WebGPU only.
 */
// Plain objects, not frozen: pixi-3d tags bits and templates it compiles (cache ids).
export const REFLECTIONS_SCENE_COLOR_BIT: Pixi3DShaderBitLike = {
  name: 'pmndrsReflectionsSceneColor',
  gpu: {
    fragment: {
      lobePostLighting: /* wgsl */ `
  {
    let reflNdotV = max(dot(normal, viewDir), 0.0);
    let reflLut = textureSampleLevel(uBrdfLutTexture, uBrdfLutSampler, vec2<f32>(reflNdotV, roughness), 0.0).rg;
    let reflFr = max(vec3<f32>(1.0 - roughness), fresnelF0) - fresnelF0;
    let reflKs = fresnelF0 + reflFr * exp2((-5.55473 * reflNdotV - 6.98316) * reflNdotV);
    let reflFssEss = reflKs * reflLut.x + f90 * reflLut.y;
    let reflRadiance = sampleEnvironment(reflect(-viewDir, specularNormal), roughness);
    finalColor = max(finalColor - reflFssEss * reflRadiance * occlusion, vec3<f32>(0.0));
  }
`,
    },
  },
};

/** The pass name materials opt into (`material.enablePass(REFLECTIONS_GBUFFER_PASS)`). */
export const REFLECTIONS_GBUFFER_PASS = 'pmndrsReflectionsGBuffer';

/**
 * The packed G-buffer one geometry pass writes (rgba32float, exact integers in the float lanes):
 *   x, y  octahedral world normal (front-facing)
 *   z     round(roughness * 1023) + round(metallic * 255) * 1024
 *   w     round(r * 255) + round(g * 255) * 256 + round(b * 255) * 65536 (linear base colour)
 * Read with `Pixi3DFrame` (./frame.ts), which unpacks it into the contract's textures.
 */
export const REFLECTIONS_GBUFFER_FORMAT = 'rgba32float' as const;

// pixi-3d's material store (0.1.0-beta.2): a texture_2d<u32> of 4096-texel rows, 16 texels per
// material. Material3D's struct is packed by alignment then declaration order, and pbrMaterialBit
// comes first, so texel 0 is `baseColor` (linear rgba) and texel 1 is `pbrParams` (metallic,
// roughness, occlusion, ior) whatever features the material has. Material textures (base colour,
// metallic-roughness, normal maps) are out of reach of a pass shader, so the G-buffer has the
// material's constants (D2101).
const MATERIAL_TEXELS = 16;
const STORE_WIDTH_SHIFT = 12;

const GBUFFER_BIT: Pixi3DShaderBitLike = {
  name: 'pmndrsReflectionsGBuffer',
  attributes: { aNormal: 'float32x3' },
  interStage: { vReflNormal: 'vec3<f32>', vReflMaterial: 'u32' },
  gpu: {
    header: /* wgsl */ `
fn reflMaterialTexel(index: i32) -> vec4<f32> {
  return bitcast<vec4<f32>>(textureLoad(uMaterialStorage, vec2<i32>(index & ${(1 << STORE_WIDTH_SHIFT) - 1}, index >> ${STORE_WIDTH_SHIFT}), 0));
}
fn reflOctEncode(n: vec3<f32>) -> vec2<f32> {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  let s = select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0));
  return select(p, (1.0 - abs(p.yx)) * s, n.z < 0.0);
}
`,
    vertex: { input: 'normal = input.aNormal;' },
  },
};

// Shaped like pixi-3d's own motion-vector template (the mesh's position, morph and skinning bits
// fill {{vertexInput}}), rasterised with the scene's view-projection so its pixels line up.
const GBUFFER_TEMPLATE: Pixi3DShaderTemplateLike = {
  bindGroups: ['global', 'camera'],
  gpu: /* wgsl */ `
{{header}}
{{vertexHeader}}

@vertex
fn mainVertex(
  input: VertexInput,
  @builtin(instance_index) ii: u32,
  @builtin(vertex_index) vid: u32
) -> VertexOutput {
  var output: VertexOutput;

  var position: vec4<f32>;
  var normal = vec3<f32>(0.0, 0.0, 1.0);
  var tangent = vec3<f32>(0.0);

  let id = uRenderableInstanceStorage[ii].id;
  let renderable = uRenderableStorage[id];
  let batchWorldMatrix = uRenderableStorage[0].transform;
  var modelMatrix = batchWorldMatrix * renderable.transform;

  {{vertexInput}}

  let worldPosition = modelMatrix * position;
  let modelMatrix3 = mat3x3<f32>(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz);
  let normalScale = 1.0 / vec3<f32>(
    dot(modelMatrix3[0], modelMatrix3[0]),
    dot(modelMatrix3[1], modelMatrix3[1]),
    dot(modelMatrix3[2], modelMatrix3[2])
  );

  output.position = camera.uViewProjectionMatrix * worldPosition;
  output.vReflNormal = modelMatrix3 * (normal * normalScale);
  output.vReflMaterial = renderable.materialIndex;

  {{vertexEnd}}

  return output;
}

@fragment
fn mainFragment(input: FragmentInput) -> @location(0) vec4<f32> {
  var n = normalize(input.vReflNormal);
  if (!input.frontFacing) { n = -n; }
  let base = i32(input.vReflMaterial) * ${MATERIAL_TEXELS};
  let baseColor = clamp(reflMaterialTexel(base).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let pbr = clamp(reflMaterialTexel(base + 1), vec4<f32>(0.0), vec4<f32>(1.0));
  let albedo = round(baseColor * 255.0);
  return vec4<f32>(
    reflOctEncode(n),
    round(pbr.y * 1023.0) + round(pbr.x * 255.0) * 1024.0,
    albedo.r + albedo.g * 256.0 + albedo.b * 65536.0,
  );
}
`,
};

/**
 * The G-buffer pass's shader, as pixi-3d `ShaderDescriptorOptions` data: give it to a
 * `ForwardRenderPass` (`descriptor: { shaderDescriptor: REFLECTIONS_GBUFFER_SHADER }`) drawing the
 * `REFLECTIONS_GBUFFER_PASS` membership into an rgba32float target. examples/pixi3d/shared has the
 * Pass3D that does it (it needs the beta's classes, so it can't live in the published adapter).
 */
export const REFLECTIONS_GBUFFER_SHADER: { readonly bitsGpu: readonly Pixi3DShaderBitLike[]; readonly template: Pixi3DShaderTemplateLike } =
  { bitsGpu: [GBUFFER_BIT], template: GBUFFER_TEMPLATE };
