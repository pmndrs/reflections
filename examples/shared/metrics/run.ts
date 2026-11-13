// X0 (W70): the flicker / firefly metrics as one API over any page that can render a frame and read it back
// (README.md in this folder lists the calls, their arguments and what they return). examples/ssr and the tuning
// bench (examples/showcase/bench.html) each build a `MetricsHost` and expose `createMetrics(host)` as
// `window.__p.metrics`; `pnpm check -- --only ssr-exp-metrics` / `ssr-exp-baseline` drive them.
//
// Every metric starts from a reset of the page's history (reflections, denoiser, AA), warms up, measures and puts
// the camera back where it found it. Camera motion goes through `host.getView` / `host.setView` (no history reset).
import { Accumulator, SecondDifference, and, borderMask, count, drift, fullMask, luminanceOfRGBA, lumaOfRGBA, quadEnergy, resampleMask, speckle, type Luma, type Mask } from './stats';

type V3 = [number, number, number];

/** A linear texture read back: RGBA floats at the texture's own size (the render size under `?upscale=`). */
export interface LinearFrame { data: Float32Array; width: number; height: number }

export interface MetricsHost {
  /** Display size of `grab()`'s frames. */
  readonly width: number; readonly height: number;
  /** Render `n` frames and wait for the GPU. */
  step(n?: number): Promise<void>;
  /** Render one frame and read the display back as RGBA bytes (width x height). */
  grab(): Promise<Uint8ClampedArray>;
  /** Drop every temporal history (reflections, denoiser, AA). */
  reset(): void;
  /** The reflection region at display size: glossy geometry (perceptual roughness < the tracer's threshold). Called before a metric warms up (it may render). */
  reflectionMask(): Promise<Mask>;
  /** Named display-size regions besides `whole` and `reflection` (e.g. the bench's W50 rects at their pose). */
  extraRegions?(): Promise<Record<string, Mask>>;
  getView(): { pos: V3; target: V3 };
  /** Move the camera; keeps history (the metrics move it between frames). */
  setView(pos: V3, target: V3): void;
  /** Raw signal / denoised readbacks (linear), after the last rendered frame. Absent: energy and speckle fall back or skip. */
  readSignal?(): Promise<LinearFrame>;
  readDenoised?(): Promise<LinearFrame | null>;
  /** Denoiser on / off (raw speckle on the display wants it off); returns the previous state. */
  setDenoise?(on: boolean): boolean;
  /** Free-form description for the result (scene, pose, aa, upscale, denoiser). */
  describe?(): Record<string, unknown>;
}

export interface RegionOptions { regions?: Record<string, Mask> }
type PerRegion<T> = Record<string, T>;

const r4 = (x: number) => Number(x.toFixed(4));
const round = <T>(o: T): T => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? r4(v) : v)));

/** Read a GPUTexture (rgba16float / rgba32float / r32float / depth32float) into RGBA floats (single channels splat to rgb). */
export async function readTextureFloats(device: GPUDevice, tex: GPUTexture): Promise<LinearFrame> {
  const f = tex.format;
  const depth = f.startsWith('depth');
  if (depth && f !== 'depth32float') throw new Error(`metrics: can't read ${f}`);
  const bytes = f === 'rgba16float' ? 8 : f === 'rgba32float' ? 16 : 4;
  const w = tex.width, h = tex.height;
  const bpr = Math.ceil((w * bytes) / 256) * 256;
  const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder({ label: 'metrics readback' });
  enc.copyTextureToBuffer({ texture: tex, ...(depth ? { aspect: 'depth-only' as GPUTextureAspect } : {}) }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = buf.getMappedRange();
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (f === 'rgba16float') {
      const row = new Uint16Array(raw, y * bpr, w * 4);
      for (let k = 0; k < w * 4; k++) out[y * w * 4 + k] = half(row[k]);
    } else if (f === 'rgba32float') {
      out.set(new Float32Array(raw, y * bpr, w * 4), y * w * 4);
    } else {
      const row = new Float32Array(raw, y * bpr, w);
      for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = out[o + 1] = out[o + 2] = row[x]; out[o + 3] = 1; }
    }
  }
  buf.unmap(); buf.destroy();
  return { data: out, width: w, height: h };
}
const HALF = (() => { const t = new Float32Array(65536); for (let h = 0; h < 65536; h++) { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff; t[h] = e === 0 ? s * 2 ** -14 * (m / 1024) : e === 31 ? (m ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + m / 1024); } return t; })();
const half = (h: number) => HALF[h];

/** A 2D-canvas reader for a page's WebGPU canvas: call it in the same task as the frame that drew it. */
export function canvasReader(width: number, height: number) {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  return (src: CanvasImageSource) => { g.clearRect(0, 0, width, height); g.drawImage(src, 0, 0, width, height); return g.getImageData(0, 0, width, height).data; };
}

// ---- camera moves ---------------------------------------------------------------------------------------------

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** Rotate v about world +y by `deg`. */
const yaw = (v: V3, deg: number): V3 => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]; };

export interface Metrics {
  regions(o?: RegionOptions): Promise<Record<string, Mask>>;
  restDrift(o?: RestDriftOptions): Promise<RestDriftResult>;
  orbitFlicker(o?: OrbitOptions): Promise<OrbitResult>;
  quadEnergy(o?: QuadOptions): Promise<QuadResult>;
  edgePan(o?: EdgePanOptions): Promise<EdgePanResult>;
  speckle(o?: SpeckleOptions): Promise<SpeckleResult>;
  energy(o?: EnergyOptions): Promise<EnergyResult | null>;
  /** Every metric above with its defaults (or the options per metric), one result object. */
  all(o?: AllOptions): Promise<Record<string, unknown>>;
}

export interface RestDriftOptions extends RegionOptions { a?: number; b?: number; threshold?: number }
export interface RestDriftResult { frames: [number, number]; threshold: number; regions: PerRegion<{ px: number; mean: number; pctOver: number; p99: number }> }
export interface OrbitOptions extends RegionOptions { warm?: number; deg?: number; half?: number; passes?: number; threshold?: number }
export interface OrbitResult { deg: number; half: number; passes: number; regions: PerRegion<{ px: number; std: number; d2: number; pctD2Over: number; mean: number }> }
export interface QuadOptions extends RegionOptions { warm?: number; frames?: number }
export interface QuadResult { warm: number; frames: number; display: PerRegion<{ pairs: number; power: number; ratio: number }>; signal?: PerRegion<{ pairs: number; power: number; ratio: number }> }
export interface EdgePanOptions { warm?: number; deg?: number; frames?: number; border?: number; threshold?: number; regions?: Record<string, Mask> }
export interface EdgePanResult { deg: number; frames: number; border: number; regions: PerRegion<{ px: number; d1: number; d2: number; pctD2Over: number }> }
export interface SpeckleOptions extends RegionOptions { warm?: number; frames?: number; sigma?: number; source?: 'signal' | 'display' }
export interface SpeckleResult { source: 'signal' | 'display'; sigma: number; frames: number; regions: PerRegion<{ px: number; pct: number }> }
export interface EnergyOptions extends RegionOptions { warm?: number; frames?: number }
export interface EnergyResult { frames: number; size: [number, number]; regions: PerRegion<{ px: number; raw: number; denoised: number; loss: number }> }
export interface AllOptions { regions?: Record<string, Mask>; restDrift?: RestDriftOptions | false; orbitFlicker?: OrbitOptions | false; quadEnergy?: QuadOptions | false; edgePan?: EdgePanOptions | false; speckle?: SpeckleOptions | false; energy?: EnergyOptions | false }

export function createMetrics(host: MetricsHost): Metrics {
  const W = host.width, H = host.height, N = W * H;
  const luma = async () => lumaOfRGBA(await host.grab(), N);
  let cachedMask: Mask | null = null;

  /** `whole`, `reflection` (the host's glossy mask) and the host's extras, unless `o.regions` replaces them. */
  async function regions(o: RegionOptions = {}): Promise<Record<string, Mask>> {
    if (o.regions) return o.regions;
    cachedMask = await host.reflectionMask();
    return { whole: fullMask(N), reflection: cachedMask, ...((await host.extraRegions?.()) ?? {}) };
  }
  /** Regions, a reset and `warm` frames (the camera where the caller put it). */
  async function start(o: RegionOptions, warm: number) {
    const R = await regions(o);
    host.reset();
    if (warm > 0) await host.step(warm);
    return R;
  }
  const withView = async <T>(f: () => Promise<T>): Promise<T> => {
    const v = host.getView();
    try { return await f(); } finally { host.setView(v.pos, v.target); }
  };

  async function restDrift(o: RestDriftOptions = {}): Promise<RestDriftResult> {
    const a = o.a ?? 120, b = o.b ?? 240, t = o.threshold ?? 8;
    const R = await start(o, a - 1);
    const A = await luma();
    await host.step(b - a - 1);
    const B = await luma();
    const out: RestDriftResult['regions'] = {};
    for (const [k, m] of Object.entries(R)) { const d = drift(A, B, m, t); out[k] = { px: d.px, mean: d.mean, pctOver: d.pctOver, p99: d.p99 }; }
    return round({ frames: [a, b], threshold: t, regions: out });
  }

  /**
   * W39's pendulum orbit (docs/research/w39/measure/inpage.js, biasStudy): about the view's target, `deg` per
   * frame, out `half / 2` frames and back through the start pose and out the other side and back, `passes`
   * times. `std`: per-pixel temporal std of the frames sampled at the start pose while moving (one per pass),
   * mean over the region; `d2`: the second temporal difference inside each monotonic quarter (cancels the
   * smooth motion), mean and % > `threshold`; `mean`: the region's mean luma at the start pose.
   */
  async function orbitFlicker(o: OrbitOptions = {}): Promise<OrbitResult> {
    const deg = o.deg ?? 0.1, halfN = o.half ?? 10, passes = o.passes ?? 12, t = o.threshold ?? 4;
    return withView(async () => {
      const R = await start(o, o.warm ?? 60);
      const v0 = host.getView();
      const off0 = sub(v0.pos, v0.target);
      let angle = 0;
      const at = (a: number) => host.setView(add(v0.target, yaw(off0, a)), v0.target);
      const acc = new Accumulator(N);
      const d2 = Object.fromEntries(Object.entries(R).map(([k, m]) => [k, new SecondDifference(m, t)]));
      for (let p = 0; p < passes; p++) {
        for (const dir of [1, -1, -1, 1]) {
          let first = true;
          for (let i = 0; i < halfN / 2; i++) {
            angle += dir * deg; at(angle);
            const x = await luma();
            for (const s of Object.values(d2)) s.add(x, first);
            first = false;
          }
        }
        angle = 0; at(0); // back at the start pose (the quarters cancel; snapped), still moving: the sample
        acc.add(await luma());
      }
      const out: OrbitResult['regions'] = {};
      for (const [k, m] of Object.entries(R)) { const r = d2[k].result(); out[k] = { px: count(m), std: acc.std(m), d2: r.d2, pctD2Over: r.pctD2Over, mean: acc.regionMean(m) }; }
      return round({ deg, half: halfN, passes, regions: out });
    });
  }

  async function quad(o: QuadOptions = {}): Promise<QuadResult> {
    const warm = o.warm ?? 60, frames = o.frames ?? 8;
    const R = await start(o, warm);
    const sumD: Record<string, { pairs: number; power: number; ratio: number }> = {};
    const sumS: Record<string, { pairs: number; power: number; ratio: number }> = {};
    for (let f = 0; f < frames; f++) {
      const l = await luma();
      for (const [k, m] of Object.entries(R)) { const e = quadEnergy(l, W, H, m); const s = (sumD[k] ??= { pairs: 0, power: 0, ratio: 0 }); s.pairs = e.pairs; s.power += e.power / frames; s.ratio += e.ratio / frames; }
      if (host.readSignal) {
        const sig = await host.readSignal();
        const L = luminanceOfRGBA(sig.data, sig.width * sig.height);
        for (const [k, m0] of Object.entries(R)) {
          const m = resampleMask(m0, W, H, sig.width, sig.height);
          const e = quadEnergy(L, sig.width, sig.height, m); const s = (sumS[k] ??= { pairs: 0, power: 0, ratio: 0 }); s.pairs = e.pairs; s.power += e.power / frames; s.ratio += e.ratio / frames;
        }
      }
    }
    return round({ warm, frames, display: sumD, ...(host.readSignal ? { signal: sumS } : {}) });
  }

  /**
   * Edge pan: the camera yaws in place (`deg` per frame, `frames` frames: new content enters at the side), and
   * per region the frame-to-frame difference d1 and the second difference d2 (which cancels the pan's smooth
   * motion and leaves pops). Regions: `border` (the outer `border` share of the screen), `borderReflection`
   * (border and glossy), `centre` / `centreReflection` (the rest, for scale).
   */
  async function edgePan(o: EdgePanOptions = {}): Promise<EdgePanResult> {
    const deg = o.deg ?? 0.25, frames = o.frames ?? 24, b = o.border ?? 0.1, t = o.threshold ?? 4;
    return withView(async () => {
      const base = await regions(o.regions ? { regions: o.regions } : {});
      const refl = base.reflection ?? fullMask(N);
      const edge = borderMask(W, H, b), centre = borderMask(W, H, b, true);
      const R: Record<string, Mask> = o.regions ?? { border: edge, borderReflection: and(edge, refl), centre, centreReflection: and(centre, refl) };
      host.reset();
      await host.step(o.warm ?? 60);
      const v0 = host.getView();
      const dir = sub(v0.target, v0.pos);
      const s = Object.fromEntries(Object.entries(R).map(([k, m]) => [k, new SecondDifference(m, t)]));
      for (let f = 0; f < frames; f++) {
        host.setView(v0.pos, add(v0.pos, yaw(dir, (f + 1) * deg)));
        const x = await luma();
        for (const d of Object.values(s)) d.add(x);
      }
      const out: EdgePanResult['regions'] = {};
      for (const [k, m] of Object.entries(R)) { const r = s[k].result(); out[k] = { px: count(m), d1: r.d1, d2: r.d2, pctD2Over: r.pctD2Over }; }
      return round({ deg, frames, border: b, regions: out });
    });
  }

  /**
   * Raw speckle count: % of the region's px > `sigma` (3) standard deviations above their 5x5 neighbourhood,
   * mean over `frames` frames. `source: 'signal'` (default when the host reads it back) counts on the linear raw
   * signal, the denoiser's input, whatever the denoiser does; `'display'` on the displayed frame with the
   * denoiser switched off for the run (and back on after).
   */
  async function speck(o: SpeckleOptions = {}): Promise<SpeckleResult> {
    const sigma = o.sigma ?? 3, frames = o.frames ?? 8;
    const source = o.source ?? (host.readSignal ? 'signal' : 'display');
    const was = source === 'display' ? host.setDenoise?.(false) : undefined;
    try {
      const R = await start(o, o.warm ?? 30);
      const acc: Record<string, { px: number; pct: number }> = {};
      for (let f = 0; f < frames; f++) {
        let L: Luma, w = W, h = H, floor = 2;
        if (source === 'signal') {
          await host.step(1);
          const sig = await host.readSignal!();
          L = luminanceOfRGBA(sig.data, sig.width * sig.height); w = sig.width; h = sig.height; floor = 1e-3;
        } else L = await luma();
        for (const [k, m0] of Object.entries(R)) {
          const m = resampleMask(m0, W, H, w, h);
          const r = speckle(L, w, h, m, sigma, floor);
          const a = (acc[k] ??= { px: 0, pct: 0 }); a.px = r.px; a.pct += r.pct / frames;
        }
      }
      return round({ source, sigma, frames, regions: acc });
    } finally { if (was !== undefined) host.setDenoise?.(was); }
  }

  /**
   * Energy (W45's carConcept skirt / door metric): the `frames`-frame linear mean of the raw signal (denoiser
   * input) and of the denoised output, per region; `loss` = 1 - denoised / raw (W45: 26-46 % on the skirt and the
   * door). Null without readbacks or without a running denoiser.
   */
  async function energy(o: EnergyOptions = {}): Promise<EnergyResult | null> {
    if (!host.readSignal || !host.readDenoised) return null;
    const frames = o.frames ?? 64;
    const R = await start(o, o.warm ?? 60);
    let raw: Accumulator | null = null, den: Accumulator | null = null, w = 0, h = 0;
    for (let f = 0; f < frames; f++) {
      await host.step(1);
      const s = await host.readSignal(), d = await host.readDenoised();
      if (!d) return null;
      w = s.width; h = s.height;
      raw ??= new Accumulator(w * h); den ??= new Accumulator(w * h);
      raw.add(luminanceOfRGBA(s.data, w * h)); den.add(luminanceOfRGBA(d.data, w * h));
    }
    const out: EnergyResult['regions'] = {};
    for (const [k, m0] of Object.entries(R)) {
      const m = resampleMask(m0, W, H, w, h);
      const a = raw!.regionMean(m), b = den!.regionMean(m);
      out[k] = { px: count(m), raw: a, denoised: b, loss: a > 0 ? 1 - b / a : 0 };
    }
    return round({ frames, size: [w, h] as [number, number], regions: out });
  }

  async function all(o: AllOptions = {}) {
    const reg = o.regions ? { regions: o.regions } : {};
    const out: Record<string, unknown> = { host: host.describe?.() ?? {}, size: [W, H] };
    if (o.restDrift !== false) out.restDrift = await restDrift({ ...reg, ...(o.restDrift ?? {}) });
    if (o.orbitFlicker !== false) out.orbitFlicker = await orbitFlicker({ ...reg, ...(o.orbitFlicker ?? {}) });
    if (o.quadEnergy !== false) out.quadEnergy = await quad({ ...reg, ...(o.quadEnergy ?? {}) });
    if (o.edgePan !== false) out.edgePan = await edgePan({ ...(o.edgePan ?? {}) });
    if (o.speckle !== false) out.speckle = await speck({ ...reg, ...(o.speckle ?? {}) });
    if (o.energy !== false) out.energy = await energy({ ...reg, ...(o.energy ?? {}) });
    return out;
  }

  return { regions, restDrift, orbitFlicker, quadEnergy: quad, edgePan, speckle: speck, energy, all };
}
