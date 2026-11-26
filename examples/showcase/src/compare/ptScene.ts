// three scene -> @pmndrs/raytracer scene input for the compare / bench pages' path-traced reference (W89). The published
// @pmndrs/raytracer 0.1.0 has no three adapter (and no `buildGpuScene` / `loadGltf` yet), so this file turns a loaded three
// scene into a `SceneCopyInput`: meshes in object space (positions, indices, normals, uvs, per-triangle materials), one
// instance per mesh / InstancedMesh instance, OpenPBR materials with their textures (RGBA8, decoded on the CPU), the
// brightest directional light as the sun and `scene.environment` (an equirect HDR DataTexture) as the environment map.
//
// What is approximated or dropped is listed in `notes` (and in docs/DIVERGES.md D5453):
// - point lights become small emissive spheres (radius `pointLightRadius`, radiance I / (pi r^2) for intensity I in cd);
//   their `distance` cut-off is not modelled. Spot, hemisphere, ambient and further directional lights are dropped.
// - a texture's transform (offset / repeat / rotation) is baked into the mesh's uvs, from the material's base colour map
//   (or its first map): every map of one material shares it. Normal maps get `normalScale` baked into their texels.
// - clearcoat / sheen / transmission / iridescence maps are factors only; anisotropy is dropped.
import * as THREE from 'three/webgpu';

/** The parts of @pmndrs/raytracer's input types this file builds (structural: the page passes them straight to `buildSceneCopy`). */
export interface PtMesh {
  positions: Float32Array;
  indices: Uint32Array | null;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  triangleMaterials: Uint16Array | null;
}
export interface PtInstance { meshIndex: number; instanceIndex: number; objectToWorld: number[]; material: number }
export interface PtTexture { width: number; height: number; data: Uint8ClampedArray; colorSpace: 'srgb' | 'linear'; wrap: 'repeat' | 'clamp' | 'mirror'; label?: string }
export interface PtSceneInput {
  meshes: PtMesh[];
  instances: PtInstance[];
  materials: Record<string, unknown>[];
  textures: PtTexture[];
  sun: { direction: [number, number, number]; irradiance: [number, number, number] } | null;
  environment: { map: { width: number; height: number; channels: number; data: Float32Array }; scale: number } | { radiance: [number, number, number]; scale: number } | null;
  notes: string[];
}

export interface PtSceneOptions {
  /** Radius of the emissive sphere standing in for a point light, in scene units. Default 0.03. */
  pointLightRadius?: number;
}

const TRIANGLE_MATERIAL_NONE = 0xffff;

function vec3(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) { out[i * 3] = a.getX(i); out[i * 3 + 1] = a.getY(i); out[i * 3 + 2] = a.getZ(i); }
  return out;
}

/** RGBA8 texels of a three texture's image, row 0 = top in glTF's uv convention (a `flipY` texture's rows are flipped). */
function decodeImage(t: THREE.Texture): { width: number; height: number; data: Uint8ClampedArray } | null {
  const img = t.image as { width?: number; height?: number; data?: ArrayLike<number> } | CanvasImageSource | undefined;
  const w = (img as { width?: number })?.width ?? 0, h = (img as { height?: number })?.height ?? 0;
  if (!img || !w || !h) return null;
  let data: Uint8ClampedArray;
  if ('data' in img && img.data) {
    const d = img.data, n = w * h, ch = Math.round(d.length / n);
    const scale = d instanceof Uint8Array || d instanceof Uint8ClampedArray ? 1 : 255;
    data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = c < ch ? d[i * ch + c] * scale : c === 3 ? 255 : d[i * ch] * scale;
  } else {
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img as CanvasImageSource, 0, 0);
    data = g.getImageData(0, 0, w, h).data;
  }
  if (t.flipY) {
    const row = w * 4, tmp = new Uint8ClampedArray(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row, b = (h - 1 - y) * row;
      tmp.set(data.subarray(a, a + row)); data.copyWithin(a, b, b + row); data.set(tmp, b);
    }
  }
  // the scene copy's samplers are trilinear: a small nearest-filtered texture (a 2x2 checker) is blown up with nearest
  // texels first, so its edges stay hard
  if (t.magFilter === THREE.NearestFilter && Math.min(w, h) < 256) {
    const k = Math.ceil(256 / Math.min(w, h)), W = w * k, H = h * k;
    const big = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const s = (Math.floor(y / k) * w + Math.floor(x / k)) * 4, d = (y * W + x) * 4;
      big[d] = data[s]; big[d + 1] = data[s + 1]; big[d + 2] = data[s + 2]; big[d + 3] = data[s + 3];
    }
    return { width: W, height: H, data: big };
  }
  return { width: w, height: h, data };
}

const wrapOf = (t: THREE.Texture): PtTexture['wrap'] => (t.wrapS === THREE.ClampToEdgeWrapping ? 'clamp' : t.wrapS === THREE.MirroredRepeatWrapping ? 'mirror' : 'repeat');

export function ptSceneFromThree(scene: THREE.Scene, options: PtSceneOptions = {}): PtSceneInput {
  scene.updateMatrixWorld(true);
  const notes = new Set<string>();
  const meshes: PtMesh[] = [];
  const instances: PtInstance[] = [];
  const materials: Record<string, unknown>[] = [];
  const textures: PtTexture[] = [];
  const textureIds = new Map<string, number>();
  const materialIds = new Map<THREE.Material, number>();
  const meshIds = new Map<string, number>();
  const geometryKeys = new WeakMap<THREE.BufferGeometry, number>();
  let geometrySerial = 0;

  const addTexture = (key: string, make: () => PtTexture | null): number | undefined => {
    if (textureIds.has(key)) return textureIds.get(key);
    const t = make();
    if (!t) { notes.add(`texture ${key}: not readable on the CPU, dropped`); return undefined; }
    textureIds.set(key, textures.length);
    textures.push(t);
    return textures.length - 1;
  };
  const colorTexture = (t: THREE.Texture | null | undefined, colorSpace: 'srgb' | 'linear') => t
    ? addTexture(`${t.uuid}:${colorSpace}`, () => { const d = decodeImage(t); return d && { ...d, colorSpace, wrap: wrapOf(t), label: t.name || undefined }; })
    : undefined;
  // glTF metallic-roughness: G roughness, B metalness. three's maps may be two textures, or one of them only
  const roughMetalTexture = (rough: THREE.Texture | null, metal: THREE.Texture | null) => {
    if (!rough && !metal) return undefined;
    if (rough && metal && rough === metal) return colorTexture(rough, 'linear');
    return addTexture(`${rough?.uuid ?? '-'}+${metal?.uuid ?? '-'}:rm`, () => {
      const r = rough ? decodeImage(rough) : null, m = metal ? decodeImage(metal) : null;
      const base = r ?? m;
      if (!base) return null;
      const { width, height } = base;
      const data = new Uint8ClampedArray(width * height * 4);
      const at = (d: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number, c: number) =>
        d.data[((Math.floor((y * d.height) / height) * d.width + Math.floor((x * d.width) / width)) * 4) + c];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        data[o] = 0; data[o + 1] = r ? at(r, x, y, 1) : 255; data[o + 2] = m ? at(m, x, y, 2) : 255; data[o + 3] = 255;
      }
      return { width, height, data, colorSpace: 'linear', wrap: wrapOf((rough ?? metal)!) };
    });
  };
  const normalTexture = (t: THREE.Texture | null, scale: THREE.Vector2 | undefined) => {
    if (!t) return undefined;
    const sx = scale?.x ?? 1, sy = scale?.y ?? 1;
    if (sx === 1 && sy === 1) return colorTexture(t, 'linear');
    return addTexture(`${t.uuid}:n${sx},${sy}`, () => {
      const d = decodeImage(t);
      if (!d) return null;
      const out = new Uint8ClampedArray(d.data.length);
      for (let i = 0; i < d.data.length; i += 4) {
        const x = (d.data[i] / 255 * 2 - 1) * sx, y = (d.data[i + 1] / 255 * 2 - 1) * sy, z = d.data[i + 2] / 255 * 2 - 1;
        const l = Math.hypot(x, y, z) || 1;
        out[i] = (x / l * 0.5 + 0.5) * 255; out[i + 1] = (y / l * 0.5 + 0.5) * 255; out[i + 2] = (z / l * 0.5 + 0.5) * 255; out[i + 3] = 255;
      }
      return { width: d.width, height: d.height, data: out, colorSpace: 'linear', wrap: wrapOf(t) };
    });
  };

  const materialOf = (mat: THREE.Material): number => {
    let id = materialIds.get(mat);
    if (id !== undefined) return id;
    const m = mat as THREE.MeshPhysicalMaterial;
    const rgb = (c: THREE.Color | undefined, k = 1): [number, number, number] => (c ? [c.r * k, c.g * k, c.b * k] : [0, 0, 0]);
    const out: Record<string, unknown> = {};
    const pbr = typeof m.metalness === 'number' && typeof m.roughness === 'number';
    out.baseColor = rgb(m.color ?? new THREE.Color(0.5, 0.5, 0.5));
    out.metalness = pbr ? m.metalness : 0;
    out.specularRoughness = pbr ? m.roughness : 1;
    if (!pbr) out.specularWeight = 0;
    const set = (k: string, v: number | undefined) => { if (v !== undefined) out[k] = v; };
    set('baseColorTexture', colorTexture(m.map, 'srgb'));
    if (pbr) set('roughnessMetalTexture', roughMetalTexture(m.roughnessMap ?? null, m.metalnessMap ?? null));
    set('normalTexture', normalTexture(m.normalMap ?? null, m.normalScale));
    if (m.emissive) {
      const k = m.emissiveIntensity ?? 1;
      if (k > 0 && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0)) {
        out.emissionColor = rgb(m.emissive, k);
        set('emissionTexture', colorTexture(m.emissiveMap, 'srgb'));
      }
    }
    if (m.isMeshPhysicalMaterial) {
      out.ior = m.ior ?? 1.5;
      out.specularWeight = m.specularIntensity ?? 1;
      out.specularColor = rgb(m.specularColor ?? new THREE.Color(1, 1, 1));
      if (m.clearcoat > 0) { out.coatWeight = m.clearcoat; out.coatRoughness = m.clearcoatRoughness; out.coatIor = 1.5; if (m.clearcoatMap || m.clearcoatRoughnessMap || m.clearcoatNormalMap) notes.add('clearcoat maps: factors only'); }
      if (m.transmission > 0) {
        out.transmissionWeight = m.transmission;
        out.thinWalled = !(m.thickness > 0);
        if (m.thickness > 0 && Number.isFinite(m.attenuationDistance)) { out.transmissionColor = rgb(m.attenuationColor); out.transmissionDepth = m.attenuationDistance; }
        if (m.transmissionMap || m.thicknessMap) notes.add('transmission / thickness maps: factors only');
      }
      if (m.sheen > 0) { out.sheenWeight = m.sheen; out.sheenColor = rgb(m.sheenColor); out.sheenRoughness = m.sheenRoughness; }
      if (m.iridescence > 0) { out.thinFilmWeight = m.iridescence; out.thinFilmThickness = (m.iridescenceThicknessRange?.[1] ?? 400) / 1000; out.thinFilmIor = m.iridescenceIOR ?? 1.3; }
      if (m.anisotropy > 0) notes.add('anisotropy: dropped (isotropic GGX)');
    }
    if (m.alphaTest > 0) { out.alphaMode = 1; out.alphaCutoff = m.alphaTest; out.opacity = m.opacity; }
    else if (m.transparent && m.opacity < 1) notes.add('alpha blend: rendered opaque');
    if (m.side === THREE.DoubleSide) out.doubleSided = true;
    id = materials.length;
    materials.push(out);
    materialIds.set(mat, id);
    return id;
  };

  /** One mesh per geometry, material set and uv transform (the transform is baked into its uvs). */
  const meshOf = (mesh: THREE.Mesh): { index: number; material: number } | null => {
    const g = mesh.geometry;
    const position = g?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position || position.count < 3) return null;
    const list = ([] as THREE.Material[]).concat(mesh.material);
    const multi = Array.isArray(mesh.material) && g.groups.length > 0;
    const ids = list.map(materialOf);
    const first = list[0] as THREE.MeshStandardMaterial;
    const mapT = first?.map ?? first?.normalMap ?? first?.roughnessMap ?? first?.emissiveMap ?? null;
    if (mapT) mapT.updateMatrix();
    const uvMatrix = mapT && !mapT.matrix.equals(new THREE.Matrix3()) ? mapT.matrix : null;
    let gk = geometryKeys.get(g);
    if (gk === undefined) geometryKeys.set(g, gk = geometrySerial++);
    const key = `${gk}|${multi ? ids.join(',') : ''}|${uvMatrix ? uvMatrix.elements.join(',') : ''}`;
    const cached = meshIds.get(key);
    if (cached !== undefined) return { index: cached, material: ids[0] };
    const index = g.getIndex();
    let indices = index ? Uint32Array.from(index.array as ArrayLike<number>) : null;
    if (indices && indices.length % 3) indices = indices.slice(0, indices.length - (indices.length % 3));
    const normal = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    let uvs: Float32Array | null = null;
    if (uv && uv.count === position.count) {
      uvs = new Float32Array(uv.count * 2);
      const v = new THREE.Vector2();
      for (let i = 0; i < uv.count; i++) {
        v.set(uv.getX(i), uv.getY(i));
        if (uvMatrix) v.applyMatrix3(uvMatrix);
        uvs[i * 2] = v.x; uvs[i * 2 + 1] = v.y;
      }
    }
    let triangleMaterials: Uint16Array | null = null;
    if (multi) {
      const count = index ? index.count : position.count;
      triangleMaterials = new Uint16Array(Math.floor(count / 3)).fill(TRIANGLE_MATERIAL_NONE);
      const { start: ds, count: dc } = g.drawRange;
      for (const group of g.groups) {
        const s = Math.max(group.start, ds), e = Math.min(count, group.start + group.count, ds + dc);
        const id = ids[group.materialIndex ?? 0];
        if (id === undefined) continue;
        for (let j = s; j < e; j += 3) { const t = Math.floor(j / 3); if (triangleMaterials[t] === TRIANGLE_MATERIAL_NONE) triangleMaterials[t] = id; }
      }
    }
    const out = meshes.length;
    meshes.push({ positions: vec3(position), indices, normals: normal && normal.count === position.count ? vec3(normal) : null, uvs, triangleMaterials });
    meshIds.set(key, out);
    return { index: out, material: ids[0] };
  };

  let sun: PtSceneInput['sun'] = null, sunLum = 0, directional = 0;
  const pointLights: THREE.PointLight[] = [];
  const m4 = new THREE.Matrix4();
  scene.traverseVisible((o) => {
    const light = o as THREE.Light & { isDirectionalLight?: boolean; isPointLight?: boolean; isSpotLight?: boolean; isHemisphereLight?: boolean; isAmbientLight?: boolean };
    if (light.isDirectionalLight) {
      directional++;
      const l = light as THREE.DirectionalLight;
      const lum = (0.2126 * l.color.r + 0.7152 * l.color.g + 0.0722 * l.color.b) * l.intensity;
      if (lum > sunLum) {
        const p = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld), t = new THREE.Vector3().setFromMatrixPosition(l.target.matrixWorld);
        const d = t.sub(p).normalize();
        sunLum = lum;
        sun = { direction: [d.x, d.y, d.z], irradiance: [l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity] };
      }
      return;
    }
    if (light.isPointLight) { pointLights.push(light as THREE.PointLight); return; }
    if (light.isSpotLight) { notes.add('spot lights: dropped'); return; }
    if (light.isHemisphereLight || light.isAmbientLight) { if (light.intensity > 0) notes.add('hemisphere / ambient lights: dropped'); return; }
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as unknown as { isHelper?: boolean }).isHelper) return;
    if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh || mesh.morphTargetInfluences?.length) notes.add('skinning / morph targets: bind pose');
    const built = meshOf(mesh);
    if (!built) return;
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m4);
        instances.push({ meshIndex: built.index, instanceIndex: instances.length, objectToWorld: new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, m4).toArray(), material: built.material });
      }
    } else instances.push({ meshIndex: built.index, instanceIndex: instances.length, objectToWorld: mesh.matrixWorld.toArray(), material: built.material });
  });
  if (directional > 1) notes.add(`${directional} directional lights: the brightest is the sun, the others are dropped`);

  // point lights -> emissive spheres (intensity in candela: radiance I / (pi r^2) gives the same intensity far away)
  if (pointLights.length) {
    const r = options.pointLightRadius ?? 0.03;
    const sphere = new THREE.IcosahedronGeometry(r, 2);
    const mi = meshes.length;
    meshes.push({ positions: vec3(sphere.getAttribute('position') as THREE.BufferAttribute), indices: sphere.getIndex() ? Uint32Array.from(sphere.getIndex()!.array as ArrayLike<number>) : null, normals: vec3(sphere.getAttribute('normal') as THREE.BufferAttribute), uvs: null, triangleMaterials: null });
    for (const l of pointLights) {
      const k = l.intensity / (Math.PI * r * r);
      const id = materials.length;
      materials.push({ baseColor: [0, 0, 0], specularWeight: 0, emissionColor: [l.color.r * k, l.color.g * k, l.color.b * k] });
      const p = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld);
      instances.push({ meshIndex: mi, instanceIndex: instances.length, objectToWorld: new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).toArray(), material: id });
    }
    notes.add(`${pointLights.length} point lights as emissive spheres (r ${r}; no distance cut-off)`);
  }

  // the environment: an equirect HDR DataTexture (HDRLoader: rgba half floats, row 0 = +Y as in the file). three's equirect u
  // is the raytracer's + 0.25 (three u = atan2(z, x) / 2pi + 0.5, the raytracer's atan2(x, -z) / 2pi): shift the columns
  let environment: PtSceneInput['environment'] = null;
  const env = scene.environment as THREE.DataTexture | null;
  const envScale = scene.environmentIntensity ?? 1;
  const envImg = env?.image as { width?: number; height?: number; data?: ArrayLike<number> } | undefined;
  if (env && envImg?.data && envImg.width && envImg.height && env.mapping === THREE.EquirectangularReflectionMapping) {
    const { width: w, height: h, data: d } = envImg as { width: number; height: number; data: ArrayLike<number> };
    const ch = Math.round(d.length / (w * h));
    const half = d instanceof Uint16Array;
    const rgb = new Float32Array(w * h * 3);
    const shift = Math.round(w / 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const src = (y * w + ((x + shift) % w)) * ch, dst = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) { const v = d[src + Math.min(c, ch - 1)]; rgb[dst + c] = half ? THREE.DataUtils.fromHalfFloat(v) : v; }
    }
    environment = { map: { width: w, height: h, channels: 3, data: rgb }, scale: envScale };
    const rot = scene.environmentRotation;
    if (rot && (rot.x || rot.y || rot.z)) notes.add('scene.environmentRotation: not applied');
  } else if (env) notes.add('scene.environment is not an equirect DataTexture with CPU data: no environment');
  return { meshes, instances, materials, textures, sun, environment, notes: [...notes] };
}
