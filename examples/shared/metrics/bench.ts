// X0 (W70): the metrics that need the path-traced reference, on the tuning bench (examples/showcase/bench.html):
// the line spread (the double-blur gate) and the grazing sweep. Both drive the bench's own Measure (the PT
// reference, warm-up, the K-frame mean per method) and read its images (`lastImages`). README.md here.
import * as THREE from 'three/webgpu';
import { ELEVATIONS, STRIP } from './scenes';
import { bias, gradientEnergy, lineSpread as spread, lumaOfRGBA, mad, srgbToLinear } from './stats';

/** What the bench hands over (examples/showcase/src/bench.ts). */
export interface BenchApi {
  width: number; height: number;
  camera: THREE.PerspectiveCamera;
  scene(): string;
  load(id: string): Promise<void>;
  setPose(name: string): void;
  setSetting(id: string, value: string | number | boolean | null): void;
  getSetting(id: string): string | null;
  pending(): { methods: string[]; page: boolean };
  rebuild(): Promise<void>;
  measure(o: { samples?: number; warmup?: number; frames?: number; methods?: string[] }): Promise<unknown>;
  lastImages(): { ref: Uint8ClampedArray; means: Map<string, Float32Array>; masks: Map<string, Uint8Array> } | null;
}

type Settings = Record<string, string | number | null>;
export interface LineSpreadOptions { /** 'lineSpread' (default, the blur gate) or 'lineSpreadThin' (the thickness case). */ scene?: string; /** Bench settings by URL key for the run (e.g. `{ aa: 'off' }`, a stream's new setting); null = back to the default. */ settings?: Settings; /** Peak below this share of the PT's = the reflection is lost: no width, fails (default 0.1). */ minPeak?: number; roughness?: number[]; pose?: string; methods?: string[]; samples?: number; warmup?: number; frames?: number; tolerance?: number }
export interface LineSpreadRow { roughness: number; pt: number | null; ptPeak: number; ptAt: number | null; methods: Record<string, { width: number | null; ratio: number | null; pass: boolean | null; lost: boolean; peak: number; peakRatio: number | null; at: number | null; medianColumn: number | null }>; window: [number, number, number, number] }
export interface GrazingOptions { settings?: Settings; elevations?: number[]; methods?: string[]; samples?: number; warmup?: number; frames?: number; floorRoughness?: number }
export interface GrazingRow { elevation: number; px: number; ptGradient: number; methods: Record<string, { mad: number; bias: number; gradient: number; gradientRatio: number }> }

export interface BenchPTMetrics {
  lineSpread(o?: LineSpreadOptions): Promise<{ scene: string; pose: string; tone: string; samples: number; frames: number; tolerance: number; rows: LineSpreadRow[] }>;
  grazing(o?: GrazingOptions): Promise<{ scene: string; floorRoughness: number | null; samples: number; frames: number; rows: GrazingRow[] }>;
}

const r4 = (x: number | null) => (x === null ? null : Number(x.toFixed(4)));
/** Linear luminance of RGB 8-bit values (sRGB decoded per channel), array of pixel triples or RGBA. */
function linearLuma(d: ArrayLike<number>, stride: 3 | 4, n: number) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.2126 * srgbToLinear(d[i * stride]) + 0.7152 * srgbToLinear(d[i * stride + 1]) + 0.0722 * srgbToLinear(d[i * stride + 2]);
  return out;
}

export function benchPTMetrics(b: BenchApi): BenchPTMetrics {
  const W = b.width, H = b.height;
  async function ensure(scene: string, settings: Record<string, string | number | null>) {
    if (b.scene() !== scene) await b.load(scene);
    for (const [k, v] of Object.entries(settings)) if ((b.getSetting(k) ?? null) !== (v === null ? null : String(v))) b.setSetting(k, v);
    const p = b.pending();
    if (p.page) throw new Error('metrics: a page-level setting (size) is pending; reload first');
    if (p.methods.length) await b.rebuild();
  }
  /** Screen row (0 = top) of a world point through the bench camera. */
  const rowOf = (p: THREE.Vector3) => { const v = p.clone().project(b.camera); return (1 - (v.y + 1) / 2) * H; };

  /**
   * The double-blur gate (plan, X0 and X2): the lineSpread scene at pose e15 (default), floor roughness 0.05 /
   * 0.15 / 0.3 / 0.5, the PT raw (no OIDN), Neutral tone mapping (near linear under its knee) and the display decoded from sRGB, so
   * half maximum is half the radiance. Per roughness: the PT reference and each method's mean, then per column of
   * the middle 60 % of the screen the vertical profile of the reflected strip (window: from just under the strip to
   * the bottom), averaged over the columns, and its FWHM. `ratio` = ours / PT; `pass` = within `tolerance` (0.1) of
   * 1; `lost` (and a fail) when the method's peak is under `minPeak` (0.1) of the PT's: the reflection is gone
   * (W70: the upscaler's clamp and the FFX denoiser remove the sparse hits on a small emitter at r >= 0.15).
   */
  async function lineSpread(o: LineSpreadOptions = {}) {
    const scene = o.scene ?? 'lineSpread', roughness = o.roughness ?? [0.05, 0.15, 0.3, 0.5], pose = o.pose ?? 'e15', methods = o.methods ?? ['ours-denoised'];
    const samples = o.samples ?? 512, warmup = o.warmup ?? 48, frames = o.frames ?? 16, tol = o.tolerance ?? 0.1;
    const rows: LineSpreadRow[] = [];
    for (const r of roughness) {
      // the PT raw (OIDN removes a glossy reflection of a small emitter, which is all fireflies; the column mean denoises)
      await ensure(scene, { tone: 'neutral', floorRoughness: r, ptDenoise: 0, ...(o.settings ?? {}) });
      b.setPose(pose);
      await b.measure({ samples, warmup, frames, methods });
      const img = b.lastImages();
      if (!img) throw new Error('metrics.lineSpread: Measure left no images');
      const yStrip = rowOf(new THREE.Vector3(0, STRIP.height, 0));
      const cam = b.camera.position;
      const zMirror = cam.z * STRIP.height / (cam.y + STRIP.height); // the mirror point, strip at z = 0
      const yMirror = rowOf(new THREE.Vector3(0, 0, zMirror));
      // from just under the strip's image (its ~3 px plus a quarter of the way to the mirror point) to the bottom
      const win: [number, number, number, number] = [Math.round(W * 0.2), Math.max(0, Math.round(yStrip + Math.max(4, (yMirror - yStrip) / 4))), Math.round(W * 0.8), H];
      const pt = spread(linearLuma(img.ref, 4, W * H), W, win);
      const row: LineSpreadRow = { roughness: r, pt: r4(pt.width), ptPeak: r4(pt.peak)!, ptAt: pt.at, window: win, methods: {} };
      for (const id of methods) {
        const mean = img.means.get(id);
        if (!mean) continue;
        const s = spread(linearLuma(mean, 3, W * H), W, win);
        const peakRatio = pt.peak > 0 ? s.peak / pt.peak : null;
        const lost = peakRatio !== null && peakRatio < (o.minPeak ?? 0.1);
        const width = lost ? null : s.width;
        const ratio = width !== null && pt.width ? width / pt.width : null;
        row.methods[id] = { width: r4(width), ratio: r4(ratio), pass: lost ? false : ratio === null ? null : Math.abs(ratio - 1) <= tol, lost, peak: r4(s.peak)!, peakRatio: r4(peakRatio), at: s.at, medianColumn: r4(s.medianColumn) };
      }
      rows.push(row);
    }
    return { scene, pose, tone: 'neutral', samples, frames, tolerance: tol, rows };
  }

  /**
   * Grazing sweep: the grazing scene at poses e5 / e15 / e30 / e60; per elevation over the glossy px (our G-buffer
   * mask): MAD and signed bias of each method's mean vs the PT (8-bit RGB, as Measure), and the gradient energy
   * (mean squared neighbour difference of 8-bit luma) of the method's mean and of the PT; `gradientRatio` < 1 =
   * blurrier than the PT, > 1 = sharper or noisier.
   */
  async function grazing(o: GrazingOptions = {}) {
    const elevations = o.elevations ?? [...ELEVATIONS], methods = o.methods ?? ['ours-denoised'];
    const samples = o.samples ?? 256, warmup = o.warmup ?? 48, frames = o.frames ?? 16;
    await ensure('grazing', { floorRoughness: o.floorRoughness ?? null, ...(o.settings ?? {}) });
    const rows: GrazingRow[] = [];
    for (const e of elevations) {
      b.setPose(`e${e}`);
      await b.measure({ samples, warmup, frames, methods });
      const img = b.lastImages();
      if (!img) throw new Error('metrics.grazing: Measure left no images');
      const m = img.masks.get('glossy');
      if (!m) throw new Error('metrics.grazing: no glossy mask (measure an ours method)');
      let px = 0; for (const v of m) px += v;
      const refL = lumaOfRGBA(img.ref, W * H), gPT = gradientEnergy(refL, W, H, m);
      const row: GrazingRow = { elevation: e, px, ptGradient: r4(gPT)!, methods: {} };
      for (const id of methods) {
        const mean = img.means.get(id);
        if (!mean) continue;
        const L = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) L[i] = 0.2126 * mean[i * 3] + 0.7152 * mean[i * 3 + 1] + 0.0722 * mean[i * 3 + 2];
        // MAD over RGB as Measure: mean of the channel MADs
        let sm = 0, sb = 0;
        for (let c = 0; c < 3; c++) {
          const a = new Float32Array(W * H), r = new Float32Array(W * H);
          for (let i = 0; i < W * H; i++) { a[i] = mean[i * 3 + c]; r[i] = img.ref[i * 4 + c]; }
          sm += mad(a, r, m) / 3; sb += bias(a, r, m) / 3;
        }
        const g = gradientEnergy(L, W, H, m);
        row.methods[id] = { mad: r4(sm)!, bias: r4(sb)!, gradient: r4(g)!, gradientRatio: r4(gPT > 0 ? g / gPT : 0)! };
      }
      rows.push(row);
    }
    return { scene: 'grazing', floorRoughness: o.floorRoughness ?? null, samples, frames, rows };
  }

  return { lineSpread, grazing };
}
