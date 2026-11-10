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
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { backbufferColorTextureHandle } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import { FrameGraphImageProcessingTask } from '@babylonjs/core/FrameGraph/Tasks/PostProcesses/imageProcessingTask.js';
import { FrameGraphGeometryRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js';
import { FrameGraphObjectRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask.js';
import { FrameGraphClearTextureTask } from '@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
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

const camera = new FreeCamera('camera', L(0, 1.5, 5.5), scene);
camera.setTarget(L(0, 1.0, -3));
camera.fov = (50 * Math.PI) / 180;
camera.minZ = 0.05;
camera.maxZ = 100;
scene.activeCamera = camera;
if (!manual) camera.attachControl(canvas, true);

/** examples/shared/kit.ts gradientEnvironment, as a float cube in WebGPU's face convention. */
function gradientSky(dir: Vector3): [number, number, number] {
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
function skyCube(size = 64): RawCubeTexture {
  const faces: Float32Array[] = [];
  for (let f = 0; f < 6; f++) {
    const data = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = cubeFaceDir(f, ((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1).normalize();
      const c = gradientSky(d);
      data.set([c[0], c[1], c[2], 1], (y * size + x) * 4);
    }
    faces.push(data);
  }
  return new RawCubeTexture(scene, faces, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_FLOAT, false, false, Texture.BILINEAR_SAMPLINGMODE);
}
const environment = skyCube();
scene.environmentTexture = environment;
scene.environmentIntensity = 0.3;

const skybox = CreateBox('skybox', { size: 90 }, scene);
skybox.infiniteDistance = true;
const skyMat = new StandardMaterial('sky', scene);
const skyTex = skyCube();
skyTex.coordinatesMode = Texture.SKYBOX_MODE;
// The sky is drawn at the environment's intensity, so the visible sky, the environment slot the
// probes capture from it, and the PBR irradiance all agree; the tracer's iblFactor stays 1 (local
// probe captures are real radiance and are not scaled).
skyTex.level = scene.environmentIntensity;
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

const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
hemi.diffuse = lin(0xdde6ff);
hemi.groundColor = lin(0x302820);
hemi.specular = Color3.Black();
hemi.intensity = 0.5;
const sun = new DirectionalLight('sun', L(-3, -6, -6).normalize(), scene);
sun.diffuse = lin(0xfff2e0);
sun.intensity = 2.2;

const sceneMeshes: AbstractMesh[] = scene.meshes.filter((m) => m !== skybox);

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

  const geometry = new FrameGraphGeometryRendererTask('geometry', graph, scene);
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
    stats, orientation,
  },
});
