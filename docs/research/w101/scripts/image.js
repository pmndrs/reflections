// W101: at rest, minTraversalOccupancy 4 vs 0 on one page, configs alternating (A B A B ...). Per run: set the
// config, drop history, render W frames (loop stopped), then 8 consecutive frames: the frame-to-frame change
// (8-bit luma: mean, % px > 1/255, max) = the rest flicker; the last frame kept. Then the image change between
// configs (last frames, per channel mean / max / % px > 8) next to the same config's two runs (the noise floor).
// prelude: TAG, optional SHOWCASE, RT, POSE, PRESET, RUNS (per config, default 2), WARM (default 90)
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p && window.__p.ssr && window.__p.step); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
if (typeof SHOWCASE !== 'undefined') { await S.setSources?.({ rt: typeof RT !== 'undefined' && !!RT }); if (typeof POSE !== 'undefined') S.setPose(POSE); }
S.stop?.();
if (typeof PRESET !== 'undefined' && S.setPreset) S.setPreset(PRESET);
const runs = typeof RUNS !== 'undefined' ? RUNS : 2, warm = typeof WARM !== 'undefined' ? WARM : 90;
const configs = [['occ4', 4], ['occ0', 0]];
const decode = async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
const luma = (d) => { const l = new Float32Array(d.length / 4); for (let i = 0; i < l.length; i++) l[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2]; return l; };
const diff = (a, b) => { let s = 0, mx = 0, over = 0, n = 0; for (let k = 0; k < a.length; k++) { if ((k & 3) === 3) continue; const d = Math.abs(a[k] - b[k]); s += d; if (d > mx) mx = d; n++; } for (let i = 0; i < a.length; i += 4) { if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 8) over++; } return { mean: +(s / n).toFixed(4), max: mx, over8pct: +(over / (a.length / 4) * 100).toFixed(3) }; };
const last = Object.fromEntries(configs.map(([n]) => [n, []]));
const rest = Object.fromEntries(configs.map(([n]) => [n, []]));
for (let k = 0; k < runs; k++) {
  for (const [name, occ] of (k % 2 ? [...configs].reverse() : configs)) {
    S.ssr.settings.minTraversalOccupancy = occ;
    S.ssr.resetHistory?.(); S.hybrid?.resetHistory?.(); S.aa?.reset?.();
    await S.step(warm);
    let prev = null, acc = null, n = 0, mx = 0, d = null;
    for (let f = 0; f < 8; f++) {
      d = await decode(await S.shot());
      const l = luma(d);
      if (prev) { acc ??= new Float32Array(l.length); for (let i = 0; i < l.length; i++) { const v = Math.abs(l[i] - prev[i]); acc[i] += v; if (v > mx) mx = v; } n++; }
      prev = l;
    }
    let sum = 0, over = 0; for (let i = 0; i < acc.length; i++) { sum += acc[i] / n; if (acc[i] / n > 1) over++; }
    rest[name].push({ mean: +(sum / acc.length).toFixed(4), over1pct: +(over / acc.length * 100).toFixed(3), max: +mx.toFixed(1) });
    last[name].push(d);
  }
}
const cross = [], floor4 = [], floor0 = [];
for (let k = 0; k < runs; k++) cross.push(diff(last.occ4[k], last.occ0[k]));
for (let k = 1; k < runs; k++) { floor4.push(diff(last.occ4[0], last.occ4[k])); floor0.push(diff(last.occ0[0], last.occ0[k])); }
log({ tag: TAG, rest, cross, floor4, floor0 });
delete S.ssr.settings.minTraversalOccupancy;
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors ?? []).slice(0, 3) };
