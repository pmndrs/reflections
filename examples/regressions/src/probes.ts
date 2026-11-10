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
