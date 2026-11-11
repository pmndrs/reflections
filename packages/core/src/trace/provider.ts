// The trace seam (docs/SPEC.md, "Trace seam"): how a ray-traced pass in core asks an engine-free
// BVH "what does this ray hit first?" without knowing whose BVH it is.
//
// A provider is WGSL text plus the resources it binds, in the shape of @pmndrs/ddgi's `WgslModule`
// (packages/ddgi-core/src/platform/contract/wgsl.ts), so @pmndrs/bvh's trace module
// (`giTraceClosest` over its GPU layout) wraps into one without changes on either side:
//
//   - the pass decides where the bindings land (`code(slot)`), so the provider never owns a
//     bind-group index and can share a group with other modules;
//   - `entries` / `resources()` / `version` let the pass rebuild its bind group only when the
//     provider reallocated a buffer (scene grew), not every frame;
//   - `storageBufferCount` lets the pass stay under `maxStorageBuffersPerShaderStage` (8 by default),
//     the tightest default limit for a tracing kernel.
//
// The pass declares `struct Hit` (HIT_WGSL) before the provider's code; the provider defines
//
//   fn traceFirstHit(origin: vec3f, dir: vec3f, tMax: f32) -> Hit
//
// and, if `capabilities.hitMaterial`, also `fn traceHitMaterial(hit: Hit) -> HitMaterial`;
// if `capabilities.anyHit`, also
//
//   fn traceAny(origin: vec3f, dir: vec3f, tMax: f32) -> bool
//
// (true if any triangle lies along the ray within tMax; the walk may stop at the first one), the
// occlusion query hit shading uses for shadow rays (D903). Without it the pass derives one from
// `traceFirstHit` (same answer, a full closest-hit walk).
// Hit shading itself belongs to the pass (HitShading below), not the provider.

/** Where a module's bindings land inside a kernel (same shape as @pmndrs/ddgi's `BindingSlot`). */
export interface BindingSlot {
  readonly group: number;
  /** Binding number of the module's first entry; the rest follow in order. */
  readonly firstBinding: number;
}

/** A bind group layout entry without its binding number, which the pass assigns. */
export type ModuleBindingEntry = Omit<GPUBindGroupLayoutEntry, 'binding'>;

export interface TraceProviderCapabilities {
  /** `Hit.normal` is the world-space geometric normal (unit, not necessarily facing the ray). Otherwise it is 0. */
  readonly hitNormal: boolean;
  /** The provider defines `fn traceHitMaterial(hit: Hit) -> HitMaterial`. Otherwise the pass supplies a grey default. */
  readonly hitMaterial: boolean;
  /**
   * The provider defines `fn traceAny(origin: vec3f, dir: vec3f, tMax: f32) -> bool` (an any-hit /
   * occlusion walk that may stop at the first triangle it finds). Otherwise the pass supplies one
   * from `traceFirstHit`. Default false.
   */
  readonly anyHit?: boolean;
}

/** A BVH ray walk behind the trace seam. */
export interface TraceProvider {
  /** Stable name, for labels and errors. */
  readonly name: string;
  /**
   * WGSL declaring this provider's bindings at `slot` (in `entries` order) and defining
   * `traceFirstHit` (+ `traceHitMaterial` / `traceAny` per `capabilities`). Other global names
   * should carry a provider prefix so they never collide with the pass.
   */
  code(slot: BindingSlot): string;
  /** Layout entries, in the order `resources()` returns them. Fixed for the provider's lifetime. */
  readonly entries: readonly ModuleBindingEntry[];
  /** The current resources, one per entry. */
  resources(): readonly GPUBindingResource[];
  /** Increments whenever `resources()` would return different objects. */
  readonly version: number;
  /** Storage buffers among `entries`. */
  readonly storageBufferCount: number;
  readonly capabilities: TraceProviderCapabilities;
  /**
   * The version of the GPU layout the WGSL reads, for providers over a versioned layout (@pmndrs/bvh
   * exports `GPU_LAYOUT_VERSION`). The provider checks it against the package it loaded at start-up;
   * the pass only reports it.
   */
  readonly layoutVersion?: number;
}

/**
 * What `traceFirstHit` returns. Function results only (`bool` is not host-shareable).
 *
 * - `t`: world distance along `dir` (unit); negative = no hit within `tMax`.
 * - `triangle`: the provider's triangle id (mesh-local or global, the provider documents which).
 * - `barycentrics`: weights of the triangle's vertices 1 and 2 (vertex 0 = 1 - x - y), as
 *   @pmndrs/bvh's `GiHit`.
 * - `material`: index into the engine's material table (three: the mesh's slot), 0xffffffff if none.
 * - `instance`: the provider's instance / object index.
 * - `normal`: world geometric normal if `capabilities.hitNormal`, else vec3f(0).
 * - `frontFace`: the ray hit the side the mesh was authored as front.
 */
export const HIT_WGSL = /* wgsl */ `
struct Hit {
  t: f32,
  triangle: u32,
  barycentrics: vec2f,
  material: u32,
  instance: u32,
  normal: vec3f,
  frontFace: bool,
}
fn noHit() -> Hit { return Hit(-1.0, 0xffffffffu, vec2f(0.0), 0xffffffffu, 0xffffffffu, vec3f(0.0), true); }

struct HitMaterial {
  albedo: vec3f,
  emissive: vec3f,
}
`;

/** `traceHitMaterial` for providers without materials: mid grey, no emission. */
export const DEFAULT_HIT_MATERIAL_WGSL = /* wgsl */ `
fn traceHitMaterial(hit: Hit) -> HitMaterial { return HitMaterial(vec3f(0.5), vec3f(0.0)); }
`;

/** `traceAny` for providers without an any-hit walk: the closest-hit walk, hit or not. */
export const DEFAULT_TRACE_ANY_WGSL = /* wgsl */ `
fn traceAny(origin: vec3f, dir: vec3f, tMax: f32) -> bool { return traceFirstHit(origin, dir, tMax).t >= 0.0; }
`;

/**
 * How the pass shades a traced hit: WGSL defining
 *
 *   fn shadeTracedHit(hit: Hit, P: vec3f, N: vec3f, dir: vec3f) -> vec3f
 *
 * (world hit point, world normal facing the ray, unit ray direction; returns the radiance leaving
 * P toward the ray origin). It may call `traceHitMaterial(hit)`, the pass's
 * `sampleRadianceFallback(P, dir, roughness)` and the pass's shadow query
 *
 *   fn traceLightVisible(P: vec3f, N: vec3f, L: vec3f, tMax: f32) -> bool
 *
 * (false if the provider's `traceAny` finds geometry between P, offset along N like the reflection
 * ray's origin, and P + L x tMax; always true with the pass's `hitShadows` off; D903).
 * Its own bindings, if any, go in `@group(3)`.
 * The on-screen reuse (a hit visible in the current frame takes its scene colour) happens in the
 * pass before this is called.
 */
export interface HitShading {
  wgsl: string;
  /** Layout of `@group(3)`; omit when the snippet has no bindings. */
  layout?: GPUBindGroupLayout;
  /** Storage buffers in `layout`, counted against the device's per-stage limit. Default 0. */
  storageBufferCount?: number;
  /** Storage textures in `layout`, likewise. Default 0. */
  storageTextureCount?: number;
}

/**
 * Default hit shading (SPEC section 4, D11): emissive + albedo x the radiance fallback at the hit
 * point along the normal at roughness 1, i.e. a diffuse surface lit by whatever the fallback holds
 * (probes or the environment). No direct light, no shadows.
 */
export function fallbackHitShading(): HitShading {
  return {
    wgsl: /* wgsl */ `
fn shadeTracedHit(hit: Hit, P: vec3f, N: vec3f, dir: vec3f) -> vec3f {
  let m = traceHitMaterial(hit);
  return m.emissive + m.albedo * sampleRadianceFallback(P, N, 1.0);
}
`,
  };
}
