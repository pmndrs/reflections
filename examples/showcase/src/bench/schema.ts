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
// W77: the package's named presets (plain data; core's presets.ts imports nothing at runtime)
import { REFLECTION_PRESET_NAMES, reflectionsPreset, type ReflectionsPresetName } from '../../../../packages/core/src/presets';

export type GroupId = 'preset' | 'aa' | 'scene' | 'sssr' | 'rt' | 'hybrid' | 'denoiser' | 'probes' | 'materials' | 'three' | 'pathtracer';

export const GROUPS: { id: GroupId; title: string; blurb: string }[] = [
  { id: 'preset', title: 'Preset', blurb: 'A named bundle of the settings below (core `REFLECTION_PRESETS`, W77): see "Presets" above for what each one sets, costs and trades. Keys you set explicitly win over the preset.' },
  { id: 'aa', title: 'Anti-aliasing / upscaler', blurb: 'Display AA after the composite (examples/shared/antialias.ts, W36): @pmndrs/upscaler at ratio 1 acts as TAA and smooths the last fireflies. Same choice on ours and on three\'s SSR; the path tracer needs none.' },
  { id: 'scene', title: 'Scene', blurb: 'What every method renders: scene, camera, floor, tone mapping, exposure, size.' },
  { id: 'sssr', title: 'Screen-space (SSSR)', blurb: '`ScreenSpaceReflectionsPass.settings` (core `ScreenSpaceReflectionsSettings`), read every frame.' },
  { id: 'rt', title: 'Ray tracing', blurb: 'The ray-traced fallback over the SSR miss list: provider, which misses are traced, and `ScreenSpaceReflectionsPass.traceSettings`.' },
  { id: 'hybrid', title: 'Hybrid / composite', blurb: '`HybridReflections` and its composite.' },
  { id: 'denoiser', title: 'Denoiser', blurb: '`FfxReflectionDenoiser` (denoiser/ffx) behind the denoise seam. Its options are taken at construction: the bench rebuilds it on change (history drops).' },
  { id: 'probes', title: 'Probes', blurb: '`ReflectionProbes` and its `bake()` options. A change re-bakes (Rebuild).' },
  { id: 'materials', title: 'Materials (examples)', blurb: 'Example-side material options, not package API: roughness from normal variance (specAA, W46) and the W45 experiments.' },
  { id: 'three', title: 'three SSRNode (reference)', blurb: 'three r187\'s stock SSRNode, its TemporalReproject + RecurrentDenoise, and denoiser/three\'s ffxReflections: the three SSR methods only.' },
  { id: 'pathtracer', title: 'Path tracer (reference)', blurb: '@pmndrs/pathtracer + OIDN, the ground truth Measure compares against.' },
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
  /**
   * W76: the package's default when ray tracing is on (the three adapter's `trace` / `rayTracing`; core
   * `missesTraced`), where it differs from `default`. Listed in docs/SETTINGS.md "What changes when ray
   * tracing is on". An explicit value always wins.
   */
  rtDefault?: Value;
  /** W76: one line on why the RT default differs (for that section). */
  rtWhy?: string;
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
  // ---- preset (W77): first, since it sets keys of the groups below ------------------------------------------
  sel('preset', 'preset', 'Preset', REFLECTION_PRESET_NAMES.map((n) => [n, n] as const), 'default', {
    apply: 'rebuild', appliesTo: OURS_SSR, api: "ScreenSpaceReflectionsPass({ preset }) + HybridReflections({ preset }); applyReflectionsPreset() at runtime",
    tradeoff: 'Sets the URL keys the preset names (performance: s.reflectionResolution half) wherever the URL doesn\'t set them; the controls of those keys keep showing their own value. Clearing a key returns it to the preset\'s value.',
  }),
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
  sel('scene', 'scene', 'Scene', [['carConcept', 'Car concept'], ['toyCar', 'Toy car'], ['chess', 'Chess set'], ['sponza', 'Sponza'], ['lineSpread', 'Line spread (X0: emissive strip over a glossy floor)'], ['lineSpreadThin', 'Line spread, thin strip (X0: SSR thickness case)'], ['grazing', 'Grazing sweep (X0: checker wall over a glossy floor)'], ['cubeFloor', 'Cube and slab on a glossy floor (T53)'], ['edgesFloor', 'Sharp-edged panel above a glossy floor (T53)'], ['plateFloor', 'Thin plate over a glossy floor (T53)']], null, {
    pageDefault: 'carConcept', apply: 'rebuild', appliesTo: 'page', tradeoff: 'Reloads every method on the new scene (downloaded assets; X0\'s lineSpread / grazing are procedural, W70).',
  }),
  sel('pose', 'scene', 'Camera', [['hero', 'hero'], ['low', 'low'], ['front', 'front'], ['close', 'close'], ['top', 'top'], ['w50', 'w50 (carConcept: W50\'s view, the Measure regions)'], ['e5', 'e5 (X0 scenes: 5 deg elevation)'], ['e15', 'e15 (X0: 15 deg, the line-spread gate)'], ['e30', 'e30 (X0: 30 deg)'], ['e60', 'e60 (X0: 60 deg)']], null, {
    pageDefault: 'hero', appliesTo: 'page', tradeoff: 'Camera preset (orbit freely after). The named Measure regions for carConcept are defined at `w50` (W50) and `hero` (W46).',
  }),
  sel('view', 'scene', 'Debug view (ours)', [['final', 'Final (hybrid)'], ['split', 'Raw | denoised (left half raw)'], ['off', 'Reflections off'], ['ibl', 'Probes / environment only'], ['reflections', 'Reflection term only'], ['source', 'Source per pixel'], ['rtSource', 'Ray-traced pass per pixel'], ['confidence', 'Screen-space confidence'], ['ssrWeight', 'Hit weight vs probe (depth-aware)'], ['hitDistance', 'Hit distance'], ['hitRadiance', 'Hit radiance (x confidence)'], ['signal', 'Raw signal (denoiser input)'], ['specular', 'Specular radiance (composited)'], ['denoiseDelta', 'Denoiser change |denoised - raw|'], ['probeSpecular', 'Probe / environment radiance'], ['ao', 'AO input (specOcc on)'], ['specularOcclusion', 'Specular occlusion factor'], ['traced', 'Traced pixels (RT)'], ['depth', 'Depth (banded)'], ['depthEdges', 'Depth edges'], ['normals', 'G-buffer normals'], ['roughness', 'G-buffer roughness'], ['shadingRoughness', "three's shading roughness"]], null, {
    pageDefault: 'final', appliesTo: OURS, api: 'examples showcase/src/debugViews.ts (the showcase\'s Debug view)',
    tradeoff: 'What ours draws: the showcase\'s debug views plus depth / normals / roughness. Source: green SSR hit, blue traced hit, orange probe, magenta environment, grey rough (untraced). rtSource: blue traced hit, cyan traced hit coloured from the screen, magenta traced miss, orange over budget. denoiseDelta: red where the denoiser added light, blue where it took light away (x4). Measure reads whatever is shown.',
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
  num('envLight', 'scene', 'Environment light scale', 0, 3, 0.05, null, { pageDefault: 1, apply: 'rebuild', appliesTo: ALL, tradeoff: 'W58: scales the image-based light (scene.environmentIntensity): three\'s IBL, the probe bake and the path tracer\'s environment. 0 leaves the key light alone (with keyLight: what share of a look is the HDRI).' }),
  sel('background', 'scene', 'Background', [['hdri', 'HDRI'], ['black', 'black (camera rays only)']], null, { pageDefault: 'hdri', apply: 'rebuild', appliesTo: ALL, tradeoff: 'W58: black hides the backdrop the camera sees (backgroundIntensity 0); lighting and reflections keep the environment.' }),
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
  sel('s.quadCopy', 'sssr', 'Quad copy', [['always', 'always (FFX)'], ['sameSurface', 'same surface only (edge px trace their own ray)']], 'always', {
    appliesTo: OURS_SSR, api: 'settings.quadCopy',
    tradeoff: 'W58 (D3740): with samplesPerQuad < 4 a quad shares one ray. \'always\' copies it to every glossy px of the quad, across a silhouette too: on carConcept the skirt\'s reflection lands on the mirror floor below it (bright 2x2 dashes, raw) and the floor\'s on the skirt, the stair-stepped raw edge the denoiser then spreads. \'sameSurface\' gives px on another surface (depth > 5 %, normal > ~25 deg) their own ray. carConcept w50 960x540, lip / band MAD vs PT raw 18.6 / 14.0 -> 11.5 / 12.2, denoised 41.5 / 30.6 -> 34.4 / 26.9 (spq 4: 11.2 / 13.5, 34.3 / 27.7).',
    cost: '1080p: classify +0.02, intersect +0.02, rt trace ~+0.2 ms (carConcept w50, W58)',
  }),
  num('s.maxCandidates', 'sssr', 'Max candidates', 1, 8, 1, 1, {
    appliesTo: OURS_SSR, api: 'settings.maxCandidates',
    tradeoff: 'W80 (D5180): hits tried per ray. 1 = FFX (the first hit is validated once, a reject is a miss). More restarts the march past a rejected leaf cell (a thin foreground object, a back face) and keeps going, sharing the march-step budget; every leaf cell behind an object is another candidate, so it only gets through overlaps a few px wide, and it cannot find a surface the camera does not see. A 6 cm post in front of a wall (examples/ssr scene thinPost, 960x540): nothing changes up to 4, at 8 the wall class 0.944 -> 0.988 confident and misses -27 % at 1080p; the other examples scenes and carConcept do not move (lip / band MAD vs PT unchanged).',
    cost: '1080p, intersect: mirrorWall 0.93 -> 1.06 / 1.16 / 1.21 ms at 2 / 4 / 8, thinPost 0.96 -> 1.25 at 8 (about +0.25 ms at 8); carConcept w50 within noise (W80)',
  }),
  sel('s.reflectionResolution', 'sssr', 'Reflection resolution', [['full', 'full'], ['half', 'half (trace + denoise at half res, joint bilateral upsample)']], 'full', {
    apply: 'rebuild', appliesTo: OURS_SSR, api: 'settings.reflectionResolution',
    tradeoff: 'W75 (X5, D5080): \'half\' point-samples the G-buffer at one pixel per 2x2 quad, traces (SSR + RT) and denoises there, and upsamples the residual (denoised - probe) with a joint bilateral filter (plane distance, normal, roughness). Fewer rays and a quarter of the denoiser\'s pixels; mirrors and thin edges lose resolution (step 1: everything at half res). carConcept w50 MAD vs PT denoised: band 30.6 -> 58.3, lip 41.5 -> 50.5 (raw +0.4..+2.4).',
    cost: '1080p, AA off, rt (W75 phase 2): carConcept frame sum 14.0 -> 10.6 ms (rt trace 2.53 -> 0.89, denoise 1.94 -> 0.51, upsample +0.37, half-res sample +0.16); contact 11.2 -> 9.0; mirrorWall 8.2 -> 6.6',
  }),
  sel('s.rayReuse', 'sssr', 'Ray reuse', [['copy', 'copy (FFX quad copy)'], ['ratio', 'ratio estimator (BRDF / pdf-weighted neighbours)']], 'copy', {
    appliesTo: OURS_SSR, api: 'settings.rayReuse',
    tradeoff: 'W73 (X3, D5040): what a glossy px without its own ray gets. \'copy\' pastes its quad\'s ray (FFX). \'ratio\' resolves every glossy px from its own ray, its quad\'s and s.rayReuseTaps neighbours within s.rayReuseRadius, weighted by its own BRDF along the direction to each neighbour\'s hit over that ray\'s pdf (SSSR 2015, DiligentFX); same surface only. The target: ratio at spq 1 about as quiet as copy at spq 4. Experiment; the FFX denoiser still runs after it.',
    cost: 'one extra pass + 16 B/px record buffer (not timed yet: shared GPU)',
  }),
  sel('s.rayReuseTaps', 'sssr', 'Ray reuse taps', [['4', '4'], ['8', '8']], 8, {
    appliesTo: OURS_SSR, api: 'settings.rayReuseTaps',
    tradeoff: 'W73: neighbour taps of the ratio resolve besides the px\'s own quad. Only with s.rayReuse ratio.',
  }),
  num('s.rayReuseRadius', 'sssr', 'Ray reuse radius', 0, 16, 0.5, 4, {
    appliesTo: OURS_SSR, api: 'settings.rayReuseRadius',
    tradeoff: 'W73: tap radius in px at perceptual roughness >= 0.2, x sat(5 r) below (DiligentFX\'s 4 sat(5 r)). Wider is quieter and blurs more (the line-spread gate). Only with s.rayReuse ratio.',
  }),
  sel('s.rayReusePattern', 'sssr', 'Ray reuse tap pattern', [['frame', 'rotated per frame'], ['pixel', 'fixed per pixel']], 'frame', {
    appliesTo: OURS_SSR, api: 'settings.rayReusePattern',
    tradeoff: 'W73 (D5046): the ratio taps re-rotated per pixel and frame (the resolve\'s error moves every frame) or fixed per pixel (it stays put, for the denoiser\'s temporal pass). Only with s.rayReuse ratio.',
  }),
  bool('s.rayReuseMixSources', 'sssr', 'Ray reuse: mix hits and misses', false, {
    appliesTo: OURS_SSR, api: 'settings.rayReuseMixSources',
    tradeoff: 'W73 (D5047): off (default), the ratio resolve reuses only rays of the px\'s own hit source (screen hit vs miss, D3660). On, it also averages the hit / miss pattern, but the confidence then is a share of hits and the depth-aware blend (h.depthAware, D2400) hands the hits the whole weight: carConcept door raw 1.04 -> 1.38 linear (SSR only). Use with h.depthAware 0.',
  }),
  sel('s.quadBaseRotation', 'sssr', 'Quad base rotation', [['fixed', 'fixed (FFX: top-left)'], ['frame', 'frame (corner cycles per frame)'], ['pattern', 'pattern (4x4 Latin square, per frame)']], 'fixed', {
    appliesTo: OURS_SSR, api: 'settings.quadBaseRotation',
    tradeoff: 'W71 (X1 #1, D5000): which px of a 2x2 quad traces when samplesPerQuad < 4. \'fixed\' keeps the copy\'s 2x2 grid in place (it can show under TAA / the upscaler and drift in blocks at rest); \'frame\' / \'pattern\' move it every frame, so the history averages it out. Composes with Quad copy \'sameSurface\'.',
    cost: 'classify +0.06 ms at 1080p (pattern: 0.154 -> 0.211, contact + RT; intersect / rt trace within noise; W71)',
  }),
  num('s.maxTraversalIntersections', 'sssr', 'Max march steps', 0, 256, 1, 128, { appliesTo: OURS_SSR, api: 'settings.maxTraversalIntersections', tradeoff: 'Hi-Z march steps per ray: fewer is cheaper and sends long rays to the miss list (probe or RT); 0 = SSR off.' }),
  num('s.minTraversalOccupancy', 'sssr', 'Min occupancy', 0, 64, 1, 0, {
    appliesTo: OURS_SSR, api: 'settings.minTraversalOccupancy',
    tradeoff: 'Glossy rays stop once this few lanes of their subgroup still march (FFX\'s early exit, FFX: 4): higher ends long tails earlier (cheaper, more misses). Mirrors ignore it. W101 (D5560): 0 by default. Subgroup membership follows the ray list\'s atomic order, which changes every dispatch, so with the exit a still frame traces differently each time: at 4, quickstart rest flicker 0.30-0.32 % of px (0 gives 0.24-0.25), engines/three rest 0.0078-0.0081 / 255 (0 gives 0.0072-0.0075), contact orbit std +5 %; 0 also finds hits the exit dropped (contact: image 0.18 / 255 mean vs a 0.10 noise floor).',
    cost: '0 vs 4, 1080p intersect: +0.05-0.14 ms on glossy scenes (contact, Sponza, carConcept; +10-21 % of the pass, 2-6 % of the tracer), mirrorWall 0; half res +0.03-0.06 ms (W101)',
  }),
  num('s.depthBufferThickness', 'sssr', 'Thickness', 0, 0.5, 0.001, 0.2, {
    defaultNote: 'showcase scenes set their own (kit.thickness)', appliesTo: OURS_SSR, api: 'settings.depthBufferThickness (THICKNESS_HYBRID)',
    tradeoff: 'Hit acceptance thickness in view-space units. Thicker accepts rays that pass behind objects (streaks, the dark band under carConcept\'s sill, D2402); thinner cuts holes (FFX\'s 0.015 holes the sphere, D4303). Room scale 0.2 is too thick for a car (W11).',
  }),
  num('s.thicknessRoughnessFactor', 'sssr', 'Thickness per alpha', 0, 20, 0.1, 10, { defaultNote: 'showcase scenes set their own', appliesTo: OURS_SSR, api: 'settings.thicknessRoughnessFactor', tradeoff: 'Thickness added per unit of the pixel\'s alpha: rough rays need less precision (D1001).' }),
  num('s.thicknessLengthFactor', 'sssr', 'Thickness per ray length', 0, 0.1, 0.001, 0.01, { appliesTo: OURS_SSR, api: 'settings.thicknessLengthFactor', tradeoff: 'Thickness added per world unit of ray length: far hits are coarser (D1001).' }),
  num('s.thicknessDepthFactor', 'sssr', 'Thickness per view depth', 0, 0.1, 0.001, 0, {
    appliesTo: OURS_SSR, api: 'settings.thicknessDepthFactor (RT_THICKNESS_DEPTH_FACTOR)',
    rtDefault: 0.02, defaultNote: 'with RT on and the mode \'relative\': 0.02 (W76)',
    rtWhy: 'W76 (maintainer\'s call on X1 #2, D5001): the relative test at 0.02 x view depth stops thin geometry turning into a slab (lineSpreadThin x4.25 -> x1.45..x2.2 of the PT\'s width) and is flat on carConcept, toyCar, chess, Sponza with RT (within 0.15 MAD); the rays it rejects go to the RT pass. Without RT they would take the probe (Sponza +1 %, more misses), so the default stays 0 there. `thicknessDepthFactor: 0` (or mode \'add\') restores the old test.',
    cost: 'intersect +0.008 ms at 1080p (add, k 0.01); relative: none measured (contact + RT, W71). Relative 0.01 sends 9-13 % more rays to the miss list. W76, the RT default (relative 0.02, rough: re-time on a quiet machine): traced rays Sponza +15 % (rt trace ~+0.1 ms at 1080p), mirrorWall +3 %, carConcept 0',
    tradeoff: 'W71 (X1 #2, D5001): thickness += k x the hit\'s view depth, so one value scales from a toy car to a hall (with mode \'relative\' it is the whole thickness: Diligent\'s distance / viewZ < 0.025 is k 0.025). 0 = off.',
  }),
  sel('s.thicknessDepthMode', 'sssr', 'Thickness depth mode', [['add', 'add (to the constant, alpha and length terms)'], ['relative', 'relative (k x view depth alone, Diligent)']], 'add', {
    appliesTo: OURS_SSR, api: 'settings.thicknessDepthMode',
    rtDefault: 'relative', defaultNote: 'with RT on: `relative` (W76)',
    rtWhy: 'W76: with Thickness per view depth, the RT default (relative 0.02), only while both are unset. An explicit \'add\' keeps the pre-W76 thickness with RT on (the factor then defaults to 0); an explicit factor alone keeps \'add\' too.',
    tradeoff: 'W71 (X1 #2, D5001): how Thickness per view depth combines. \'relative\' drops the constant, per-alpha and per-length terms; it takes effect only once Thickness per view depth is above 0 (k 0 = off in both modes).',
  }),
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
  num('s.mirrorBias', 'sssr', 'Mirror bias', 0, 0.99, 0.01, 0.5, { // W72: capped (compensated, f stops at 0.99: MAX_COMPENSATED_BIAS)
    appliesTo: OURS_SSR, api: 'settings.mirrorBias (DEFAULT_COMPENSATED_MIRROR_BIAS)',
    defaultNote: 'W76: 0.5 with the cone + compensation (the defaults), else 0',
    tradeoff: 'D49: truncates the GGX lobe toward the mirror direction: less noise, a sharper (biased) reflection. W32 / W39: no gain with the denoiser on a still or orbiting camera; W40: 0.7 halves rest shimmer on the carConcept floor (0.31 -> 0.14/255).',
    cost: 'free (one multiply in the sample)',
  }),
  sel('s.hitColorFilter', 'sssr', 'Hit colour filter', [['off', 'off (the hit texel, FFX; the pre-W76 default)'], ['cone', 'cone (pre-filtered pyramid by the lobe cone at the hit)']], 'cone', {
    appliesTo: OURS_SSR, api: 'settings.hitColorFilter (DEFAULT_HIT_COLOR_FILTER; the tracer builds its variant async on the first \'cone\' frame)',
    defaultNote: 'W76: `cone` with compensation at mirror bias 0.5; `off` is the one switch back to the pre-W76 tracer (bit for bit)',
    tradeoff: 'W72 (X2 #5, D5020): a screen-space hit reads its screen colour (the re-shade\'s diffuse) from an 8-level pyramid at log2 of the lobe cone\'s width in px where the ray hits: long rays blur, contacts stay sharp (SSSR 2015). Raw fireflies go (r 0.35 sphere p999 23.9 -> 3.2 x mean, grazing emissive wall raw MAD 32 -> 8 at 5 deg); no widening on the line spread (r 0.05 x1.24 -> 1.22) and no leakage at silhouettes, but alone it brings no lost glossy reflection back and the denoised grazing floor gets blurrier (gradient x0.79 -> 0.40). Use it with Compensate mirror bias.',
    cost: 'W76 (rough, shared GPU: re-time on a quiet machine): hit colour pyramid pass 0.24-0.27 ms at 1080p, 0.43-0.63 ms at 1440p (carConcept, Sponza, mirrorWall, RT on, loop stopped, interleaved A/B); intersect within the noise. W72: +0.24-0.26 ms at 1080p',
  }),
  num('s.hitColorConeGrazing', 'sssr', 'Hit colour cone grazing shrink', 0, 1, 0.05, 0, {
    appliesTo: OURS_SSR, api: 'settings.hitColorConeGrazing (DEFAULT_HIT_COLOR_CONE_GRAZING)',
    tradeoff: 'W76 (X1 #3 folded into the cone, D5100): the cone x mix(1, mix(sat(2 NdotV), 1, sqrt(roughness)), this) (SSSR 2015 slide 85 at 1), so a floor seen at a grazing angle reads a finer pyramid mip. X0 grazing (r 0.15 floor, cone + compensation 0.5): denoised gradient vs PT at 5 / 15 deg x0.53 / 0.53 at 0 -> x0.59 / 0.58 at 0.5 -> x0.67 / 0.63 at 1 (pre-W76 x0.79 / 0.75), denoised MAD at 5 deg 6.98 -> 6.50, at 15 deg 8.91 -> 9.24; 60 deg unchanged. But the line-spread gate\'s r 0.15 line (seen at 15 deg) narrows past +-10 %: x1.01 at 0 -> x0.91 at 0.5 -> x0.84 at 1 (AA on; AA off x0.96 / 0.86 / 0.93), so off by default. Only with the cone. (W71\'s hitLobeFilterGrazing, the same shrink on the lobe filter, was a no-op and is gone.)',
    cost: 'part of the intersect (one normal load per cone hit); see Hit colour filter',
  }),
  num('s.hitColorConeScale', 'sssr', 'Hit colour cone scale', 0, 4, 0.05, 1, {
    appliesTo: OURS_SSR, api: 'settings.hitColorConeScale',
    tradeoff: 'W72 (D5020): scales the cone of Hit colour filter (1 = the reflected GGX lobe\'s full width at half maximum, 2.57 alpha). Only with the cone on. 2 widens the line spread (r 0.05 x1.22 -> 1.33): keep 1.',
    cost: 'free',
  }),
  bool('s.mirrorBiasCompensate', 'sssr', 'Compensate mirror bias', true, {
    appliesTo: OURS_SSR, api: 'settings.mirrorBiasCompensate (DEFAULT_MIRROR_BIAS_COMPENSATE; the RT pass follows the tracer, mirrorBiasSplit)',
    tradeoff: 'W72 (X2 #6, D5021-D5022; needs Hit colour filter cone): Mirror bias f narrows the sampled lobe to alpha sqrt(1 - f) instead of truncating it, and the cone and the lobe filter (SSR and RT) supply alpha sqrt(f): less noise at the same total width. At f 0.5 the line spread\'s r 0.15 reflection, lost at the defaults, comes back at x0.99 of the PT (AA off x0.95) and r 0.05 narrows x1.24 -> 1.18; truncation (no compensation) brings it back at x0.55 (too sharp). Grazing denoised MAD -0.7..-1.0 at 5-15 deg but blurrier. f 0.7 x0.93 (AA off x0.88).',
    cost: 'free on top of the cone (scales in the sample and the lobe filter); the default cone + compensation together: the cone\'s pyramid pass (W76, rough: re-time on a quiet machine)',
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
  sel('bvhBuilder', 'rt', 'Builder (@pmndrs/bvh)', [['auto', 'auto (H-PLOC with subgroups, else tinybvh)'], ['gpu-hploc', 'gpu-hploc'], ['gpu-lbvh', 'gpu-lbvh'], ['tinybvh', 'tinybvh (CPU)']], 'auto', {
    apply: 'rebuild', appliesTo: RT, api: 'createRaytracerTraceProviderFromObjects({ builder })', tradeoff: 'Tree builder: build time and tree quality (trace cost); same hits.',
  }),
  bool('rtShade', 'rt', 'Raytracer hit shading (opt-in)', false, {
    apply: 'rebuild', appliesTo: RT, api: 'trace.raytracerHitShading (pass.setRaytracerHitShading)',
    tradeoff: 'W82 (T70, D5201): traced hits are shaded by @pmndrs/raytracer\'s one bounce (emission + one light sample with a shadow ray, diffuse + GGX) instead of the probe lookup; stochastic, so meant for the denoised frame. Off (default): the probes shade traced hits, as before. The traced pass binds 7 storage buffers with it (8 with probe hit shading; W89, D5450): WebGPU\'s default 8 suffice.',
    cost: 'one light sample and its shadow ray per traced hit; not measured separately',
  }),
  bool('rtShadingNormals', 'rt', 'Interpolated hit normals', true, { apply: 'rebuild', appliesTo: RT, api: 'provider option shadingNormals', tradeoff: 'D1700: traced hits shade with the vertex normals (smooth, as three shades on screen) instead of the face normal (faceted).', cost: 'up to +0.07 ms at 1080p (D1700, measured on a former provider)' }),
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
  bool('t.hitShadows', 'rt', 'Hit shadow rays', true, { appliesTo: RT, api: 'traceSettings.hitShadows', tradeoff: 'D903: one shadow ray per directional light from each traced off-screen hit; off lights every hit unoccluded.', cost: '<= 0.03 ms on 3 of 4 scenes (D903); \'moving\' 1080p +0.081 ms (D2601, the former @pmndrs/bvh wrapper)' }),
  bool('t.hitSpecular', 'rt', 'Hit specular lobe', true, { appliesTo: RT, api: 'traceSettings.hitSpecular', tradeoff: 'D3510: traced hits shade their specular lobe and coat (with D3513\'s one visibility ray); off = diffuse + emissive only.' }),
  num('rtLobeFilter', 'rt', 'Hit lobe filter (traced)', 0, 2, 0.05, null, { defaultNote: 'the tracer\'s (Hit lobe filter)', appliesTo: RT, api: 'traceSettings.hitLobeFilter', tradeoff: 'Overrides the lobe filter at traced hits only (the compare page\'s ?rtLobeFilter=): separates the W45 effect on RT hits from the screen-space ones.' }),
  num('t.onScreenDepthTolerance', 'rt', 'On-screen depth tolerance', 0, 0.1, 0.005, 0.02, { appliesTo: RT, api: 'traceSettings.onScreenDepthTolerance', tradeoff: 'Relative view-distance tolerance for "the camera sees this hit": looser reuses more screen colour (cheaper shading, can pick a neighbour).' }),
  num('t.iblFactor', 'rt', 'IBL factor (traced)', 0, 2, 0.05, 1, { appliesTo: RT, api: 'traceSettings.iblFactor', tradeoff: 'Scales the traced misses\' fallback.' }),
  sel('t.hitShadeVisibility', 'rt', 'Visibility ray on re-shaded hits', [['offscreen', 'offscreen (on-screen re-shaded hits take none, D3542)'], ['all', 'all (on-screen re-shaded hits too)']], 'offscreen', {
    appliesTo: RT, api: 'traceSettings.hitShadeVisibility',
    tradeoff: 'W52 (D3640): D3513\'s visibility ray along R for on-screen re-shaded traced hits too. Wheel 43 -> 41 vs PT 26 (carConcept); mirrors seen in mirrors go black where blocked (facingMirrors, D3542). Needs Hit shadow rays on.',
    cost: 'rt trace +0.30 ms (W52)',
  }),
  sel('t.tracedMissRate', 'rt', 'Traced miss rate (glossy)', [['full', 'full (every miss traced)'], ['half', 'half (every other quad + bilateral fill)']], 'full', {
    appliesTo: RT, api: 'traceSettings.tracedMissRate (or settings.tracedMissRate; traceSettings wins)',
    tradeoff: 'W74 (X4, D5060): \'half\' traces the glossy misses of every other 2x2 quad (a checkerboard flipping each frame); the others take their traced neighbours\' result through core bilateralFill (plane distance, normal power, roughness, same source), or the probe where none fits. Half the glossy BVH rays; mirrors and near-mirrors stay full rate.',
  }),
  num('t.tracedHalfRateMinRoughness', 'rt', 'Half rate from roughness', 0, 1, 0.01, 0.05, {
    appliesTo: RT, api: 'traceSettings.tracedHalfRateMinRoughness (or settings.; DEFAULT_TRACED_HALF_RATE_MIN_ROUGHNESS)',
    tradeoff: 'W74: perceptual roughness from which \'half\' applies; smoother misses are all traced (mirror-like floors and paint keep their sharp reflections).',
  }),
  num('t.fillPlaneTolerance', 'rt', 'Fill: plane tolerance', 0, 0.1, 0.001, 0.01, { appliesTo: RT, api: 'traceSettings.fillPlaneTolerance (BilateralFillWeights.planeTolerance)', tradeoff: 'W74: a neighbour farther than this x the view distance from the pixel\'s tangent plane takes no weight (silhouettes, steps). 0 = off.' }),
  num('t.fillNormalPower', 'rt', 'Fill: normal power', 0, 128, 1, 16, { appliesTo: RT, api: 'traceSettings.fillNormalPower', tradeoff: 'W74: pow(dot(n_p, n_q), k): higher keeps the fill on one face (curved and normal-mapped surfaces fall back to the probe more). 0 = off.' }),
  num('t.fillRoughnessTolerance', 'rt', 'Fill: roughness tolerance', 0, 1, 0.01, 0.1, { appliesTo: RT, api: 'traceSettings.fillRoughnessTolerance', tradeoff: 'W74: perceptual roughness difference at which a neighbour\'s weight reaches 0. 0 = off.' }),
  num('t.fillSourceMask', 'rt', 'Fill: accepted sources', 0, 31, 1, 22, { appliesTo: RT, api: 'traceSettings.fillSourceMask', tradeoff: 'W74: RT_SOURCE codes a neighbour may have, one bit each: 22 = traced hit (2) + traced miss (4) + on-screen traced hit (16). +1 also takes screen-space hits, +8 capped entries.' }),
  num('t.fillMinWeightSum', 'rt', 'Fill: min weight sum', 0, 1, 0.01, 0.01, { appliesTo: RT, api: 'traceSettings.fillMinWeightSum', tradeoff: 'W74: below this the pixel keeps intersect\'s probe fallback (as an entry past the ray budget).' }),
  sel('t.fillFootprint', 'rt', 'Fill: footprint (quads)', [['3', '3x3 quads'], ['2', '2x2 quads'], ['4', '4x4 quads']], 3, { appliesTo: RT, api: 'traceSettings.fillFootprint', tradeoff: 'W74: quads gathered around the pixel\'s own; 3 reaches the 4 traced edge neighbours of the checkerboard, 4 also the next ring (wider, softer).' }),

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
    tradeoff: 'W77 (maintainer: not in the performance preset): with RT it lowers silhouette error but raises flicker there. carConcept w50 sill band at half res MAD 57.9 -> 39.3, but the band\'s orbit flicker 1.16 -> 2.94 (reflection region 0.41 -> 0.51); at full res band 30.6 -> 23.2, band flicker 0.90 -> 1.32; chess, Sponza, the ssr scenes unchanged; no effect without RT. The denoiser stops blending bright screen-space hits into dark traced ones (the W50 halo: carConcept lip 80 -> 59 with hits, 52 with all, PT 48, at 960x540; at 1080p the halo is mostly gone anyway). hits: no regression on chess / toyCar / Sponza. all: boils where rays flip between hit and miss (std p99 x4-10). Both show a 2x2 stair step at source edges (D3663).',
    cost: '+0.35 ms (hits) / +0.51 ms (all) at 1080p, ~0 at 960x540 (W53)',
  }),
  num('hitDistW', 'denoiser', 'Hit-distance weight', 0, 16, 1, 0, {
    appliesTo: OURS_DN, api: 'FfxReflectionDenoiser({ hitDistanceWeight })',
    tradeoff: 'Neighbours weighted by relative hit distance, exp(-k |t_p - t_q| / (t_p + t_q)); no extra input. 8 separates the lip as well as the source (50.6) but boils everywhere the hit distance varies (std p99 x5-10). 0 = off.',
    cost: '+1.3 ms at 1080p for k 8 (W53)',
  }),
  sel('keepBlack', 'denoiser', 'Black samples keep the history', [['0', 'off (FFX: output 0, history dropped)'], ['1', 'on (HybridReflections default)']], '1', {
    appliesTo: OURS_DN, api: 'HybridReflections.denoiserKeepHistoryOnBlack (default true) -> FfxReflectionDenoiser({ keepHistoryOnBlack })',
    tradeoff: 'W78 (D5145): FFX\'s resolve writes 0 to the output and the history wherever a frame\'s prefiltered radiance is black, so a sparse glossy reflection over a dark environment never builds up (the line-spread gate\'s r 0.15 / 0.3 losses). On, black samples accumulate like any other.',
  }),
  sel('variance', 'denoiser', 'Variance-guided tracing input', [['0', 'off'], ['1', 'on (denoiser variance -> tracer)']], '0', {
    appliesTo: OURS_DN, api: 'HybridReflections.denoiserVariance = true; settings.temporalVarianceGuidedTracing / varianceThreshold',
    tradeoff: 'W85 (T36, Denoiser #25): last frame\'s denoiser variance goes back to the tracer, which traces the quad\'s other pixels where it is above Variance threshold (s.varianceThreshold; FFX samples use 0, documented range 0 to 0.01). Extra rays after disocclusion and in noisy glossy areas.',
  }),
  num('brdfMin', 'denoiser', 'BRDF weights from roughness', 0, 0.447, 0.01, 0.1, {
    appliesTo: OURS_DN, api: 'FfxReflectionDenoiser({ brdfMinAlpha: r * r })',
    tradeoff: 'W78: the BRDF / pdf weights only from this perceptual roughness up; smoother px keep FFX\'s weights (near-mirrors: the ratio is so peaked the taps barely average, orbit flicker +40-70 % on carConcept\'s r 0.03 floor).',
  }),
  sel('brdf', 'denoiser', 'BRDF / pdf prefilter weights', [['off', 'off (FFX)'], ['replace', 'replace the luminance weight'], ['combine', 'combine with the luminance weight']], 'off', {
    appliesTo: OURS_DN, api: 'ssr.settings.sampleDirection = true; hybrid.denoiserSampleDirection = true; FfxReflectionDenoiser({ brdfWeights, brdfAlphaScale })',
    tradeoff: 'W78 (X3 phase B, D5140-D5145): each neighbour\'s sample in FFX\'s prefilter weighted by this px\'s GGX BRDF x cos along the direction to that sample\'s hit, over the sample\'s pdf (SSSR 2015\'s ratio estimator, W73\'s weights inside the denoiser instead of a pass in front of it). The tracer hands each px\'s direction and pdf through the seam (a tracer rebuild on an on / off flip).',
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
  sel('probeLayout', 'probes', 'Probe layout (Sponza)', [['shipped', 'shipped'], ['few', 'few'], ['medium', 'medium'], ['many', 'many'], ['manyCell', 'manyCell'], ['mixed', 'mixed'], ['oneSize128', 'oneSize128 (W62: mixed volumes, all 128 px)'], ['oneSize256', 'oneSize256 (W62)'], ['twoSize', 'twoSize (W62: 512 floor + 256)'], ['twoSizeFew', 'twoSizeFew (W62)'], ['mixedDown', 'mixedDown (W62)']], null, { defaultNote: 'per scene: Sponza oneSize128 (W102), shipped elsewhere', apply: 'rebuild', appliesTo: OURS, api: 'examples probeLayouts.ts (W61)', tradeoff: 'W61: probe layouts at an equal memory budget (Sponza only): a few large or mixed sizes beat a grid of small ones. W102 (T22): Sponza defaults to oneSize128 (W62: +3.5 dB vs the PT at a third of the memory); shipped is the seven hand-placed boxes.' }),
  sel('carProbes', 'probes', 'Car interior probes (carConcept)', [['off', 'off'], ['wheels', 'wheels (one per wheel well)'], ['cabin', 'cabin'], ['both', 'wheels + cabin'], ['cabinGlass', 'cabin grown to the paint (takes in the glass; experiment)']], null, {
    defaultNote: 'wheels (carConcept, W102)', apply: 'rebuild', appliesTo: OURS, api: 'examples showcase/src/carProbes.ts (W55)',
    tradeoff: 'W55: small probes inside carConcept beside the stage probe, boxes from the car\'s geometry (wheel bounds less the body paint; the cabin grown from the seats to the glass). The wells and the cabin then reflect their own capture instead of the open studio (D3680, D3681). W102 (T21, decision 18): wheels at 64 px is carConcept\'s default on the showcase, the bench and the compare page; off is the stage probe alone.',
  }),
  sel('carProbeRes', 'probes', 'Car interior probe size', [['64', '64'], ['128', '128'], ['256', '256']], null, {
    pageDefault: '64', apply: 'rebuild', appliesTo: OURS, api: 'ReflectionProbe.resolution (D4700)',
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

/**
 * W76: what else behaves differently with ray tracing on, besides the `rtDefault` settings (docs/SETTINGS.md
 * "What changes when ray tracing is on"). Behaviour of the RT path itself, not a default a user can miss.
 */
export const RT_BEHAVIOUR: { what: string; why: string }[] = [
  { what: 'The tracer runs with `missesTraced: true`', why: 'The three adapter sets it while its traced pass runs; it is what switches the RT defaults above on in core (`resolveScreenSpaceSettings`). A direct core user sets it on the tracer\'s dispatch.' },
  { what: 'On-screen traced hits are re-shaded without a visibility ray', why: 'D3542: as the screen-space re-shade (no BVH there); with the ray a mirror seen in a mirror went black in stripes. `traceSettings.hitShadeVisibility: \'all\'` adds it (D3640). Off-screen traced hits keep D3513\'s ray.' },
  { what: 'Specular occlusion skips traced misses', why: 'W45 (D3551, D4513): a traced miss left the scene unblocked, so Lagarde\'s AO guess would occlude it twice. Untraced pixels keep it (`specOcc`).' },
  { what: 'Lobe filter where hits mix (`s.hitLobeFilterMixed` < 1) acts', why: 'D3641: it reads last frame\'s hit source, which only the traced pass writes; without RT it changes nothing.' },
  { what: '`rayReuse: \'ratio\'` leaves traced pixels alone', why: 'D5043: the resolve runs before the traced pass, which overwrites the miss list\'s pixels; screen and traced hits never mix in it.' },
  { what: 'The traced lobe filter follows the tracer\'s lobe split', why: 'D5021 / W76: with the cone + compensation defaults a traced hit\'s specular is filtered by hitLobeFilter x alpha x sqrt(mirrorBias) (the share the narrowed sample leaves out); `traceSettings` can override it.' },
];

/** W77: what docs/SETTINGS.md says about each named preset (core REFLECTION_PRESETS); one entry per preset. */
export interface PresetDoc {
  name: ReflectionsPresetName;
  /** What it sets, in words. */
  sets: string;
  /** Measured GPU cost or saving, with its source. */
  cost: string;
  /** What it trades. */
  tradeoffs: string;
  /** When not to use it. */
  avoid: string;
  /** How it combines with the upscaler's render ratio. */
  upscaler: string;
}
export const PRESET_DOCS: PresetDoc[] = [
  {
    name: 'default',
    sets: 'Nothing: every key a preset names goes back to what the app passed at construction, else to the package default.',
    cost: '',
    tradeoffs: 'Full-resolution trace and denoise (the package defaults).',
    avoid: '',
    upscaler: 'At ratio 1.5 the reflections are already a small share of the frame (W77), so the upscaler is the bigger saving.',
  },
  {
    name: 'performance',
    sets: '`reflectionResolution: \'half\'`: trace, RT and denoise at half size in each axis, joint bilateral upsample. No denoiser hit source (maintainer, 2026-11-13: flicker first); that stays its own switch (Denoiser group, `hitSource`).',
    cost: 'Relative only, re-time on a quiet machine (W77: 1080p, ratio 1, RT, cone defaults, GPU shared with other runs, least-contended page, measured with the hit source on, which W53 puts at +0.35 ms): reflection passes about halve, carConcept 6.0 -> 2.6 ms, chess 4.0 -> 1.6, Sponza 3.3 -> 2.4, mirrorWall 10.7 -> 5.0, contact 12.4 -> 7.4. At ratio 1.5 about -1 ms; at ratio 2 nothing (its half-res sample + upsample passes eat the saving).',
    tradeoffs: 'W77 bench vs the path tracer (960x540, ours-rt, ratio 1): carConcept frame MAD 7.8 -> 8.9, lip 41.8 -> 50.0, sill band 30.6 -> 57.9 (the half-res denoiser covers twice the screen area); chess 6.9 -> 7.2; Sponza unchanged. Orbit flicker of the reflection: carConcept 0.36 -> 0.41, chess 0.23 -> 0.25, Sponza 0.53 -> 0.55. Mirrors: jagged reflected edges (W75). A thin bright reflection loses most of its peak at r 0.05 and is lost at r 0.15 (line spread).',
    avoid: 'With an upscale ratio of 2 (no saving, thin features lost, carConcept door MAD +4); when the frame already upscales at 1.5 or more and reflections are a small share; mirror close-ups whose reflected edges must stay crisp; thin bright emitters (neon strips, specular lines) on glossy floors; RT scenes whose silhouettes over a mirror floor matter (the car sill: add hitSource \'hits\' if its flicker is acceptable).',
    upscaler: 'Use it at ratio 1. At 1.5 it still saves ~1 ms but stacks: a thin strip at r 0.05 is lost, mirrorWall orbit flicker +17 %. Not at 2. Given the choice, upscale 1.5 first (the whole frame shrinks) and keep full-res reflections.',
  },
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

/**
 * W77: the bench URL keys preset `name` sets (tracer settings as `s.<field>`, the denoiser's hit source as
 * `hitSource`), as URL strings. Empty for an unknown name or null.
 */
export function presetUrlKeys(name: string | null): Record<string, string> {
  if (!name || !(REFLECTION_PRESET_NAMES as string[]).includes(name)) return {};
  const p = reflectionsPreset(name as ReflectionsPresetName);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.tracer)) if (v !== undefined) out[`s.${k}`] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  if (p.denoiser.hitSource !== undefined) out.hitSource = p.denoiser.hitSource === 'off' ? '0' : p.denoiser.hitSource;
  return out;
}

/** A value as the URL carries it (booleans 1 / 0). */
export const encodeValue = (s: Setting, v: Value): string => (s.type === 'bool' ? (v ? '1' : '0') : String(v));
export function decodeValue(s: Setting, v: string): Value {
  if (s.type === 'bool') return v === '1' || v === 'true';
  if (s.type === 'number') return Number(v);
  return v;
}
/** The value a control shows when the URL has none. */
export const effectiveDefault = (s: Setting): Value | null => s.pageDefault ?? s.default;
