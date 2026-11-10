// Geometry for the adapter's 3-D layer: interleaved position (3), normal (3), uv (2) floats and
// u32 indices, counter-clockwise front faces. A few builders cover the demos; anything else (a glTF
// mesh, a pixi MeshGeometry lifted to 3-D) can be passed as raw arrays.

export interface GeometryData {
  /** 8 floats per vertex: px py pz nx ny nz u v. */
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
}

/** Stride of one vertex in bytes. */
export const VERTEX_STRIDE = 32;

/** The GPU side of a GeometryData, created once per device. */
export class Geometry {
  readonly data: GeometryData;
  private gpu: { device: GPUDevice; vertex: GPUBuffer; index: GPUBuffer } | null = null;

  constructor(data: GeometryData) { this.data = data; }

  get indexCount() { return this.data.indices.length; }

  buffers(device: GPUDevice): { vertex: GPUBuffer; index: GPUBuffer } {
    if (this.gpu?.device === device) return this.gpu;
    this.gpu?.vertex.destroy();
    this.gpu?.index.destroy();
    const make = (data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number, label: string) => {
      const b = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    this.gpu = {
      device,
      vertex: make(this.data.vertices, GPUBufferUsage.VERTEX, 'pixi reflections: vertices'),
      index: make(this.data.indices, GPUBufferUsage.INDEX, 'pixi reflections: indices'),
    };
    return this.gpu;
  }

  dispose() {
    this.gpu?.vertex.destroy();
    this.gpu?.index.destroy();
    this.gpu = null;
  }

  /** An axis-aligned box centred on the origin. */
  static box(width = 1, height = 1, depth = 1): Geometry {
    const v: number[] = [], idx: number[] = [];
    const face = (n: [number, number, number], u: [number, number, number], w: [number, number, number], su: number, sv: number, sn: number) => {
      const base = v.length / 8;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        v.push(n[0] * sn + u[0] * a * su + w[0] * b * sv, n[1] * sn + u[1] * a * su + w[1] * b * sv, n[2] * sn + u[2] * a * su + w[2] * b * sv,
          n[0], n[1], n[2], (a + 1) / 2, (1 - b) / 2);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const [hx, hy, hz] = [width / 2, height / 2, depth / 2];
    face([1, 0, 0], [0, 0, -1], [0, 1, 0], hz, hy, hx);
    face([-1, 0, 0], [0, 0, 1], [0, 1, 0], hz, hy, hx);
    face([0, 1, 0], [1, 0, 0], [0, 0, -1], hx, hz, hy);
    face([0, -1, 0], [1, 0, 0], [0, 0, 1], hx, hz, hy);
    face([0, 0, 1], [1, 0, 0], [0, 1, 0], hx, hy, hz);
    face([0, 0, -1], [-1, 0, 0], [0, 1, 0], hx, hy, hz);
    return new Geometry({ vertices: new Float32Array(v), indices: new Uint32Array(idx) });
  }

  /**
   * A plane facing +Z (a panel, a wall), uv (0, 0) at the top-left so a pixi texture (row 0 on top)
   * reads upright. Rotate it by -PI/2 about X for a floor.
   */
  static plane(width = 1, height = 1): Geometry {
    const [hx, hy] = [width / 2, height / 2];
    return new Geometry({
      vertices: new Float32Array([
        -hx, -hy, 0, 0, 0, 1, 0, 1,
        hx, -hy, 0, 0, 0, 1, 1, 1,
        hx, hy, 0, 0, 0, 1, 1, 0,
        -hx, hy, 0, 0, 0, 1, 0, 0,
      ]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
  }

  static sphere(radius = 0.5, widthSegments = 48, heightSegments = 32): Geometry {
    const v: number[] = [], idx: number[] = [];
    for (let y = 0; y <= heightSegments; y++) {
      const t = y / heightSegments, phi = t * Math.PI;
      for (let x = 0; x <= widthSegments; x++) {
        const s = x / widthSegments, theta = s * Math.PI * 2;
        const nx = -Math.cos(theta) * Math.sin(phi), ny = Math.cos(phi), nz = Math.sin(theta) * Math.sin(phi);
        v.push(nx * radius, ny * radius, nz * radius, nx, ny, nz, s, t);
      }
    }
    const row = widthSegments + 1;
    for (let y = 0; y < heightSegments; y++) for (let x = 0; x < widthSegments; x++) {
      const a = y * row + x, b = a + row;
      if (y !== 0) idx.push(a, b, a + 1);
      if (y !== heightSegments - 1) idx.push(a + 1, b, b + 1);
    }
    return new Geometry({ vertices: new Float32Array(v), indices: new Uint32Array(idx) });
  }

  static torus(radius = 0.5, tube = 0.18, radialSegments = 32, tubularSegments = 96): Geometry {
    const v: number[] = [], idx: number[] = [];
    for (let j = 0; j <= radialSegments; j++) for (let i = 0; i <= tubularSegments; i++) {
      const u = (i / tubularSegments) * Math.PI * 2, w = (j / radialSegments) * Math.PI * 2;
      const cx = radius * Math.cos(u), cy = radius * Math.sin(u);
      const px = (radius + tube * Math.cos(w)) * Math.cos(u), py = (radius + tube * Math.cos(w)) * Math.sin(u), pz = tube * Math.sin(w);
      const n = [px - cx, py - cy, pz], l = Math.hypot(n[0], n[1], n[2]);
      v.push(px, py, pz, n[0] / l, n[1] / l, n[2] / l, i / tubularSegments, j / radialSegments);
    }
    const row = tubularSegments + 1;
    for (let j = 1; j <= radialSegments; j++) for (let i = 1; i <= tubularSegments; i++) {
      const a = row * j + i - 1, b = row * (j - 1) + i - 1, c = row * (j - 1) + i, d = row * j + i;
      idx.push(a, b, d, b, c, d);
    }
    return new Geometry({ vertices: new Float32Array(v), indices: new Uint32Array(idx) });
  }

  /** A capped cylinder along Y, centred on the origin. */
  static cylinder(radius = 0.5, height = 1, segments = 48): Geometry {
    const v: number[] = [], idx: number[] = [];
    const h = height / 2;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2, x = Math.sin(a), z = Math.cos(a);
      v.push(x * radius, -h, z * radius, x, 0, z, i / segments, 1, x * radius, h, z * radius, x, 0, z, i / segments, 0);
    }
    for (let i = 0; i < segments; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    for (const [y, ny] of [[h, 1], [-h, -1]]) {
      const c = v.length / 8;
      v.push(0, y, 0, 0, ny, 0, 0.5, 0.5);
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2, x = Math.sin(a), z = Math.cos(a);
        v.push(x * radius, y, z * radius, 0, ny, 0, x * 0.5 + 0.5, z * 0.5 + 0.5);
      }
      for (let i = 0; i < segments; i++) ny > 0 ? idx.push(c, c + 1 + i, c + 2 + i) : idx.push(c, c + 2 + i, c + 1 + i);
    }
    return new Geometry({ vertices: new Float32Array(v), indices: new Uint32Array(idx) });
  }
}
