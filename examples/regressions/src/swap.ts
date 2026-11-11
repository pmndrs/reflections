// examples/regressions, W27 (DIVERGES D603): the hybrid composite's specular swap.
//
// The composite swaps three's specular IBL term for ours: final = lit + w (ssr - confidence x
// probeEnv). That is exact only if `w x probeEnv` is the term three added. Here we measure, per
// material term, how far off it is, with three's own lighting model as the oracle:
//
//   T  = three's environment specular as it appears in lit: a copy of each material whose lighting
//        model only runs indirectSpecular (radiance x single scattering; iblIrradiance zeroed, so no
//        multi-scattering) and three's ambient-occlusion step, no direct light, no diffuse, no
//        emissive. Clearcoat / sheen indirect lobes are zeroed (they stay three's in the composite);
//        clearcoat's attenuation of the base layer stays in (finish()).
//   Wt = three's radiance weight: the same with radiance = 1 and no AO step (what a hit should get).
//
// The composite is driven with synthetic SSR inputs (a proxy of the pass with 1 x 1 textures):
// hit distance 0, so the depth-aware blend is off and the hit weight is the confidence.
//
//   c = 0                  final must be lit exactly
//   c = 0.5, hit black     expected lit - 0.5 T             (the halo: what the swap removes)
//   c = 1,   hit white     expected lit - T + Wt            (the term removed and the hit's weight)
//
// `specularSwap`: spheres, one material term each, lit by an equirect environment (no probes).
// `specularSwapAssets`: the showcase's car concept, toy car and chess set (glTF materials).
import * as THREE from 'three/webgpu';
import { texture, vec3, vec4 } from 'three/tsl';
import { ScreenSpaceReflectionsPass, getGPUTexture, screenSpaceComposite } from '@pmndrs/reflections/three';
import { availableAssets, gradientEnvironment } from '../../shared';
import { SHOWCASE } from '../../showcase/src/scenes';
import { readTexture, trackErrors } from './util';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

type OracleMode = 'term' | 'weight';

/** three's PhysicalLightingModel with everything but the environment specular removed. */
class OracleModel extends (THREE as N).PhysicalLightingModel {
  mode: OracleMode = 'term';
  direct() {}
  directRectArea() {}
  indirect(builder: N) {
    const ctx = builder.context;
    const { radiance, iblIrradiance } = ctx;
    if (this.mode === 'weight') ctx.radiance = vec3(1);
    ctx.iblIrradiance = vec3(0);
    (this as N).indirectSpecular(builder);
    ctx.radiance = radiance; ctx.iblIrradiance = iblIrradiance;
    const s = this as N;
    if (s.clearcoat === true) s.clearcoatSpecularIndirect.assign(vec3(0));
    if (s.sheen === true) s.sheenSpecularIndirect.assign(vec3(0));
    if (this.mode === 'term') s.ambientOcclusion(builder);
  }
}

/** A node-material copy of `m` (as three's NodeLibrary makes one) whose lighting model is the oracle. */
function oracleMaterial(m: N, mode: OracleMode): N {
  const C = m.isMeshPhysicalMaterial || m.isMeshPhysicalNodeMaterial ? THREE.MeshPhysicalNodeMaterial : THREE.MeshStandardNodeMaterial;
  const o: N = new C();
  for (const key in m) { if (key !== 'uuid' && key !== 'version') o[key] = m[key]; }
  o.emissive = new THREE.Color(0, 0, 0); o.emissiveMap = null; o.emissiveNode = null;
  o.transmission = 0; // the backdrop replaces totalDiffuse: keep it out of the oracle
  o.lightMap = null;
  o.setupLightingModel = function setupLightingModel() {
    const model = new OracleModel(this.useClearcoat, this.useSheen, this.useIridescence, this.useAnisotropy, false, false, this.useRetroreflection, this.useDiffuseRoughness);
    model.mode = mode;
    return model;
  };
  // three caches programs by material key: without this the oracles reuse each other's (or the
  // original's) shader, since the lighting-model override is not part of the key
  const key = o.customProgramCacheKey.bind(o);
  o.customProgramCacheKey = () => `${key()}|oracle-${mode}`;
  o.needsUpdate = true;
  return o;
}

const isPBR = (m: N) => !!m && (m.isMeshStandardMaterial === true || m.isMeshStandardNodeMaterial === true);

interface Swappable { mesh: THREE.Mesh; orig: N; term: N; weight: N; id: N }

function prepare(scene: THREE.Scene) {
  const list: Swappable[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const m = mesh.material as N;
    const i = list.length + 1;
    const id = new THREE.MeshBasicNodeMaterial({ side: m.side });
    id.colorNode = vec3(i, 0, 0);
    const pbr = isPBR(m);
    list.push({ mesh, orig: m, id, term: pbr ? oracleMaterial(m, 'term') : blackLike(m), weight: pbr ? oracleMaterial(m, 'weight') : blackLike(m) });
  });
  return list;
}

function blackLike(m: N) {
  const b = new THREE.MeshBasicNodeMaterial({ side: m.side });
  b.colorNode = vec3(0);
  return b;
}

interface Rig {
  renderer: THREE.WebGPURenderer;
  device: GPUDevice;
  width: number;
  height: number;
}

const halfTarget = (w: number, h: number) => new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });

/** Render `scene` with each mesh's material swapped to `pick`, background black, into a new target. */
async function renderWith(rig: Rig, scene: THREE.Scene, camera: THREE.Camera, list: Swappable[], pick: (s: Swappable) => N) {
  const { renderer, device, width, height } = rig;
  const bg = scene.background;
  scene.background = new THREE.Color(0, 0, 0);
  for (const s of list) s.mesh.material = pick(s);
  const rt = halfTarget(width, height);
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  for (const s of list) s.mesh.material = s.orig;
  scene.background = bg;
  const data = await readTexture(device, getGPUTexture(renderer, rt.texture));
  rt.dispose();
  return data.data;
}

/** 1 x 1 float textures standing in for the tracer's outputs. */
function syntheticSsr(ssr: ScreenSpaceReflectionsPass, gbuffer?: N) {
  const tex = (format: THREE.PixelFormat, n: number) => {
    const t = new THREE.DataTexture(new Float32Array(n), 1, 1, format, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true;
    return t;
  };
  const radiance = tex(THREE.RGBAFormat, 4), confidence = tex(THREE.RedFormat, 1), hitDistance = tex(THREE.RedFormat, 1), source = tex(THREE.RedFormat, 1);
  const props: PropertyDescriptorMap = { radiance: { value: radiance }, confidence: { value: confidence }, hitDistance: { value: hitDistance }, source: { value: source } };
  if (gbuffer) props.gbuffer = { value: gbuffer };
  const proxy = Object.create(ssr, props) as ScreenSpaceReflectionsPass;
  const set = (c: number, hit: number) => {
    (radiance.image.data as Float32Array).set([c * hit, c * hit, c * hit, 0]);
    (confidence.image.data as Float32Array)[0] = c;
    radiance.needsUpdate = confidence.needsUpdate = true;
  };
  return { proxy, set, dispose: () => [radiance, confidence, hitDistance, source].forEach((t) => t.dispose()) };
}

async function renderNode(rig: Rig, node: N) {
  const { renderer, device, width, height } = rig;
  const mat = new THREE.NodeMaterial();
  mat.fragmentNode = node;
  const quad = new THREE.QuadMesh(mat);
  const rt = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
  renderer.setRenderTarget(rt);
  quad.render(renderer);
  renderer.setRenderTarget(null);
  const data = await readTexture(device, getGPUTexture(renderer, rt.texture));
  rt.dispose(); mat.dispose();
  return data.data;
}

const srgb8 = (x: number) => {
  const v = Math.min(1, Math.max(0, x));
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
};

interface Stat { px: number; mean: number; p99: number; max: number; meanLinear: number; meanT: number }

/** |a - b| over the pixels in `mask`: 8-bit sRGB (clamped, no tone mapping) mean / p99 / max, linear mean; and T's mean. */
function stat(a: Float32Array, b: Float32Array, mask: (i: number) => boolean, T?: Float32Array): Stat {
  const d: number[] = [];
  let lin = 0, t = 0;
  for (let i = 0; i < a.length / 4; i++) {
    if (!mask(i)) continue;
    let m8 = 0;
    for (let c = 0; c < 3; c++) {
      const k = i * 4 + c;
      m8 = Math.max(m8, Math.abs(srgb8(a[k]) - srgb8(b[k])));
      lin += Math.abs(a[k] - b[k]) / 3;
      if (T) t += T[k] / 3;
    }
    d.push(m8);
  }
  d.sort((x, y) => x - y);
  const n = d.length;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    px: n, mean: r(n ? d.reduce((s, x) => s + x, 0) / n : 0), p99: r(n ? d[Math.min(n - 1, Math.floor(0.99 * n))] : 0), max: r(n ? d[n - 1] : 0),
    meanLinear: Math.round((n ? lin / n : 0) * 1e5) / 1e5, meanT: Math.round((n ? t / n : 0) * 1e5) / 1e5,
  };
}

interface Measured {
  /** max |final - lit| at c = 0 over all geometry px, per channel, linear */
  c0Max: number;
  blend: Stat;
  full: Stat;
}

/**
 * Composite `ssr` (or a proxy) with synthetic inputs and compare against the oracle. `variants`:
 * name -> the G-buffer view the composite reads (undefined = the pass's own).
 */
async function measure(rig: Rig, ssr: ScreenSpaceReflectionsPass, env: THREE.Texture | null, envIntensity: number, T: Float32Array, Wt: Float32Array,
  masks: Record<string, (i: number) => boolean>, variants: Record<string, N>) {
  const out: Record<string, Record<string, Measured>> = {};
  const litQuad = await renderNode(rig, vec4(texture(ssr.gbuffer.textures.lit!).rgb, 1));
  for (const [variant, gbuffer] of Object.entries(variants)) {
    const syn = syntheticSsr(ssr, gbuffer);
    const c = screenSpaceComposite(syn.proxy, { environment: env, environmentIntensity: envIntensity });
    syn.set(0, 0);
    const f0 = await renderNode(rig, c.final);
    syn.set(0.5, 0);
    const fb = await renderNode(rig, c.final);
    syn.set(1, 1);
    const ff = await renderNode(rig, c.final);
    syn.dispose();
    const expBlend = litQuad.map((v, k) => (k % 4 === 3 ? v : v - 0.5 * T[k]));
    const expFull = litQuad.map((v, k) => (k % 4 === 3 ? v : v - T[k] + Wt[k]));
    out[variant] = {};
    for (const [name, mask] of Object.entries(masks)) {
      let c0Max = 0;
      for (let i = 0; i < f0.length / 4; i++) if (mask(i)) for (let ch = 0; ch < 3; ch++) c0Max = Math.max(c0Max, Math.abs(f0[i * 4 + ch] - litQuad[i * 4 + ch]));
      out[variant][name] = { c0Max, blend: stat(fb, expBlend, mask, T), full: stat(ff, expFull, mask, T) };
    }
  }
  return { results: out, litQuad };
}

/** Variants to compare: the pass's G-buffer, and (if it has the specular target) the same without it. */
function variantsOf(ssr: ScreenSpaceReflectionsPass): Record<string, N> {
  const v: Record<string, N> = { gbuffer: undefined };
  const tx = ssr.gbuffer.textures as N;
  if (tx.specular) v.estimate = Object.create(ssr.gbuffer, { textures: { value: { ...tx, specular: undefined } } });
  return v;
}

async function makeRig(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: { maxColorAttachmentBytesPerSample: 64 } } as never);
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  const device = (renderer as N).backend.device as GPUDevice;
  const gpuErrors: string[] = [];
  trackErrors(device, gpuErrors);
  return { renderer, device, width, height, gpuErrors };
}

/** The per-term spheres. */
export async function specularSwapChecks() {
  const W = 700, H = 150;
  const rig = await makeRig(W, H);
  const { renderer } = rig;
  const env = gradientEnvironment(new THREE.Vector3(0.5, 0.6, 0.6), 4);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 0);
  scene.environment = env;
  scene.environmentIntensity = 0.8;
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(2, 3, 4);
  scene.add(sun);
  // aoMap: horizontal stripes 0.25 / 1
  const ao = new THREE.DataTexture(new Uint8Array([64, 64, 64, 255, 255, 255, 255, 255, 64, 64, 64, 255, 255, 255, 255, 255]), 1, 4, THREE.RGBAFormat);
  ao.magFilter = THREE.NearestFilter; ao.needsUpdate = true;
  const grey = new THREE.Color(0.6, 0.6, 0.6);
  const terms: Record<string, N> = {
    control: { color: grey, roughness: 0.3, metalness: 0 },
    specularIntensity: { color: grey, roughness: 0.3, metalness: 0, specularIntensity: 0.3 },
    specularColor: { color: grey, roughness: 0.3, metalness: 0, specularColor: new THREE.Color(1, 0.45, 0.15) },
    ior: { color: grey, roughness: 0.3, metalness: 0, ior: 1.8 },
    envMapIntensity: { color: grey, roughness: 0.3, metalness: 0, envMap: env, envMapIntensity: 0.5 },
    aoMap: { color: grey, roughness: 0.3, metalness: 0, aoMap: ao },
    metal: { color: new THREE.Color(0.95, 0.8, 0.5), roughness: 0.2, metalness: 1 },
  };
  const names = Object.keys(terms);
  const meshes: Record<string, THREE.Mesh> = {};
  names.forEach((name, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.45, 64, 32), new THREE.MeshPhysicalNodeMaterial(terms[name]));
    m.position.set((i - (names.length - 1) / 2) * 1.0, 0, 0);
    scene.add(m);
    meshes[name] = m;
  });
  const camera = new THREE.PerspectiveCamera(14, W / H, 0.1, 100);
  camera.position.set(0, 0.6, 6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  scene.updateMatrixWorld(true);

  const ssr = new ScreenSpaceReflectionsPass(renderer, { gbufferOptions: { width: W, height: H } });
  ssr.render(scene, camera);
  const list = prepare(scene);
  const ids = await renderWith(rig, scene, camera, list, (s) => s.id);
  const T = await renderWith(rig, scene, camera, list, (s) => s.term);
  const Wt = await renderWith(rig, scene, camera, list, (s) => s.weight);
  const idOf = (name: string) => list.findIndex((s) => s.mesh === meshes[name]) + 1;
  const masks: Record<string, (i: number) => boolean> = {};
  for (const name of names) { const id = idOf(name); masks[name] = (i) => Math.round(ids[i * 4]) === id; }
  const { results, litQuad } = await measure(rig, ssr, env, scene.environmentIntensity, T, Wt, masks, variantsOf(ssr));
  // the oracle is in the same image space as the quad's lit (row order): their geometry masks must agree
  let litMismatch = 0;
  for (let i = 0; i < W * H; i++) if ((ids[i * 4] > 0.5) !== (litQuad[i * 4] + litQuad[i * 4 + 1] + litQuad[i * 4 + 2] > 0)) litMismatch++;
  const out = { results, litMismatch, specularTarget: !!(ssr.gbuffer.textures as N).specular, gpuErrors: rig.gpuErrors };
  ssr.dispose();
  renderer.dispose();
  return out;
}

/** The showcase's glTF scenes (env only, no probes), when `pnpm assets` fetched them. */
export async function specularSwapAssetChecks() {
  const have = new Set((await availableAssets()).map((a) => a.dir));
  const W = 480, H = 270;
  const rig = await makeRig(W, H);
  const { renderer } = rig;
  const out: Record<string, unknown> = {};
  for (const entry of SHOWCASE.filter((e) => e.id !== 'sponza')) {
    if (!have.has(entry.asset) || !have.has('hdri')) { out[entry.id] = { skipped: 'asset missing' }; continue; }
    const sc = await entry.build(W / H);
    const { scene, camera } = sc;
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const v = sc.views.hero ?? Object.values(sc.views)[0];
    camera.position.set(...v.pos); camera.lookAt(new THREE.Vector3(...v.target)); camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    const ssr = new ScreenSpaceReflectionsPass(renderer, { gbufferOptions: { width: W, height: H } });
    ssr.render(scene, camera);
    const list = prepare(scene);
    const ids = await renderWith(rig, scene, camera, list, (s) => s.id);
    const T = await renderWith(rig, scene, camera, list, (s) => s.term);
    const Wt = await renderWith(rig, scene, camera, list, (s) => s.weight);
    // material features, per mesh id
    const feat = list.map((s) => {
      const m = s.orig as N;
      return {
        outOfScope: (m.clearcoat ?? 0) > 0 || (m.sheen ?? 0) > 0 || (m.iridescence ?? 0) > 0 || (m.anisotropy ?? 0) > 0 || (m.transmission ?? 0) > 0,
        specular: (m.specularIntensity ?? 1) !== 1 || (m.specularColor && m.specularColor.getHex() !== 0xffffff) || !!m.specularIntensityMap || !!m.specularColorMap,
        ior: m.ior !== undefined && Math.abs(m.ior - 1.5) > 1e-6,
        aoMap: !!m.aoMap,
        envMapIntensity: !!m.envMap,
      };
    });
    const f = (i: number) => feat[Math.round(ids[i * 4]) - 1];
    const masks: Record<string, (i: number) => boolean> = {
      all: (i) => ids[i * 4] > 0.5,
      inScope: (i) => ids[i * 4] > 0.5 && !f(i).outOfScope,
      outOfScope: (i) => ids[i * 4] > 0.5 && f(i).outOfScope,
      specularOrIor: (i) => ids[i * 4] > 0.5 && !f(i).outOfScope && (f(i).specular || f(i).ior),
      aoMap: (i) => ids[i * 4] > 0.5 && !f(i).outOfScope && f(i).aoMap,
    };
    const census = { meshes: list.length, ...Object.fromEntries((['outOfScope', 'specular', 'ior', 'aoMap', 'envMapIntensity'] as const).map((k) => [k, feat.filter((x) => x[k]).length])) };
    const { results } = await measure(rig, ssr, scene.environment, scene.environmentIntensity, T, Wt, masks, variantsOf(ssr));
    out[entry.id] = { census, results };
    ssr.dispose();
  }
  out.gpuErrors = rig.gpuErrors;
  renderer.dispose();
  return out;
}
