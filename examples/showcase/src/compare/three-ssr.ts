// three r187's stock SSRNode on the same showcase scene, in its own canvas and renderer, three ways:
//
//  three-raw      ssr({ stochastic: true }) added to the lit pass ("SSR (Raw)" in
//                 webgpu_postprocessing_ssr_denoise.html)
//  three-denoise  + TemporalReprojectNode + RecurrentDenoiseNode, history fed back to SSR, the
//                 example's parameters verbatim
//  three-ffx      + denoiser/three's ffxReflections() (FidelityFX reflection denoiser), wired as the
//                 denoiser repo's examples/three-temporal/src/ssr.ts does (side B there): radiance =
//                 ssr.rgb, hit distance = ssr.a, roughness = the MRT's material roughness, packed view
//                 normals, three's velocity; the FFX output is fed back as SSR history.
//
// As in three's example, the environment's specular is turned off in the lit pass (SSR provides it,
// its misses sample the environment). The example patches PhysicalLightingModel's prototype for every
// renderer; here the patch is scoped to renderers flagged `__noEnvSpecular`, so our pipeline's
// renderers on the same page keep their environment specular. No probes: this is three's stock path.
// Divergences from the example (D2300-D2302): scene-scaled maxDistance / thickness, the scene's own
// environmentIntensity, no TRAA / sharpen / grading.
//
// W51 (bench.html): the same display AA choice as ours (`?aa=upscaler|taa|off`, `?upscale=`, the upscaler's
// settings; ../../../shared/antialias.ts) on three's lit + SSR image, fed this method's own unjittered velocity
// (a VelocityNode per method, given the AA's unjittered projection) and its scene-pass depth; and its SSR /
// reprojection / denoise parameters as live settings (`mirrorBias`, `ssrMaxDistance`, `ssrThickness`, `th.<name>`).
// Off unless asked, so the compare page renders as before.
import * as THREE from 'three/webgpu';
import {
  Fn, diffuseColor, float, materialMetalness, materialRoughness, mrt, nodeObject, normalView, output, packNormalToRGB, pass, renderOutput, sample, texture, uniform,
  unpackRGBToNormal, vec2, vec3, vec4, velocity as velocityShared,
} from 'three/tsl';
import { ssr as threeSSR } from 'three/addons/tsl/display/SSRNode.js';
import { temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { recurrentDenoise } from 'three/addons/tsl/display/RecurrentDenoiseNode.js';
import { ffxReflections } from '@pmndrs/denoiser-three-ffx';
import { DisplayAA, aaFromQuery, renderSize, type AAMode } from '../../../shared/antialias';
import { setSpecularAA, specAAFromQuery, specAAStrength } from '../specAA';
import type { FloorKind } from '../scenes';
import { type CompareMethod, type MethodContext, type MethodId, destroyWebGPU, applySceneParams, applySpecAA, applyGeometryRoughness, freshEnvironment, mergedParams, newCanvas, sceneInfo, syncCamera } from './method';
import { toneOf } from './ours';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export const ffxAvailable = ffxReflections !== null;

// three's example: "Disable env map specular ... since SSR provides the specular reflections
// instead", scoped to the renderers that ask for it.
{
  const PLM = (THREE as N).PhysicalLightingModel.prototype;
  if (!PLM.__comparePatched) {
    const original = PLM.indirectSpecular;
    PLM.indirectSpecular = function (this: N, builder: N) {
      if (builder.renderer?.__noEnvSpecular) {
        builder.context.radiance = vec3(0);
        if (this.clearcoatRadiance) this.clearcoatRadiance.assign(vec3(0));
      }
      original.call(this, builder);
    };
    PLM.__comparePatched = true;
  }
}

/** The example's SSR parameters (webgpu_postprocessing_ssr_denoise.html, as the denoiser repo's port has them). */
export const EXAMPLE = { quality: 0.25, mirrorBias: 0.5, intensity: 1, maxLuminance: 35, stepExponent: 3, screenEdgeFade: 0.2 };
export const REPROJECT = { maxFrames: 16, clampIntensity: 0.25, flickerSuppression: 1, hitPointReprojection: true };
export const DENOISE = { lumaPhi: 0.75, depthPhi: 20, normalPhi: 0.3, roughnessPhi: 100, radius: 1.5, alphaPhi: 5, strength: 0.725, adapt: 0.5, smoothDisocclusions: true, flickerSuppression: 1, adaptiveTrust: 1 };
/** A bench value in the type of the parameter's default (booleans as 1 / 0). */
const parseTh = (d: number | boolean, v: string) => (typeof d === 'boolean' ? v === '1' || v === 'true' : Number(v));
/** W51: the SSRNode uniforms the bench sets live as `th.<name>` (mirrorBias / maxDistance / thickness keep the compare page's keys). */
const SSR_UNIFORMS = ['quality', 'intensity', 'maxLuminance', 'screenEdgeFade', 'environmentIntensity'] as const;
/** @pmndrs/upscaler runtime settings as `aa.<field>` (as ours). */
const UPS: Record<string, 'n' | 'b'> = { rcasDenoise: 'b', exposure: 'n', autoExposure: 'b', lockThinFeatures: 'b', detectShadingChanges: 'b' };

export async function createThreeSSR(id: Extract<MethodId, 'three-raw' | 'three-denoise' | 'three-ffx'>, ctx: MethodContext): Promise<CompareMethod> {
  const { width: W, height: H } = ctx;
  const params = mergedParams(ctx);
  if (id === 'three-ffx' && !ffxReflections) throw new Error('three SSR + FFX needs the sibling Denoiser repo (denoiser/three)');
  const canvas = newCanvas(W, H);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false } as N);
  (renderer as N).__noEnvSpecular = true;
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setSize(W, H, false);
  await renderer.init();
  renderer.toneMappingExposure = ctx.exposure;
  const device = (renderer.backend as N).device as GPUDevice;
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; errors.push(m); console.error(`[${id} webgpu]`, m); });

  const kit = await ctx.entry.build(W / H);
  await freshEnvironment(kit, ctx.entry);
  const floorRoughness0 = kit.floor.roughness;
  applySceneParams(kit, params);
  const specAA = applySpecAA(kit, params);
  const geoRough = applyGeometryRoughness(kit, params); // W56
  const { scene, camera } = kit;
  // one velocity node per method: the display AA hands it the unjittered projection (a shared node would take
  // whichever method set it last); without AA it reads the camera's own projection, as three's `velocity`
  const VelocityNodeClass = (THREE as N).VelocityNode;
  const velNode: N = VelocityNodeClass ? new VelocityNodeClass() : null;
  const velocity: N = velNode ? nodeObject(velNode) : velocityShared;
  // the material's roughness as its lit term shades it: its `roughnessNode` when it has one (W46's
  // roughness from normal variance, ?specAA=1), else three's material roughness (scalar x map)
  const roughnessOut: N = (Fn((builder: N) => (builder.material?.roughnessNode != null ? float(builder.material.roughnessNode) : materialRoughness)) as N)();

  const scenePass: N = pass(scene, camera);
  scenePass.setMRT(mrt({
    output, diffuseColor: vec4(diffuseColor.rgb, materialMetalness),
    normal: vec4(packNormalToRGB(normalView).rgb, roughnessOut), velocity,
  }));
  const color = scenePass.getTextureNode('output'), depth = scenePass.getTextureNode('depth');
  const nrm = scenePass.getTextureNode('normal'), vel = scenePass.getTextureNode('velocity');
  const diffuse = scenePass.getTextureNode('diffuseColor');
  scenePass.getTexture('normal').type = THREE.UnsignedByteType;
  scenePass.getTexture('diffuseColor').type = THREE.UnsignedByteType;
  const sceneNormal = (sample as N)((u: N) => unpackRGBToNormal(nrm.sample(u).rgb));
  const metalRough = (sample as N)((u: N) => vec2(diffuse.sample(u).a, nrm.sample(u).a));
  const env = (scene.environment as N)?.image?.data ? scene.environment : null;
  const node: N = threeSSR(color, depth, sceneNormal, {
    stochastic: true, diffuseNode: diffuse, metalnessNode: diffuse.a, roughnessNode: nrm.a,
    environmentNode: env, envImportanceSampling: false, binaryRefine: false, camera,
  } as N);
  // scene scale (D2301): the example's 0.4 / 0.1 are for its 0.1-scaled dungeon
  const maxDistance0 = kit.bake.far / 4, thickness0 = kit.thickness ? kit.thickness.depthBufferThickness * 3 : 0.1;
  const maxDistance = Number(params.get('ssrMaxDistance') ?? maxDistance0);
  const thickness = Number(params.get('ssrThickness') ?? thickness0);
  const mirrorBias = Number(params.get('mirrorBias') ?? EXAMPLE.mirrorBias);
  node.resolutionScale = Number(params.get('th.resolutionScale') ?? 1); node.quality.value = EXAMPLE.quality; node.mirrorBias.value = mirrorBias;
  node.stepExponent = Number(params.get('th.stepExponent') ?? EXAMPLE.stepExponent);
  node.binaryRefine = params.get('th.binaryRefine') === '1'; node.maxDistance.value = maxDistance; node.intensity.value = EXAMPLE.intensity; node.thickness.value = thickness;
  node.maxLuminance.value = EXAMPLE.maxLuminance; node.screenEdgeFade.value = EXAMPLE.screenEdgeFade; node.screenEdgeFadeBlack = params.get('th.screenEdgeFadeBlack') === '1';
  node.environmentIntensity.value = scene.environmentIntensity ?? 1; // D2300: the scene's, not the example's 3.14
  const base: Record<string, number> = { ...EXAMPLE, environmentIntensity: scene.environmentIntensity ?? 1 };
  for (const k of SSR_UNIFORMS) if (params.has(`th.${k}`)) node[k].value = Number(params.get(`th.${k}`));

  let reflection: N = node;
  let ffx: N = null;
  let tr: N = null, dn: N = null;
  if (id === 'three-denoise') {
    tr = temporalReproject(node, depth, nrm, vel, camera, { mode: 'specular', accumulate: false } as N);
    dn = recurrentDenoise(tr, camera, { depth, normal: nrm, raw: node, metalRoughness: metalRough, mode: 'specular', accumulate: true } as N);
    dn.alphaSource = 'raylength';
    node.setHistory(dn, vel);
    tr.setHistoryTexture(dn);
    for (const [k, v] of Object.entries(REPROJECT)) tr[k].value = params.has(`th.rp.${k}`) ? parseTh(v, params.get(`th.rp.${k}`)!) : v;
    for (const [k, v] of Object.entries(DENOISE)) dn[k].value = params.has(`th.dn.${k}`) ? parseTh(v, params.get(`th.dn.${k}`)!) : v;
    reflection = dn;
  } else if (id === 'three-ffx') {
    // W51: the FFX denoiser's own options (`th.ffx.tsf`, `th.ffx.roughnessThreshold`; ffxReflections' defaults otherwise)
    const ffxOpts: Record<string, number> = {};
    if (params.has('th.ffx.tsf')) ffxOpts.temporalStabilityFactor = Number(params.get('th.ffx.tsf'));
    if (params.has('th.ffx.roughnessThreshold')) ffxOpts.roughnessThreshold = Number(params.get('th.ffx.roughnessThreshold'));
    ffx = ffxReflections!(node, {
      camera, depth, velocity: vel, roughness: nrm.a,
      normal: nrm, normalSpace: 'view', normalEncoding: 'packed',
      ...(Object.keys(ffxOpts).length ? { denoiser: ffxOpts } : {}),
    });
    node.setHistory(ffx.outputTexture, vel);
    reflection = ffx;
  }
  // as in the example / the denoiser repo's port: lit + reflection (ssr.a referenced so SSR is built)
  const lit = color.rgb.add(vec4(reflection.rgb, node.a.greaterThan(0).toVar()).rgb);
  const tone = toneOf(params);
  const toned = (x: N): N => (renderOutput(vec4(x, 1), tone, THREE.SRGBColorSpace) as N).rgb;
  // with the upscaler, the display graph outputs linear colour and the AA tone-maps after it (antialias.ts)
  const linear = uniform(0);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = vec4((linear as N).equal(1).select(lit, toned(lit)), 1);
  const nextNodeFrame = () => (renderer as N)._nodes.nodeFrame.update();

  // W51: AA at ratio 1 only on this side: `?upscale=` (a render size below the display) is ours' (three's SSR + FFX at a
  // scaled pass size disagreed with its own radiance size; the AA choice itself is the same on both sides)
  const aaQ = { ...aaFromQuery(params, 'off'), ratio: 1 };
  const { width: RW, height: RH } = renderSize(W, H, aaQ.ratio);
  // the AA wants uv-space motion (current - previous, y down); three's velocity is the NDC delta (y up)
  const motionRT = new THREE.RenderTarget(RW, RH, { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false });
  motionRT.texture.minFilter = motionRT.texture.magFilter = THREE.NearestFilter;
  const motionMat = new THREE.NodeMaterial();
  motionMat.fragmentNode = vec4((texture(scenePass.getTexture('velocity')) as N).xy.mul(vec2(0.5, -0.5)), 0, 1);
  const motionQuad = new THREE.QuadMesh(motionMat);
  let aa: DisplayAA | null = null;
  let aaMode: AAMode = aaQ.mode;
  const upscalerSettings = () => {
    const o: Record<string, unknown> = { ...aaQ.settings };
    for (const [f, t] of Object.entries(UPS)) if (params.has(`aa.${f}`)) o[f] = t === 'n' ? Number(params.get(`aa.${f}`)) : params.get(`aa.${f}`) === '1';
    return o;
  };
  const makeAA = async () => {
    if (aa) return aa;
    const a = new DisplayAA(renderer, { textures: { motion: motionRT.texture, depth: scenePass.getTexture('depth') } }, {
      mode: aaMode, ratio: aaQ.ratio, settings: upscalerSettings() as N, displayWidth: W, displayHeight: H, tone: toned, gpuTiming: false,
    });
    await a.init();
    aa = a;
    return a;
  };
  if (aaMode !== 'off' || aaQ.ratio > 1) await makeAA();
  const unjittered = new THREE.Matrix4();
  const setParam = (k: string, v: string | null) => { if (v === null) params.delete(k); else params.set(k, v); };
  /** W51: live settings by URL key (the bench); anything else this method reads at creation only. */
  const live: Record<string, (v: string | null) => void> = {
    mirrorBias: (v) => { node.mirrorBias.value = Number(v ?? EXAMPLE.mirrorBias); },
    ssrMaxDistance: (v) => { node.maxDistance.value = Number(v ?? maxDistance0); },
    ssrThickness: (v) => { node.thickness.value = Number(v ?? thickness0); },
    aa: (v) => {
      aaMode = (v ?? (ctx.defaults?.aa as AAMode) ?? 'off') as AAMode;
      if (aa) aa.mode = aaMode; else if (aaMode !== 'off') void makeAA().then((a) => { a.mode = aaMode; });
    },
    sharpness: (v) => { if (aa) aa.upscaler.settings.sharpness = v === null ? aaQ.settings.sharpness : Number(v); },
    accum: (v) => { if (aa) aa.upscaler.settings.maxAccumulation = v === null ? aaQ.settings.maxAccumulation : Number(v); },
    specAA: (v) => {
      const s = v === null ? specAAFromQuery(new URLSearchParams(ctx.defaults ?? {}), 1) : specAAFromQuery(new URLSearchParams({ specAA: v }), 0);
      if (s > 0) specAAStrength.value = s;
      setSpecularAA(scene, s > 0);
    },
    floorRoughness: (v) => { kit.floor.setRoughness(v === null ? floorRoughness0 : Number(v)); },
    floor: (v) => { kit.floor.setKind?.((v ?? 'mirror') as FloorKind); },
    floorPolish: (v) => { kit.floor.setPolished?.(v !== '0'); },
  };
  for (const k of SSR_UNIFORMS) live[`th.${k}`] = (v) => { node[k].value = v === null ? base[k] : Number(v); };
  for (const f of Object.keys(UPS)) live[`aa.${f}`] = () => { if (aa) Object.assign(aa.upscaler.settings, upscalerSettings()); };
  if (tr) for (const [k, d] of Object.entries(REPROJECT)) live[`th.rp.${k}`] = (v) => { tr[k].value = v === null ? d : parseTh(d, v); };
  if (dn) for (const [k, d] of Object.entries(DENOISE)) live[`th.dn.${k}`] = (v) => { dn[k].value = v === null ? d : parseTh(d, v); };
  const REBUILD = new Set(['th.stepExponent', 'th.resolutionScale', 'th.binaryRefine', 'th.screenEdgeFadeBlack', 'th.ffx.tsf', 'th.ffx.roughnessThreshold', 'tone',
    'keyLight', 'paintRoughness', 'geometryRoughness', 'bgBlur', 'bgIntensity', 'envLight', 'background']);

  return {
    id, canvas, scene: sceneInfo(kit),
    frame(cam) {
      nextNodeFrame();
      syncCamera(camera, cam);
      const j = aa ? aa.begin(camera) : {};
      linear.value = aa ? aa.linear.value : 0;
      if (velNode) velNode.setProjectionMatrix(j.projection ? unjittered.fromArray(Array.from(j.projection)) : null);
      renderer.setRenderTarget(aa?.target ?? null);
      pipeline.render();
      aa?.end(camera);
      if (aa) {
        renderer.setRenderTarget(motionRT); motionQuad.render(renderer); renderer.setRenderTarget(null);
        aa.resolve(camera);
      }
      renderer.setRenderTarget(null);
    },
    idle: () => device.queue.onSubmittedWorkDone(),
    reset() { ffx?.resetHistory?.(); aa?.reset(); },
    setExposure(e) { renderer.toneMappingExposure = e; },
    status: () => (aa && aa.mode !== 'off' ? `AA ${aa.mode}${aa.ratio > 1 ? ` x${aa.ratio.toFixed(2)}` : ''}` : ''),
    set(key, value) {
      const f = live[key];
      if (f) { setParam(key, value); f(value); return 'live'; }
      return REBUILD.has(key) ? 'rebuild' : 'ignored';
    },
    timings: () => {
      const out = new Map<string, number>();
      if (aa && aa.mode === 'upscaler') for (const [k, v] of aa.timings) out.set(`upscaler ${k}`, v);
      return out;
    },
    info: () => ({
      ssr: {
        ...EXAMPLE, ...Object.fromEntries(SSR_UNIFORMS.map((k) => [k, node[k].value])), mirrorBias: node.mirrorBias.value, maxDistance: node.maxDistance.value,
        thickness: node.thickness.value, stepExponent: node.stepExponent, resolutionScale: node.resolutionScale, envMisses: !!env,
      },
      ...(id === 'three-denoise' ? { temporalReproject: REPROJECT, recurrentDenoise: DENOISE } : {}),
      ...(id === 'three-ffx' ? { ffx: 'ffxReflections defaults (roughnessThreshold 1, temporalStabilityFactor 0.7) unless th.ffx.*, SSR history = FFX output' } : {}),
      envSpecularInLighting: 'off (the example patch)', probes: 'none', specAA, geometryRoughness: geoRough, aa: aa ? { mode: aa.mode, ratio: aa.ratio } : 'off',
    }),
    gpuErrors: () => errors,
    dispose() { aa?.dispose(); motionRT.dispose(); destroyWebGPU(renderer as N); },
  };
}
