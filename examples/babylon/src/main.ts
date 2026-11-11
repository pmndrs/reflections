// The mirrorWall scene (examples/shared/scenes.ts) rebuilt in Babylon.js on a WebGPUEngine, with
// @pmndrs/reflections/babylon: core's screen-space tracer and probe set on Babylon's device.
//
//   clear -> geometry (PBR, specular IBL stripped; depth, world normal, reflectivity, linear velocity)
//         -> sky (the skybox, after the G-buffer so it writes no geometry)
//         -> FrameGraphReflectionsTask (core SSR, fallback = core ProbeSet: 1 probe + environment slot)
//         -> FrameGraphReflectionsCompositeTask (lit + split-sum weight x radiance; debug views)
//         -> image processing (ACES) -> backbuffer
//
// Babylon's world is left-handed. The scene uses three's coordinates with x negated, so the image
// matches the three page (examples/ssr/?scene=mirrorWall) instead of its mirror image.
//
// ?scene=ibl: metal / rough / dielectric spheres and a ground with ambient-occlusion and normal maps
// (plus clear coat, sheen and bent-normal spheres) under a flat sky (?sky=gradient for the gradient),
// to compare the composite against Babylon's own specular IBL (`__p.iblCompare()`, D1804).
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { backbufferColorTextureHandle } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import { FrameGraphImageProcessingTask } from '@babylonjs/core/FrameGraph/Tasks/PostProcesses/imageProcessingTask.js';
import { FrameGraphGeometryRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js';
import { FrameGraphObjectRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask.js';
import { FrameGraphShadowGeneratorTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/shadowGeneratorTask.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import { FrameGraphClearTextureTask } from '@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture.js';
import { HDRFiltering } from '@babylonjs/core/Materials/Textures/Filtering/hdrFiltering.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { ToHalfFloat } from '@babylonjs/core/Misc/textureTools.js';
import { CubeMapToSphericalPolynomialTools } from '@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { Scene } from '@babylonjs/core/scene.js';
// Deep imports skip Babylon's side-effect registrations: the WebGPU engine extensions (render
// targets, multi-render targets for the geometry renderer) load here.
import '@babylonjs/core/Engines/WebGPU/Extensions/index.js';
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent.js';
import {
  BabylonCubeCapture, BabylonProbeSet, COMPOSITE_VIEWS, FrameGraphReflectionsCompositeTask, FrameGraphReflectionsTask, ScreenSpaceReflections,
  getDevice, getGPUTexture, stripSpecularIBL, type CompositeView,
} from '@pmndrs/reflections/babylon';

const q = new URLSearchParams(location.search);
const manual = q.has('manual');
const sceneName = q.get('scene') === 'ibl' ? 'ibl' : 'mirrorWall';
const flatSky = (q.get('sky') ?? (sceneName === 'ibl' ? 'flat' : 'gradient')) === 'flat';
const status = document.getElementById('status')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const controls = document.getElementById('controls')!;
const log = (s: string) => { status.textContent = s; };

if (!navigator.gpu) { log('WebGPU is not available in this browser.'); throw new Error('WebGPU unavailable'); }

// enableAllFeatures: 'subgroups' for the tracer's subgroup variant; setMaximumLimits: 4 colour targets.
const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false, enableAllFeatures: true, setMaximumLimits: true });
await engine.initAsync();
const device = getDevice(engine);
const gpuErrors: string[] = [];
device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('WebGPU validation:', m); });

// ---- scene (three's mirrorWall, x negated) -----------------------------------------------------
const scene = new Scene(engine);
scene.clearColor = new Color4(0.004, 0.005, 0.006, 1); // three's 0x0d0f12, linear
const L = (x: number, y: number, z: number) => new Vector3(-x, y, z);
const lin = (hex: number) => Color3.FromHexString(`#${hex.toString(16).padStart(6, '0')}`).toLinearSpace();

const camera = new FreeCamera('camera', sceneName === 'ibl' ? L(0, 2.2, 5.2) : L(0, 1.5, 5.5), scene);
camera.setTarget(sceneName === 'ibl' ? L(0, 0.4, -0.6) : L(0, 1.0, -3));
camera.fov = (50 * Math.PI) / 180;
camera.minZ = 0.05;
camera.maxZ = 100;
scene.activeCamera = camera;
if (!manual) camera.attachControl(canvas, true);

/** examples/shared/kit.ts gradientEnvironment, as a float cube in WebGPU's face convention. */
function gradientSky(dir: Vector3): [number, number, number] {
  if (flatSky) return [0.62, 0.6, 0.56]; // constant: any prefilter of it is itself, so the radiance matches Babylon's exactly
  const up = dir.y;
  if (up > 0) { const k = Math.min(1, up * 1.6); return [0.46 + 0.22 * k, 0.44 + 0.21 * k, 0.41 + 0.19 * k]; }
  const k = Math.min(1, -up * 2.5);
  return [0.46 - 0.30 * k, 0.44 - 0.29 * k, 0.41 - 0.28 * k];
}
function cubeFaceDir(face: number, u: number, v: number): Vector3 {
  // u, v in [-1, 1], v down the face (texel row 0 at the top)
  switch (face) {
    case 0: return new Vector3(1, -v, -u);
    case 1: return new Vector3(-1, -v, u);
    case 2: return new Vector3(u, 1, v);
    case 3: return new Vector3(u, -1, -v);
    case 4: return new Vector3(u, -v, 1);
    default: return new Vector3(-u, -v, -1);
  }
}
function skyCube(mipmaps = false, size = 64): RawCubeTexture {
  const faces: Uint16Array[] = [];
  for (let f = 0; f < 6; f++) {
    const data = new Uint16Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = cubeFaceDir(f, ((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1).normalize();
      const c = gradientSky(d);
      data.set([ToHalfFloat(c[0]), ToHalfFloat(c[1]), ToHalfFloat(c[2]), ToHalfFloat(1)], (y * size + x) * 4);
    }
    faces.push(data);
  }
  const cube = new RawCubeTexture(scene, faces, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_HALF_FLOAT, mipmaps, false, mipmaps ? Texture.TRILINEAR_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE);
  // Linear radiance. Babylon's default (gammaSpace true) decodes it with pow 2.2 in PBR's IBL and the
  // skybox material alike, but the skybox applies its level before the decode ((0.3 c)^2.2 vs
  // 0.3 c^2.2), so the sky (and the environment slot captured from it) was ~4x darker than the
  // environment PBR lit with.
  cube.gammaSpace = false;
  return cube;
}
const environment = skyCube(true);
// GGX-prefiltered into its mips, as Babylon's PBR expects of an environment (it samples the radiance
// at a roughness LOD). Babylon's own specular IBL reads it only with the strip plugin off
// (`iblCompare`); the reflections take the environment slot captured from the sky instead.
await new HDRFiltering(engine, { quality: Constants.TEXTURE_FILTERING_QUALITY_OFFLINE }).prefilter(environment);
// Its spherical harmonics (PBR's environment irradiance). Deep imports skip the side effect that
// computes them on demand, so without this the irradiance was 0: no IBL diffuse, and Babylon's own
// specular IBL, which mixes the radiance toward the irradiance by alphaG (MIX_IBL_RADIANCE_WITH_IRRADIANCE),
// went dark on rough materials.
environment.sphericalPolynomial = await CubeMapToSphericalPolynomialTools.ConvertCubeMapTextureToSphericalPolynomial(environment);
scene.environmentTexture = environment;
scene.environmentIntensity = 0.3;

const skybox = CreateBox('skybox', { size: 90 }, scene);
skybox.infiniteDistance = true;
const skyMat = new StandardMaterial('sky', scene);
const skyTex = skyCube();
skyTex.coordinatesMode = Texture.SKYBOX_MODE;
// The sky is drawn at the environment's intensity, so the visible sky, the environment slot the
// probes capture from it, and the PBR irradiance all agree; the tracer's iblFactor stays 1 (local
// probe captures are real radiance and are not scaled). StandardMaterial works in gamma space: it
// encodes a linear texture with pow 1 / 2.2, applies the level, and decodes its output with pow 2.2,
// so the level that draws the sky at `intensity x radiance` is intensity^(1 / 2.2).
skyTex.level = Math.pow(scene.environmentIntensity, 1 / 2.2);
skyMat.reflectionTexture = skyTex;
skyMat.backFaceCulling = false;
skyMat.disableLighting = true;
skyMat.diffuseColor = Color3.Black();
skyMat.specularColor = Color3.Black();
skyMat.disableDepthWrite = true;
skybox.material = skyMat;

const pbr = (name: string, hex: number, roughness: number, metallic = 0) => {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = lin(hex);
  m.roughness = roughness;
  m.metallic = metallic;
  stripSpecularIBL(m); // the composite adds the specular IBL term back from SSR / probes / environment
  return m;
};

function buildMirrorWall() {
  const floor = CreateGround('floor', { width: 16, height: 16 }, scene);
  floor.material = pbr('mirror', 0xeeeeee, 0, 1);

  function patternTexture(): DynamicTexture {
    const [cx, cy] = [10, 4], [w, h] = [1024, 410];
    const tex = new DynamicTexture('pattern', { width: w, height: h }, scene, true);
    const g = tex.getContext() as CanvasRenderingContext2D;
    const bands = ['#e63946', '#f4a261', '#2a9d8f', '#457b9d', '#8d5fd3'];
    const cw = w / cx, ch = h / cy;
    for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) { g.fillStyle = (x + y) % 2 ? '#d8d8d8' : '#9a9a9a'; g.fillRect(x * cw, y * ch, cw, ch); }
    for (let y = 0; y < cy; y += 2) { g.fillStyle = bands[(y / 2) % bands.length]; g.fillRect(0, y * ch + ch * 0.4, w, ch * 0.2); }
    g.fillStyle = '#202020';
    g.font = `bold ${Math.floor(ch * 0.32)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) g.fillText(String.fromCharCode(65 + y) + (x + 1), (x + 0.5) * cw, (y + 0.22) * ch);
    tex.update(true);
    tex.anisotropicFilteringLevel = 8;
    return tex;
  }
  const wall = CreatePlane('wall', { width: 10, height: 4 }, scene);
  wall.position = L(0, 2, -3);
  wall.rotation.y = Math.PI; // Babylon's plane faces -Z; the camera is at +Z
  const wallMat = pbr('wall', 0xffffff, 0.75);
  wallMat.albedoTexture = patternTexture();
  wall.material = wallMat;

  const post = (name: string, hex: number, x: number) => {
    const m = CreateBox(name, { width: 0.4, height: 3, depth: 0.4 }, scene);
    m.position = L(x, 1.5, -2.4);
    m.material = pbr(name, hex, 0.5);
  };
  post('postRed', 0xd1495b, -4.2);
  post('postTeal', 0x00798c, 4.2);
  const sphere = CreateSphere('sphere', { diameter: 0.9, segments: 48 }, scene);
  sphere.position = L(-1.6, 0.45, -1.2);
  sphere.material = pbr('sphere', 0xedae49, 0.35);
  const box = CreateBox('box', { size: 0.8 }, scene);
  box.position = L(1.5, 0.4, -1.5);
  box.rotation.y = -0.5;
  box.material = pbr('box', 0x66a182, 0.6);
  const strip = CreateBox('strip', { width: 9, height: 0.08, depth: 0.05 }, scene);
  strip.position = L(0, 3.85, -2.95);
  const stripMat = pbr('strip', 0x000000, 1);
  stripMat.emissiveColor = lin(0xfff0d8);
  stripMat.emissiveIntensity = 4;
  strip.material = stripMat;
}

/** Grey-scale ambient-occlusion map: dark grooves on a tile grid, softer towards the tile centres. */
function aoTexture(): DynamicTexture {
  const n = 256, tiles = 4;
  const tex = new DynamicTexture('ao', { width: n, height: n }, scene, true);
  const g = tex.getContext() as CanvasRenderingContext2D;
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = ((x + 0.5) / n) * tiles, v = ((y + 0.5) / n) * tiles;
    const du = Math.min(u - Math.floor(u), Math.ceil(u) - u), dv = Math.min(v - Math.floor(v), Math.ceil(v) - v);
    const edge = Math.min(du, dv); // 0 at the grooves, 0.5 at the tile centre
    const ao = 0.12 + 0.88 * Math.min(1, Math.pow(edge / 0.22, 0.8));
    const b = Math.round(ao * 255), k = (y * n + x) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = b; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  tex.update(false);
  return tex;
}
/** Tangent-space normal map of rounded tiles (the AO map's grid), for horizon occlusion (needs BUMP). */
function normalTexture(): DynamicTexture {
  const n = 256, tiles = 4;
  const tex = new DynamicTexture('normals', { width: n, height: n }, scene, true);
  const g = tex.getContext() as CanvasRenderingContext2D;
  const img = g.createImageData(n, n);
  const h = (u: number, v: number) => { const fu = u - Math.floor(u), fv = v - Math.floor(v); return Math.sin(Math.PI * fu) * Math.sin(Math.PI * fv); };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = ((x + 0.5) / n) * tiles, v = ((y + 0.5) / n) * tiles, e = 1 / n;
    const dx = (h(u + e * tiles, v) - h(u - e * tiles, v)) / (2 * e), dy = (h(u, v + e * tiles) - h(u, v - e * tiles)) / (2 * e);
    const s = 0.08; // slope scale
    let nx = -dx * s, ny = -dy * s, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const k = (y * n + x) * 4;
    img.data[k] = Math.round((nx * 0.5 + 0.5) * 255); img.data[k + 1] = Math.round((ny * 0.5 + 0.5) * 255); img.data[k + 2] = Math.round((nz * 0.5 + 0.5) * 255); img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  tex.update(false);
  return tex;
}
/** A flat bent-normal map (the bent normal is the surface normal): bent-normal occlusion from the AO alone. */
function flatNormalTexture(): DynamicTexture {
  const tex = new DynamicTexture('bentNormals', { width: 4, height: 4 }, scene, false);
  const g = tex.getContext() as CanvasRenderingContext2D;
  g.fillStyle = 'rgb(128,128,255)';
  g.fillRect(0, 0, 4, 4);
  tex.update(false);
  return tex;
}

/** Metal / rough / dielectric materials with AO and normal maps, clear coat, sheen, bent normals. */
function buildIBL() {
  const ao = aoTexture(), normals = normalTexture();
  const ground = CreateGround('ground', { width: 10, height: 10 }, scene);
  const groundMat = pbr('ground', 0x9a9a9a, 0.55, 0);
  groundMat.ambientTexture = ao;
  groundMat.bumpTexture = normals;
  ground.material = groundMat;
  // [name, colour, roughness, metallic, AO, bump, extra]
  const spheres: [string, number, number, number, boolean, boolean, string?][] = [
    ['gold', 0xffc356, 0.25, 1, true, false],
    ['silver', 0xe8e8e8, 0.6, 1, true, true],
    ['copper', 0xf0a070, 0.9, 1, false, false],
    ['red', 0xc0303a, 0.4, 0, true, true],
    ['coat', 0x3050c0, 0.5, 0, true, false, 'clearcoat'],
    ['sheen', 0x606060, 0.7, 0, true, false, 'sheen'],
    ['bent', 0xd0d0d0, 0.35, 1, true, false, 'bent'],
  ];
  spheres.forEach(([name, hex, roughness, metallic, useAO, bump, extra], i) => {
    const m = CreateSphere(name, { diameter: 0.85, segments: 48 }, scene);
    m.position = L(-3 + i, 0.425, i % 2 ? -1.6 : -0.6);
    const mat = pbr(name, hex, roughness, metallic);
    if (useAO) mat.ambientTexture = ao;
    if (bump) mat.bumpTexture = normals;
    if (extra === 'clearcoat') { mat.clearCoat.isEnabled = true; mat.clearCoat.roughness = 0.1; }
    if (extra === 'sheen') { mat.sheen.isEnabled = true; mat.sheen.color = new Color3(1, 1, 1); mat.sheen.intensity = 0.8; mat.sheen.albedoScaling = true; }
    if (extra === 'bent') mat.bentNormalTexture = flatNormalTexture();
    m.material = mat;
  });
  const box = CreateBox('metalBox', { size: 0.8 }, scene);
  box.position = L(2.4, 0.4, 0.6);
  box.rotation.y = 0.6;
  const boxMat = pbr('metalBox', 0xc8c8d0, 0.3, 1);
  boxMat.ambientTexture = ao;
  boxMat.bumpTexture = normals;
  box.material = boxMat;
}

if (sceneName === 'ibl') buildIBL(); else buildMirrorWall();

const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
hemi.diffuse = lin(0xdde6ff);
hemi.groundColor = lin(0x302820);
hemi.specular = Color3.Black();
hemi.intensity = 0.5;
const sun = new DirectionalLight('sun', L(-3, -6, -6).normalize(), scene);
sun.diffuse = lin(0xfff2e0);
sun.intensity = 2.2;
sun.position = L(3, 6, 6); // the shadow map's origin (three's key light position)
sun.shadowMinZ = 0.5;
sun.shadowMaxZ = 40;

const sceneMeshes: AbstractMesh[] = scene.meshes.filter((m) => m !== skybox);
for (const m of sceneMeshes) m.receiveShadows = true;

// ---- reflections -------------------------------------------------------------------------------
const probes = new BabylonProbeSet(scene, { capacity: 1, sourceSize: 128, environment: [skybox] });
probes.setProbes([{ position: [0, 2, 0], influenceSize: [16, 4.2, 16], projectionSize: [16, 4.2, 12] }]);
const variant = (q.get('variant') as 'workgroup' | 'subgroups' | null) ?? 'auto';
const ssr = new ScreenSpaceReflections({ engine, probes, variant, timestamps: device.features.has('timestamp-query') });
ssr.enabled = q.get('ssr') !== '0';

let graph: FrameGraph | null = null;
let composite: FrameGraphReflectionsCompositeTask | null = null;

async function build() {
  const width = engine.getRenderWidth(), height = engine.getRenderHeight();
  ssr.configure(width, height);
  scene.frameGraph = null;
  graph?.dispose();
  graph = new FrameGraph(scene);
  const size = { width, height };
  const manager = graph.textureManager;
  const color = manager.createRenderTargetTexture('color', {
    size, sizeIsPercentage: false,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_HALF_FLOAT], formats: [Constants.TEXTUREFORMAT_RGBA] },
  });
  const depth = manager.createRenderTargetTexture('depth', {
    size, sizeIsPercentage: false,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_FLOAT], formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT] },
  });
  const clear = new FrameGraphClearTextureTask('clear', graph);
  clear.targetTexture = color;
  clear.depthTexture = depth;
  clear.color = scene.clearColor;
  clear.clearColor = true;
  clear.clearDepth = true;
  graph.addTask(clear);

  const shadows = new FrameGraphShadowGeneratorTask('shadows', graph);
  shadows.light = sun;
  shadows.camera = camera;
  shadows.mapSize = 2048;
  shadows.objectList = { meshes: sceneMeshes, particleSystems: [] };
  shadows.filter = ShadowGenerator.FILTER_PCF;
  shadows.bias = 0.0005;
  shadows.normalBias = 0.02;
  graph.addTask(shadows);

  const geometry = new FrameGraphGeometryRendererTask('geometry', graph, scene);
  geometry.shadowGenerators = [shadows];
  geometry.targetTexture = clear.outputTexture;
  geometry.depthTexture = clear.outputDepthTexture;
  geometry.camera = camera;
  geometry.objectList = { meshes: sceneMeshes, particleSystems: [] };
  geometry.isMainObjectRenderer = true;
  geometry.disableImageProcessing = true; // linear HDR into the tracer and the composite
  geometry.size = size;
  geometry.sizeIsPercentage = false;
  geometry.textureDescriptions = [
    { type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    { type: Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    { type: Constants.PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
  ];
  graph.addTask(geometry);

  const sky = new FrameGraphObjectRendererTask('sky', graph, scene);
  sky.targetTexture = geometry.outputTexture;
  sky.depthTexture = geometry.outputDepthTexture;
  sky.camera = camera;
  sky.objectList = { meshes: [skybox], particleSystems: [] };
  sky.disableImageProcessing = true;
  sky.depthWrite = false;
  graph.addTask(sky);

  const trace = new FrameGraphReflectionsTask('reflections', graph, ssr);
  trace.camera = camera;
  trace.colorTexture = sky.outputTexture;
  trace.depthTexture = sky.outputDepthTexture;
  trace.worldNormalTexture = geometry.geometryWorldNormalTexture;
  trace.reflectivityTexture = geometry.geometryReflectivityTexture;
  trace.velocityTexture = geometry.geometryLinearVelocityTexture;
  graph.addTask(trace);

  const debugView = composite?.debugView ?? Math.max(0, COMPOSITE_VIEWS.indexOf((q.get('view') ?? 'final') as CompositeView));
  composite = new FrameGraphReflectionsCompositeTask('composite', graph, scene);
  composite.debugView = debugView;
  composite.camera = camera;
  composite.sourceTexture = sky.outputTexture;
  composite.depthTexture = sky.outputDepthTexture;
  composite.worldNormalTexture = geometry.geometryWorldNormalTexture;
  composite.reflectivityTexture = geometry.geometryReflectivityTexture;
  composite.velocityTexture = geometry.geometryLinearVelocityTexture;
  composite.radianceTexture = trace.radianceTexture;
  composite.confidenceTexture = trace.confidenceTexture;
  composite.hitDistanceTexture = trace.hitDistanceTexture;
  graph.addTask(composite);

  const present = new FrameGraphImageProcessingTask('present', graph);
  present.sourceTexture = composite.outputTexture;
  present.targetTexture = backbufferColorTextureHandle;
  const ip = present.postProcess;
  ip.fromLinearSpace = true;
  ip.imageProcessingConfiguration.toneMappingEnabled = true;
  ip.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  graph.addTask(present);

  await graph.buildAsync();
  scene.frameGraph = graph;
}

log('baking probes...');
await scene.whenReadyAsync();
await probes.bake();
log('building the frame graph...');
await build();

// ---- loop + UI ---------------------------------------------------------------------------------
let looping = false;
let frames = 0;
// Outside runRenderLoop, a frame has to be bracketed by hand: endFrame() submits Babylon's command
// buffers while this task still owns the canvas texture.
const frame = () => { if (looping) { scene.render(); } else { engine.beginFrame(); scene.render(); engine.endFrame(); } frames++; };
const startLoop = () => { if (looping) return; looping = true; engine.runRenderLoop(() => { frame(); if (frames % 30 === 0) refreshUI(); }); };
const stopLoop = () => { looping = false; engine.stopRenderLoop(); };

const row = (label: string, el: HTMLElement) => { const l = document.createElement('label'); l.append(el, label); controls.append(l); };
const ssrBox = document.createElement('input'); ssrBox.type = 'checkbox'; ssrBox.checked = ssr.enabled;
ssrBox.onchange = () => { ssr.enabled = ssrBox.checked; refreshUI(); if (!looping) frame(); };
row('SSR', ssrBox);
const probesBox = document.createElement('input'); probesBox.type = 'checkbox'; probesBox.checked = q.get('probes') !== '0';
probes.enabled = probesBox.checked;
probesBox.onchange = () => { probes.enabled = probesBox.checked; refreshUI(); if (!looping) frame(); };
row('Probes', probesBox);
const viewSel = document.createElement('select');
for (const v of COMPOSITE_VIEWS) viewSel.append(new Option(v, v));
viewSel.value = COMPOSITE_VIEWS[composite!.debugView];
viewSel.onchange = () => { composite!.setView(viewSel.value as CompositeView); if (!looping) frame(); };
row('View', viewSel);

function refreshUI() {
  status.textContent = [
    `Babylon.js ${(engine.constructor as unknown as { Version?: string }).Version ?? WebGPUEngine.Version} WebGPUEngine | ${engine.getRenderWidth()}x${engine.getRenderHeight()} | ${manual ? 'manual (loop stopped)' : 'running'}`,
    `tracer variant ${ssr.variant} | SSR ${ssr.enabled ? 'on' : 'off (probes / environment only)'} | probes ${probes.enabled ? 'on (1 probe + environment slot)' : 'off (environment slot only)'}`,
    `view ${COMPOSITE_VIEWS[composite!.debugView]} | frames ${frames} | GPU errors ${gpuErrors.length}`,
  ].join('\n');
}
if (manual) frame(); else startLoop();
refreshUI();

// ---- headless hooks ----------------------------------------------------------------------------
const idle = () => device.queue.onSubmittedWorkDone();

function f16(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
/** Reads a 2-D r32float / rgba16float / rgba8unorm texture as floats (channels per texel: 1 or 4). */
async function readTexture(tex: GPUTexture): Promise<{ data: Float32Array; channels: number }> {
  const bpp = tex.format === 'r32float' ? 4 : tex.format === 'rgba16float' ? 8 : 4;
  const channels = tex.format === 'r32float' ? 1 : 4;
  const bytesPerRow = Math.ceil((tex.width * bpp) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [tex.width, tex.height]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = buf.getMappedRange();
  const out = new Float32Array(tex.width * tex.height * channels);
  for (let y = 0; y < tex.height; y++) {
    const row = y * bytesPerRow;
    for (let x = 0; x < tex.width; x++) {
      const i = (y * tex.width + x) * channels;
      if (tex.format === 'r32float') out[i] = new Float32Array(raw, row + x * 4, 1)[0];
      else if (tex.format === 'rgba16float') { const h = new Uint16Array(raw, row + x * 8, 4); for (let c = 0; c < 4; c++) out[i + c] = f16(h[c]); }
      else { const b = new Uint8Array(raw, row + x * 4, 4); for (let c = 0; c < 4; c++) out[i + c] = b[c] / 255; }
    }
  }
  buf.unmap();
  buf.destroy();
  return { data: out, channels };
}

/** Readback stats of the last frame: rays, finite outputs, confidence on the mirror floor (rows below the wall's reflection band included). */
async function stats() {
  frame();
  await idle();
  const core = ssr.core!;
  const counter = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(core.outputs.rayCounter, 0, counter, 0, 16);
  device.queue.submit([enc.finish()]);
  await counter.mapAsync(GPUMapMode.READ);
  const rays = new Uint32Array(counter.getMappedRange().slice(0))[1];
  counter.destroy();
  const rad = await readTexture(core.outputs.radiance);
  const conf = await readTexture(core.outputs.confidence);
  const mat = await readTexture(ssr.frame.material!);
  let nonFinite = 0, mirror = 0, mirrorConfident = 0, geometryPx = 0, confSum = 0;
  for (let i = 0; i < conf.data.length; i++) {
    for (let c = 0; c < 4; c++) if (!Number.isFinite(rad.data[i * 4 + c])) nonFinite++;
    const rough = mat.data[i * 4];
    if (rough < 0.999) { geometryPx++; confSum += conf.data[i]; }
    if (rough < 0.02) { mirror++; if (conf.data[i] >= 0.9) mirrorConfident++; }
  }
  return {
    variant: ssr.variant, rays, nonFinite, gpuErrors: gpuErrors.length,
    mirrorPixels: mirror, mirrorConfident: mirror ? mirrorConfident / mirror : 0,
    meanConfidence: geometryPx ? confSum / geometryPx : 0,
  };
}

/**
 * Do the adapter's cube captures (BabylonCubeCapture: a ReflectionProbe render, reoriented) sample as
 * world directions under a plain WebGPU `texture_cube` lookup, which is what core's ProbeSet does? A test scene puts a
 * coloured box on each axis and a white marker off-centre on each face; the capture is sampled
 * toward each axis (face colour), toward each marker (white) and toward the marker mirrored in
 * either face axis (face colour, not white).
 */
async function orientation() {
  const s = new Scene(engine);
  s.clearColor = new Color4(0, 0, 0, 1);
  const cam = new FreeCamera('ocam', Vector3.Zero(), s);
  cam.minZ = 0.1; cam.maxZ = 100;
  s.activeCamera = cam;
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
  const perp = (a: number[]) => (a[0] ? [[0, 1, 0], [0, 0, 1]] : a[1] ? [[0, 0, 1], [1, 0, 0]] : [[1, 0, 0], [0, 1, 0]]);
  const emissive = (name: string, c: number[]) => {
    const m = new StandardMaterial(name, s);
    m.disableLighting = true;
    m.emissiveColor = new Color3(c[0], c[1], c[2]);
    return m;
  };
  const dirs: number[][] = [], expect: number[][] = [];
  axes.forEach((a, i) => {
    const wallBox = CreateBox(`face${i}`, { size: 12 }, s);
    wallBox.position = new Vector3(a[0] * 12, a[1] * 12, a[2] * 12);
    wallBox.material = emissive(`face${i}`, colors[i]);
    const [u, v] = perp(a);
    const mk = CreateBox(`marker${i}`, { size: 1 }, s);
    mk.position = new Vector3(4 * a[0] + 1.5 * (u[0] + v[0]), 4 * a[1] + 1.5 * (u[1] + v[1]), 4 * a[2] + 1.5 * (u[2] + v[2]));
    mk.material = emissive(`marker${i}`, [1, 1, 1]);
    const at = (su: number, sv: number) => [4 * a[0] + 1.5 * (su * u[0] + sv * v[0]), 4 * a[1] + 1.5 * (su * u[1] + sv * v[1]), 4 * a[2] + 1.5 * (su * u[2] + sv * v[2])];
    dirs.push(a, at(1, 1), at(-1, 1), at(1, -1));
    expect.push(colors[i], [1, 1, 1], colors[i], colors[i]);
  });
  await s.whenReadyAsync();
  const capture = new BabylonCubeCapture(s, 64);
  const capEnc = device.createCommandEncoder();
  const cube = capture.capture(capEnc, [0, 0, 0], s.meshes);
  device.queue.submit([capEnc.finish()]);
  const module = device.createShaderModule({ code: /* wgsl */ `
    @group(0) @binding(0) var cube: texture_cube<f32>;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var<storage, read> dirs: array<vec4f>;
    @group(0) @binding(3) var<storage, read_write> out: array<vec4f>;
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
      out[id.x] = textureSampleLevel(cube, samp, normalize(dirs[id.x].xyz), 0.0);
    }` });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const dirBuf = device.createBuffer({ size: dirs.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(dirBuf, 0, new Float32Array(dirs.flatMap((d) => [d[0], d[1], d[2], 0])));
  const outBuf = device.createBuffer({ size: dirs.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: dirs.length * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  const p = enc.beginComputePass();
  p.setPipeline(pipe);
  p.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: cube.createView({ dimension: 'cube' }) },
    { binding: 1, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
    { binding: 2, resource: { buffer: dirBuf } }, { binding: 3, resource: { buffer: outBuf } }] }));
  p.dispatchWorkgroups(dirs.length);
  p.end();
  enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, dirs.length * 16);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const got = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)));
  readBuf.unmap();
  const rows = dirs.map((d, i) => {
    const g = got.slice(i * 4, i * 4 + 3).map((x) => Math.round(Math.min(1, x)));
    return { dir: d, expect: expect[i], got: g, ok: g.every((x, c) => x === expect[i][c]) };
  });
  capture.dispose();
  s.dispose();
  return { ok: rows.every((r) => r.ok), failed: rows.filter((r) => !r.ok).length, rows };
}

/**
 * Motion-vector convention check (conventions.ts: motionVectorScale [-1, -1] on Babylon's Y-flipped
 * targets): render a frame, move the camera, render again, and reproject this frame's scene colour
 * into the last one through the velocity texture under each candidate scale. The contract's scale
 * must give the smallest colour error, well below no reprojection at all.
 */
async function motionCheck() {
  stopLoop();
  const pos0 = camera.position.clone(), target0 = camera.getTarget().clone();
  frame();
  await idle();
  const a = await readTexture(ssr.lastFrame!.textures.sceneColor);
  camera.position.addInPlace(new Vector3(0.12, 0.05, -0.1));
  camera.setTarget(target0.add(new Vector3(0.25, 0, 0)));
  frame();
  await idle();
  const t = ssr.lastFrame!.textures;
  const b = await readTexture(t.sceneColor);
  const m = await readTexture(t.motion);
  const mat = await readTexture(ssr.frame.material!);
  const W = t.sceneColor.width, H = t.sceneColor.height;
  const scales: [number, number][] = [[-1, -1], [1, 1], [1, -1], [-1, 1], [0, 0]];
  const err = scales.map(() => 0);
  let n = 0;
  for (let y = 4; y < H - 4; y += 3) for (let x = 4; x < W - 4; x += 3) {
    const i = y * W + x;
    if (mat.data[i * 4] > 0.999) continue; // background
    const mx = m.data[i * 4], my = m.data[i * 4 + 1];
    if (Math.abs(mx) + Math.abs(my) < 1e-4) continue;
    const res = scales.map(([sx, sy]) => {
      const px = Math.floor(((x + 0.5) / W - mx * sx) * W), py = Math.floor(((y + 0.5) / H - my * sy) * H);
      if (px < 0 || py < 0 || px >= W || py >= H) return null;
      const j = py * W + px;
      let e = 0;
      for (let c = 0; c < 3; c++) e += Math.abs(Math.min(b.data[i * 4 + c], 4) - Math.min(a.data[j * 4 + c], 4));
      return e;
    });
    if (res.some((r) => r === null)) continue;
    res.forEach((r, k) => { err[k] += r!; });
    n++;
  }
  camera.position.copyFrom(pos0);
  camera.setTarget(target0);
  ssr.frame.resetHistory();
  frame();
  await idle();
  const rows = scales.map((sc, k) => ({ scale: sc.join(','), meanError: n ? err[k] / n : NaN }));
  const best = rows.reduce((p, r) => (r.meanError < p.meanError ? r : p));
  return { pixels: n, best: best.scale, rows };
}

/** The canvas as RGBA8 (what the page shows: ACES, sRGB), row 0 at the top. */
async function canvasPixels(): Promise<Uint8ClampedArray> {
  frame();
  const url = canvas.toDataURL('image/png');
  await idle();
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, img.width, img.height).data;
}

/** Renders until two frames in a row are identical (materials recompiled after a plugin toggle). */
async function settled(): Promise<Uint8ClampedArray> {
  await scene.whenReadyAsync();
  let last = await canvasPixels();
  for (let i = 0; i < 40; i++) {
    const next = await canvasPixels();
    let same = true;
    for (let k = 0; k < next.length; k += 4) if (next[k] !== last[k] || next[k + 1] !== last[k + 1] || next[k + 2] !== last[k + 2]) { same = false; break; }
    if (same) return next;
    last = next;
  }
  return last;
}

/**
 * The composite against Babylon's own specular IBL (D1804). SSR off and probes off, so core's
 * radiance is the environment slot (captured from the sky) and ours should equal Babylon's IBL:
 *   ours   = lit (strip plugin on) + weight x radiance (view 'final'), with and without the plugin's
 *            per-pixel factors (`composite.specularFactors`): after / before;
 *   theirs = Babylon's own render (plugin off on every PBR material, view 'lit').
 * Mean and p99 of the per-pixel max-channel abs difference of the shown image (8-bit), over the
 * geometry, over the pixels with a specular factor < 1 (AO, horizon / bent-normal occlusion, coat,
 * sheen) and over the energy-compensated pixels with factor 1.
 */
async function iblCompare() {
  stopLoop();
  const pbrs = scene.materials.filter((m): m is PBRMaterial => m instanceof PBRMaterial);
  const plugins = pbrs.map((m) => stripSpecularIBL(m));
  const saved = { ssr: ssr.enabled, probes: probes.enabled, view: composite!.debugView, factors: composite!.specularFactors };
  ssr.enabled = false; probes.enabled = false;
  composite!.setView('final');
  composite!.specularFactors = true;
  const after = await settled();
  // the masks, from the G-buffer of this frame (Babylon's targets are Y-flipped: row 0 = bottom)
  const t = ssr.lastFrame!.textures;
  const vel = await readTexture(t.motion);
  const mat = await readTexture(ssr.frame.material!);
  composite!.specularFactors = false;
  const before = await settled();
  for (const pl of plugins) pl.active = false;
  composite!.setView('lit');
  const babylon = await settled();
  for (const pl of plugins) pl.active = true;
  composite!.debugView = saved.view; composite!.specularFactors = saved.factors;
  ssr.enabled = saved.ssr; probes.enabled = saved.probes;
  await settled();
  const W = t.motion.width, H = t.motion.height;
  const sets = { geometry: [] as number[], occluded: [] as number[], energyOnly: [] as number[] };
  const diffs = { before: { geometry: [] as number[], occluded: [] as number[], energyOnly: [] as number[] }, after: { geometry: [] as number[], occluded: [] as number[], energyOnly: [] as number[] } };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (mat.data[i * 4] > 0.999) continue; // background
    const packed = vel.data[i * 4 + 2];
    const ms = packed > 1.5, factor = 1 - (packed - (ms ? 2 : 0));
    const k = ((H - 1 - y) * W + x) * 4; // canvas row
    const d = (img: Uint8ClampedArray) => Math.max(Math.abs(img[k] - babylon[k]), Math.abs(img[k + 1] - babylon[k + 1]), Math.abs(img[k + 2] - babylon[k + 2]));
    const groups: (keyof typeof sets)[] = ['geometry'];
    if (factor < 0.999) groups.push('occluded'); else if (ms) groups.push('energyOnly');
    for (const g of groups) { sets[g].push(i); diffs.before[g].push(d(before)); diffs.after[g].push(d(after)); }
  }
  const summary = (a: number[]) => {
    if (!a.length) return { mean: NaN, p99: NaN, max: NaN };
    const s = [...a].sort((p, r) => p - r);
    return { mean: Number((a.reduce((p, r) => p + r, 0) / a.length).toFixed(3)), p99: s[Math.min(s.length - 1, Math.floor(s.length * 0.99))], max: s[s.length - 1] };
  };
  const out: Record<string, unknown> = {};
  for (const g of Object.keys(sets) as (keyof typeof sets)[]) out[g] = { pixels: sets[g].length, before: summary(diffs.before[g]), after: summary(diffs.after[g]) };
  return out;
}

Object.assign(window, {
  __p: {
    engine, scene, ssr, probes, get composite() { return composite; }, gpuErrors, views: COMPOSITE_VIEWS,
    stop: stopLoop, start: startLoop,
    async step(n = 1) { for (let i = 0; i < n; i++) frame(); await idle(); },
    setView(v: CompositeView) { composite!.setView(v); viewSel.value = v; },
    setSSR(on: boolean) { ssr.enabled = on; ssrBox.checked = on; },
    setProbes(on: boolean) { probes.enabled = on; probesBox.checked = on; },
    async shot() { frame(); const url = canvas.toDataURL('image/png'); await idle(); return url; },
    /** Median GPU ms per core pass over `n` frames (loop stopped). */
    async time(n = 30) {
      stopLoop();
      const per: Record<string, number[]> = {};
      for (let i = 0; i < n + 3; i++) {
        frame();
        await idle();
        const t = await ssr.readTimings();
        if (i >= 3) for (const [k, v] of t) (per[k] ??= []).push(v);
      }
      const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
      return Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Number(med(v).toFixed(4))]));
    },
    stats, orientation, motionCheck, iblCompare,
  },
});
