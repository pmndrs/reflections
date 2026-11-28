// examples/regressions, stream F2: three probe repros (ReflectionProbes / its node).
//
//  probeScale  a probe under a mirrored parent (negative determinant) keeps a positive volume and
//              covers its centre; a probe under a zero-scale parent has a zero (disabled) volume.
import * as THREE from 'three/webgpu';
import { float, uniform, vec3, vec4 } from 'three/tsl';
import { ReflectionProbe, ReflectionProbes, sampleReflectionProbesLocal } from '@pmndrs/reflections/three';

async function newRenderer() {
  const renderer = new THREE.WebGPURenderer({ canvas: document.createElement('canvas'), antialias: false });
  renderer.setSize(4, 4, false);
  await renderer.init();
  return renderer;
}

/** Probe coverage (sampleReflectionProbesLocal's alpha) at world points `points`, one pixel each. */
async function coverageAt(renderer: THREE.WebGPURenderer, probes: ReflectionProbes, points: THREE.Vector3[]) {
  const target = new THREE.RenderTarget(points.length, 1, { type: THREE.FloatType, depthBuffer: false });
  const P = uniform(new THREE.Vector3());
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = vec4(sampleReflectionProbesLocal(probes, P, vec3(0, 1, 0), float(0.5)).a, 0, 0, 1);
  const quad = new THREE.QuadMesh(material);
  const out: number[] = [];
  for (const p of points) {
    P.value.copy(p);
    renderer.setRenderTarget(target);
    quad.render(renderer);
    renderer.setRenderTarget(null);
    const px = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1) as Float32Array;
    out.push(px[0]);
  }
  target.dispose(); material.dispose();
  return out;
}

/** One probe (influence 2 x 2 x 2, blend 0.5) inside a ReflectionProbes group under a parent scaled by `scale`, at `position`. */
async function scaledProbe(renderer: THREE.WebGPURenderer, scale: [number, number, number], position: [number, number, number]) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: 0x808080, side: THREE.BackSide })));
  const parent = new THREE.Group();
  parent.position.set(...position);
  parent.scale.set(...scale);
  const probes = new ReflectionProbes();
  const probe = new ReflectionProbe(2, 2, 2);
  probes.add(probe);
  parent.add(probes);
  scene.add(parent);
  scene.updateMatrixWorld(true);
  probes.bake(renderer, scene, { resolution: 64 });
  const centre = probe.getWorldPosition(new THREE.Vector3());
  return { scene, probes, centre };
}

/** A constant-colour equirect environment. */
function flatEnvironment(r: number, g: number, b: number) {
  const t = new THREE.DataTexture(new Float32Array([r, g, b, 1, r, g, b, 1]), 2, 1, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.needsUpdate = true;
  return t;
}

/**
 * probeRebake: a bake that changes both the atlas layout (a probe added) and the environment lights
 * its captures with the new environment. The probes sit in a white diffuse room lit only by
 * `reflectionProbes()` (scene.environmentNode), so a capture sees the walls lit by whatever
 * environment slot the node samples while capturing. Environment A is red, B blue.
 */
export async function probeRebakeChecks() {
  const { reflectionProbes } = await import('@pmndrs/reflections/three');
  const renderer = await newRenderer();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 0);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.BackSide })));
  const probes = new ReflectionProbes();
  const a = new ReflectionProbe(4, 4, 4);
  a.position.set(-2, 0, 0);
  probes.add(a);
  scene.add(probes);
  const envA = flatEnvironment(1, 0, 0), envB = flatEnvironment(0, 0, 1);
  scene.environment = envA;
  probes.bake(renderer, scene, { resolution: 64 });
  scene.environmentNode = reflectionProbes(probes) as never;
  const P = a.getWorldPosition(new THREE.Vector3());
  // what probe a captured: the wall at +x, lit by the environment slot
  const wall = async () => {
    const target = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec4(sampleReflectionProbesLocal(probes, vec3(P.x, P.y, P.z), vec3(1, 0, 0), float(0.5)).rgb, 1);
    renderer.setRenderTarget(target);
    new THREE.QuadMesh(material).render(renderer);
    renderer.setRenderTarget(null);
    const px = Array.from(await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1) as Float32Array).slice(0, 3);
    target.dispose(); material.dispose();
    return px;
  };
  // the room lit by A: rebake once so the captures see A in the environment slot
  probes.bake(renderer, scene, { resolution: 64 });
  const before = await wall();
  // environment B and a second probe (new layout) in one bake
  scene.environment = envB;
  const b = new ReflectionProbe(4, 4, 4);
  b.position.set(2.5, 0, 0);
  probes.add(b);
  probes.bake(renderer, scene, { resolution: 64 });
  const after = await wall();
  // reference: the same bake again (layout and environment unchanged now)
  probes.bake(renderer, scene, { resolution: 64 });
  const settled = await wall();
  probes.dispose(); envA.dispose(); envB.dispose(); renderer.dispose();
  return { before, after, settled };
}

/**
 * textureLimit (T24, W104, D5640): a material whose own maps plus the probe set's atlases pass the
 * device's sampled-texture limit gets our console warning (naming it, the count and the limit) when
 * three builds it, once; WebGPU rejects its pipeline with the same count. A light material on the same
 * set gets none, and on a renderer with reflectionsRequiredLimits the heavy one draws without either.
 * The page catches WebGPU's errors in an error scope and three's console error, so the deliberate
 * failure stays out of the run's validation check; both come back in the result.
 */
export async function textureLimitChecks() {
  const { reflectionProbes, reflectionsRequiredLimits } = await import('@pmndrs/reflections/three');
  const tex = (i: number) => {
    const t = new THREE.DataTexture(new Uint8Array([40 + i * 10, 120, 200 - i * 10, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  };
  const heavyMaps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap',
    'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'specularIntensityMap', 'specularColorMap'] as const;
  const textures = heavyMaps.map((_, i) => tex(i));
  const heavy = () => {
    const m = new THREE.MeshPhysicalMaterial({ name: 'HeavyPhysical', clearcoat: 1, sheen: 1, iridescence: 1, roughness: 0.3, metalness: 0.5, emissive: 0x111111 });
    heavyMaps.forEach((k, i) => { (m as unknown as Record<string, THREE.Texture>)[k] = textures[i]; });
    return m;
  };
  const light = () => new THREE.MeshStandardMaterial({ name: 'LightStandard', map: textures[0], normalMap: textures[1], roughness: 0.3 });

  const run = async (limits: 'default' | 'reflections') => {
    const canvas = document.createElement('canvas');
    let requiredLimits: Record<string, number> | undefined;
    if (limits === 'reflections') {
      const adapter = await navigator.gpu.requestAdapter();
      requiredLimits = reflectionsRequiredLimits(adapter!);
    }
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, ...(requiredLimits ? { requiredLimits } : {}) });
    renderer.setSize(64, 64, false);
    await renderer.init();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const device: GPUDevice = (renderer as any).backend.device;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0.1, 0.1, 0.1);
    scene.environment = flatEnvironment(0.5, 0.5, 0.5);
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.BackSide })));
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    // three probe sizes: the set default (64, with the environment), 128 and 256: three atlases
    const probes = new ReflectionProbes();
    const sizes = [null, 128, 256];
    sizes.forEach((res, i) => { const p = new ReflectionProbe(3, 3, 3); p.position.set(i * 3 - 3, 0, 0); p.resolution = res; probes.add(p); });
    scene.add(probes);
    probes.bake(renderer, scene, { resolution: 64, bounces: 1 });
    scene.environmentNode = reflectionProbes(probes) as never;
    const geometry = new THREE.SphereGeometry(0.5, 16, 8);
    const heavyMesh = new THREE.Mesh(geometry, heavy()); heavyMesh.name = 'heavySphere'; heavyMesh.position.set(-0.7, 0, 0);
    const lightMesh = new THREE.Mesh(geometry, light()); lightMesh.name = 'lightSphere'; lightMesh.position.set(0.7, 0, 0);
    scene.add(heavyMesh, lightMesh);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
    camera.position.set(0, 0, 3);

    // our warnings and three's error log, captured while the deliberate failure renders
    const warnings: string[] = [], threeErrors: string[] = [], gpuErrors: string[] = [];
    const warn = console.warn, error = console.error;
    console.warn = (...a: unknown[]) => { const s = a.map(String).join(' '); if (s.startsWith('ReflectionProbes:')) warnings.push(s); else warn(...a); };
    console.error = (...a: unknown[]) => { threeErrors.push(a.map(String).join(' ')); };
    try {
      for (let frame = 0; frame < 3; frame++) {
        device.pushErrorScope('validation');
        renderer.render(scene, camera);
        const e = await device.popErrorScope();
        if (e) gpuErrors.push(e.message);
      }
      // a re-bake with the node installed: the captures build the materials again for the cube camera
      device.pushErrorScope('validation');
      probes.bake(renderer, scene, { resolution: 64, bounces: 1 });
      const e = await device.popErrorScope();
      if (e) gpuErrors.push(e.message);
      await device.queue.onSubmittedWorkDone();
      await new Promise((r) => setTimeout(r, 200)); // three's own popErrorScope().then
    } finally {
      console.warn = warn; console.error = error;
    }
    // WebGPU's own count, from its message ("The number of sampled textures (17) in the Fragment stage ...")
    const reported = [...gpuErrors, ...threeErrors].map((m) => /number of sampled textures \((\d+)\)/i.exec(m)?.[1]).find((x) => x !== undefined);
    const ours = warnings.map((w) => /binds (\d+) sampled textures/.exec(w)?.[1]).find((x) => x !== undefined);
    const out = {
      limits, maxSampledTextures: device.limits.maxSampledTexturesPerShaderStage, maxSamplers: device.limits.maxSamplersPerShaderStage,
      atlases: probes.textures.length, warnings, heavyWarned: warnings.filter((w) => w.includes('HeavyPhysical')).length,
      lightWarned: warnings.filter((w) => w.includes('LightStandard')).length,
      oursCount: ours === undefined ? null : Number(ours), webgpuCount: reported === undefined ? null : Number(reported),
      gpuErrors: gpuErrors.map((m) => m.slice(0, 300)), threeErrors: threeErrors.map((m) => m.slice(0, 300)),
    };
    probes.dispose(); renderer.dispose();
    return out;
  };
  const atDefault = await run('default');
  const raised = await run('reflections');
  textures.forEach((t) => t.dispose());
  return { atDefault, raised };
}

export async function probeScaleChecks() {
  const renderer = await newRenderer();
  const out: Record<string, unknown> = {};
  // mirrored parent: |scale| (2, 1, 1): influence 4 x 2 x 2, so (1.5, 0, 0) from the centre is inside, (2.5, 0, 0) outside
  {
    const { probes, centre } = await scaledProbe(renderer, [-2, 1, 1], [1, 0, 0]);
    const [c, inside, outside] = await coverageAt(renderer, probes, [centre, centre.clone().add(new THREE.Vector3(1.5, 0, 0)), centre.clone().add(new THREE.Vector3(2.5, 0, 0))]);
    out.mirrored = { centre: c, inside, outside };
    probes.dispose();
  }
  // zero-scale parent: no volume at all
  {
    const { probes, centre } = await scaledProbe(renderer, [0, 0, 0], [1, 0, 0]);
    const [c, near] = await coverageAt(renderer, probes, [centre, centre.clone().add(new THREE.Vector3(0.3, 0, 0))]);
    out.zeroScale = { centre: c, near };
    probes.dispose();
  }
  renderer.dispose();
  return out;
}
