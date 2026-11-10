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
import * as THREE from 'three/webgpu';
import {
  diffuseColor, materialMetalness, materialRoughness, mrt, normalView, output, packNormalToRGB, pass, renderOutput, sample, unpackRGBToNormal,
  vec2, vec3, vec4, velocity,
} from 'three/tsl';
import { ssr as threeSSR } from 'three/addons/tsl/display/SSRNode.js';
import { temporalReproject } from 'three/addons/tsl/display/TemporalReprojectNode.js';
import { recurrentDenoise } from 'three/addons/tsl/display/RecurrentDenoiseNode.js';
import { ffxReflections } from '@pmndrs/denoiser-three-ffx';
import { type CompareMethod, type MethodContext, type MethodId, destroyWebGPU, freshEnvironment, newCanvas, sceneInfo, syncCamera } from './method';

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
const EXAMPLE = { quality: 0.25, mirrorBias: 0.5, intensity: 1, maxLuminance: 35, stepExponent: 3, screenEdgeFade: 0.2 };
const REPROJECT = { maxFrames: 16, clampIntensity: 0.25, flickerSuppression: 1, hitPointReprojection: true };
const DENOISE = { lumaPhi: 0.75, depthPhi: 20, normalPhi: 0.3, roughnessPhi: 100, radius: 1.5, alphaPhi: 5, strength: 0.725, adapt: 0.5, smoothDisocclusions: true, flickerSuppression: 1, adaptiveTrust: 1 };

export async function createThreeSSR(id: Extract<MethodId, 'three-raw' | 'three-denoise' | 'three-ffx'>, ctx: MethodContext): Promise<CompareMethod> {
  const { width: W, height: H, params } = ctx;
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
  const { scene, camera } = kit;

  const scenePass: N = pass(scene, camera);
  scenePass.setMRT(mrt({
    output, diffuseColor: vec4(diffuseColor.rgb, materialMetalness),
    normal: vec4(packNormalToRGB(normalView).rgb, materialRoughness), velocity,
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
  const maxDistance = Number(params.get('ssrMaxDistance') ?? kit.bake.far / 4);
  const thickness = Number(params.get('ssrThickness') ?? (kit.thickness ? kit.thickness.depthBufferThickness * 3 : 0.1));
  const mirrorBias = Number(params.get('mirrorBias') ?? EXAMPLE.mirrorBias);
  node.resolutionScale = 1; node.quality.value = EXAMPLE.quality; node.mirrorBias.value = mirrorBias; node.stepExponent = EXAMPLE.stepExponent;
  node.binaryRefine = false; node.maxDistance.value = maxDistance; node.intensity.value = EXAMPLE.intensity; node.thickness.value = thickness;
  node.maxLuminance.value = EXAMPLE.maxLuminance; node.screenEdgeFade.value = EXAMPLE.screenEdgeFade; node.screenEdgeFadeBlack = false;
  node.environmentIntensity.value = scene.environmentIntensity ?? 1; // D2300: the scene's, not the example's 3.14

  let reflection: N = node;
  let ffx: N = null;
  if (id === 'three-denoise') {
    const tr: N = temporalReproject(node, depth, nrm, vel, camera, { mode: 'specular', accumulate: false } as N);
    const dn: N = recurrentDenoise(tr, camera, { depth, normal: nrm, raw: node, metalRoughness: metalRough, mode: 'specular', accumulate: true } as N);
    dn.alphaSource = 'raylength';
    node.setHistory(dn, vel);
    tr.setHistoryTexture(dn);
    for (const [k, v] of Object.entries(REPROJECT)) tr[k].value = v;
    for (const [k, v] of Object.entries(DENOISE)) dn[k].value = v;
    reflection = dn;
  } else if (id === 'three-ffx') {
    ffx = ffxReflections!(node, {
      camera, depth, velocity: vel, roughness: nrm.a,
      normal: nrm, normalSpace: 'view', normalEncoding: 'packed',
    });
    node.setHistory(ffx.outputTexture, vel);
    reflection = ffx;
  }
  // as in the example / the denoiser repo's port: lit + reflection (ssr.a referenced so SSR is built)
  const lit = color.rgb.add(vec4(reflection.rgb, node.a.greaterThan(0).toVar()).rgb);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = vec4((renderOutput(vec4(lit, 1), THREE.AgXToneMapping, THREE.SRGBColorSpace) as N).rgb, 1);
  const nextNodeFrame = () => (renderer as N)._nodes.nodeFrame.update();

  return {
    id, canvas, scene: sceneInfo(kit),
    frame(cam) { nextNodeFrame(); syncCamera(camera, cam); pipeline.render(); },
    idle: () => device.queue.onSubmittedWorkDone(),
    reset() { ffx?.resetHistory?.(); },
    setExposure(e) { renderer.toneMappingExposure = e; },
    status: () => '',
    info: () => ({
      ssr: { ...EXAMPLE, mirrorBias, maxDistance, thickness, environmentIntensity: scene.environmentIntensity ?? 1, envMisses: !!env },
      ...(id === 'three-denoise' ? { temporalReproject: REPROJECT, recurrentDenoise: DENOISE } : {}),
      ...(id === 'three-ffx' ? { ffx: 'ffxReflections defaults (roughnessThreshold 1, temporalStabilityFactor 0.7), SSR history = FFX output' } : {}),
      envSpecularInLighting: 'off (the example patch)', probes: 'none',
    }),
    gpuErrors: () => errors,
    dispose() { destroyWebGPU(renderer as N); },
  };
}
