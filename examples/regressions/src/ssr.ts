// examples/regressions, SSR / RT review (stream F2): GPU repros on a three scene through
// ScreenSpaceReflectionsPass and core's ray-traced pass.
//
//  ssrHistory  hitColor 'history' never reads a history texture nothing valid was written to: the
//              first frame with an app `historySource`, the frame after resetHistory(), and the first
//              'history' frame after a 'history' -> 'current' -> 'history' toggle (lit target).
import * as THREE from 'three/webgpu';
import { ScreenSpaceReflectionsPass, getDevice, getGPUTexture } from '@pmndrs/reflections/three';
import { readTexture, trackErrors } from './util';

const W = 320, H = 160;
/** A colour no scene here emits: (20, 0, 20). Its presence in SSR radiance means a stale history was read. */
const STALE = 20;

export interface SsrRig {
  width: number;
  height: number;
  renderer: THREE.WebGPURenderer;
  device: GPUDevice;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  box: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  meshes: THREE.Mesh[];
  gpuErrors: string[];
}

/** A mirror floor under an emissive box, seen from the front; black background, no lights. */
export async function ssrRig(width = W, height = H): Promise<SsrRig> {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, requiredLimits: { maxColorAttachmentBytesPerSample: 64 } } as never);
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  await renderer.init();
  const device = getDevice(renderer);
  const gpuErrors: string[] = [];
  trackErrors(device, gpuErrors);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 0);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0, metalness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(0, 1, 0), roughness: 1 }));
  box.position.set(0, 0.8, 0);
  scene.add(box);
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
  camera.position.set(0, 1.0, 5);
  camera.lookAt(0, 0.2, 0);
  camera.updateMatrixWorld();
  scene.updateMatrixWorld(true);
  return { width, height, renderer, device, scene, camera, box, meshes: [floor, box], gpuErrors };
}

/** SSR radiance over confident hits: how many there are, and how many carry the stale colour. */
async function hitColours(rig: SsrRig, ssr: ScreenSpaceReflectionsPass) {
  const rad = await readTexture(rig.device, getGPUTexture(rig.renderer, ssr.radiance));
  const conf = await readTexture(rig.device, getGPUTexture(rig.renderer, ssr.confidence));
  let hits = 0, stale = 0, current = 0;
  for (let i = 0; i < W * H; i++) {
    if (conf.data[i] < 0.5) continue;
    hits++;
    const r = rad.data[i * 4], g = rad.data[i * 4 + 1];
    if (r > STALE / 4) stale++;
    else if (g > 0.25) current++;
  }
  return { hits, stale, current };
}

function fillTexture(device: GPUDevice, tex: GPUTexture, rgba: [number, number, number, number]) {
  const e = device.createCommandEncoder();
  e.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: rgba }] }).end();
  device.queue.submit([e.finish()]);
}

export async function ssrHistoryChecks() {
  const rig = await ssrRig();
  const { renderer, device, scene, camera, box } = rig;
  const out: Record<string, unknown> = {};

  // (a) app history texture: it holds an "old scene" (the stale colour) the whole time
  {
    const app = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
    renderer.initRenderTarget(app);
    fillTexture(device, getGPUTexture(renderer, app.texture), [STALE, 0, STALE, 1]);
    const ssr = new ScreenSpaceReflectionsPass(renderer, { gbufferOptions: { width: W, height: H }, settings: { hitColor: 'history' } });
    ssr.historySource = app.texture;
    ssr.render(scene, camera);
    out.appFirstFrame = await hitColours(rig, ssr);
    // a valid history is read from the second frame on (shows the check can see it)
    ssr.render(scene, camera);
    out.appSecondFrame = await hitColours(rig, ssr);
    ssr.resetHistory();
    ssr.render(scene, camera);
    out.appAfterReset = await hitColours(rig, ssr);
    ssr.dispose(); app.dispose();
  }

  // (b) the G-buffer's lit target: history -> current -> history with a scene change in between
  {
    const ssr = new ScreenSpaceReflectionsPass(renderer, { gbufferOptions: { width: W, height: H }, settings: { hitColor: 'history' } });
    box.material.emissive.setRGB(STALE, 0, STALE);
    ssr.render(scene, camera); // history <- lit with the stale-coloured box
    ssr.render(scene, camera);
    out.litWhileStale = await hitColours(rig, ssr);
    ssr.settings.hitColor = 'current';
    box.material.emissive.setRGB(0, 1, 0);
    ssr.render(scene, camera);
    out.litCurrent = await hitColours(rig, ssr);
    ssr.settings.hitColor = 'history';
    ssr.render(scene, camera);
    out.litBackToHistory = await hitColours(rig, ssr);
    ssr.dispose();
  }
  out.gpuErrors = rig.gpuErrors;
  renderer.dispose();
  return out;
}

/**
 * rtTiles: with a frame budget below the number of tiles with misses (each tile then gets at most
 * one ray), which tiles trace must not depend on the miss list's append order. Every ray goes to
 * the miss list (missConfidenceThreshold > 1) on a static frame; over `frames` frames we count, per
 * tile with misses, the frames in which it traced. The yardstick is independent uniform selection
 * at p = budget / tiles: a tile is never traced with probability (1 - p)^frames, every frame p^frames.
 */
export async function rtTileChecks() {
  const { MeshBVHTraceProvider } = await import('@pmndrs/reflections/three');
  const rig = await ssrRig(640, 320);
  const { renderer, device, scene, camera, width, height } = rig;
  const provider = await MeshBVHTraceProvider.fromObjects(device, rig.meshes);
  const ssr = new ScreenSpaceReflectionsPass(renderer, {
    gbufferOptions: { width, height }, settings: { missConfidenceThreshold: 1.01 }, trace: { provider, lights: false },
  });
  const tilesX = Math.ceil(width / 8), tilesY = Math.ceil(height / 8);
  // unlimited budget first: the tiles that have misses
  for (let i = 0; i < 2; i++) ssr.render(scene, camera);
  const open = (await ssr.readTraceStats())!;
  const tiles = open.tilesWithMisses;
  const budget = Math.round(0.35 * tiles);
  ssr.traceSettings = { maxTracedRaysPerFrame: budget };
  for (let i = 0; i < 2; i++) ssr.render(scene, camera); // tile feedback settles
  const frames = 4;
  const count = new Uint32Array(tilesX * tilesY);
  const missFrames = new Uint32Array(tilesX * tilesY);
  const traced: number[] = [], capped: number[] = [], tileCaps: number[] = [], tilesWithMisses: number[] = [];
  for (let f = 0; f < frames; f++) {
    ssr.render(scene, camera);
    const st = (await ssr.readTraceStats())!;
    traced.push(st.traced); capped.push(st.capped); tileCaps.push(st.tileCap); tilesWithMisses.push(st.tilesWithMisses);
    const src = await readTexture(device, getGPUTexture(renderer, ssr.source));
    // every miss pixel gets a source code (traced 1 / 2 / 4, capped 3)
    const hit = new Uint8Array(tilesX * tilesY), miss = new Uint8Array(tilesX * tilesY);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = Math.round(src.data[y * width + x]);
      const t = (y >> 3) * tilesX + (x >> 3);
      if (v !== 0) miss[t] = 1;
      if (v === 1 || v === 2 || v === 4) hit[t] = 1;
    }
    for (let t = 0; t < hit.length; t++) { count[t] += hit[t]; missFrames[t] += miss[t]; }
  }
  const hist = new Array(frames + 1).fill(0);
  let n = 0;
  // tiles with misses in every measured frame (a few edge tiles come and go)
  for (let t = 0; t < count.length; t++) if (missFrames[t] === frames) { hist[count[t]]++; n++; }
  const p = budget / (tilesWithMisses.reduce((a, b) => a + b, 0) / frames);
  const qNever = (1 - p) ** frames, qEvery = p ** frames;
  const expect = (q: number) => ({ mean: n * q, sd: Math.sqrt(n * q * (1 - q)) });
  ssr.dispose(); provider.destroy();
  const out = { width, height, tiles, tilesWithMisses, tilesSeen: n, budget, p, frames, hist, traced, capped, tileCaps, never: hist[0], every: hist[frames], expectNever: expect(qNever), expectEvery: expect(qEvery), gpuErrors: rig.gpuErrors };
  renderer.dispose();
  return out;
}
