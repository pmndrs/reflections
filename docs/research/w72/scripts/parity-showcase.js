// W72 default-identical (showcase): carConcept at W50's view, RT on, denoised; FNV hash of the final image
// after 20 frames, occupancy exit off (deterministic). Optional EXTRA settings for the tracer.
// node drive.mjs 'http://127.0.0.1:5444/showcase/?manual&scene=carConcept&rt=1&aa=off&w=960&h=540' <out> parity-showcase.js
const hashU8 = (b) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
const extra = typeof EXTRA === 'undefined' ? {} : EXTRA;
P.stop(); await P.setSources({ rt: true }); P.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
Object.assign(P.ssr.settings, { minTraversalOccupancy: 0, ...extra });
await P.step(20);
const shots = [];
for (let k = 0; k < 2; k++) { shots.push(hashU8(await px(await P.shot()))); }
log({ carConcept: shots, errors: P.gpuErrors?.length ?? null });
