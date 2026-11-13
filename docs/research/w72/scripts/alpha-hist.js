// W72: histogram of the tracer's extracted alpha (glossy px), to pick a mask.
const dev = P.ssr.device;
await P.step(4);
const t = P.ssr.tracer.outputs.extractedRoughness;
const bpr = Math.ceil(t.width * 4 / 256) * 256;
const buf = dev.createBuffer({ size: bpr * t.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const enc = dev.createCommandEncoder(); enc.copyTextureToBuffer({ texture: t }, { buffer: buf, bytesPerRow: bpr }, [t.width, t.height]); dev.queue.submit([enc.finish()]);
await buf.mapAsync(GPUMapMode.READ);
const h = {}; const raw = buf.getMappedRange();
for (let y = 0; y < t.height; y++) { const f = new Float32Array(raw, y * bpr, t.width); for (const a of f) { if (a <= 0 || a >= 0.2) continue; const k = (Math.round(Math.sqrt(a) * 100) / 100).toFixed(2); h[k] = (h[k] ?? 0) + 1; } }
buf.unmap();
return Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 12);
