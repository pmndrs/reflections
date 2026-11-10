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
