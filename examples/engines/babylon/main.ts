// Babylon.js: the engine page. The two rooms of engines/three (examples/shared/rooms.ts) built in Babylon on a
// WebGPUEngine: the same dimensions, colours, roughness and lights, the same three probes. `@pmndrs/reflections/babylon`
// runs core's probe set and screen-space tracer on Babylon's device, as two frame-graph tasks:
//
//   clear -> shadows (one cube map per point light) -> geometry (PBR, specular IBL stripped; depth, world normal,
//   reflectivity, linear velocity) -> FrameGraphReflectionsTask -> FrameGraphReflectionsCompositeTask -> ACES -> canvas
//
// What the Babylon adapter does not have (docs/site/guides/adapters.mdx): the ray-traced fallback, the denoiser, presets
// and the hybrid resolve. Without a denoiser, the glossy floor shows the tracer's raw samples. Babylon's materials do not
// sample the probes either, so the rooms have no bounce light (three's do, from the probes' irradiance).
//
// Babylon's world is left-handed: the rooms are built with x negated (L()), so the image is three's, not its mirror.
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import { backbufferColorTextureHandle } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import { FrameGraphImageProcessingTask } from '@babylonjs/core/FrameGraph/Tasks/PostProcesses/imageProcessingTask.js';
import { FrameGraphGeometryRendererTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask.js';
import { FrameGraphShadowGeneratorTask } from '@babylonjs/core/FrameGraph/Tasks/Rendering/shadowGeneratorTask.js';
import { FrameGraphClearTextureTask } from '@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { CreateTorusKnot } from '@babylonjs/core/Meshes/Builders/torusKnotBuilder.js';
import { Scene } from '@babylonjs/core/scene.js';
// Deep imports skip Babylon's side effects: the WebGPU extensions (render targets, MRT) and the geometry renderer load here.
import '@babylonjs/core/Engines/WebGPU/Extensions/index.js';
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent.js';
import {
  BabylonProbeSet, COMPOSITE_VIEWS, FrameGraphReflectionsCompositeTask, FrameGraphReflectionsTask, ScreenSpaceReflections, getDevice, stripSpecularIBL,
  type CompositeView,
} from '@pmndrs/reflections/babylon';
import { mountShell } from '../../shell';

mountShell('engines/babylon');

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const ssrBox = document.querySelector<HTMLInputElement>('#ssr')!;
const animateBox = document.querySelector<HTMLInputElement>('#animate')!;
const viewSelect = document.querySelector<HTMLSelectElement>('#cameraView')!;
const debugSelect = document.querySelector<HTMLSelectElement>('#debugView')!;

type V3 = [number, number, number];
/** three's coordinates (rooms.ts) to Babylon's: x negated. */
const L = (x: number, y: number, z: number) => new Vector3(-x, y, z);
const lin = (hex: number) => Color3.FromHexString(`#${hex.toString(16).padStart(6, '0')}`).toLinearSpace();
// rooms.ts's camera views
const VIEWS: Record<string, { pos: V3; target: V3 }> = {
  default: { pos: [0, 2.3, 8.5], target: [0, 2.05, 0] },
  ball: { pos: [-3.0, 1.6, 3.85], target: [-4.6, 0.3, 0.8] },
  table: { pos: [-1.3, 0.55, 2.3], target: [-4.2, 0.45, -0.2] },
  stale: { pos: [-2.9, 2.2, 3.7], target: [-4.8, 0.4, -1.5] },
  doorway: { pos: [6.6, 1.5, 1.9], target: [-4.0, 0.9, -0.4] },
  explore: { pos: [-6.2, 2.1, 3.1], target: [1.0, 1.0, -0.8] },
};

async function main() {
  // enableAllFeatures: subgroups for the tracer's faster variant. setMaximumLimits: four colour targets.
  const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false, enableAllFeatures: true, setMaximumLimits: true });
  await engine.initAsync();

  // ---- the two rooms (rooms.ts, x negated) -------------------------------------------------------------------
  const scene = new Scene(engine);
  scene.clearColor = new Color4(...lin(0x111111).asArray(), 1);
  const camera = new ArcRotateCamera('camera', 0, 1, 8, Vector3.Zero(), scene);
  camera.fov = (50 * Math.PI) / 180;
  camera.minZ = 0.05;
  camera.maxZ = 60;
  camera.wheelPrecision = 40;
  camera.attachControl(canvas, true);
  scene.activeCamera = camera;

  const pbr = (hex: number, roughness = 1, metallic = 0) => {
    const m = new PBRMaterial(`pbr ${hex.toString(16)}`, scene);
    m.albedoColor = lin(hex);
    m.roughness = roughness;
    m.metallic = metallic;
    stripSpecularIBL(m); // the composite adds the specular IBL term back from the probes and the screen
    return m;
  };
  const place = (mesh: Mesh, at: Vector3, material: PBRMaterial, receive = true) => {
    mesh.position = at;
    mesh.material = material;
    mesh.receiveShadows = receive;
    return mesh;
  };
  const box = (w: number, h: number, d: number, at: Vector3, m: PBRMaterial, receive = true) => place(CreateBox('box', { width: w, height: h, depth: d }, scene), at, m, receive);
  // shell: x -8 to 8, z -4 to 4, y 0 to 5, seen from inside
  place(CreateBox('shell', { width: 16, height: 5, depth: 8, sideOrientation: 1 /* BACKSIDE */ }, scene), L(0, 2.5, 0), pbr(0xcccccc));
  place(CreateGround('floor', { width: 16, height: 8 }, scene), L(0, 0.002, 0), pbr(0x5c5650, 0.12));
  // the end walls face into the room (Babylon's plane faces -z; rotation.y turns it)
  const redWall = place(CreatePlane('red', { width: 8, height: 5 }, scene), L(-7.99, 2.5, 0), pbr(0xdd2200), false);
  redWall.rotation.y = Math.PI / 2;
  const blueWall = place(CreatePlane('blue', { width: 8, height: 5 }, scene), L(7.99, 2.5, 0), pbr(0x0044ff), false);
  blueWall.rotation.y = -Math.PI / 2;
  // the dividing wall with its doorway
  const divider = pbr(0xcccccc), gap = 1.25;
  box(0.3, 5, 4 - gap, L(0, 2.5, -(gap + (4 - gap) / 2)), divider);
  box(0.3, 5, 4 - gap, L(0, 2.5, gap + (4 - gap) / 2), divider);
  box(0.3, 1.2, gap * 2, L(0, 4.4, 0), divider);
  // left room: columns, a table with a gold sphere, steps
  const white = pbr(0xeeeeee), wood = pbr(0x886644);
  for (const x of [-6, -2, 2, 6]) for (const z of [-2.5, 2.5]) place(CreateCylinder('column', { height: 4, diameter: 0.6, tessellation: 16 }, scene), L(x, 2, z), white);
  box(2.4, 0.12, 1.4, L(-4, 1, 0), wood);
  for (const x of [-5.05, -2.95]) for (const z of [-0.55, 0.55]) box(0.1, 1, 0.1, L(x, 0.5, z), wood, false);
  place(CreateSphere('gold', { diameter: 0.7, segments: 32 }, scene), L(-4, 1.41, 0), pbr(0xffd700, 0.4, 0.3));
  box(1.5, 0.5, 1, L(-7, 0.25, 0), white);
  box(1, 1, 1, L(-7, 0.5, 0), white);
  box(0.5, 1.5, 1, L(-7, 0.75, 0), white);
  // right room: a plinth with a turning knot (mirrored: x is negated), a five-sided cone
  box(0.8, 1.2, 0.8, L(4, 0.6, 0), white);
  const knot = place(CreateTorusKnot('knot', { radius: 0.3, tube: 0.1, radialSegments: 128, tubularSegments: 16 }, scene), L(4, 1.65, 0), pbr(0xff44aa, 0.5, 0.2));
  knot.scaling.x = -1;
  place(CreateCylinder('cone', { height: 2.5, diameterTop: 0, diameterBottom: 0.8, tessellation: 5 }, scene), L(6.5, 1.25, -1.5), white);
  // the mirror ball on its figure eight (kept out of the probe captures below)
  const ball = place(CreateSphere('mirrorBall', { diameter: 4.5 * 0.24, segments: 48 }, scene), L(0, 1.2, 0), pbr(0xffffff, 0, 1));
  const update = (t: number) => {
    knot.rotation.y = -t * 0.5; // three's turn, mirrored
    const phase = (t + 2.2) * 0.35;
    ball.position = L(5.6 * Math.sin(phase), 1.2, 1.4 * Math.sin(2 * phase));
  };
  update(0);

  // a point light in each room (three's intensity 30 cd, inverse-square falloff), each with a cube shadow map
  const lights = ([[0xffaa44, -4], [0x88bbff, 4]] as const).map(([hex, x]) => {
    const light = new PointLight(`light ${x}`, L(x, 4.5, 0), scene);
    light.diffuse = lin(hex);
    light.specular = lin(hex);
    light.intensity = 30;
    light.shadowMinZ = 0.05;
    light.shadowMaxZ = 30;
    return light;
  });
  const meshes = scene.meshes.slice();
  const casters = meshes.filter((m) => !['shell', 'floor', 'red', 'blue'].includes(m.name));

  // ---- reflections: the three probes of rooms.ts (influence boxes reaching under the floor) + the tracer ------
  const probes = new BabylonProbeSet(scene, { capacity: 3, sourceSize: 256, environment: null });
  const captured = meshes.filter((m) => m !== ball);
  probes.setProbes([
    { position: [4, 2.3, 0], influenceSize: [8.4, 5.8, 8.4], projectionSize: [8, 5, 8], projectionOffset: [0, 0.2, 0], originOffset: [0, 0.2, 0], renderList: captured },
    { position: [-4, 2.3, 0], influenceSize: [8.4, 5.8, 8.4], projectionSize: [8, 5, 8], projectionOffset: [0, 0.2, 0], originOffset: [0, 0.2, 0], renderList: captured },
    { position: [0, 1.6, 0], influenceSize: [2.4, 4.4, 2.5], projectionSize: [16, 3.8, 8], projectionOffset: [0, 0.3, 0], originOffset: [0, 0.3, 0], renderList: captured },
  ]);
  // No denoiser in this adapter: a fixed blue-noise pattern (frameIndex) keeps the glossy floor's samples from flickering.
  const ssr = new ScreenSpaceReflections({ engine, probes, settings: { frameIndex: 0 } });

  let graph: FrameGraph | null = null;
  let composite: FrameGraphReflectionsCompositeTask | null = null;
  async function build() {
    const width = engine.getRenderWidth(), height = engine.getRenderHeight();
    ssr.configure(width, height);
    scene.frameGraph = null;
    graph?.dispose();
    graph = new FrameGraph(scene);
    const size = { width, height };
    const opts = (type: number, format: number) => ({ createMipMaps: false, samples: 1, types: [type], formats: [format] });
    const color = graph.textureManager.createRenderTargetTexture('color', { size, sizeIsPercentage: false, options: opts(Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTUREFORMAT_RGBA) });
    const depth = graph.textureManager.createRenderTargetTexture('depth', { size, sizeIsPercentage: false, options: opts(Constants.TEXTURETYPE_FLOAT, Constants.TEXTUREFORMAT_DEPTH32_FLOAT) });
    const clear = new FrameGraphClearTextureTask('clear', graph);
    Object.assign(clear, { targetTexture: color, depthTexture: depth, color: scene.clearColor, clearColor: true, clearDepth: true });
    graph.addTask(clear);
    const shadows = lights.map((light, i) => {
      const task = new FrameGraphShadowGeneratorTask(`shadows ${i}`, graph!);
      Object.assign(task, { light, camera, mapSize: 256, objectList: { meshes: casters, particleSystems: [] }, filter: ShadowGenerator.FILTER_POISSONSAMPLING, bias: 0.002, normalBias: 0.02 });
      graph!.addTask(task);
      return task;
    });
    const geometry = new FrameGraphGeometryRendererTask('geometry', graph, scene);
    Object.assign(geometry, {
      shadowGenerators: shadows, targetTexture: clear.outputTexture, depthTexture: clear.outputDepthTexture, camera,
      objectList: { meshes, particleSystems: [] }, isMainObjectRenderer: true, disableImageProcessing: true, size, sizeIsPercentage: false,
    });
    geometry.textureDescriptions = [
      { type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
      { type: Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
      { type: Constants.PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    ];
    graph.addTask(geometry);
    // ---- the part to copy: the tracer and the composite as frame-graph tasks ----------------------------------
    const trace = new FrameGraphReflectionsTask('reflections', graph, ssr);
    trace.camera = camera;
    trace.colorTexture = geometry.outputTexture;
    trace.depthTexture = geometry.outputDepthTexture;
    trace.worldNormalTexture = geometry.geometryWorldNormalTexture;
    trace.reflectivityTexture = geometry.geometryReflectivityTexture;
    trace.velocityTexture = geometry.geometryLinearVelocityTexture;
    graph.addTask(trace);
    const debugView = composite?.debugView ?? Math.max(0, COMPOSITE_VIEWS.indexOf((new URLSearchParams(location.search).get('debug') ?? 'final') as CompositeView)); // ?debug=<view>
    composite = new FrameGraphReflectionsCompositeTask('composite', graph, scene);
    composite.debugView = debugView;
    composite.camera = camera;
    composite.sourceTexture = geometry.outputTexture;
    composite.depthTexture = geometry.outputDepthTexture;
    composite.worldNormalTexture = geometry.geometryWorldNormalTexture;
    composite.reflectivityTexture = geometry.geometryReflectivityTexture;
    composite.velocityTexture = geometry.geometryLinearVelocityTexture;
    composite.radianceTexture = trace.radianceTexture;
    composite.confidenceTexture = trace.confidenceTexture;
    composite.hitDistanceTexture = trace.hitDistanceTexture;
    graph.addTask(composite);
    // -----------------------------------------------------------------------------------------------------------
    const present = new FrameGraphImageProcessingTask('present', graph);
    present.sourceTexture = composite.outputTexture;
    present.targetTexture = backbufferColorTextureHandle;
    const ip = present.postProcess;
    ip.fromLinearSpace = true;
    ip.imageProcessingConfiguration.toneMappingEnabled = true;
    ip.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.imageProcessingConfiguration.exposure = 1 / 0.6; // three's ACESFilmicToneMapping scales by 1 / 0.6 before the same fit
    graph.addTask(present);
    await graph.buildAsync();
    scene.frameGraph = graph;
  }

  status.textContent = 'baking the probes...';
  await scene.whenReadyAsync();
  await probes.bake();
  await build();

  // ---- controls and loop --------------------------------------------------------------------------------------
  const setSSR = (on: boolean) => { ssr.enabled = on; ssrBox.checked = on; };
  ssrBox.onchange = () => setSSR(ssrBox.checked);
  for (const name of Object.keys(VIEWS)) viewSelect.append(new Option(name, name));
  const setView = (name: string) => {
    const v = VIEWS[name] ?? VIEWS.default;
    camera.setTarget(L(...v.target));
    camera.setPosition(L(...v.pos));
    viewSelect.value = name;
    ssr.frame.resetHistory();
  };
  viewSelect.onchange = () => setView(viewSelect.value);
  setView('default');
  for (const v of COMPOSITE_VIEWS) debugSelect.append(new Option(v, v));
  debugSelect.value = COMPOSITE_VIEWS[composite!.debugView];
  debugSelect.onchange = () => composite!.setView(debugSelect.value as CompositeView);

  let time = 0;
  const setTime = (t: number) => { time = t; update(t); };
  let looping = true;
  // Outside runRenderLoop a frame is bracketed by hand, so endFrame() submits while this task owns the canvas texture.
  const frame = () => { if (looping) scene.render(); else { engine.beginFrame(); scene.render(); engine.endFrame(); } };
  let resizing = false; // no frames while the graph is rebuilt for a new size
  engine.runRenderLoop(() => {
    if (resizing) return;
    if (animateBox.checked) setTime(time + Math.min(0.05, engine.getDeltaTime() / 1000));
    frame();
  });
  addEventListener('resize', async () => {
    if (resizing) return;
    resizing = true;
    engine.resize();
    await build();
    resizing = false;
  });

  const gpuErrors: string[] = [];
  getDevice(engine).addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; gpuErrors.push(m); console.error('WebGPU validation:', m); });
  status.textContent = `Babylon.js ${WebGPUEngine.Version}: 3 probes + screen space (${ssr.variant} tracer); no ray tracing, no denoiser in this adapter; drag to orbit`;

  // headless driver (scripts/run-headless.mjs, sections `catalog` and `engines`)
  (window as unknown as { __p: unknown }).__p = {
    stop() { looping = false; engine.stopRenderLoop(); },
    /** Render n frames, then the PNG data URL of the canvas. */
    async shot(n = 1) { for (let i = 0; i < n - 1; i++) frame(); frame(); const url = canvas.toDataURL('image/png'); await getDevice(engine).queue.onSubmittedWorkDone(); return url; },
    /** The baseline of `brief.compare`: true turns screen space off (probes only). */
    setCompare(on: boolean) { setSSR(!on); },
    setView,
    setTime,
    info: () => ({ variant: ssr.variant, ssr: ssr.enabled, gpuErrors: gpuErrors.length }),
  };
}

main().catch((e) => { status.textContent = String(e?.stack ?? e); console.error(e); });
