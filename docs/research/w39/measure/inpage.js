// W39 in-page measurement helpers (evaluated into the ssr / showcase pages).
(() => {
  const P = window.__p;
  const isSSR = !!P.controls;
  let W = 0, H = 0;
  const lumaOf = (d, n) => { const l = new Float32Array(n); for (let i = 0; i < n; i++) l[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]; return l; };
  async function decode(url) {
    const img = new Image(); img.src = url; await img.decode();
    W = img.width; H = img.height;
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, W, H).data;
  }
  async function grab(keepRGB = false) {
    const url = await P.shot();
    const d = await decode(url);
    const l = lumaOf(d, W * H);
    return keepRGB ? { l, d, url } : l;
  }
  const target = () => (isSSR ? P.controls.target.clone() : new P.THREE.Vector3(...P.camera()[1]));
  function rotate(deg) {
    const cam = P.kit.camera, t = target();
    const o = cam.position.clone().sub(t);
    o.applyAxisAngle(new P.THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
    cam.position.copy(t).add(o);
    cam.lookAt(t);
    cam.updateMatrixWorld();
  }
  function halfToFloat(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * 2 ** (e - 15) * (1 + f / 1024);
  }
  async function readTex(tex) {
    const device = P.ssr.device;
    const bytes = tex.format === 'rgba16float' ? 8 : 4;
    const bpr = Math.ceil((tex.width * bytes) / 256) * 256;
    const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex, aspect: tex.format.startsWith('depth') ? 'depth-only' : 'all' }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const dv = new DataView(buf.getMappedRange());
    const ch = tex.format === 'rgba16float' ? 4 : 1;
    const out = new Float32Array(tex.width * tex.height * ch);
    for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) for (let c = 0; c < ch; c++) {
      const o = y * bpr + x * bytes;
      out[(y * tex.width + x) * ch + c] = ch === 4 ? halfToFloat(dv.getUint16(o + c * 2, true)) : dv.getFloat32(o, true);
    }
    buf.unmap(); buf.destroy();
    return { data: out, w: tex.width, h: tex.height };
  }
  /** Masks: ssr page from the G-buffer (needs render size = display size), showcase from the 'reflections' view. */
  async function masks(scene) {
    const n = W * H;
    const m = { whole: new Uint8Array(n).fill(1) };
    if (isSSR) {
      const t = P.ssr.gbuffer.gpuTextures();
      const [dep, nr] = await Promise.all([readTex(t.depth), readTex(t.normal)]);
      const inv = P.ssr.gbuffer.conventions.depthInverted;
      const refl = new Uint8Array(n), mir = new Uint8Array(n), floor = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const geo = inv ? dep.data[i] > 0 : dep.data[i] < 1;
        if (!geo) continue;
        const r = nr.data[i * 4 + 3];
        if (r < 0.447) refl[i] = 1;
        if (r < 0.05) mir[i] = 1;
        if (nr.data[i * 4 + 1] > 0.9) floor[i] = 1;
      }
      m.reflective = refl;
      if (scene === 'facingMirrors') m.mirrors = mir;
      if (scene === 'mirrorWall' || scene === 'roughnessRamp') m.floor = floor;
    } else {
      P.setView('reflections');
      for (let i = 0; i < 4; i++) await P.step(1);
      const l = await grab();
      const r = new Uint8Array(n);
      for (let i = 0; i < n; i++) r[i] = l[i] > 12 ? 1 : 0;
      m.reflection = r;
      P.setView('final');
    }
    return m;
  }
  function count(m) { let c = 0; for (const v of m) c += v; return c; }
  function restStats(frames, mask) {
    const n = W * H; const T = frames.length;
    let px = 0, meanSum = 0, over1 = 0, over4 = 0, pairs = 0; const all = [];
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      px++;
      let s = 0;
      for (let t = 1; t < T; t++) { const d = Math.abs(frames[t][i] - frames[t - 1][i]); s += d; if (d > 4) over4++; pairs++; if ((i & 7) === 0) all.push(d); }
      const md = s / (T - 1);
      meanSum += md; if (md > 1) over1++;
    }
    all.sort((a, b) => a - b);
    return { px, mean: meanSum / px, pctMeanOver1: (100 * over1) / px, pctOver4: (100 * over4) / pairs, p99: all[Math.floor(all.length * 0.99)] ?? 0 };
  }
  function orbitStats(frames, mask) {
    const n = W * H; const T = frames.length;
    let px = 0, s2 = 0, c2 = 0, o2 = 0, o1 = 0, c1 = 0; const all = [];
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      px++;
      for (let t = 1; t < T; t++) { const d1 = Math.abs(frames[t][i] - frames[t - 1][i]); c1++; if (d1 > 4) o1++; }
      for (let t = 2; t < T; t++) { const d = Math.abs(frames[t][i] - 2 * frames[t - 1][i] + frames[t - 2][i]); s2 += d; c2++; if (d > 4) o2++; if ((i & 7) === 0) all.push(d); }
    }
    all.sort((a, b) => a - b);
    return { px, d2mean: s2 / c2, pctD2Over4: (100 * o2) / c2, d2p99: all[Math.floor(all.length * 0.99)] ?? 0, pctD1Over4: (100 * o1) / c1 };
  }
  async function toUrl(rgba) {
    const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
    const bl = await c.convertToBlob({ type: 'image/png' });
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(bl); });
  }
  /** Heat map of per-px mean |diff| (x gain), as a PNG data URL. */
  async function heat(frames, gain = 40, second = false) {
    const n = W * H; const T = frames.length; const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      if (second) for (let t = 2; t < T; t++) { s += Math.abs(frames[t][i] - 2 * frames[t - 1][i] + frames[t - 2][i]); c++; }
      else for (let t = 1; t < T; t++) { s += Math.abs(frames[t][i] - frames[t - 1][i]); c++; }
      const v = Math.min(1, (s / c) * gain / 255);
      out[i * 4] = 255 * Math.min(1, v * 3); out[i * 4 + 1] = 255 * Math.min(1, Math.max(0, v * 3 - 1)); out[i * 4 + 2] = 255 * Math.max(0, v * 3 - 2); out[i * 4 + 3] = 255;
    }
    return toUrl(out);
  }
  /**
   * One configuration: warm at rest, rest frames, then a slow orbit (deg / frame), then a fast orbit
   * and a settle (ghost = |moving - settled| at the same pose). The camera is put back afterwards.
   */
  async function measure(o = {}) {
    const { scene = '', warm = 90, rest = 13, orbitWarm = 20, orbit = 17, deg = 0.03, fastDeg = 0.25, fastFrames = 24, settle = 150, shots = false } = o;
    P.stop();
    const cam = P.kit.camera; const pos0 = cam.position.clone(); const q0 = cam.quaternion.clone();
    await P.step(2);
    const first = await grab();
    const M = o.masks ?? await masks(scene);
    for (let i = 0; i < warm; i++) await P.step(1);
    const R = []; for (let i = 0; i < rest; i++) R.push(await grab());
    const out = { size: [W, H], px: Object.fromEntries(Object.entries(M).map(([k, v]) => [k, count(v)])), rest: {}, orbit: {}, ghost: {} };
    for (const [k, m] of Object.entries(M)) out.rest[k] = restStats(R, m);
    for (let i = 0; i < orbitWarm; i++) { rotate(deg); await P.step(1); }
    const O = []; for (let i = 0; i < orbit; i++) { rotate(deg); O.push(await grab()); }
    for (const [k, m] of Object.entries(M)) out.orbit[k] = orbitStats(O, m);
    if (shots) { out.restHeat = await heat(R, 64); out.orbitHeat = await heat(O, 16, true); }
    if (fastFrames > 0) {
      for (let i = 0; i < fastFrames - 1; i++) { rotate(fastDeg); await P.step(1); }
      rotate(fastDeg);
      const A = await grab(true);
      for (let i = 0; i < settle; i++) await P.step(1);
      const B = await grab(true);
      const MB = isSSR ? await masks(scene) : M;
      for (const [k, m] of Object.entries(MB)) {
        let px = 0, s = 0; const all = [];
        for (let i = 0; i < W * H; i++) if (m[i]) { const d = Math.abs(A.l[i] - B.l[i]); s += d; px++; if ((i & 3) === 0) all.push(d); }
        all.sort((a, b) => a - b);
        out.ghost[k] = { px, mean: s / px, p99: all[Math.floor(all.length * 0.99)] ?? 0 };
      }
      if (shots) {
        out.moving = A.url; out.settled = B.url;
        const dd = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) { const v = Math.min(255, Math.abs(A.l[i] - B.l[i]) * 8); dd[i * 4] = v; dd[i * 4 + 1] = v * 0.6; dd[i * 4 + 2] = 0; dd[i * 4 + 3] = 255; }
        out.ghostHeat = await toUrl(dd);
      }
    }
    cam.position.copy(pos0); cam.quaternion.copy(q0); cam.updateMatrixWorld();
    out.firstShot = shots ? undefined : undefined;
    return out;
  }
  /** Roughness-bin masks from the G-buffer (perceptual r within +-0.02 of each bin; `floorOnly`: n.y > 0.9). */
  async function binMasks(bins, floorOnly) {
    const t = P.ssr.gbuffer.gpuTextures();
    const [dep, nr] = await Promise.all([readTex(t.depth), readTex(t.normal)]);
    const inv = P.ssr.gbuffer.conventions.depthInverted;
    const n = dep.w * dep.h;
    const bin = new Int8Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const geo = inv ? dep.data[i] > 0 : dep.data[i] < 1;
      if (!geo) continue;
      if (floorOnly && nr.data[i * 4 + 1] < 0.9) continue;
      const r = nr.data[i * 4 + 3];
      const k = bins.findIndex((b) => Math.abs(r - b) < 0.02);
      if (k >= 0) bin[i] = k;
    }
    // drop px within 2 of a bin change (edges: AA and the strips' borders)
    const out = new Int8Array(n).fill(-1);
    for (let y = 2; y < dep.h - 2; y++) for (let x = 2; x < dep.w - 2; x++) {
      const i = y * dep.w + x; const b = bin[i]; if (b < 0) continue;
      let ok = true;
      for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) if (bin[i + dy * dep.w + dx] !== b) { ok = false; break; }
      if (ok) out[i] = b;
    }
    return out;
  }
  const resetAll = () => { P.ssr.resetHistory(); P.hybrid.resetHistory(); P.aa.reset(); };
  /**
   * W39 task 2 (D49 under AA): per (aa, denoise, bias), per roughness bin, against `ref` (per aa: the
   * mean of `refFrames` raw bias-0 still frames):
   *   still:  warm, then `frames` frames: std (temporal), flicker (mean |x_t - x_t-1|), bias (RMS of mean - ref,
   *           finite-sample noise taken out), rmse (one frame vs ref).
   *   moving: a pendulum orbit (deg / frame, `half` frames each way) through the start pose; at each pass
   *           through it (`passes`) the frame is compared with ref: rmse; d2 = second difference inside each
   *           monotonic half (cancels the smooth motion): mean and % > 4/255.
   */
  async function biasStudy(o = {}) {
    const { aas = ['upscaler', 'off'], denoises = [false, true], biases = [0, 0.25, 0.5, 0.75], bins = [0.1, 0.2, 0.3, 0.4], floorOnly = false,
      frames = 32, refFrames = 256, warm = 60, deg = 0.1, half = 10, passes = 12 } = o;
    P.stop();
    const cam = P.kit.camera; const pos0 = cam.position.clone(); const q0 = cam.quaternion.clone();
    const home = () => { cam.position.copy(pos0); cam.quaternion.copy(q0); cam.updateMatrixWorld(); };
    await P.step(2); await grab();
    const bin = await binMasks(bins, floorOnly);
    const n = W * H;
    const binPx = bins.map((_, k) => { let c = 0; for (let i = 0; i < n; i++) if (bin[i] === k) c++; return c; });
    const results = [];
    for (const aa of aas) {
      P.setAA(aa);
      // reference: raw, bias 0, still
      P.setSettings({ mirrorBias: 0 }); P.setDenoise(false); home(); resetAll();
      for (let i = 0; i < (aa === 'off' ? 2 : 160); i++) await P.step(1);
      const rs = new Float64Array(n), rq = new Float64Array(n);
      for (let f = 0; f < refFrames; f++) { const x = await grab(); for (let i = 0; i < n; i++) if (bin[i] >= 0) { rs[i] += x[i]; rq[i] += x[i] * x[i]; } }
      const ref = new Float64Array(n), refVar = new Float64Array(n);
      for (let i = 0; i < n; i++) if (bin[i] >= 0) { ref[i] = rs[i] / refFrames; refVar[i] = Math.max(0, rq[i] / refFrames - ref[i] ** 2); }
      for (const dn of denoises) for (const b of biases) {
        P.setSettings({ mirrorBias: b }); P.setDenoise(dn); home(); resetAll();
        for (let i = 0; i < warm; i++) await P.step(1);
        const sum = new Float64Array(n), sq = new Float64Array(n), fl = new Float64Array(n), se = new Float64Array(n); let prev = null;
        for (let f = 0; f < frames; f++) {
          const x = await grab();
          for (let i = 0; i < n; i++) { if (bin[i] < 0) continue; const v = x[i]; sum[i] += v; sq[i] += v * v; se[i] += (v - ref[i]) ** 2; if (prev) fl[i] += Math.abs(v - prev[i]); }
          prev = x;
        }
        // pendulum
        const mse = new Float64Array(n), msum = new Float64Array(n), msq = new Float64Array(n);
        const d2s = bins.map(() => ({ s: 0, c: 0, o: 0 }));
        for (let p = 0; p < passes; p++) {
          for (const dir of [1, -1, -1, 1]) {
            let a = null, bb = null;
            for (let i = 0; i < half / 2; i++) {
              rotate(dir * deg);
              const x = await grab();
              if (a && bb) for (let j = 0; j < n; j++) { const k = bin[j]; if (k < 0) continue; const d = Math.abs(x[j] - 2 * bb[j] + a[j]); d2s[k].s += d; d2s[k].c++; if (d > 4) d2s[k].o++; }
              a = bb; bb = x;
            }
          }
          // back at the start pose (rotations cancel; snap to remove drift) and still moving: this frame is the sample
          home();
          const x = await grab();
          for (let i = 0; i < n; i++) { if (bin[i] < 0) continue; const v = x[i]; mse[i] += (v - ref[i]) ** 2; msum[i] += v; msq[i] += v * v; }
        }
        const per = bins.map((bv, k) => {
          let px = 0, std = 0, flick = 0, d2 = 0, vv = 0, vr = 0, e2 = 0, sg = 0, me2 = 0, md2 = 0, mv = 0;
          for (let i = 0; i < n; i++) {
            if (bin[i] !== k) continue;
            px++;
            const m = sum[i] / frames, v = Math.max(0, sq[i] / frames - m * m) * frames / (frames - 1);
            std += Math.sqrt(v); flick += fl[i] / (frames - 1); vv += v; vr += refVar[i];
            const d = m - ref[i]; d2 += d * d; sg += d; e2 += se[i] / frames;
            const mm = msum[i] / passes, mvv = Math.max(0, msq[i] / passes - mm * mm) * passes / (passes - 1);
            me2 += mse[i] / passes; md2 += (mm - ref[i]) ** 2; mv += mvv;
          }
          if (!px) return { roughness: bv, px: 0 };
          const r = (x) => Number(x.toFixed(3));
          return {
            roughness: bv, px,
            still: { std: r(std / px), flicker: r(flick / px), bias: r(Math.sqrt(Math.max(0, d2 / px - vv / px / frames - vr / px / refFrames))), signed: r(sg / px), rmse: r(Math.sqrt(e2 / px)) },
            moving: { rmse: r(Math.sqrt(me2 / px)), bias: r(Math.sqrt(Math.max(0, md2 / px - mv / px / passes))), std: r(Math.sqrt(mv / px)), d2: r(d2s[k].s / Math.max(1, d2s[k].c)), pctD2Over4: r((100 * d2s[k].o) / Math.max(1, d2s[k].c)) },
          };
        });
        results.push({ aa, denoise: dn, mirrorBias: b, bins: per });
      }
    }
    home(); P.setSettings({ mirrorBias: 0 }); P.setDenoise(true); P.setAA('upscaler'); resetAll();
    return { size: [W, H], frames, refFrames, warm, deg, half, passes, binPx, results };
  }
  /**
   * W39 task 3: specular occlusion off / on against a traced reference. Reference: every pixel traced
   * (roughnessThreshold 1, SSR then the ray-traced fallback, hits carry their own visibility), raw
   * (no denoiser), the mean of `refFrames` still frames. Tests: the page's defaults (threshold 0.447,
   * no RT, denoiser on), specOcc off / on, mean of `frames` after `warm`. Masks: AO bands from the
   * page's GTAO (the 'ao' view), geometry; per mask mean |test - ref| and the signed mean (8-bit luma).
   */
  async function soStudy(o = {}) {
    const { refFrames = 256, frames = 16, warm = 90, shots = false } = o;
    P.stop();
    let rgbMean = null;
    const meanOf = async (cnt) => {
      let acc = null; const rgb = new Float64Array(W * H * 4 || 1);
      for (let f = 0; f < cnt; f++) { const g = await grab(true); const x = g.l; if (!acc) acc = new Float64Array(x.length); for (let i = 0; i < x.length; i++) acc[i] += x[i]; if (rgb.length === g.d.length) for (let i = 0; i < g.d.length; i++) rgb[i] += g.d[i]; }
      for (let i = 0; i < acc.length; i++) acc[i] /= cnt;
      rgbMean = rgb.map((v) => v / cnt);
      return acc;
    };
    const keepThr = P.ssr.settings.roughnessThreshold;
    P.setSpecOcc(true); P.setView('ao'); for (let i = 0; i < 3; i++) await P.step(1);
    const aoL = await grab();
    P.setView('final');
    await P.step(1);
    const t = P.ssr.gbuffer.gpuTextures(); const dep = await readTex(t.depth);
    const inv = P.ssr.gbuffer.conventions.depthInverted;
    const n = W * H;
    const geo = new Uint8Array(n); for (let i = 0; i < n; i++) geo[i] = (inv ? dep.data[i] > 0 : dep.data[i] < 1) ? 1 : 0;
    const band = (th) => geo.map((g, i) => (g && aoL[i] < th * 255 ? 1 : 0));
    const nrm = await readTex(t.normal);
    const rough = (i) => nrm.data[i * 4 + 3];
    const b8 = band(0.8);
    const M = {
      geometry: geo, 'ao<0.95': band(0.95), 'ao<0.8': b8, 'ao<0.6': band(0.6),
      'ao<0.8 r<0.1': b8.map((v, i) => (v && rough(i) < 0.1 ? 1 : 0)),
      'ao<0.8 r.1-.447': b8.map((v, i) => (v && rough(i) >= 0.1 && rough(i) < 0.447 ? 1 : 0)),
      'ao<0.8 r>=.447': b8.map((v, i) => (v && rough(i) >= 0.447 ? 1 : 0)),
    };
    P.setSpecOcc(false); P.setSettings({ roughnessThreshold: 1 }); P.setRT(true); P.setDenoise(false); resetAll();
    for (let i = 0; i < 4; i++) await P.step(1);
    const ref = await meanOf(refFrames);
    let refUrl;
    if (shots) { const c = new Uint8ClampedArray(n * 4); for (let i = 0; i < n * 4; i++) c[i] = (i & 3) === 3 ? 255 : rgbMean[i]; refUrl = await toUrl(c); }
    if (keepThr === undefined) delete P.ssr.settings.roughnessThreshold; else P.setSettings({ roughnessThreshold: keepThr });
    P.setRT(false); P.setDenoise(true);
    const out = { size: [W, H], px: Object.fromEntries(Object.entries(M).map(([k, v]) => [k, count(v)])), tests: {} };
    for (const so of [false, true]) {
      P.setSpecOcc(so); resetAll();
      for (let i = 0; i < warm; i++) await P.step(1);
      const m = await meanOf(frames);
      out.tests[so ? 'on' : 'off'] = Object.fromEntries(Object.entries(M).map(([k, mask]) => {
        let px = 0, a = 0, s = 0;
        for (let i = 0; i < n; i++) if (mask[i]) { const d = m[i] - ref[i]; px++; a += Math.abs(d); s += d; }
        return [k, { mad: Number((a / Math.max(1, px)).toFixed(3)), signed: Number((s / Math.max(1, px)).toFixed(3)) }];
      }));
    }
    P.setSpecOcc(false); resetAll();
    if (shots) out.refShot = refUrl;
    return out;
  }
  window.__w39 = { grab, masks, measure, rotate, readTex, restStats, orbitStats, heat, toUrl, decode, binMasks, biasStudy, soStudy, get size() { return [W, H]; } };
})();
