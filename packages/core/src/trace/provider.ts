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
// if `capabilities.hitSpecular`, `fn traceHitSpecular(hit: Hit) -> HitSpecular` (W41, D3510);
// if `capabilities.anyHit`, also
//
//   fn traceAny(origin: vec3f, dir: vec3f, tMax: f32) -> bool
//
// (true if any triangle lies along the ray within tMax; the walk may stop at the first one), the
// occlusion query hit shading uses for shadow rays (D903). Without it the pass derives one from
// `traceFirstHit` (same answer, a full closest-hit walk); if `capabilities.shadingNormal`, also
//
//   fn traceHitShadingNormal(hit: Hit) -> vec3f
//
// (the world shading normal: the caller's vertex normals at `hit.triangle`, interpolated with
// `hit.barycentrics`, D1700; need not be unit or face the ray, 0 when the mesh has none). Without it
// the pass shades with the geometric `hit.normal`.
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
   * The provider defines `fn traceHitSpecular(hit: Hit) -> HitSpecular` (W41, D3510). Otherwise the
   * pass supplies a no-specular default, so hits shade as before (diffuse + emissive only).
   */
  readonly hitSpecular?: boolean;
  /**
   * The provider defines `fn traceAny(origin: vec3f, dir: vec3f, tMax: f32) -> bool` (an any-hit /
   * occlusion walk that may stop at the first triangle it finds). Otherwise the pass supplies one
   * from `traceFirstHit`. Default false.
   */
  readonly anyHit?: boolean;
  /**
   * The provider defines `fn traceHitShadingNormal(hit: Hit) -> vec3f`: the interpolated vertex
   * normal at the hit in world space (any length, any side; vec3f(0) where the mesh has no normals).
   * The pass shades with it, turned to the side of the ray-facing geometric normal. Otherwise the
   * pass uses `Hit.normal` (flat shading, D1700). Default false.
   */
  readonly shadingNormal?: boolean;
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

// The specular lobe of a traced hit (W41, D3510): F0 (linear; mix(0.04, base, metalness) for a
// metal-rough material), perceptual roughness, and a clear coat layer (three's / glTF's
// KHR_materials_clearcoat: F0 0.04 over the base, factor and perceptual roughness).
struct HitSpecular {
  color: vec3f,
  roughness: f32,
  clearcoat: f32,
  clearcoatRoughness: f32,
}

// Karis 2014 (mobile) analytic fit of the split-sum DFG term: F0 x A + B, at NdotV and perceptual
// roughness. Close to three's DFGLUT for the hit's one sample; no texture needed in the trace pass.
fn hitEnvBRDF(f0: vec3f, roughness: f32, NdotV: f32) -> vec3f {
  let r = roughness * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
  let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

// What leaves a traced hit toward the ray origin, given its diffuse radiance (emissive excluded) and
// the environment along the mirror direction at the base and clear coat roughness: three's
// split-sum IBL (F0 x A + B) on the base, the clear coat layered on top as three does
// (base x (1 - clearcoat x Fcc) + clearcoat x coat), Fcc = Schlick(0.04, 1, NdotV).
fn hitLayered(s: HitSpecular, diffuse: vec3f, envBase: vec3f, envCoat: vec3f, NdotV: f32) -> vec3f {
  let base = diffuse + envBase * hitEnvBRDF(s.color, s.roughness, NdotV);
  let fcc = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);
  let coat = envCoat * hitEnvBRDF(vec3f(0.04), s.clearcoatRoughness, NdotV);
  return base * (1.0 - s.clearcoat * fcc) + s.clearcoat * coat;
}
`;

/** `traceHitMaterial` for providers without materials: mid grey, no emission. */
export const DEFAULT_HIT_MATERIAL_WGSL = /* wgsl */ `
fn traceHitMaterial(hit: Hit) -> HitMaterial { return HitMaterial(vec3f(0.5), vec3f(0.0)); }
`;

/** `traceHitSpecular` for providers without it: no specular lobe, no clear coat (diffuse hits, as before W41). */
export const DEFAULT_HIT_SPECULAR_WGSL = /* wgsl */ `
fn traceHitSpecular(hit: Hit) -> HitSpecular { return HitSpecular(vec3f(0.0), 1.0, 0.0, 0.0); }
`;

/** `traceHitShadingNormal` for providers without vertex normals: none (the pass keeps the geometric normal). */
export const DEFAULT_SHADING_NORMAL_WGSL = /* wgsl */ `
fn traceHitShadingNormal(hit: Hit) -> vec3f { return vec3f(0.0); }
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
 * (world hit point, world normal facing the ray (the shading normal if the provider has one, D1700),
 * unit ray direction; returns the radiance leaving
 * P toward the ray origin). It may call `traceHitMaterial(hit)`, `traceHitSpecular(hit)`, `hitLayered`, the pass's
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
 * (probes or the environment), plus the specular lobe (W41, D3510): the fallback along the mirror
 * direction at the hit's roughness, by `hitLayered`. No direct light, no shadows.
 */
export function fallbackHitShading(): HitShading {
  return {
    wgsl: /* wgsl */ `
fn shadeTracedHit(hit: Hit, P: vec3f, N: vec3f, dir: vec3f) -> vec3f {
  let m = traceHitMaterial(hit);
  let s = traceHitSpecular(hit);
  let diffuse = m.albedo * sampleRadianceFallback(P, N, 1.0);
  if (P.hitSpecular == 0u || (max(s.color.x, max(s.color.y, s.color.z)) <= 0.0 && s.clearcoat <= 0.0)) { return m.emissive + diffuse; }
  let R = reflect(dir, N);
  let NdotV = clamp(dot(N, -dir), 1e-4, 1.0);
  let envBase = sampleRadianceFallback(P, R, s.roughness);
  let envCoat = select(envBase, sampleRadianceFallback(P, R, s.clearcoatRoughness), s.clearcoat > 0.0);
  return m.emissive + hitLayered(s, diffuse, envBase, envCoat, NdotV);
}
`,
  };
}
