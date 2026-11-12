// Our pipeline as the showcase page runs it (main.ts), in its own canvas and renderer: probes baked
// per scene, ScreenSpaceReflectionsPass (hit colour from last frame's final image), HybridReflections
// with the FFX reflection denoiser behind the denoise seam, and the BVH ray-traced fallback for
// 'ours-rt'. Same settings as the showcase defaults; `ctx.params` only carries explicit experiment
// overrides (?spq= samples per quad, ?tsf= the denoiser's temporal stability, ?hit=current|lit|final,
// ?specOcc=1 Lagarde's specular occlusion from GTAO on the probe part, W39 / D4510).
import * as THREE from 'three/webgpu';
import { renderOutput, vec3, vec4 } from 'three/tsl';
import {
  HybridReflections, MeshBVHTraceProvider, ReflectionProbe, ReflectionProbes, ScreenSpaceReflectionsPass, installCubeArraySupport, reflectionProbes,
} from '@pmndrs/reflections/three';
import { FfxReflectionDenoiser } from '@pmndrs/denoiser-ffx';
import { ScreenSpaceAO } from '../../../shared/ao';
import { type CompareMethod, type MethodContext, type MethodId, destroyWebGPU, applySceneParams, freshEnvironment, newCanvas, sceneInfo, syncCamera } from './method';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const GLOSSY = 0.447;

export async function createOurs(id: Extract<MethodId, 'ours-raw' | 'ours-denoised' | 'ours-rt' | 'probes'>, ctx: MethodContext): Promise<CompareMethod> {
  const { width: W, height: H, params } = ctx;
  const canvas = newCanvas(W, H);
  const adapter = await navigator.gpu.requestAdapter();
  const maxBytes = Math.min(adapter?.limits.maxColorAttachmentBytesPerSample ?? 32, 64);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: { maxColorAttachmentBytesPerSample: maxBytes } } as N);
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setSize(W, H, false);
  await renderer.init();
  // cube arrays on stock r187 (W20 shim, self-tested; the 2D array if it fails), as the showcase page. ?shim=0 opts out.
  if (params.get('shim') !== '0') await installCubeArraySupport(renderer);
  renderer.toneMappingExposure = ctx.exposure;

  const ssr = new ScreenSpaceReflectionsPass(renderer, { missList: true });
  const device = ssr.device;
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; errors.push(m); console.error('[ours webgpu]', m); });
  const wantDenoise = id === 'ours-denoised' || id === 'ours-rt';
  const tsf = params.has('tsf') ? Number(params.get('tsf')) : undefined;
  const denoiserOptions = { roughnessThreshold: GLOSSY * GLOSSY, timestamps: false, ...(tsf !== undefined ? { temporalStabilityFactor: tsf } : {}) };
  const denoiser = wantDenoise && FfxReflectionDenoiser ? new FfxReflectionDenoiser(device, denoiserOptions) : null;
  const hybrid = new HybridReflections(ssr, { denoiser });
  hybrid.denoise = !!denoiser;

  const kit = await ctx.entry.build(W / H);
  await freshEnvironment(kit, ctx.entry);
  applySceneParams(kit, params);
  const camera = kit.camera;
  delete ssr.settings.depthBufferThickness; delete ssr.settings.thicknessRoughnessFactor;
  if (kit.thickness) Object.assign(ssr.settings, kit.thickness);
  if (params.has('spq')) ssr.settings.samplesPerQuad = Number(params.get('spq')) as 1 | 2 | 4;
  const hit = (params.get('hit') ?? 'final') as 'final' | 'lit' | 'current';
  // W44 (D3540): ?reshade=reshade|off (default the package's 'reshade')
  const reshade = (params.get('reshade') ?? 'reshade') as 'reshade' | 'off';
  ssr.settings.hitShading = reshade;
  // W45 (D3550): ?lobeFilter=<k> filtered importance sampling at hits (default: the package's)
  if (params.has('lobeFilter')) ssr.settings.hitLobeFilter = Number(params.get('lobeFilter'));
  const motionScale = Number(params.get('motionScale') ?? 1);

  // probes, as the showcase bakes them
  const probes = new ReflectionProbes();
  for (const v of kit.probes) {
    const p = new ReflectionProbe(...v.influenceSize);
    p.position.set(...v.position);
    if (v.projectionSize) p.projectionSize = new THREE.Vector3(...v.projectionSize);
    if (v.originOffset) p.originOffset.set(...v.originOffset);
    if (v.projectionOffset) p.projectionOffset.set(...v.projectionOffset);
    if (v.blendDistance !== undefined) p.blendDistance = v.blendDistance;
    if (v.resolution !== undefined) p.resolution = v.resolution;
    probes.add(p);
  }
  kit.scene.add(probes);
  const sc = kit.scene, keep = [sc.backgroundIntensity, sc.backgroundBlurriness] as const;
  if (sc.background === sc.environment) { sc.backgroundIntensity = sc.environmentIntensity; sc.backgroundBlurriness = 0; }
  probes.bake(renderer, kit.scene, {
    ...(params.has('probeRes') ? { resolution: Number(params.get('probeRes')) } : {}),
    ...(params.has('bounces') ? { bounces: Number(params.get('bounces')) } : {}), // default 2 (D4300)
    near: kit.bake.near, far: kit.bake.far,
  });
  [sc.backgroundIntensity, sc.backgroundBlurriness] = keep;
  // W26 (D53): ?seam=0|1|dist|lerp Lagarde's distanceRoughness / roughnessLerp (lit and composite), default: the package's
  if (params.has('seam')) {
    const v = params.get('seam');
    probes.distanceRoughness = v === '1' || v === 'dist';
    probes.roughnessLerp = v === '1' || v === 'lerp';
  }
  kit.scene.environmentNode = reflectionProbes(probes) as N;

  let provider: MeshBVHTraceProvider | null = null;
  if (id === 'ours-rt') {
    const meshes: THREE.Mesh[] = [];
    kit.scene.updateMatrixWorld(true);
    kit.scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.noTrace) meshes.push(o as THREE.Mesh); });
    provider = await MeshBVHTraceProvider.fromObjects(device, meshes);
    ssr.setTraceProvider(provider);
    ssr.rayTracing = true;
  }

  // display: the composite, AgX + sRGB (as the showcase's 'final' view); 'probes' = SSR amount 0
  const ao = params.get('specOcc') === '1' ? new ScreenSpaceAO(ssr.gbuffer, camera) : null;
  Object.assign(hybrid.options, { probes, environment: kit.scene.environment, environmentIntensity: kit.scene.environmentIntensity, ao: ao ? (u: N) => ao.sample(u) : null });
  hybrid.rebuild();
  const amount = id === 'probes' ? 0 : 1;
  const c = hybrid.composite();
  c.amount.value = amount;
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = vec4((renderOutput(c.final.rgb, THREE.AgXToneMapping, THREE.SRGBColorSpace) as N).rgb, 1);
  const maskPipeline = new THREE.RenderPipeline(renderer);
  maskPipeline.outputColorTransform = false;
  maskPipeline.outputNode = vec4(c.geometry.and(c.roughness.lessThan(GLOSSY)).select(vec3(1), vec3(0)), 1);

  // hit colour from last frame's final image (the showcase default)
  const historyRT = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
  const historyMaterial = new THREE.MeshBasicNodeMaterial();
  historyMaterial.toneMapped = false;
  const h = hybrid.composite();
  h.amount.value = amount;
  historyMaterial.colorNode = h.final;
  const historyQuad = new THREE.QuadMesh(historyMaterial);
  ssr.settings.hitColor = hit === 'current' ? 'current' : 'history';
  ssr.historySource = hit === 'final' ? historyRT.texture : null;

  const nextNodeFrame = () => (renderer as N)._nodes.nodeFrame.update();
  const draw = (cam: THREE.PerspectiveCamera) => {
    nextNodeFrame();
    syncCamera(camera, cam);
    ssr.render(kit.scene, camera);
    if (motionScale !== 1) {
      // experiment (?motionScale=): scale the motion the denoise seam hands the denoiser, to test
      // whether the reprojection is aligned (flicker in motion should be lowest at 1)
      const f = ssr.gbuffer.frame as N;
      const m = f.conventions.motionVectorScale;
      f.conventions = { ...f.conventions, motionVectorScale: [m[0] * motionScale, m[1] * motionScale] };
    }
    hybrid.update();
  };
  ssr.resetHistory(); hybrid.resetHistory();

  return {
    id, canvas, scene: sceneInfo(kit),
    frame(cam) {
      draw(cam);
      pipeline.render();
      if (hit === 'final') {
        renderer.setRenderTarget(historyRT);
        historyQuad.render(renderer);
        renderer.setRenderTarget(null);
      }
    },
    renderMask(cam) { draw(cam); maskPipeline.render(); },
    idle: () => device.queue.onSubmittedWorkDone(),
    reset() { ssr.resetHistory(); hybrid.resetHistory(); ssr.gbuffer.resetHistory(); },
    setExposure(e) { renderer.toneMappingExposure = e; },
    status: () => (denoiser ? 'denoiser ffx-reflections' : wantDenoise ? 'no denoiser found' : '') + (provider ? ` | BVH ${provider.triangles.toLocaleString()} tris` : ''),
    info: () => ({
      samplesPerQuad: ssr.settings.samplesPerQuad ?? 1, hitColor: hit, hitShading: reshade, denoiser: denoiser ? { ...denoiserOptions } : null,
      thickness: kit.thickness ?? 'default', rayTracing: !!provider, probes: kit.probes.length,
      varianceGuidedTracing: 'off (the seam passes no variance back to the tracer)',
    }),
    gpuErrors: () => errors,
    dispose() {
      provider?.destroy();
      hybrid.dispose();
      probes.dispose();
      historyRT.dispose();
      destroyWebGPU(renderer as N);
    },
  };
}
