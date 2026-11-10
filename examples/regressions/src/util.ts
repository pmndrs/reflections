// Shared readback helpers for the regression checks.

export function halfToFloat(h: number) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

export interface TextureData { data: Float32Array; ch: number; width: number; height: number }

/** Read a 2D texture into floats (rg16float, rgba16float, rgba8unorm, r32float). */
export async function readTexture(device: GPUDevice, tex: GPUTexture): Promise<TextureData> {
  const info = ({ rg16float: [4, 2, 'h'], rgba16float: [8, 4, 'h'], rgba8unorm: [4, 4, 'u8'], r32float: [4, 1, 'f'] } as const)[tex.format as 'rg16float'];
  if (!info) throw new Error(`readTexture: ${tex.format}`);
  const [bytes, ch, kind] = info;
  const bpr = Math.ceil((tex.width * bytes) / 256) * 256;
  const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const e = device.createCommandEncoder();
  e.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  device.queue.submit([e.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const dv = new DataView(buf.getMappedRange());
  const out = new Float32Array(tex.width * tex.height * ch);
  for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) for (let c = 0; c < ch; c++) {
    const o = y * bpr + x * bytes;
    out[(y * tex.width + x) * ch + c] = kind === 'h' ? halfToFloat(dv.getUint16(o + c * 2, true)) : kind === 'f' ? dv.getFloat32(o + c * 4, true) : dv.getUint8(o + c) / 255;
  }
  buf.unmap(); buf.destroy();
  return { data: out, ch, width: tex.width, height: tex.height };
}

/** Read a buffer (COPY_SRC) as u32 words. */
export async function readBufferU32(device: GPUDevice, src: GPUBuffer, size = src.size): Promise<Uint32Array> {
  const r = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const e = device.createCommandEncoder(); e.copyBufferToBuffer(src, 0, r, 0, size); device.queue.submit([e.finish()]);
  await r.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(r.getMappedRange().slice(0)); r.unmap(); r.destroy();
  return out;
}

/** Read a buffer (COPY_SRC) as f32 words. */
export async function readBufferF32(device: GPUDevice, src: GPUBuffer, size = src.size): Promise<Float32Array> {
  return new Float32Array((await readBufferU32(device, src, size)).buffer);
}

/** Collect a device's uncaptured WebGPU errors into `into`. */
export function trackErrors(device: GPUDevice, into: string[]) {
  device.addEventListener('uncapturederror', (e) => { const m = (e as GPUUncapturedErrorEvent).error.message; into.push(m); console.error('[webgpu uncapturederror]', m); });
}
