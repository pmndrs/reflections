// The adapter's 3-D layer: what the G-buffer pass (./gbuffer.ts) draws. pixi.js v8 is a 2-D
// renderer with no depth, normals, roughness or motion of its own (and the pixi 3-D extension is a
// closed beta that exposes none of them either, D2000), so the reflections bring a minimal scene:
// meshes with a metal / roughness material, a perspective camera, one sun and a procedural sky.
//
// The bridge to pixi is the textures: a material's `map`, `emissiveMap` and `roughnessMap` are pixi
// `Texture`s, so a RenderTexture holding pixi content (Text, Graphics, Sprites, a whole Container)
// becomes a lit, reflected surface in 3-D, updated whenever pixi renders into it.
//
// Conventions are three's (the frame contract's): right-handed, Y up, the camera looks down -Z.
import type { Texture } from 'pixi.js';
import type { Geometry } from './geometry';
import { mat4Compose, mat4Invert, mat4LookAt, mat4Perspective, type Mat4, type Vec3 } from './math';

export interface ReflectionMaterialOptions {
  /** Linear base colour (rgb 0..1). Default white. */
  color?: Vec3;
  /** Base colour map (pixi texture, sRGB like everything pixi draws). Multiplies `color`. */
  map?: Texture | null;
  /** Perceptual roughness 0..1. Default 0.5. */
  roughness?: number;
  /** 0..1. Default 0. */
  metalness?: number;
  /**
   * glTF-style metal / roughness map (pixi texture, linear): g scales roughness, b scales metalness.
   * Default none.
   */
  roughnessMap?: Texture | null;
  /** Linear emissive colour. Default black. */
  emissive?: Vec3;
  /** Emissive map (pixi texture, sRGB, premultiplied alpha as pixi renders). Multiplies `emissive`. */
  emissiveMap?: Texture | null;
  /** Scales `emissive`. Default 1. */
  emissiveIntensity?: number;
  /** uv repeat for every map. Default [1, 1]. */
  uvScale?: readonly [number, number];
}

export class ReflectionMaterial {
  color: Vec3;
  map: Texture | null;
  roughness: number;
  metalness: number;
  roughnessMap: Texture | null;
  emissive: Vec3;
  emissiveMap: Texture | null;
  emissiveIntensity: number;
  uvScale: readonly [number, number];

  constructor(o: ReflectionMaterialOptions = {}) {
    this.color = o.color ?? [1, 1, 1];
    this.map = o.map ?? null;
    this.roughness = o.roughness ?? 0.5;
    this.metalness = o.metalness ?? 0;
    this.roughnessMap = o.roughnessMap ?? null;
    this.emissive = o.emissive ?? [0, 0, 0];
    this.emissiveMap = o.emissiveMap ?? null;
    this.emissiveIntensity = o.emissiveIntensity ?? 1;
    this.uvScale = o.uvScale ?? [1, 1];
  }
}

/** A mesh in the 3-D layer: geometry, material and a TRS transform (or a raw `matrix`). */
export class ReflectionMesh {
  geometry: Geometry;
  material: ReflectionMaterial;
  position: [number, number, number] = [0, 0, 0];
  /** Euler XYZ, radians. */
  rotation: [number, number, number] = [0, 0, 0];
  scale: [number, number, number] = [1, 1, 1];
  /** When set, used instead of position / rotation / scale. */
  matrix: Mat4 | null = null;
  visible = true;
  /** Drawn into the sun's shadow map. Default true. */
  castShadow = true;
  /** Drawn into probe captures. Default true. */
  inCaptures = true;
  /** @internal last frame's model matrix (motion vectors). */
  prevModel: Float32Array | null = null;
  private readonly model = new Float32Array(16);

  constructor(geometry: Geometry, material: ReflectionMaterial = new ReflectionMaterial()) {
    this.geometry = geometry;
    this.material = material;
  }

  /** World matrix (column-major). */
  modelMatrix(): Mat4 {
    return this.matrix ?? mat4Compose(this.position, this.rotation, this.scale, this.model);
  }
}

/** A perspective camera (three's PerspectiveCamera conventions; vertical fov in degrees). */
export class ReflectionCamera {
  position: [number, number, number] = [0, 1.5, 5];
  target: [number, number, number] = [0, 1, 0];
  up: Vec3 = [0, 1, 0];
  fov = 50;
  near = 0.05;
  far = 100;
  /** Sub-pixel jitter in pixels (x right, y down); none by default. */
  jitter: readonly [number, number] = [0, 0];

  view(): Mat4 { return mat4LookAt(this.position, this.target, this.up); }
  projection(aspect: number): Mat4 { return mat4Perspective((this.fov * Math.PI) / 180, aspect, this.near, this.far); }
  /** World matrix (inverse view). */
  world(): Mat4 { return mat4Invert(this.view()); }
}

/** Procedural sky: a zenith / horizon / ground gradient and a sun disc (linear HDR). */
export interface SkyOptions {
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
  /** Sun disc colour (added within `sunSize` of the sun direction). */
  sunDisc: Vec3;
  /** Angular radius of the disc (radians). */
  sunSize: number;
}

export interface SunOptions {
  /** Direction *toward* the sun (normalised on use). */
  direction: Vec3;
  /** Linear colour times intensity (three's DirectionalLight colour x intensity). */
  color: Vec3;
  /** Shadow map: a box of `radius` around `center` seen from the sun. Null: no shadows. */
  shadow: { center: Vec3; radius: number; size?: number; bias?: number } | null;
}

/** Everything the G-buffer pass draws. */
export class ReflectionScene {
  meshes: ReflectionMesh[] = [];
  sun: SunOptions = { direction: [0.4, 0.8, 0.45], color: [3, 3, 3], shadow: null };
  /** Hemisphere ambient (diffuse only; specular ambient is the reflections' job): sky and ground irradiance. */
  ambient: { sky: Vec3; ground: Vec3 } = { sky: [0.25, 0.28, 0.35], ground: [0.08, 0.07, 0.06] };
  sky: SkyOptions = { zenith: [0.18, 0.3, 0.6], horizon: [0.7, 0.75, 0.85], ground: [0.12, 0.1, 0.09], sunDisc: [40, 36, 30], sunSize: 0.02 };

  add(...meshes: ReflectionMesh[]) { this.meshes.push(...meshes); return this; }
  remove(mesh: ReflectionMesh) { const i = this.meshes.indexOf(mesh); if (i >= 0) this.meshes.splice(i, 1); }
}
