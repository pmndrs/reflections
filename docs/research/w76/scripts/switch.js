// W76: the half-res runtime switch check (full -> half -> full) by hand, with a prelude SET (settings) and optional SKIP_HALF.
P.stop?.();
await P.load('contact');
if (typeof SET !== 'undefined') Object.assign(P.ssr.settings, SET);
const ready = async () => { for (let i = 0; i < 60 && (P.ssr.settings.hitColorFilter ?? 'cone') === 'cone' && !P.ssr.tracer?.outputs.hitColorFilterActive; i++) { await P.step(1); await new Promise((r) => setTimeout(r, 100)); } };
const shot = async () => { await ready(); Object.assign(P.ssr.settings, { frameIndex: 5, minTraversalOccupancy: 0 }); P.ssr.resetHistory(); P.hybrid.resetHistory(); await P.step(24); return P.shot(); };
const f0 = await shot();
const tr0 = P.ssr.tracer;
if (typeof SKIP_HALF === 'undefined') { await P.setResolution('half'); await shot(); await P.setResolution('full'); }
const f2 = await shot();
const f3 = await shot();
const img = async (u) => { const im = new Image(); im.src = u; await im.decode(); const c = new OffscreenCanvas(im.width, im.height); const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height).data; };
const [a, b, c] = await Promise.all([img(f0), img(f2), img(f3)]);
const d = (p, q) => { let m = 0, s = 0; for (let i = 0; i < p.length; i += 4) { const v = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])); m = Math.max(m, v); s += v; } return { max: m, mean: +(s / (p.length / 4)).toFixed(4) }; };
log({ set: typeof SET !== 'undefined' ? SET : null, f0f2: d(a, b), f2f3: d(b, c), f0f3: d(a, c), newTracer: tr0 !== P.ssr.tracer });
