// W107: the ssr-rt lobe check's sequence on the ssr page, every step against the first frame.
const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
const frame = async (trace) => { P.setSettings({ frameIndex: 7, hitShadeOcclusion: 'off', hitLobeFilterMixed: 1 }); P.setTraceSettings(trace); P.setView('final'); await P.step(4); return px(await P.shot()); };
const lum = (a, k) => 0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2];
const cmp = (A, B) => { let d = 0, b = 0, n = 0; for (let k = 0; k < A.length; k += 4) { n++; const x = lum(B, k) - lum(A, k); if (x < -2) d++; else if (x > 2) b++; } return { darker: +(d / n * 100).toFixed(3), brighter: +(b / n * 100).toFixed(3) }; };
const V = { hitShadeVisibility: 'all' };
const A = await frame(V);
const out = {};
out.same = cmp(A, await frame({ ...V, hitLobeOcclusionRays: 0 }));
out.l4 = cmp(A, await frame({ ...V, hitLobeOcclusionRays: 4 }));
out.l4b = cmp(A, await frame({ ...V, hitLobeOcclusionRays: 4 }));
out.back0 = cmp(A, await frame({ ...V, hitLobeOcclusionRays: 0 }));
out.offRef = cmp(A, await frame({}));
return out;
