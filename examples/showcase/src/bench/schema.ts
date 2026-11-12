// The tuning bench's settings (W51): one entry per knob, in one list. The bench (../bench.ts) builds its
// panel, its URL state, its "Copy as code" and its Reset from this list, and docs/SETTINGS.md is generated
// from it (`pnpm settings:doc`; test/settings-doc.test.ts fails when the two drift apart).
//
// Adding a setting is one entry here plus, if a method has to do something new with it, a handler in that
// method under the same URL key (`set(key, value)` in ../compare/ours.ts, three-ssr.ts or pathtracer.ts;
// a key a method reads only at creation is applied by the bench's Rebuild). Values travel as strings in
// the URL (`?<id>=<value>`, booleans as 1 / 0); a key absent from the URL is the default.
//
// `default` is the package's default (what you get without passing the option); `pageDefault` is what the
// bench and the showcase use when it differs (a per-scene value, an example-side choice). `cost` is a
// measured GPU number from docs/HANDOFF.md / docs/DIVERGES.md where one exists (no new timing here).
//
// This module is plain data: no three, no DOM (vitest imports it for the doc).
import type { MethodId } from '../compare/method';

export type GroupId = 'aa' | 'scene' | 'sssr' | 'rt' | 'hybrid' | 'denoiser' | 'probes' | 'materials' | 'three' | 'pathtracer';

export const GROUPS: { id: GroupId; title: string; blurb: string }[] = [
  { id: 'aa', title: 'Anti-aliasing / upscaler', blurb: 'Display AA after the composite (examples/shared/antialias.ts, W36): @pmndrs/upscaler at ratio 1 acts as TAA and smooths the last fireflies. Same choice on ours and on three\'s SSR; the path tracer needs none.' },
  { id: 'scene', title: 'Scene', blurb: 'What every method renders: scene, camera, floor, tone mapping, exposure, size.' },
  { id: 'sssr', title: 'Screen-space (SSSR)', blurb: '`ScreenSpaceReflectionsPass.settings` (core `ScreenSpaceReflectionsSettings`), read every frame.' },
  { id: 'rt', title: 'Ray tracing', blurb: 'The ray-traced fallback over the SSR miss list: provider, which misses are traced, and `ScreenSpaceReflectionsPass.traceSettings`.' },
  { id: 'hybrid', title: 'Hybrid / composite', blurb: '`HybridReflections` and its composite.' },
  { id: 'denoiser', title: 'Denoiser', blurb: '`FfxReflectionDenoiser` (denoiser/ffx) behind the denoise seam. Its options are taken at construction: the bench rebuilds it on change (history drops).' },
  { id: 'probes', title: 'Probes', blurb: '`ReflectionProbes` and its `bake()` options. A change re-bakes (Rebuild).' },
  { id: 'materials', title: 'Materials (examples)', blurb: 'Example-side material options, not package API: roughness from normal variance (specAA, W46) and the W45 experiments.' },
  { id: 'three', title: 'three SSRNode (reference)', blurb: 'three r187\'s stock SSRNode, its TemporalReproject + RecurrentDenoise, and denoiser/three\'s ffxReflections: the three SSR methods only.' },
  { id: 'pathtracer', title: 'Path tracer (reference)', blurb: 'three-gpu-pathtracer (WebGPU) + OIDN, the ground truth Measure compares against.' },
];

export type Value = number | boolean | string;

export interface Setting {
  /** The URL key (and the key a method's `set()` takes). */
  id: string;
  group: GroupId;
  label: string;
  type: 'number' | 'bool' | 'select';
  min?: number; max?: number; step?: number;
  /** For selects: [value, label]. */
  choices?: readonly (readonly [string, string])[];
  /** The package's default (null: the option has none, e.g. "unlimited" or an example-side setting). */
  default: Value | null;
  /** What the bench / showcase use when the URL has no value, where that differs from `default`. */
  pageDefault?: Value;
  /** Words for a default no single value describes ("per scene", "camera far"). */
  defaultNote?: string;
  /** 'live': applied without reload; 'rebuild': taken at creation, applied by the Rebuild button. */
  apply: 'live' | 'rebuild';
  /** Which methods it changes ('page': the page itself: scene, camera, size). */
  appliesTo: readonly MethodId[] | 'page';
  /** One line: what it trades and when to change it. */
  tradeoff: string;
  /** Measured GPU cost with its source, where one exists. */
  cost?: string;
  /** Where it lives in the package (for "Copy as code" and the doc). */
  api?: string;
  /** Planned, not built yet: shown greyed out with this note (no URL key acts on it). */
  planned?: string;
}

export const OURS: readonly MethodId[] = ['ours-raw', 'ours-denoised', 'ours-rt', 'probes'];
export const OURS_SSR: readonly MethodId[] = ['ours-raw', 'ours-denoised', 'ours-rt'];
export const OURS_DN: readonly MethodId[] = ['ours-denoised', 'ours-rt'];
export const RT: readonly MethodId[] = ['ours-rt'];
export const THREE: readonly MethodId[] = ['three-raw', 'three-denoise', 'three-ffx'];
export const RASTER: readonly MethodId[] = [...OURS, ...THREE];
export const ALL: readonly MethodId[] = [...RASTER, 'pathtraced'];

const num = (id: string, group: GroupId, label: string, min: number, max: number, step: number, def: number | null, o: Partial<Setting> & Pick<Setting, 'tradeoff' | 'appliesTo'>): Setting =>
  ({ id, group, label, type: 'number', min, max, step, default: def, apply: 'live', ...o });
const bool = (id: string, group: GroupId, label: string, def: boolean | null, o: Partial<Setting> & Pick<Setting, 'tradeoff' | 'appliesTo'>): Setting =>
  ({ id, group, label, type: 'bool', default: def, apply: 'live', ...o });
const sel = (id: string, group: GroupId, label: string, choices: readonly (readonly [string, string])[], def: string | number | null, o: Partial<Setting> & Pick<Setting, 'tradeoff' | 'appliesTo'>): Setting =>
  ({ id, group, label, type: 'select', choices, default: def, apply: 'live', ...o });

export const SETTINGS: Setting[] = [
  // ---- anti-aliasing (top: the maintainer's ask, W51) -----------------------------------------------------
  sel('aa', 'aa', 'AA mode', [['upscaler', 'Upscaler (@pmndrs/upscaler, TAA at ratio 1)'], ['taa', 'TAA (W40 resolve)'], ['off', 'Off']], null, {
    pageDefault: 'upscaler', appliesTo: RASTER, api: 'examples DisplayAA (mode)',
    defaultNote: 'examples-side; bench and showcase upscaler, compare page off',
    tradeoff: 'The upscaler accumulates up to 128 jittered frames: edges, normal-mapped highlights and the denoised reflections\' last 1-3/255 shimmer settle (W36, W40). Off shows the raw per-frame image (what compare.html showed: aliased).',
    cost: 'the upscaler\'s own passes show under GPU time (its timer); not in HANDOFF',
  }),
  sel('upscale', 'aa', 'Upscale', [['native', 'native (ratio 1)'], ['quality', 'quality (1.5x)'], ['balanced', 'balanced (1.7x)'], ['performance', 'performance (2x)'], ['ultra', 'ultra performance (3x)']], null, {
    pageDefault: 'native', apply: 'rebuild', appliesTo: OURS, api: 'examples DisplayAA (ratio)',
    tradeoff: 'G-buffer, reflections and the denoiser run at the render size and the upscaler rebuilds the display size: every reflection pass scales with the pixel count; softer at higher ratios. Ours only: three\'s SSR side keeps ratio 1 (D3620).',
  }),
  num('reactive', 'aa', 'Reactive mask', 0, 1, 0.05, null, {
    pageDefault: 0, appliesTo: OURS, api: 'examples reflectionReactive (D4202)',
    tradeoff: 'Upscaler favours the current frame where reflections move with the pixel: less reflection ghosting on moving surfaces, more of their noise. 0 = off.',
  }),
  num('sharpness', 'aa', 'RCAS sharpness', 0, 1, 0.05, 0.8, {
    pageDefault: 0, appliesTo: RASTER, api: '@pmndrs/upscaler settings.sharpness',
    tradeoff: 'RCAS after the upscale. The pages run 0 (D4201): 0.8 sharpened each jitter phase differently, mirror-edge flicker at rest 0.16% -> 4.2% of px.',
  }),
  num('accum', 'aa', 'Max accumulation', 1, 256, 1, 24, {
    pageDefault: 128, appliesTo: RASTER, api: '@pmndrs/upscaler settings.maxAccumulation',
    tradeoff: 'History length: longer is calmer at rest, ghosts longer in motion. 24 leaves the reflections\' residual noise at rest (0.48% vs 0.02% px, W36).',
  }),
  bool('aa.rcasDenoise', 'aa', 'RCAS denoise', false, { appliesTo: RASTER, api: '@pmndrs/upscaler settings.rcasDenoise', tradeoff: 'Damps sharpening on lone luma outliers (noisy inputs); only matters with sharpness > 0.' }),
  bool('aa.autoExposure', 'aa', 'Auto pre-exposure', true, { appliesTo: RASTER, api: '@pmndrs/upscaler settings.autoExposure', tradeoff: 'Pre-exposure from the scene luminance for the invertible tonemap the history accumulates in; off uses the fixed pre-exposure below.' }),
  num('aa.exposure', 'aa', 'Pre-exposure', 0.1, 8, 0.1, 1, { appliesTo: RASTER, api: '@pmndrs/upscaler settings.exposure', tradeoff: 'Fixed pre-exposure (ignored while auto is on); divided out again, so it only conditions the accumulation.' }),
  bool('aa.lockThinFeatures', 'aa', 'Lock thin features', true, { appliesTo: RASTER, api: '@pmndrs/upscaler settings.lockThinFeatures', tradeoff: 'Protects stable sub-pixel features from history rectification (less shimmer on thin parts; can hold a stale value longer).' }),
  bool('aa.detectShadingChanges', 'aa', 'Detect shading changes', true, { appliesTo: RASTER, api: '@pmndrs/upscaler settings.detectShadingChanges', tradeoff: 'Ages the history where shading really changed (a light, a bake) so it re-converges instead of ghosting.' }),

  // ---- scene -----------------------------------------------------------------------------------------------
  sel('scene', 'scene', 'Scene', [['carConcept', 'Car concept'], ['toyCar', 'Toy car'], ['chess', 'Chess set'], ['sponza', 'Sponza']], null, {
    pageDefault: 'carConcept', apply: 'rebuild', appliesTo: 'page', tradeoff: 'Reloads every method on the new scene (downloaded assets only).',
  }),
  sel('pose', 'scene', 'Camera', [['hero', 'hero'], ['low', 'low'], ['front', 'front'], ['close', 'close'], ['top', 'top'], ['w50', 'w50 (carConcept: W50\'s view, the Measure regions)']], null, {
    pageDefault: 'hero', appliesTo: 'page', tradeoff: 'Camera preset (orbit freely after). The named Measure regions for carConcept are defined at `w50` (W50) and `hero` (W46).',
  }),
  num('exposure', 'scene', 'Exposure', 0.2, 3, 0.05, null, { defaultNote: 'per scene', appliesTo: ALL, api: 'renderer.toneMappingExposure', tradeoff: 'Display exposure, every method alike.' }),
  sel('tone', 'scene', 'Tone mapping', [['agx', 'AgX'], ['neutral', 'Neutral (Khronos PBR)'], ['aces', 'ACES filmic']], null, {
    pageDefault: 'agx', apply: 'rebuild', appliesTo: ALL, api: 'renderOutput(..., toneMapping)', tradeoff: 'Display transform, every method alike. Measure\'s numbers are in this display space.',
  }),
  sel('size', 'scene', 'Render size', [['960x540', '960 x 540'], ['1280x720', '1280 x 720'], ['1920x1080', '1920 x 1080'], ['1280x1280', '1280 x 1280 (the showcase shots)']], null, {
    pageDefault: '960x540', apply: 'rebuild', appliesTo: 'page', tradeoff: 'Each method\'s canvas (`?w=&h=`). W52 (D3643): the skirt halo is mostly a 960x540 effect (lip 48 vs PT 46 at 1920x1080). W50: at 960x540 the car has 2.4x fewer px across than the showcase\'s 1280x1280 shots, most of the "detail loss" seen there.',
  }),
  sel('floor', 'scene', 'Floor material', [['mirror', 'Mirror (metal)'], ['lacquer', 'Black lacquer']], null, { pageDefault: 'mirror', appliesTo: ALL, tradeoff: 'The stages\' floor disc (not Sponza). The path tracer rebuilds.' }),
  num('floorRoughness', 'scene', 'Floor roughness', 0, 0.6, 0.01, null, { defaultNote: 'per scene (stages 0.03)', appliesTo: ALL, tradeoff: 'Floor roughness, every method; ours re-bakes its probes. The path tracer rebuilds.' }),
  bool('floorPolish', 'scene', 'Polished floor (Sponza)', null, { pageDefault: true, appliesTo: ALL, tradeoff: 'Sponza\'s polished override of its `Floors` material; off = the asset\'s rough stone.' }),
  num('bgBlur', 'scene', 'Background blur', 0, 1, 0.05, null, { pageDefault: 0, apply: 'rebuild', appliesTo: ALL, tradeoff: 'Backdrop blur (display only; lighting unchanged). The compare / bench show it sharp so every method shows the same backdrop (the PT blurs differently); the showcase uses 0.35.' }),
  num('keyLight', 'scene', 'Key light scale', 0, 3, 0.05, null, { pageDefault: 1, apply: 'rebuild', appliesTo: ALL, tradeoff: 'Scales every directional / spot / point light (W45: what share of a reference is the key light).' }),

  // ---- screen-space ----------------------------------------------------------------------------------------
  bool('ssr', 'sssr', 'Screen-space march', null, {
    pageDefault: true, appliesTo: OURS_SSR, api: 'settings.maxTraversalIntersections = 0 when off',
    tradeoff: 'Off: no screen-space march, every ray goes to the miss list (RT traces all of them on ours + RT; the rest take the probe). Judges what SSR adds.',
  }),
  num('s.roughnessThreshold', 'sssr', 'Roughness threshold', 0, 1, 0.01, 0.447, {
    appliesTo: OURS_SSR, api: 'settings.roughnessThreshold',
    tradeoff: 'Perceptual roughness above which a pixel skips the trace and takes the probe / environment only (D43). Higher traces rougher surfaces: more rays, more noise for the denoiser. The examples\' denoiser gate follows it (W34).',
    cost: 'SSR passes 0.81-0.91 ms at 1080p at the default (pyramid 0.17-0.21, classify 0.10-0.11, intersect 0.53-0.58; W6); scales with traced px',
  }),
  sel('spq', 'sssr', 'Samples per quad', [['1', '1'], ['2', '2'], ['4', '4']], 1, {
    appliesTo: OURS_SSR, api: 'settings.samplesPerQuad',
    tradeoff: 'Rays per 2x2 quad for glossy (non-mirror) pixels. More rays, less noise: spq 4 lowered denoised std 0.14 -> 0.10 on a 0.25 floor (W21).',
    cost: 'intersect grows about linearly in glossy rays (0.53-0.58 ms at 1080p at 1, W6)',
  }),
  num('s.maxTraversalIntersections', 'sssr', 'Max march steps', 0, 256, 1, 128, { appliesTo: OURS_SSR, api: 'settings.maxTraversalIntersections', tradeoff: 'Hi-Z march steps per ray: fewer is cheaper and sends long rays to the miss list (probe or RT); 0 = SSR off.' }),
  num('s.minTraversalOccupancy', 'sssr', 'Min occupancy', 0, 64, 1, 4, { appliesTo: OURS_SSR, api: 'settings.minTraversalOccupancy', tradeoff: 'Glossy rays stop once this few lanes of their subgroup still march (FFX): higher ends long tails earlier (cheaper, more misses). Mirrors ignore it.' }),
  num('s.depthBufferThickness', 'sssr', 'Thickness', 0, 0.5, 0.001, 0.2, {
    defaultNote: 'showcase scenes set their own (kit.thickness)', appliesTo: OURS_SSR, api: 'settings.depthBufferThickness (THICKNESS_HYBRID)',
    tradeoff: 'Hit acceptance thickness in view-space units. Thicker accepts rays that pass behind objects (streaks, the dark band under carConcept\'s sill, D2402); thinner cuts holes (FFX\'s 0.015 holes the sphere, D4303). Room scale 0.2 is too thick for a car (W11).',
  }),
  num('s.thicknessRoughnessFactor', 'sssr', 'Thickness per alpha', 0, 20, 0.1, 10, { defaultNote: 'showcase scenes set their own', appliesTo: OURS_SSR, api: 'settings.thicknessRoughnessFactor', tradeoff: 'Thickness added per unit of the pixel\'s alpha: rough rays need less precision (D1001).' }),
  num('s.thicknessLengthFactor', 'sssr', 'Thickness per ray length', 0, 0.1, 0.001, 0.01, { appliesTo: OURS_SSR, api: 'settings.thicknessLengthFactor', tradeoff: 'Thickness added per world unit of ray length: far hits are coarser (D1001).' }),
  num('s.mostDetailedMip', 'sssr', 'Most detailed mip', 0, 4, 1, 0, { appliesTo: OURS_SSR, api: 'settings.mostDetailedMip', tradeoff: 'Pyramid mip glossy rays start on: higher is cheaper and coarser. Mirrors always use 0.' }),
  sel('hit', 'sssr', 'Hit colour', [['final', 'last frame\'s image'], ['lit', 'last frame\'s lit (no SSR)'], ['current', 'this frame, no specular (FFX)']], 'current', {
    pageDefault: 'final', appliesTo: OURS_SSR, api: 'settings.hitColor (+ historySource)',
    tradeoff: '`current` (FFX, the package default) has no reflections in reflections: a mirror seen in a mirror is black (W9: 99.6% px). `final` reprojects last frame\'s final image (D69, D1002): mirror-in-mirror, one frame late, can ghost.',
  }),
  sel('reshade', 'sssr', 'Hit specular (re-shade)', [['reshade', 'specular along the ray (re-shade)'], ['off', 'screen colour as is (FFX)']], 'reshade', {
    appliesTo: OURS_SSR, api: 'settings.hitShading',
    tradeoff: 'W44 (D3540): a hit keeps its screen diffuse and evaluates its specular along the ray. Fixes carConcept\'s reflected door (48 -> 100 vs PT 118, W50); with the lobe filter and the denoiser it is the halo under the door / skirt (lip 37 -> 80 vs PT 48, D3610).',
    cost: 'intersect +0.003..0.017 ms at 1280x720 (D3540)',
  }),
  num('lobeFilter', 'sssr', 'Hit lobe filter', 0, 2, 0.05, 1, {
    appliesTo: OURS_SSR, api: 'settings.hitLobeFilter (DEFAULT_HIT_LOBE_FILTER)',
    tradeoff: 'W45 (D3550): a hit\'s specular looked up wider by k x the pixel\'s alpha (filtered importance sampling): same mean, less variance, so the denoiser stops clipping rare softbox samples (RT door 111 -> 155). 0 = the hit\'s own roughness (W44); 1 default; 1.5 wider. W50, carConcept + RT: lip 53 at 0 vs 80 at 1 (PT 48), door 110 either way. Double-blurs the lobe (x1.41 alpha at 1).',
    cost: 'part of the re-shade\'s +0.003..0.017 ms (one lookup at another lod)',
  }),
  num('s.hitLobeFilterMixed', 'sssr', 'Lobe filter where hits mix', 0, 1, 0.05, 1, {
    appliesTo: OURS_SSR, api: 'settings.hitLobeFilterMixed (+ traceSettings)',
    tradeoff: 'W52 (D3641): the lobe filter x this where traced and screen-space hits mix (last frame\'s source around the pixel). W50\'s halo: lip 80 -> 56 at 0, but the skirt 50 -> 23 (PT 35), and it overshoots at 1080p (D3643: the halo is mostly a 960x540 effect). Below 1 the tracer is rebuilt once (one more sampled texture).',
    cost: '+0.07 ms (W52)',
  }),
  sel('s.hitShadeOcclusion', 'sssr', 'Re-shade occlusion', [['off', 'off'], ['screen', 'screen (8-sample depth march along R)']], 'off', {
    appliesTo: OURS_SSR, api: 'settings.hitShadeOcclusion (+ traceSettings)',
    tradeoff: 'W52 (D3642): a re-shaded hit marches the depth buffer along R and darkens where blocked (the re-shade had no occlusion, W44). Wheel 43 -> 37 (PT 26); works without RT. Untuned.',
    cost: 'intersect +0.04 ms (W52)',
  }),
  num('s.mirrorBias', 'sssr', 'Mirror bias', 0, 1, 0.01, 0, {
    appliesTo: OURS_SSR, api: 'settings.mirrorBias',
    tradeoff: 'D49: truncates the GGX lobe toward the mirror direction: less noise, a sharper (biased) reflection. W32 / W39: no gain with the denoiser on a still or orbiting camera; W40: 0.7 halves rest shimmer on the carConcept floor (0.31 -> 0.14/255).',
    cost: 'free (one multiply in the sample)',
  }),
  sel('s.fallbackRoughness', 'sssr', 'Miss fallback roughness', [['surface', 'surface (the pixel\'s roughness)'], ['mirror', 'mirror (FFX: the ray\'s direction, sharp)']], 'surface', {
    appliesTo: OURS_SSR, api: 'settings.fallbackRoughness (+ traceSettings.fallbackRoughness)',
    tradeoff: 'D1806: where a ray misses, the probe at the pixel\'s own roughness (blurred, low noise) or at roughness 0 along the ray (FFX; the denoiser has to blur it).',
  }),
  bool('s.temporalVarianceGuidedTracing', 'sssr', 'Variance-guided tracing', true, { appliesTo: OURS_SSR, api: 'settings.temporalVarianceGuidedTracing', tradeoff: 'Extra rays where last frame\'s variance is high. No effect here: the seam passes no variance back to the tracer (W21).' }),
  num('s.varianceThreshold', 'sssr', 'Variance threshold', 0, 1, 0.01, 0, { appliesTo: OURS_SSR, api: 'settings.varianceThreshold', tradeoff: 'Variance above which variance-guided tracing adds rays (no effect without a variance input).' }),
  num('s.iblFactor', 'sssr', 'IBL factor (tracer)', 0, 2, 0.05, 1, { appliesTo: OURS_SSR, api: 'settings.iblFactor', tradeoff: 'Scales the tracer\'s own radiance fallback. The three adapter forces that fallback black (the composite adds the probe), so no visible effect here.' }),
  num('s.temporalStabilityFactor', 'sssr', 'Temporal stability (tracer)', 0, 1, 0.01, 0.7, { appliesTo: OURS_SSR, api: 'settings.temporalStabilityFactor', tradeoff: 'Carried in the tracer\'s uniform block for a denoiser; unused by these passes (the denoiser has its own, below).' }),
  num('s.frameIndex', 'sssr', 'Frame index (freeze noise)', 0, 1023, 1, null, { defaultNote: 'increments per dispatch', appliesTo: OURS_SSR, api: 'settings.frameIndex', tradeoff: 'Fixes the blue-noise rotation: a still noise pattern to judge structure without the temporal part (the denoiser then sees the same samples every frame).' }),

  // ---- ray tracing -----------------------------------------------------------------------------------------
  bool('rt', 'rt', 'Ray-traced fallback', true, { pageDefault: true, appliesTo: RT, api: 'pass.rayTracing', tradeoff: 'On the ours + RT method: traced rays for the SSR misses. Off shows the same instance without them (= ours denoised).' }),
  sel('bvh', 'rt', 'Provider', [['pmndrs', '@pmndrs/bvh'], ['three-mesh-bvh', 'three-mesh-bvh (stopgap)']], null, {
    pageDefault: 'pmndrs', apply: 'rebuild', appliesTo: RT, api: 'PmndrsBvhTraceProvider | MeshBVHTraceProvider',
    defaultNote: 'the app picks one; the examples default to @pmndrs/bvh (W51, D1705)',
    tradeoff: 'Same hits on the procedural scenes (100% hit / t agreement, W14 / W48); @pmndrs/bvh agrees with THREE.Raycaster on Sponza where three-mesh-bvh misses 2.4% (D1705), and is faster.',
    cost: 'trace at 1080p: Sponza 0.771 vs 1.417 ms (default misses), 1.043 vs 1.867 (all traced) (D1705); offscreen mirror 0.459 vs 0.539 (W14)',
  }),
  sel('bvhBuilder', 'rt', 'Builder (@pmndrs/bvh)', [['auto', 'auto (H-PLOC with subgroups, else tinybvh)'], ['gpu-hploc', 'gpu-hploc'], ['gpu-lbvh', 'gpu-lbvh'], ['tinybvh', 'tinybvh (CPU)']], 'auto', {
    apply: 'rebuild', appliesTo: RT, api: 'createPmndrsBvhTraceProviderFromObjects({ builder })', tradeoff: 'Tree builder: build time and tree quality (trace cost); same hits.',
  }),
  bool('rtShadingNormals', 'rt', 'Interpolated hit normals', true, { apply: 'rebuild', appliesTo: RT, api: 'provider option shadingNormals', tradeoff: 'D1700: traced hits shade with the vertex normals (smooth, as three shades on screen) instead of the face normal (faceted).', cost: 'three-mesh-bvh up to +0.07 ms at 1080p (D1700)' }),
  num('s.missRoughnessThreshold', 'rt', 'Glossy threshold (traced)', 0, 1, 0.01, 1, {
    appliesTo: RT, api: 'settings.missRoughnessThreshold',
    tradeoff: 'Only misses at perceptual roughness <= this go to the ray tracer (FFX hybrid sample: 0.469). Lower = fewer traced rays (cheaper); rougher misses keep the probe.',
    cost: 'trace 0.357 ms at 174k misses -> 0.535 ms at 281k (1080p, W8)',
  }),
  num('s.missConfidenceThreshold', 'rt', 'Miss confidence', 0, 1, 0.01, 0.9, { appliesTo: RT, api: 'settings.missConfidenceThreshold', tradeoff: 'A ray goes to the miss list when its SSR confidence is below this: higher traces more edge-faded rays.' }),
  num('t.maxTracedRaysPerFrame', 'rt', 'Ray budget per frame', 0, 2000000, 1000, null, { defaultNote: 'unlimited', appliesTo: RT, api: 'traceSettings.maxTracedRaysPerFrame', tradeoff: 'Caps the traced rays (D9); entries past it keep the probe. A fair share per tile, rotating (D1100).' }),
  num('t.maxRaysPerTile', 'rt', 'Rays per 8x8 tile', 1, 64, 1, 64, { appliesTo: RT, api: 'traceSettings.maxRaysPerTile', tradeoff: 'Per-tile cap (D9, D56): spreads a capped budget over the screen.' }),
  num('t.maxRayLength', 'rt', 'Max ray length', 0, 200, 1, 100, { appliesTo: RT, api: 'traceSettings.maxRayLength', tradeoff: 'World-unit cap at roughness 0 (FFX hybrid sample); shorter is cheaper and misses far content.' }),
  num('t.rayLengthRoughnessFalloff', 'rt', 'Ray length falloff', 0, 20, 0.5, 5, { appliesTo: RT, api: 'traceSettings.rayLengthRoughnessFalloff', tradeoff: 'cap = maxRayLength x exp(-falloff x alpha): rough rays stay short.' }),
  num('t.normalOffset', 'rt', 'Origin offset', 0, 0.02, 0.0005, 0.003, { appliesTo: RT, api: 'traceSettings.normalOffset', tradeoff: 'Origin pushed along N by this x view distance: too small self-hits (acne), too large skips contact.' }),
  bool('t.reuseOnScreenHits', 'rt', 'Reuse on-screen hits', true, { appliesTo: RT, api: 'traceSettings.reuseOnScreenHits', tradeoff: 'D55: a traced hit the camera sees takes the screen colour (re-shaded with the re-shade on, D3542) instead of the probe-lit hit shading.' }),
  bool('t.hitShadows', 'rt', 'Hit shadow rays', true, { appliesTo: RT, api: 'traceSettings.hitShadows', tradeoff: 'D903: one shadow ray per directional light from each traced off-screen hit; off lights every hit unoccluded.', cost: '<= 0.03 ms on 3 of 4 scenes (D903); \'moving\' 1080p +0.169 ms three-mesh-bvh, +0.081 @pmndrs/bvh (D2601)' }),
  bool('t.hitSpecular', 'rt', 'Hit specular lobe', true, { appliesTo: RT, api: 'traceSettings.hitSpecular', tradeoff: 'D3510: traced hits shade their specular lobe and coat (with D3513\'s one visibility ray); off = diffuse + emissive only.' }),
  num('rtLobeFilter', 'rt', 'Hit lobe filter (traced)', 0, 2, 0.05, null, { defaultNote: 'the tracer\'s (Hit lobe filter)', appliesTo: RT, api: 'traceSettings.hitLobeFilter', tradeoff: 'Overrides the lobe filter at traced hits only (the compare page\'s ?rtLobeFilter=): separates the W45 effect on RT hits from the screen-space ones.' }),
  num('t.onScreenDepthTolerance', 'rt', 'On-screen depth tolerance', 0, 0.1, 0.005, 0.02, { appliesTo: RT, api: 'traceSettings.onScreenDepthTolerance', tradeoff: 'Relative view-distance tolerance for "the camera sees this hit": looser reuses more screen colour (cheaper shading, can pick a neighbour).' }),
  num('t.iblFactor', 'rt', 'IBL factor (traced)', 0, 2, 0.05, 1, { appliesTo: RT, api: 'traceSettings.iblFactor', tradeoff: 'Scales the traced misses\' fallback.' }),
  sel('t.hitShadeVisibility', 'rt', 'Visibility ray on re-shaded hits', [['offscreen', 'offscreen (on-screen re-shaded hits take none, D3542)'], ['all', 'all (on-screen re-shaded hits too)']], 'offscreen', {
    appliesTo: RT, api: 'traceSettings.hitShadeVisibility',
    tradeoff: 'W52 (D3640): D3513\'s visibility ray along R for on-screen re-shaded traced hits too. Wheel 43 -> 41 vs PT 26 (carConcept); mirrors seen in mirrors go black where blocked (facingMirrors, D3542). Needs Hit shadow rays on.',
    cost: 'rt trace +0.30 ms (W52)',
  }),

  // ---- hybrid ----------------------------------------------------------------------------------------------
  num('h.depthAware', 'hybrid', 'Depth-aware blend', 0, 1, 0.05, 1, { appliesTo: OURS_SSR, api: 'hybrid.depthAware.value', tradeoff: 'D2400: keeps the probe off hits it lies behind (1); 0 = FFX\'s confidence blend (the wall pattern showed through the reflected sphere, W22).' }),
  num('h.amount', 'hybrid', 'SSR / RT amount', 0, 1, 0.05, 1, { appliesTo: OURS_SSR, api: 'composite().amount.value', tradeoff: 'Share of the traced reflection in the composite: 0 = probes only, for an A/B on one instance.' }),
  bool('specOcc', 'hybrid', 'Specular occlusion (GTAO)', null, {
    pageDefault: false, apply: 'rebuild', appliesTo: OURS, api: 'HybridReflections({ ao }) (examples GTAO)',
    tradeoff: 'Lagarde\'s specular occlusion from screen-space AO on the probe / environment part (D66, D4510). Darkens probe-filled creases; traced misses skip it (D3551); grainy without a blur (backlog).',
    cost: '960x540 2.1 -> 2.3 ms wall per frame (D4510; GTAO included)',
  }),
  sel('h.denoiserMotion', 'hybrid', 'Denoiser motion convention', [['ndc', 'ndc (denoiser-core / FFX)'], ['uv', 'uv']], 'ndc', { apply: 'rebuild', appliesTo: OURS_DN, api: 'HybridReflections({ denoiserMotion })', tradeoff: 'A convention, not a tuning knob: match your denoiser (the wrong one misreprojects and smears).' }),
  sel('h.denoiserRoughness', 'hybrid', 'Denoiser roughness space', [['perceptual', 'perceptual (FFX default)'], ['alpha', 'alpha']], 'perceptual', { apply: 'rebuild', appliesTo: OURS_DN, api: 'HybridReflections({ denoiserRoughness })', tradeoff: 'A convention: match the denoiser\'s `roughnessIsPerceptual`.' }),

  // ---- denoiser --------------------------------------------------------------------------------------------
  bool('denoise', 'denoiser', 'Denoise', true, {
    appliesTo: OURS_DN, api: 'hybrid.denoise', tradeoff: 'Off shows the raw signal (ours raw). The FFX denoiser loses 26-46% of a heavy-tailed glossy signal\'s energy (D3550) and spreads bright screen hits over dark traced neighbours (the W50 halo).',
    cost: 'denoised hybrid 0.9-1.4 ms over raw at 1080p (HANDOFF, Performance)',
  }),
  num('tsf', 'denoiser', 'Temporal stability', 0, 1, 0.01, 0.7, { appliesTo: OURS_DN, api: 'new FfxReflectionDenoiser(device, { temporalStabilityFactor })', tradeoff: 'History clip box scale: higher is calmer, ghosts more.' }),
  num('dn.roughnessThreshold', 'denoiser', 'Roughness gate (alpha)', 0, 1, 0.01, 1, {
    defaultNote: 'the examples pass the tracer\'s threshold squared (0.1998)', appliesTo: OURS_DN, api: 'FfxReflectionDenoiser({ roughnessThreshold })',
    tradeoff: 'Pixels with alpha >= this pass through undenoised. The examples gate at the tracer\'s threshold (rougher px carry the probe only, no noise; D1402).',
  }),
  bool('dn.currentFrameStatistics', 'denoiser', 'Current-frame statistics', true, { appliesTo: OURS_DN, api: 'FfxReflectionDenoiser({ currentFrameStatistics })', tradeoff: 'false reproduces FFX v1.1.4 exactly (its one-frame-off statistics: dark speckles on disocclusion, a black first frame).' }),
  num('dn.missDistance', 'denoiser', 'Miss ray length', 0, 200, 1, null, { defaultNote: 'camera far', appliesTo: OURS_DN, api: 'FfxReflectionDenoiser({ missDistance })', tradeoff: 'Ray length the reprojection assumes for misses (hit distance 0).' }),
  // W53 (D3660-D3662): live (the denoiser's setOptions + HybridReflections.denoiserHitSource), no rebuild
  sel('hitSource', 'denoiser', 'Keep hit sources apart', [['0', 'off'], ['hits', 'screen vs traced hits'], ['all', 'hits and misses']], '0', {
    appliesTo: OURS_DN, api: 'hybrid.denoiserHitSource = true; FfxReflectionDenoiser({ separateHitSources, missesMatchAnySource })',
    tradeoff: 'The denoiser stops blending bright screen-space hits into dark traced ones (the W50 halo: carConcept lip 80 -> 59 with hits, 52 with all, PT 48, at 960x540; at 1080p the halo is mostly gone anyway). hits: no regression on chess / toyCar / Sponza. all: boils where rays flip between hit and miss (std p99 x4-10). Both show a 2x2 stair step at source edges (D3663).',
    cost: '+0.35 ms (hits) / +0.51 ms (all) at 1080p, ~0 at 960x540 (W53)',
  }),
  num('hitDistW', 'denoiser', 'Hit-distance weight', 0, 16, 1, 0, {
    appliesTo: OURS_DN, api: 'FfxReflectionDenoiser({ hitDistanceWeight })',
    tradeoff: 'Neighbours weighted by relative hit distance, exp(-k |t_p - t_q| / (t_p + t_q)); no extra input. 8 separates the lip as well as the source (50.6) but boils everywhere the hit distance varies (std p99 x5-10). 0 = off.',
    cost: '+1.3 ms at 1080p for k 8 (W53)',
  }),

  // ---- probes ----------------------------------------------------------------------------------------------
  bool('probes', 'probes', 'Reflection probes', null, { pageDefault: true, apply: 'rebuild', appliesTo: OURS, api: 'scene.environmentNode = reflectionProbes(probes); HybridReflections({ probes })', tradeoff: 'Off lights with the plain environment (three\'s PMREM): misses read the HDRI instead of the local capture.' }),
  sel('probeRes', 'probes', 'Resolution', [['64', '64'], ['128', '128'], ['256', '256'], ['512', '512'], ['1024', '1024']], 256, {
    apply: 'rebuild', appliesTo: OURS, api: 'probes.bake(renderer, scene, { resolution })',
    tradeoff: 'Face size (D23, D62): 256 for mirror-grade surfaces, 128 for many probes / mobile. Near-mirror floors read the HDRI blurred at small sizes (W21).',
    cost: 'memory per probe ~1.0 / 4.2 / 16.8 MB at 128 / 256 / 512; bake 3 probes 2.0 -> 4.0 ms from 128 to 256 (D23)',
  }),
  num('bounces', 'probes', 'Bounces', 1, 4, 1, 2, { apply: 'rebuild', appliesTo: OURS, api: 'probes.bake(renderer, scene, { bounces })', tradeoff: 'D4300: captures that see other probes\' reflections; 1 halves the bake where no mirror faces another.', cost: 'bake mirrorWall 1 probe: 2.5-3.5 ms at 1, 3.6-4.9 at 2 (256 px, D4300)' }),
  sel('probeStorage', 'probes', 'Storage', [['auto', 'auto (cube array when supported)'], ['cube-array', 'cube array'], ['cube2d', '2D array (6 layers per cube)']], 'auto', { apply: 'rebuild', appliesTo: OURS, api: 'probes.layout', tradeoff: 'Hardware cube arrays (W20 shim) vs the 2D-array layout with its seam fix: same look within 1/255.' }),
  sel('probeLayout', 'probes', 'Probe layout (Sponza)', [['shipped', 'shipped'], ['few', 'few'], ['medium', 'medium'], ['many', 'many'], ['manyCell', 'manyCell'], ['mixed', 'mixed'], ['oneSize128', 'oneSize128 (W62: mixed volumes, all 128 px)'], ['oneSize256', 'oneSize256 (W62)'], ['twoSize', 'twoSize (W62: 512 floor + 256)'], ['twoSizeFew', 'twoSizeFew (W62)'], ['mixedDown', 'mixedDown (W62)']], null, { pageDefault: 'shipped', apply: 'rebuild', appliesTo: OURS, api: 'examples probeLayouts.ts (W61)', tradeoff: 'W61: probe layouts at an equal memory budget (Sponza only): a few large or mixed sizes beat a grid of small ones.' }),
  sel('carProbes', 'probes', 'Car interior probes (carConcept)', [['off', 'off'], ['wheels', 'wheels (one per wheel well)'], ['cabin', 'cabin'], ['both', 'wheels + cabin'], ['cabinGlass', 'cabin grown to the paint (takes in the glass; experiment)']], null, {
    defaultNote: 'off', apply: 'rebuild', appliesTo: OURS, api: 'examples showcase/src/carProbes.ts (W55)',
    tradeoff: 'W55: small probes inside carConcept beside the stage probe, boxes from the car\'s geometry (wheel bounds less the body paint; the cabin grown from the seats to the glass). The wells and the cabin then reflect their own capture instead of the open studio (D3680, D3681).',
  }),
  sel('carProbeRes', 'probes', 'Car interior probe size', [['64', '64'], ['128', '128'], ['256', '256']], null, {
    pageDefault: '128', apply: 'rebuild', appliesTo: OURS, api: 'ReflectionProbe.resolution (D4700)',
    tradeoff: 'W55: face size of the carProbes probes; the stage probe keeps Resolution. A size other than the stage\'s is a second atlas (a mixed-size set).',
  }),
  bool('pr.distanceRoughness', 'probes', 'Distance-based roughness', true, { apply: 'rebuild', appliesTo: OURS, api: 'probes.distanceRoughness', tradeoff: 'Lagarde 2014 (D53): a glossy lookup is sharp near the projection box, as an SSR hit there would be.', cost: 'lookup within the run\'s noise at 1080p (D53)' }),
  bool('pr.roughnessLerp', 'probes', 'Roughness lerp of the direction', false, { apply: 'rebuild', appliesTo: OURS, api: 'probes.roughnessLerp', tradeoff: 'Lagarde 2014 (D53): rough lookups lose the box parallax. Narrowed the SSR-to-probe step but moved every showcase stage away from the PT (W26).' }),
  sel('pr.lodMapping', 'probes', 'Roughness to mip', [['alpha', 'alpha (sharp mips linear in r^2)'], ['r187', 'r187 (three\'s PMREM mapping)']], 'alpha', { apply: 'rebuild', appliesTo: OURS, api: 'probes.lodMapping', tradeoff: 'D101: \'alpha\' halves the error below r = 0.3 against a GGX reference (p99 at r .05: 35.4 -> 21.9 / 255 at 256 px).' }),
  bool('pr.boxProjection', 'probes', 'Box projection', true, { apply: 'rebuild', appliesTo: OURS, api: 'probes.boxProjection', tradeoff: 'Off: infinite-distance lookups (no parallax); the stages project onto a far box anyway.' }),

  // ---- materials (examples) ----------------------------------------------------------------------------------
  num('specAA', 'materials', 'Roughness from normal variance', 0, 3, 0.05, null, {
    pageDefault: 1, appliesTo: RASTER, api: 'examples specAA.ts (strength; 0 = off)',
    tradeoff: 'W46 (D3570): raises each normal-mapped material\'s roughness by its normal map\'s lost variance (Toksvig, vMF), as the path tracer sees the flakes. carConcept door / skirt MAD 35.7 / 19.0 -> 8.0 / 9.4; it is also what makes the paint lighter: off reads darker. Ours re-bakes.',
    cost: '~0.1-0.15 ms of three\'s render passes at 1280x720 (D3570)',
  }),
  bool('specAAHits', 'materials', 'specAA at traced hits', true, { apply: 'rebuild', appliesTo: RT, api: 'examples specAAHitMaterial', tradeoff: 'Traced hits take the adjusted roughness too (one value per mesh, D3571); off keeps them at the authored roughness.' }),
  bool('maskSpecAA', 'materials', 'Glossy mask from adjusted roughness', false, { appliesTo: OURS, api: 'Measure', tradeoff: 'Measure\'s glossy mask from the specAA roughness instead of the authored one (the default keeps specAA on / off comparable over the same px).' }),
  num('paintRoughness', 'materials', 'Paint roughness override', 0, 1, 0.01, null, { defaultNote: 'authored', apply: 'rebuild', appliesTo: ALL, tradeoff: 'W45: every clear-coated material at this roughness, normal map dropped (what a plain paint lobe sees). The path tracer too.' }),
  sel('glass', 'materials', 'Glass (isolation)', [['authored', 'authored'], ['noShadow', 'casts no shadow'], ['black', 'opaque black (its reflection only)'], ['hidden', 'hidden (the cabin without glass)']], null, {
    defaultNote: 'authored', apply: 'rebuild', appliesTo: ALL,
    tradeoff: 'W54: isolates what the eye sees through transmissive glass (carConcept\'s cabin): black keeps only the glass\'s own reflection, hidden only the cabin behind it, noShadow lets the key light through as the path tracer does. Every method alike, the path tracer too.',
  }),

  sel('geometryRoughness', 'materials', 'Geometry roughness (three)', [['three', 'three\'s (normal derivative added)'], ['off', 'off'], ['0.5', 'x 0.5'], ['0.25', 'x 0.25']], null, {
    defaultNote: 'three', apply: 'rebuild', appliesTo: RASTER, api: 'examples geometryRoughness.ts (W56)',
    tradeoff: 'W56 (D3720): three r187 adds the screen-space derivative of the view normal to every standard material\'s roughness (getRoughness); off / scaled re-assigns three\'s roughness after its setupVariants. Reaches three\'s lit term, the G-buffer\'s shading roughness (the composite\'s probe term) and the bake; never the path tracer. Any other scale by URL (?geometryRoughness=0.75).',
  }),

  // ---- three's SSR ---------------------------------------------------------------------------------------------
  num('mirrorBias', 'three', 'SSR mirror bias', 0, 1, 0.01, 0, { pageDefault: 0.5, appliesTo: THREE, api: 'SSRNode.mirrorBias', tradeoff: 'three\'s lobe truncation (the example\'s 0.5): less noise, sharper.' }),
  num('ssrMaxDistance', 'three', 'SSR max distance', 0, 50, 0.1, 1, { defaultNote: 'example: scene far / 4 (D2301)', appliesTo: THREE, api: 'SSRNode.maxDistance', tradeoff: 'March length in world units; the example\'s 0.4 is for its 0.1-scaled dungeon.' }),
  num('ssrThickness', 'three', 'SSR thickness', 0, 1, 0.005, 0.1, { defaultNote: 'example: our scene thickness x 3 (D2301)', appliesTo: THREE, api: 'SSRNode.thickness', tradeoff: 'Hit acceptance thickness (three\'s units).' }),
  num('th.quality', 'three', 'SSR quality', 0, 1, 0.05, 0.5, { pageDefault: 0.25, appliesTo: THREE, api: 'SSRNode.quality', tradeoff: 'Step density: higher is finer and costlier.' }),
  num('th.intensity', 'three', 'SSR intensity', 0, 3, 0.05, 1, { appliesTo: THREE, api: 'SSRNode.intensity', tradeoff: 'Scales the reflection.' }),
  num('th.maxLuminance', 'three', 'SSR max luminance', 0, 100, 1, 10, { pageDefault: 35, appliesTo: THREE, api: 'SSRNode.maxLuminance', tradeoff: 'Clamp against fireflies (biased dark on bright reflections).' }),
  num('th.screenEdgeFade', 'three', 'SSR edge fade', 0, 1, 0.05, 0.2, { appliesTo: THREE, api: 'SSRNode.screenEdgeFade', tradeoff: 'Fades hits near the screen edge.' }),
  num('th.environmentIntensity', 'three', 'SSR environment intensity', 0, 4, 0.05, Math.PI, { defaultNote: 'example: the scene\'s (D2300)', appliesTo: THREE, api: 'SSRNode.environmentIntensity', tradeoff: 'Scales the environment its misses sample (the example\'s 3.14 is for its scene).' }),
  num('th.stepExponent', 'three', 'SSR step exponent', 1, 5, 0.5, 2, { pageDefault: 3, apply: 'rebuild', appliesTo: THREE, api: 'SSRNode.stepExponent', tradeoff: 'Step distribution along the ray.' }),
  num('th.resolutionScale', 'three', 'SSR resolution scale', 0.25, 1, 0.25, 1, { apply: 'rebuild', appliesTo: THREE, api: 'SSRNode.resolutionScale', tradeoff: 'SSR at a fraction of the resolution: cheaper, blockier.' }),
  bool('th.binaryRefine', 'three', 'SSR binary refine', false, { apply: 'rebuild', appliesTo: THREE, api: 'SSRNode.binaryRefine', tradeoff: 'Binary search at the hit: sharper contact, more steps.' }),
  bool('th.screenEdgeFadeBlack', 'three', 'SSR edge fade to black', false, { apply: 'rebuild', appliesTo: THREE, api: 'SSRNode.screenEdgeFadeBlack', tradeoff: 'Fade to black instead of the environment at the edge (indoor scenes).' }),
  num('th.rp.maxFrames', 'three', 'Reproject max frames', 1, 64, 1, 16, { defaultNote: 'the example\'s', appliesTo: ['three-denoise'], api: 'TemporalReprojectNode.maxFrames', tradeoff: 'History length of three\'s reprojection.' }),
  num('th.rp.clampIntensity', 'three', 'Reproject clamp', 0, 1, 0.05, 0.25, { defaultNote: 'the example\'s', appliesTo: ['three-denoise'], api: 'TemporalReprojectNode.clampIntensity', tradeoff: 'History clamp strength: higher ghosts less, flickers more.' }),
  num('th.rp.flickerSuppression', 'three', 'Reproject flicker suppression', 0, 2, 0.05, 1, { defaultNote: 'the example\'s', appliesTo: ['three-denoise'], api: 'TemporalReprojectNode.flickerSuppression', tradeoff: 'Damps temporal flicker.' }),
  bool('th.rp.hitPointReprojection', 'three', 'Hit-point reprojection', true, { defaultNote: 'the example\'s', appliesTo: ['three-denoise'], api: 'TemporalReprojectNode.hitPointReprojection', tradeoff: 'Reprojects by the reflected hit\'s motion (reflections move unlike their surface).' }),
  ...([['lumaPhi', 0.75, 0, 4], ['depthPhi', 20, 0, 100], ['normalPhi', 0.3, 0, 2], ['roughnessPhi', 100, 0, 200], ['radius', 1.5, 0, 4], ['alphaPhi', 5, 0, 20],
    ['strength', 0.725, 0, 1], ['adapt', 0.5, 0, 1], ['flickerSuppression', 1, 0, 2], ['adaptiveTrust', 1, 0, 2]] as const).map(([k, d, lo, hi]) =>
    num(`th.dn.${k}`, 'three', `Denoise ${k}`, lo, hi, hi > 20 ? 1 : 0.05, d, { defaultNote: 'the example\'s', appliesTo: ['three-denoise'], api: `RecurrentDenoiseNode.${k}`, tradeoff: 'three\'s recurrent denoiser weight (edge-stopping phi / filter radius / blend).' })),
  bool('th.dn.smoothDisocclusions', 'three', 'Denoise smooth disocclusions', true, { defaultNote: 'the example\'s', appliesTo: ['three-denoise'], api: 'RecurrentDenoiseNode.smoothDisocclusions', tradeoff: 'Blurs freshly disoccluded px harder.' }),
  num('th.ffx.tsf', 'three', 'FFX temporal stability (three side)', 0, 1, 0.01, 0.7, { apply: 'rebuild', appliesTo: ['three-ffx'], api: 'ffxReflections(..., { denoiser: { temporalStabilityFactor } })', tradeoff: 'As ours\', on three\'s SSR + FFX.' }),
  num('th.ffx.roughnessThreshold', 'three', 'FFX roughness gate (three side)', 0, 1, 0.01, 1, { apply: 'rebuild', appliesTo: ['three-ffx'], api: 'ffxReflections(..., { denoiser: { roughnessThreshold } })', tradeoff: 'As ours\' (alpha); ffxReflections denoises every px by default.' }),

  // ---- path tracer ---------------------------------------------------------------------------------------------
  num('ptMax', 'pathtracer', 'Max samples', 1, 512, 1, 8, { appliesTo: ['pathtraced'], api: 'WebGPUPathTracer.maxSamples', tradeoff: 'Traces to this many spp, then denoises once with OIDN and idles. Measure sets its own (Reference samples). OIDN biases sub-8-bit differences: raise it or show raw for those (D2305).' }),
  bool('ptRaw', 'pathtracer', 'Show raw (no OIDN)', false, { appliesTo: ['pathtraced'], tradeoff: 'The noisy accumulation instead of the denoised frame.' }),
  num('ptBounces', 'pathtracer', 'Bounces', 1, 16, 1, 8, { apply: 'rebuild', appliesTo: ['pathtraced'], api: 'WebGPUPathTracer.maxBounces', tradeoff: 'Light bounces of the reference.' }),
  bool('ptDenoise', 'pathtracer', 'OIDN', true, { apply: 'rebuild', appliesTo: ['pathtraced'], tradeoff: 'Off: never load OIDN (raw accumulation only).' }),
  bool('ptClearcoat', 'pathtracer', 'Clear coat', true, { apply: 'rebuild', appliesTo: ['pathtraced'], tradeoff: 'Off drops the clear-coat layer (the old WebGL tracer rendered it black, D2303).' }),
];

/** What the schema can't reach without a package change (listed in docs/SETTINGS.md). */
export const NOT_EXPOSED: { name: string; why: string }[] = [
  { name: 'settings.fallbackColor', why: 'The three adapter forces the tracer\'s constant fallback black (the composite adds the probe); a constant colour is meaningless there.' },
  { name: 'traceSettings.fallbackColor, hitColor, hitShading', why: 'The adapter passes black and the tracer\'s own `hitColor` / `hitShading` (Hit colour / Hit specular above).' },
  { name: 'trace option `lights`', why: 'Constructor-only (`ScreenSpaceReflectionsPass({ trace: { provider, lights } })`); the examples attach the provider later with `setTraceProvider`, so the default (on) stays.' },
  { name: 'ReflectionProbes.refitClamp, frameIrradiance', why: 'Only with a frame-irradiance re-fit, which the showcase scenes don\'t run.' },
  { name: '@pmndrs/upscaler debugView', why: 'A debug overlay, not a tuning knob.' },
];

export const settingById = new Map(SETTINGS.map((s) => [s.id, s]));

/** A value as the URL carries it (booleans 1 / 0). */
export const encodeValue = (s: Setting, v: Value): string => (s.type === 'bool' ? (v ? '1' : '0') : String(v));
export function decodeValue(s: Setting, v: string): Value {
  if (s.type === 'bool') return v === '1' || v === 'true';
  if (s.type === 'number') return Number(v);
  return v;
}
/** The value a control shows when the URL has none. */
export const effectiveDefault = (s: Setting): Value | null => s.pageDefault ?? s.default;
