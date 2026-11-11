// Temporal anti-aliasing for the example pages (W26): the resolve the FidelityFX SSSR sample and
// the denoiser repo's reflection demo run after the reflections (TRAA there), here as a small pass
// that fits our frame order (the scene is rasterised by FrameGBuffer before the display pipeline,
// so three's TRAANode, which jitters the camera from inside a RenderPipeline, can't be used as is).
//
//   const taa = new TemporalAA(renderer, ssr.gbuffer.textures.motion);
//   // per frame:
//   const j = taa.jitter(camera, W, H);              // sub-pixel view offset (Halton 2,3)
//   ssr.render(scene, camera, j);                    // FrameGBuffer: jittered raster, unjittered motion
//   taa.restore(camera);
//   hybrid.update();
//   renderer.setRenderTarget(taa.input); pipeline.render(); renderer.setRenderTarget(null);
//   taa.resolve();                                   // history blend -> canvas
//
// The resolve: history reprojected with the G-buffer's uv-space motion (current - previous), clipped
// to the 3x3 neighbourhood's mean +- gamma sigma (variance clipping, Salvi 2016, as three's TRAANode),
// blended at 5% current or more under motion; at rest (zero motion) a running average of up to 128
// frames with a clip box that widens as it settles, since the jittered 3x3 box moves with the jitter.
// Luminance-weighted against flicker (Karis 2014), Catmull-Rom history taps. It runs on the display
// image (tone-mapped), so it treats residual reflection noise and edge / specular aliasing alike.
// No closest-depth motion dilation or disocclusion test (TRAANode has both): DIVERGES D2600.
import * as THREE from 'three/webgpu';
import { Fn, float, ivec2, max, mix, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const halton = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const OFFSETS: [number, number][] = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

export class TemporalAA {
  /** Render the display pipeline into this (then call `resolve()`). */
  readonly input: THREE.RenderTarget;
  /**
   * Current-frame weight floor while the camera moves (three's TRAANode: 0.05); it rises with the
   * pixel's motion (+0.4 at 8 px / frame). At rest the resolve is a running average instead.
   */
  readonly minWeight = uniform(0.05);
  /**
   * History length at rest (the running average's cap; 32 leaves a 1-2/255 jitter shimmer on
   * normal-mapped paint, 128 settles it).
   */
  readonly maxSamples = uniform(128);
  enabled = true;
  private readonly history: [THREE.RenderTarget, THREE.RenderTarget];
  private readonly historyNode: N;
  private readonly valid = uniform(0);
  private readonly resolveMaterial = new THREE.NodeMaterial();
  private readonly resolveQuad: THREE.QuadMesh;
  private readonly blit: THREE.RenderPipeline;
  private readonly blitNode: N;
  private index = 0;
  private cur = 0;
  private readonly unjittered = new THREE.Matrix4();

  constructor(private readonly renderer: THREE.WebGPURenderer, motion: THREE.Texture, width = 1, height = 1) {
    const rt = () => {
      const t = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
      t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
      t.texture.generateMipmaps = false;
      return t;
    };
    this.input = rt();
    this.input.texture.minFilter = this.input.texture.magFilter = THREE.NearestFilter;
    this.history = [rt(), rt()];
    const current: N = texture(this.input.texture);
    this.historyNode = texture(this.history[0].texture);
    const motionNode: N = texture(motion);

    const resolve = Fn(() => {
      const at: N = uv();
      const size: N = vec2(current.size());
      const texel: N = ivec2(at.mul(size));
      const c: N = current.load(texel).max(0).toVar();
      // neighbourhood moments (3x3)
      const m1: N = c.toVar(), m2: N = c.mul(c).toVar();
      for (const [x, y] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
        const n: N = current.offset(ivec2(x, y)).load(texel).max(0);
        m1.addAssign(n); m2.addAssign(n.mul(n));
      }
      const mean: N = m1.div(9);
      const sigma: N = m2.div(9).sub(mean.mul(mean)).max(0).sqrt();
      // the closest-depth dilation of TRAA is skipped: motion at the pixel (uv-space current - previous)
      const prevUV: N = at.sub(motionNode.sample(at).xy);
      const onScreen: N = prevUV.greaterThanEqual(vec2(0)).all().and(prevUV.lessThanEqual(vec2(1)).all());
      const motionPx: N = at.sub(prevUV).mul(size).length();
      const motionFactor: N = motionPx.div(8).saturate();
      // at rest (no reprojection error) the jittered 3x3 box moves with the jitter: a tight clip
      // would pull edges back and forth every frame, so it widens as the pixel settles
      const still: N = motionPx.lessThan(0.01);
      const hist: N = this.historyNode.sample(prevUV).toVar(); // .a: samples so far (bilinear)
      // colour: 5-tap Catmull-Rom, so the history doesn't soften a little more every moving frame
      const sp: N = prevUV.mul(size);
      const t1: N = sp.sub(0.5).floor().add(0.5);
      const f: N = sp.sub(t1);
      const w0: N = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5));
      const w1: N = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
      const w2: N = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5));
      const w3: N = f.mul(f).mul(f.mul(0.5).sub(0.5));
      const w12: N = w1.add(w2);
      const p0: N = t1.sub(1).div(size), p3: N = t1.add(2).div(size), p12: N = t1.add(w2.div(w12)).div(size);
      const tap = (x: N, y: N, w: N) => this.historyNode.sample(vec2(x, y)).rgb.mul(w);
      const cr: N = tap(p12.x, p0.y, w12.x.mul(w0.y))
        .add(tap(p0.x, p12.y, w0.x.mul(w12.y)))
        .add(tap(p12.x, p12.y, w12.x.mul(w12.y)))
        .add(tap(p3.x, p12.y, w3.x.mul(w12.y)))
        .add(tap(p12.x, p3.y, w12.x.mul(w3.y)))
        .div(w12.x.mul(w0.y).add(w0.x.mul(w12.y)).add(w12.x.mul(w12.y)).add(w3.x.mul(w12.y)).add(w12.x.mul(w3.y)))
        .max(0);
      const count: N = onScreen.and(this.valid.equal(1)).select(hist.a.add(1).min(still.select(this.maxSamples, this.minWeight.reciprocal().sub(1))), float(0)).toVar();
      const gamma: N = still.select(mix(float(1.25), float(3), count.div(this.maxSamples)), mix(float(0.75), float(1.25), motionFactor.oneMinus()));
      const lo: N = mean.sub(sigma.mul(gamma)), hi: N = mean.add(sigma.mul(gamma));
      const h: N = cr.clamp(lo.rgb, hi.rgb);
      // running average while still (1 / (n + 1), down to 1 / maxSamples), 10%+ under motion
      const w: N = count.add(1).reciprocal().max(still.select(float(0), this.minWeight.add(motionFactor.mul(0.4)))).saturate();
      // luminance weighting (Karis 2014): damp the outliers' share
      const luma = (v: N) => v.dot(vec4(0.2126, 0.7152, 0.0722, 0).xyz);
      const wc: N = w.div(luma(c.rgb).add(1)), wh: N = w.oneMinus().div(luma(h).add(1));
      return vec4(c.rgb.mul(wc).add(h.mul(wh)).div(max(wc.add(wh), 1e-5)), count);
    });
    this.resolveMaterial.fragmentNode = resolve();
    this.resolveQuad = new THREE.QuadMesh(this.resolveMaterial);
    this.blit = new THREE.RenderPipeline(renderer);
    this.blit.outputColorTransform = false;
    this.blitNode = texture(this.history[0].texture);
    this.blit.outputNode = vec4(this.blitNode.rgb, 1);
  }

  setSize(width: number, height: number) {
    for (const t of [this.input, ...this.history]) t.setSize(width, height);
    this.reset();
  }

  /** Drop the history (camera cut, scene switch, view change). */
  reset() { this.valid.value = 0; }

  /**
   * Offset `camera` by this frame's sub-pixel jitter (setViewOffset). Returns what
   * `ScreenSpaceReflectionsPass.render` / `FrameGBuffer.render` take: the jitter in pixels and the
   * unjittered projection, so the frame contract's motion and matrices carry no jitter (D405).
   */
  jitter(camera: THREE.PerspectiveCamera, width: number, height: number): { jitter?: readonly [number, number]; projection?: ArrayLike<number> } {
    if (!this.enabled) return {};
    camera.updateProjectionMatrix();
    this.unjittered.copy(camera.projectionMatrix);
    const [jx, jy] = OFFSETS[this.index++ % OFFSETS.length];
    camera.setViewOffset(width, height, jx, jy, width, height);
    return { jitter: [jx, jy], projection: this.unjittered.elements.slice() };
  }

  /** Undo `jitter()` (the controls and anything else see the plain camera). */
  restore(camera: THREE.PerspectiveCamera) {
    if (this.enabled) camera.clearViewOffset();
  }

  /** Blend `input` with the history and present it to the canvas (or `target`). */
  resolve(target: THREE.RenderTarget | null = null) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const read = this.history[this.cur], write = this.history[this.cur ^ 1];
    this.historyNode.value = read.texture;
    r.setRenderTarget(write);
    this.resolveQuad.render(r);
    this.blitNode.value = write.texture;
    r.setRenderTarget(target);
    this.blit.render();
    r.setRenderTarget(prev);
    this.cur ^= 1;
    this.valid.value = 1;
  }

  dispose() {
    for (const t of [this.input, ...this.history]) t.dispose();
    this.resolveMaterial.dispose();
  }
}
