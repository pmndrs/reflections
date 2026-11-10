// GPU checks for the probe features, driven by scripts/run-headless.mjs through `window.__p.checks`.
// Each returns plain numbers; the script decides pass or fail. Every check restores the page's
// state (probes, node, visibility) before it returns.

import * as THREE from 'three/webgpu';
import { Fn, instanceIndex, instancedArray, positionWorld, vec3, vec4 } from 'three/tsl';
import {
  ReflectionProbe, ReflectionProbes, ReflectionProbesHelper, reflectionProbes, sampleReflectionProbes, sampleReflectionProbesLocal,
} from '@pmndrs/reflections/three';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** What the checks need from the page (a subset of `window.__p`). */
export interface Page {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  probes: ReflectionProbes;
  node: N;
  params: { resolution: number };
  dynamicObject: THREE.Mesh;
  dynamicMaterial: THREE.MeshStandardMaterial;
  grid: THREE.Object3D;
  probesHelper: THREE.Object3D;
  capture(live?: boolean): void;
  shot(): Promise<string>;
  setGrid(on: boolean, roughness?: number): void;
}

/** Mean and max abs difference (0-255, rgb) between two PNG data URLs, and the share of pixels off by > 2. */
async function diff(a: string, b: string) {
  const px = async (u: string) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = u; });
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, img.width, img.height).data;
  };
  const A = await px(a), B = await px(b);
  let sum = 0, max = 0, over = 0;
  for (let k = 0; k < A.length; k += 4) {
    let m = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(A[k + c] - B[k + c]); sum += d; m = Math.max(m, d); }
    if (m > max) max = m;
    if (m > 2) over++;
  }
  // over: fraction of pixels off by more than 2 / 255 in any channel
  return { mean: sum / (A.length * 0.75), max, over: over / (A.length / 4) };
}

export function makeChecks(p: Page) {
  const { renderer, scene } = p;
  const bakeOptions = () => ({ resolution: p.params.resolution, near: 0.05, far: 30 });
  // With the loop stopped every bake falls in one frame, and three renders a shadow map at most once
  // per camera per frame, so the second bake would keep the first one's shadows. Advance the frame
  // the way the animation loop does (a sliced bake runs one slice per frame anyway).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nextFrame = () => (renderer as any)._nodes.nodeFrame.update();
  /** Bake the page's probes with helpers and test objects hidden (what `capture()` does), in a new frame. */
  const bake = (extra: object = {}, showObject = false) => {
    nextFrame();
    const grid = p.grid.visible, object = p.dynamicObject.visible, helper = p.probesHelper.visible;
    p.grid.visible = p.probesHelper.visible = false;
    p.dynamicObject.visible = showObject;
    p.probes.bake(renderer, scene, { ...bakeOptions(), ...extra });
    p.grid.visible = grid; p.dynamicObject.visible = object; p.probesHelper.visible = helper;
  };
  const restore = () => { p.dynamicObject.visible = false; p.setGrid(false); bake(); scene.environmentNode = p.node; };

  return {
    /** Shadows are restored to autoUpdate after a bake, and the bake rendered each map once. */
    shadows() {
      const lights: THREE.LightShadow[] = [];
      scene.traverse((o) => { const l = o as THREE.PointLight; if (l.isPointLight && l.castShadow) lights.push(l.shadow); });
      bake();
      return { lights: lights.length, autoUpdate: lights.every((s) => s.autoUpdate === true) };
    },

    /**
     * projectionOffset: a probe at X with projectionOffset O renders the same as a probe at X + O with
     * originOffset -O (same capture point, same projection box; the influence is far larger than the
     * scene, so its centre doesn't matter). Without the offset the image changes.
     */
    async projectionOffset() {
      const set = new ReflectionProbes();
      const probe = new ReflectionProbe(60, 60, 60);
      probe.blendDistance = 0.01;
      probe.projectionSize = new THREE.Vector3(8, 5, 8);
      set.add(probe);
      p.setGrid(true, 0.05);
      const capture = (position: number[], projectionOffset: number[], originOffset: number[]) => {
        probe.position.fromArray(position);
        probe.projectionOffset.fromArray(projectionOffset);
        probe.originOffset.fromArray(originOffset);
        const grid = p.grid.visible;
        p.grid.visible = false;
        set.bake(renderer, scene, bakeOptions());
        p.grid.visible = grid;
      };
      // capture from x = -5 (off the left room's centre), project onto the room's walls at x = -4
      capture([-5, 2.5, 0], [1, 0, 0], [0, 0, 0]);
      scene.environmentNode = reflectionProbes(set) as N;
      // again, now that the captures see this set's node (environment only) instead of the page's
      capture([-5, 2.5, 0], [1, 0, 0], [0, 0, 0]);
      const offset = await p.shot();
      capture([-4, 2.5, 0], [0, 0, 0], [-1, 0, 0]);
      const origin = await p.shot();
      capture([-5, 2.5, 0], [0, 0, 0], [0, 0, 0]);
      const none = await p.shot();
      const same = await diff(offset, origin);
      const changed = await diff(offset, none);
      scene.environmentNode = p.node;
      set.dispose();
      restore();
      return { same, changed };
    },

    /**
     * Coverage form: alpha is 0 outside every influence volume, 1 deep inside one and the fade in
     * between; rgb is 0 where alpha is 0; rgb * alpha equals the vec3 form (the environment is black
     * in this scene, so the fallback adds nothing).
     */
    async coverage() {
      const points: [number[], number][] = [
        [[-4, 2.5, 0], 1], [[4, 2.5, 0], 1], [[0, 1.9, 0], 1], [[-6, 1, 3], 1],
        [[0, 20, 0], 0], [[30, 2.5, 0], 0], [[-4, -3, 0], 0],
        // 0.1 inside the left room's influence face (half depth 4.2, blend 0.5): 0.2
        [[-4, 2.5, 4.1], 0.2],
      ];
      const n = points.length;
      const input = instancedArray(new Float32Array(points.flatMap(([q]) => [...q, 0])) as never, 'vec4') as N;
      const local = instancedArray(n, 'vec4') as N;
      const full = instancedArray(n, 'vec4') as N;
      const kernel = Fn(() => {
        const P = input.element(instanceIndex).xyz.toVar();
        const dir = vec3(0.3, -0.2, -1).normalize();
        local.element(instanceIndex).assign(sampleReflectionProbesLocal(p.probes, P, dir, 0.3));
        full.element(instanceIndex).assign(vec4(sampleReflectionProbes(p.probes, P, dir, 0.3), 1));
      })().compute(n) as N;
      await renderer.computeAsync(kernel);
      const L = new Float32Array(await renderer.getArrayBufferAsync(local.value));
      const F = new Float32Array(await renderer.getArrayBufferAsync(full.value));
      let alphaErr = 0, rgbOutside = 0, composeErr = 0, lum = 0;
      points.forEach(([, expected], i) => {
        const a = L[i * 4 + 3];
        alphaErr = Math.max(alphaErr, Math.abs(a - expected));
        for (let c = 0; c < 3; c++) {
          const rgb = L[i * 4 + c], vec = F[i * 4 + c];
          if (expected === 0) rgbOutside = Math.max(rgbOutside, Math.abs(rgb));
          composeErr = Math.max(composeErr, Math.abs(rgb * a - vec) / Math.max(1e-3, Math.abs(vec)));
          if (expected === 1) lum += rgb / (3 * 4);
        }
      });
      return { alphaErr, rgbOutside, composeErr, lum, alpha: points.map((_, i) => +L[i * 4 + 3].toFixed(4)) };
    },

    /**
     * Cache key: two probe sets of equal size (one red capture, one blue), each sampled by its own
     * material. If they shared a compiled program, both quads would show the first set.
     */
    async cacheKey() {
      const sets = [0xff0000, 0x0000ff].map((color) => {
        const set = new ReflectionProbes();
        set.add(new ReflectionProbe(100, 100, 100));
        const room = new THREE.Scene();
        room.background = new THREE.Color(color);
        set.bake(renderer, room, { resolution: 64 });
        return set;
      });
      const test = new THREE.Scene();
      const nodes = sets.map((set, i) => {
        const node = sampleReflectionProbes(set, positionWorld, vec3(0, 0, 1), 0);
        const material = new THREE.MeshBasicNodeMaterial();
        material.colorNode = node;
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        quad.position.x = i === 0 ? -1 : 1;
        test.add(quad);
        return node;
      });
      const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
      camera.position.z = 5;
      const target = new THREE.RenderTarget(64, 32);
      renderer.setRenderTarget(target);
      renderer.render(test, camera);
      renderer.setRenderTarget(null);
      const px = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 32) as Uint8Array;
      const at = (x: number) => Array.from(px.slice((16 * 64 + x) * 4, (16 * 64 + x) * 4 + 3));
      const left = at(16), right = at(48);
      const keys = nodes.map((node) => node.getCacheKey(true));
      target.dispose();
      for (const set of sets) set.dispose();
      test.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
      return { left, right, keysDiffer: keys[0] !== keys[1] };
    },

    /** Time slicing: three `bake({ probes: [one] })` calls equal one full bake; one call alone doesn't. */
    async timeSlice() {
      p.setGrid(true, 0.05);
      bake();
      // something new for the probes to see: the mirror sphere in the doorway
      p.dynamicObject.position.set(0, 1.4, 1.2);
      p.dynamicMaterial.roughness = 0;
      const order = [...p.probes.bakedProbes];
      bake({ probes: [order[0]] }, true);
      const one = await p.shot();
      bake({ probes: [order[1]] }, true);
      bake({ probes: [order[2]] }, true);
      const sliced = await p.shot();
      bake({}, true);
      const fullShot = await p.shot();
      const result = { slicedVsFull: await diff(sliced, fullShot), oneVsFull: await diff(one, fullShot) };
      restore();
      return result;
    },

    /**
     * The environment slot is captured when `scene.environment` changes (texture or version), not on
     * every bake; removing the environment clears it. Counts CubeCamera.update calls per bake.
     */
    async environment() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cube = (p.probes as any).cubeCamera as THREE.CubeCamera;
      let calls = 0;
      const update = cube.update;
      cube.update = function (...args: Parameters<THREE.CubeCamera['update']>) { calls++; return update.apply(this, args); };
      const count = (extra: object = {}) => { calls = 0; bake(extra); return calls; };
      const env = new THREE.DataTexture(new Float32Array([4, 3, 2, 1, 1, 2, 4, 1, 3, 3, 3, 1, 0.5, 0.5, 0.5, 1]), 2, 2, THREE.RGBAFormat, THREE.FloatType);
      env.mapping = THREE.EquirectangularReflectionMapping;
      env.needsUpdate = true;
      p.setGrid(true, 0.05);
      const counts: Record<string, number> = {};
      counts.noEnvironment = count();
      const before = await p.shot();
      scene.environment = env;
      counts.added = count();
      const lit = await p.shot();
      counts.unchanged = count();
      env.needsUpdate = true;
      counts.versionBumped = count();
      counts.always = count({ environment: 'always' });
      counts.slicedUnchanged = count({ probes: [] });
      scene.environment = null;
      counts.removed = count();
      const after = await p.shot();
      cube.update = update;
      env.dispose();
      const result = { counts, litVsBefore: await diff(lit, before), afterVsBefore: await diff(after, before) };
      restore();
      return result;
    },

    /** Helper: world-space volumes under a moved parent, projection boxes drawn; renders without errors. */
    async helper() {
      const group = new THREE.Group();
      group.position.set(5, -2, 1);
      group.scale.setScalar(2);
      const helper = new ReflectionProbesHelper(p.probes);
      group.add(helper);
      scene.add(group);
      scene.updateMatrixWorld(true);
      const boxes = helper.children.filter((c) => (c as THREE.Box3Helper).isLineSegments) as THREE.Box3Helper[];
      const centre = new THREE.Vector3(), probeCentre = new THREE.Vector3();
      let err = 0;
      p.probes.children.forEach((child, i) => {
        // each probe adds an influence box then (projectionSize is set on all three) a projection box
        boxes[i * 2].getWorldPosition(centre);
        child.getWorldPosition(probeCentre);
        err = Math.max(err, centre.distanceTo(probeCentre));
      });
      await p.shot();
      const children = helper.children.length;
      group.remove(helper);
      scene.remove(group);
      helper.dispose();
      return { children, boxes: boxes.length, centreErr: err };
    },
  };
}
