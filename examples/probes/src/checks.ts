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
  const box = [Infinity, Infinity, -1, -1];
  const width = Math.round(Math.sqrt((A.length / 4) * 16 / 9));
  for (let k = 0; k < A.length; k += 4) {
    let m = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(A[k + c] - B[k + c]); sum += d; m = Math.max(m, d); }
    if (m > max) max = m;
    if (m > 2) {
      over++;
      const i = k / 4, x = i % width, y = Math.floor(i / width);
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
  }
  // over: fraction of pixels off by more than 2 / 255 in any channel; box: their bounds (x0, y0, x1, y1)
  return { mean: sum / (A.length * 0.75), max, over: over / (A.length / 4), box: over ? box : null, a, b };
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
  /**
   * Render a few frames after a visibility or node change. On r187 the frame after the first one
   * that shows the grid differs once (692 px of 518k off by up to 75 / 255, then stable), so shots
   * taken in different frames only compare after this.
   */
  const settle = async () => { for (let i = 0; i < 3; i++) { nextFrame(); await p.shot(); } };
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
      await settle();
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
     * Phase 2 lookup options on explicit lookups, at points deep inside one room's probe:
     * `normal` (Lagarde's dominant direction: R at roughness 0, N at roughness 1), `ao` (Lagarde's
     * specular occlusion, against the CPU formula), `frameIrradiance` (the re-fit: the ratio to the
     * plain lookup is clamp(k / E(N), 0, refitClamp), E from the bake's L1 SH, read back).
     */
    async lookupOptions() {
      const points = [[-5, 2, 1], [-3, 1.5, -1], [4, 2, 1], [5, 3, -1]];
      const dirs = [[0.3, -0.2, -1], [-1, 0.4, 0.2], [0.2, 0.9, 0.3], [0.7, -0.6, 0.4]].map((d) => new THREE.Vector3(...d).normalize().toArray());
      const normals = [[0, 1, 0], [1, 0.2, 0], [0, 0.3, -1], [-0.5, 0.5, 0.7]].map((d) => new THREE.Vector3(...d).normalize().toArray());
      const views = [[0, 0.6, 1], [0.8, 0.2, 0.3], [0.1, 0.5, -1], [-1, 0.2, 0.4]].map((d) => new THREE.Vector3(...d).normalize().toArray());
      const aos = [0.2, 0.5, 0.8, 0.35];
      const n = points.length, K = 1;
      // one input and one output array (a compute stage binds at most 8 storage buffers)
      const input = instancedArray(new Float32Array(points.flatMap((q, i) => [...q, aos[i], ...dirs[i], 0, ...normals[i], 0, ...views[i], 0])) as never, 'vec4') as N;
      const output = instancedArray(n * 7, 'vec4') as N;
      const kernel = Fn(() => {
        const at = (k: number) => input.element(instanceIndex.mul(4).add(k));
        const P = at(0).xyz.toVar(), ao = at(0).w.toVar(), R = at(1).xyz.toVar(), Nn = at(2).xyz.toVar(), V = at(3).xyz.toVar();
        const look = (dir: N, r: number, o: object = {}) => sampleReflectionProbesLocal(p.probes, P, dir, r, o);
        const put = (k: number, v: N) => output.element(instanceIndex.mul(7).add(k)).assign(v);
        put(0, look(R, 0));
        put(1, look(R, 0, { normal: Nn }));
        put(2, look(Nn, 1));
        put(3, look(R, 1, { normal: Nn }));
        put(4, look(R, 0, { normal: Nn, view: V, ao }));
        put(5, look(R, 0, { normal: Nn, frameIrradiance: vec3(K) }));
        put(6, look(R, 0, { normal: Nn, frameIrradiance: vec3(1e6) }));
      })().compute(n) as N;
      // a frame first, so the set's table holds the bake's irradiance
      await p.shot();
      await renderer.computeAsync(kernel);
      await renderer.computeAsync(kernel);
      const all = new Float32Array(await renderer.getArrayBufferAsync(output.value));
      const O = Array.from({ length: 7 }, (_, k) => {
        const o = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) o.set(all.subarray((i * 7 + k) * 4, (i * 7 + k) * 4 + 4), i * 4);
        return o;
      });
      // the bake's L1 SH per slot
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const device: GPUDevice = (renderer.backend as any).device;
      const src = p.probes.irradiance!;
      const rb = device.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(src, 0, rb, 0, src.size); device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const sh = new Float32Array(rb.getMappedRange().slice(0)); rb.destroy();
      const slotAt = (q: number[]) => p.probes.bakedProbes.findIndex((probe) => {
        const c = probe.position, h = probe.influenceSize;
        return [0, 1, 2].every((k) => Math.abs(q[k] - c.getComponent(k)) < h.getComponent(k) / 2 - probe.blendDistance);
      });
      const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-4, Math.abs(b));
      let dom0 = 0, dom1 = 0, so = 0, refit = 0, clampErr = 0;
      const ratios: number[] = [];
      for (let i = 0; i < n; i++) {
        const nn = normals[i], vv = views[i];
        const NdotV = Math.min(1, Math.max(0, nn[0] * vv[0] + nn[1] * vv[1] + nn[2] * vv[2]));
        const soRef = Math.min(1, Math.max(0, Math.pow(NdotV + aos[i], 0.5) - 1 + aos[i]));
        const s = slotAt(points[i]) * 12;
        const E = [0, 1, 2].map((c) => {
          const L00 = sh[s + c], L1m1 = [sh[s + 3], sh[s + 4], sh[s + 5]][c], L10 = [sh[s + 6], sh[s + 7], sh[s + 8]][c], L11 = [sh[s + 9], sh[s + 10], sh[s + 11]][c];
          return Math.max(0, 0.886227 * L00 + 1.023327 * (L1m1 * nn[1] + L10 * nn[2] + L11 * nn[0]));
        });
        for (let c = 0; c < 3; c++) {
          const plain = O[0][i * 4 + c];
          dom0 = Math.max(dom0, rel(O[1][i * 4 + c], plain));
          dom1 = Math.max(dom1, rel(O[3][i * 4 + c], O[2][i * 4 + c]));
          so = Math.max(so, rel(O[4][i * 4 + c], plain * soRef));
          const expect = Math.min(p.probes.refitClamp, Math.max(0, K / Math.max(E[c], 1e-4)));
          ratios.push(+(O[5][i * 4 + c] / plain).toFixed(3));
          refit = Math.max(refit, rel(O[5][i * 4 + c], plain * expect));
          clampErr = Math.max(clampErr, rel(O[6][i * 4 + c], plain * p.probes.refitClamp));
        }
      }
      // guard: a shader that failed to compile leaves zeros, which every relative error above passes
      const lum = O[0].reduce((a, x, i) => a + ((i & 3) === 3 ? 0 : x), 0);
      return { dom0, dom1, so, refit, clampErr, ratios, lum, slots: points.map(slotAt) };
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
      await settle();
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
     * Stress variant of the time slicing (W7): renders interleaved with bake slices in the same frame,
     * no explicit frame advance, the mirror sphere visible in the view but hidden in the captures (so
     * the shadow map the captures render differs from the view's). After every slice, a shot must equal
     * a shot taken after advancing the frame (which re-renders the shadow map for the view).
     */
    async timeSliceStress() {
      p.setGrid(true, 0.05);
      p.dynamicObject.visible = true;
      p.dynamicObject.position.set(0, 1.4, 1.2);
      p.dynamicMaterial.roughness = 0;
      bake();
      await settle();
      const order = [...p.probes.bakedProbes];
      const max: number[] = [];
      const failures: object[] = [];
      for (let k = 0; k < 3; k++) {
        await p.shot();
        const grid = p.grid.visible;
        p.grid.visible = p.dynamicObject.visible = false;
        p.probes.bake(renderer, scene, { ...bakeOptions(), probes: [order[k]] });
        p.grid.visible = grid; p.dynamicObject.visible = true;
        const same = await p.shot();
        nextFrame();
        const fresh = await p.shot();
        const d = await diff(same, fresh);
        max.push(d.max);
        if (d.max > 1) failures.push({ slice: k, max: d.max, box: d.box, over: d.over, same, fresh });
      }
      restore();
      return { max, failures };
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
      await settle();
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
