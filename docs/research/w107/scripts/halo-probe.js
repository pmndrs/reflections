// W107: on the ssr page (?manual&rt=1&denoise=0&aa=off&scene=...), share of px darker / brighter than off with lobe
// occlusion (HALO_FRAME's logic from scripts/run-headless.mjs).
const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
const frame = async (trace) => { P.setSettings({ frameIndex: 7 }); P.setTraceSettings(trace); P.setView('final'); await P.step(4); return px(await P.shot()); };
const A = await frame({});
const A2 = await frame({});
const lum = (a, k) => 0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2];
const cmp = (B) => { let d = 0, b = 0, n = 0; for (let k = 0; k < A.length; k += 4) { n++; const x = lum(B, k) - lum(A, k); if (x < -2) d++; else if (x > 2) b++; } return { darker: +(d / n * 100).toFixed(3), brighter: +(b / n * 100).toFixed(3) }; };
const out = { repeat: cmp(A2) };
for (const r of [2, 4]) out['lobe ' + r] = cmp(await frame({ hitLobeOcclusionRays: r }));
out['lobe 4 vis all'] = cmp(await frame({ hitLobeOcclusionRays: 4, hitShadeVisibility: 'all' }));
out.stats = await P.traceStats();
return { out, errors: (P.gpuErrors ?? []).slice?.(0, 3) };
