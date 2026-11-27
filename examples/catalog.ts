/**
 * Every example, once. The gallery (examples/index.html + gallery.ts), each page's shell (examples/shell: info panel, nav), the Vite
 * build inputs (examples/vite.config.ts), the site build and check (tools/site-*.ts), `pnpm check -- --only catalog` and its
 * thumbnails (scripts/run-headless.mjs) all read this list. The plan behind it is docs/EXAMPLES.md; the shape follows
 * `@pmndrs/pathtracer`'s examples/catalog.ts so the sibling galleries look and work alike.
 *
 * Adding an example (the recipe; docs/EXAMPLES.md has it too):
 *  1. Copy `examples/features/probes/box-projection/` to `examples/<category>/<name>/` (path convention below).
 *  2. Fill in (or un-plan) its entry here: drop `planned`, write the brief. A feature, quality or performance page needs `brief.compare`.
 *  3. In its main.ts call `mountShell('<slug>')` and expose `window.__p` ({ stop, shot, setCompare? }) for the check.
 *  4. `REFLECTIONS_PORT=<port> pnpm check -- --only catalog` (and `--thumbs` for its card image, then commit the webp).
 *
 * Paths: existing pages keep their folders and URLs (docs and the README link them). A new page lives at
 * `<category>/<slug without its category prefix>/`: `probes/box-projection` -> `features/probes/box-projection/`,
 * `engines/three` -> `engines/three/`.
 *
 * Every example answers three things on the page (its `brief`; the info panel opens on a first visit):
 *  1. What is the point (`brief.kind`, `brief.shows`)?
 *  2. What to do to see it (`brief.tryThis`, one to three controls)?
 *  3. What to compare against (`brief.compare`): the switch that shows the cheaper, noisier or plainer way. Required for the
 *     `feature`, `quality` and `performance` kinds; a visitor should see the difference, not read about it.
 *
 * Pure data and pure functions: no DOM, no imports (vite.config.ts and Node scripts load it).
 */

export type CategoryId = 'showcase' | 'start' | 'features' | 'engines' | 'lab';

/**
 * - `stable`: built on the published API with its current defaults.
 * - `experimental`: works and is checked, but the API, the adapter or its defaults can still change.
 * - `research`: a developer page (a test, a bench, a study); it may move or go away.
 */
export type ExampleStatus = 'stable' | 'experimental' | 'research';

export interface Category {
  id: CategoryId;
  title: string;
  blurb: string;
}

/** What kind of point an example makes. */
export type ExampleKind = 'showcase' | 'feature' | 'performance' | 'quality' | 'educational' | 'debugging' | 'informative';

/** The example's brief, at the top of its info panel: what it shows, what to try, and what to compare it against. */
export interface ExampleBrief {
  kind: ExampleKind;
  /** What this shows and why it matters, in one or two sentences a newcomer can follow. */
  shows: string;
  /** One to three things to do on the page that make the point. */
  tryThis: readonly string[];
  /** The baseline: the control that shows the plainer way. Required for `feature`, `performance` and `quality`. */
  compare?: string;
}

export interface ExampleEntry {
  /** Unique; the page's id in the shell, the anchor in the gallery and the localStorage key of its info panel. */
  slug: string;
  /** URL under the gallery root: a folder with a trailing slash (`quickstart/`) or an html file (`quickstart/probes.html`). */
  path: string;
  title: string;
  /** One line for the card. */
  summary: string;
  /** How it works, shown in the info panel below the brief. `code` and **bold** render. */
  description: string;
  brief: ExampleBrief;
  category: CategoryId;
  status: ExampleStatus;
  /** Shown as tags on the card. */
  tags: string[];
  /** Docs page below the docs root (no leading slash), linked from the page's nav. */
  docs?: string;
  /** Repository path of the source (a folder or the main file), linked from the page's nav. */
  source: string;
  /** Optional WebGPU features the page needs; the gallery marks it when the browser lacks one. */
  requires?: GPUFeatureName[];
  /** Streams models from another host (the site loads Khronos glTF sample assets from GitHub; locally `pnpm assets`). */
  network?: boolean;
  /** Heavy on the GPU (a laptop fan will notice). */
  heavy?: boolean;
  /** Card image under examples/ when it is not {@link thumbPath}'s default; a generated pattern while there is none. */
  thumbnail?: string;
  /** In docs/EXAMPLES.md but not built yet: no page. The gallery hides it (unless asked), the build and the check skip it. */
  planned?: boolean;
  /** Left out of the public site build, with the reason (a closed beta, a private checkout). Dev server only. */
  devOnly?: string;
  /**
   * `pnpm check -- --only catalog`: extra query (`a=1&b=2`, no `?`) for the load check, ms to let it run after `window.__p` exists
   * (default 1500), and `image: false` for a page that shows text, not a rendered image. `thumbQuery` is used instead when capturing
   * the card image (`--thumbs`).
   */
  check?: { query?: string; wait?: number; image?: boolean; thumbQuery?: string; /** false: don't require `__p.setCompare` to change the image (the brief says why). W95. */ compare?: boolean };
}

export const CATEGORIES: readonly Category[] = [
  { id: 'showcase', title: 'Showcase', blurb: 'The whole pipeline on real models, and the tools to judge it against a path tracer.' },
  { id: 'start', title: 'Getting started', blurb: 'The smallest complete programs: reflections on a three.js scene in a few lines.' },
  { id: 'features', title: 'Features', blurb: 'One thing each, over a baseline you can switch back to.' },
  { id: 'engines', title: 'Engines', blurb: 'One page per adapter, each with the features that adapter has.' },
  { id: 'lab', title: 'Lab', blurb: 'Developer pages: the checks and benches the repository runs on a real GPU. To read and poke at, not demos.' },
];

export const STATUS_LABELS: Record<ExampleStatus, { label: string; blurb: string }> = {
  stable: { label: 'Stable', blurb: 'Built on the published API with its current defaults.' },
  experimental: { label: 'Experimental', blurb: 'Works and is checked, but the API, the adapter or its defaults can still change.' },
  research: { label: 'Lab', blurb: 'A developer page (a test, a bench, a study). It may move or go away.' },
};

export const KIND_LABELS: Record<ExampleKind, string> = {
  showcase: 'Showcase', feature: 'Feature', performance: 'Performance', quality: 'Quality', educational: 'Learn', debugging: 'Debugging', informative: 'Info',
};

export const REPOSITORY = 'https://github.com/pmndrs/reflections';
/** The deployed site: docs at the root, the gallery under `examples/`. */
export const SITE_URL = 'https://pmndrs.github.io/reflections/';

const PLANNED_TRY = ['Not built yet: see docs/EXAMPLES.md'];

export const EXAMPLES: readonly ExampleEntry[] = [
  // ---- showcase -------------------------------------------------------------------------------------
  {
    slug: 'showcase',
    path: 'showcase/',
    title: 'Showcase',
    summary: 'Everything on real models: a car concept, a toy car and a chess set on a mirror floor, and Sponza with a polished floor.',
    description:
      'Each scene bakes its reflection probes, traces screen-space reflections with last frame\'s image as the hit colour, fills the misses from ' +
      'rays (`@pmndrs/raytracer`, built on first use) and the probes, and denoises through the denoise seam (`denoiser/ffx`). The panel switches every source, ' +
      'the denoiser and the anti-aliasing, shows the debug views and the GPU ms per pass. `?scene=carConcept|toyCar|chess|sponza`, `?rt=1`, `?denoise=0`, `?off`.',
    brief: {
      kind: 'showcase',
      shows: 'The full hybrid on real assets: probes, screen-space reflections, the ray-traced fallback and the denoiser, composed per pixel, with the GPU cost of each pass.',
      tryThis: ['Press Off (baseline), then On: the difference is every reflection the package adds', 'Turn Screen-space (SSR) off and the Ray-traced fallback on, then the other way round', 'Set Debug view to the source map to see which source each pixel took'],
      compare: 'Reflections: Off (baseline), and each source\'s checkbox',
    },
    category: 'showcase',
    status: 'stable',
    tags: ['probes', 'ssr', 'ray tracing', 'denoiser', 'gltf'],
    docs: 'getting-started/introduction',
    source: 'examples/showcase/src/main.ts',
    network: true,
    heavy: true,
    check: { query: 'scene=toyCar', wait: 3000 },
  },
  {
    slug: 'showcase/compare',
    path: 'showcase/compare.html',
    title: 'Compare with a path tracer',
    summary: 'Ours against a path-traced reference (@pmndrs/pathtracer + OIDN) on the same view, split by a draggable divider.',
    description:
      'Two methods side by side, each with its own renderer and its own load of the scene, one orbit camera. Methods: ours raw, denoised and with the ' +
      'ray-traced fallback, probes only, three\'s `SSRNode` with and without its denoisers, and the path tracer (stopped at a sample cap and OIDN-denoised). ' +
      '**Freeze camera** lets the path tracer converge; **Measure** reads the error against it over the glossy pixels. `?scene= ?left= ?right= ?split=`.',
    brief: {
      kind: 'quality',
      shows: 'How close the real-time reflections get to a path-traced reference of the same view, and where they differ.',
      tryThis: ['Freeze the camera and wait for the path tracer to converge, then drag the divider', 'Set the left side to three SSR and compare with ours'],
      compare: 'The right side: the path tracer (the reference)',
    },
    category: 'showcase',
    status: 'experimental',
    tags: ['path tracer', 'oidn', 'reference', 'gltf'],
    docs: 'guides/performance-and-quality',
    source: 'examples/showcase/src/compare.ts',
    network: true,
    heavy: true,
    check: { query: 'scene=toyCar&left=ours-denoised&right=probes', wait: 3000 },
  },

  // ---- start ----------------------------------------------------------------------------------------
  {
    slug: 'start/hello',
    path: 'quickstart/',
    title: 'Quick start',
    summary: 'Reflections on an ordinary three.js scene with one Reflections.create() and reflections.render(camera).',
    description:
      'The scene is plain three. `Reflections.create(renderer, scene)` renders it through a G-buffer, traces screen-space reflections, fills what the screen ' +
      'cannot see from a baked probe, denoises (`denoiser/ffx`) and composites; the loop calls `reflections.render(camera)` instead of `renderer.render()`. ' +
      '`?rt=1` adds the ray-traced fallback, `?preset=performance` half-resolution reflections, `?denoise=0` no denoiser.',
    brief: {
      kind: 'educational',
      shows: 'The smallest complete program: an existing three.js scene gets screen-space reflections, a probe for what the screen cannot see, and the denoiser from one object.',
      tryThis: ['Untick reflections: three\'s own pass with the probe as its environment', 'Add `?rt=1` to the URL for the ray-traced fallback, or `?preset=performance`'],
      compare: 'The reflections checkbox (off: three\'s own pass)',
    },
    category: 'start',
    status: 'stable',
    tags: ['three', 'Reflections.create', 'ssr', 'probes', 'denoiser'],
    docs: 'getting-started/quick-start',
    source: 'examples/quickstart/src/main.ts',
  },
  {
    slug: 'start/probes-only',
    path: 'quickstart/probes.html',
    title: 'Probes only',
    summary: 'One baked reflection probe and your own renderer.render(): the cheapest path, no extra passes.',
    description:
      'No G-buffer and no extra passes: the probe is baked once into a cube map and every physical material samples it as its environment, ' +
      'box-projected and prefiltered by roughness (`scene.environmentNode = reflectionProbes(probes)`). It shows what the scene held at bake time; bake again when it changes.',
    brief: {
      kind: 'educational',
      shows: 'The cheapest reflections: one baked, box-projected probe that every material samples, with the render loop you already have.',
      tryThis: ['Orbit: the reflections in the floor stay where they belong as you move (box projection)', 'Open the quick start beside it: screen space adds the contact-sharp reflections a probe cannot hold'],
      compare: 'The quick start (screen space + probe + denoiser)',
    },
    category: 'start',
    status: 'stable',
    tags: ['three', 'probes', 'cheapest'],
    docs: 'concepts/reflection-probes',
    source: 'examples/quickstart/src/probes.ts',
  },
  {
    slug: 'start/r3f',
    path: 'r3f/',
    title: 'React Three Fiber',
    summary: 'The quick start in React Three Fiber v10, with a useReflections() hook.',
    description:
      'R3F v10 renders with `WebGPURenderer`; its `renderer` prop takes `createReflectionsRenderer` for the device limits. `useReflections()` (in the example, ' +
      '`src/useReflections.ts`) creates `Reflections` once the environment is ready and takes over the frame loop. Same query keys as the quick start.',
    brief: {
      kind: 'educational',
      shows: 'The same reflections in React Three Fiber: a plain R3F scene and one hook.',
      tryThis: ['Orbit around the spinning knot: its reflection on the floor follows it (screen space)', 'Add `?rt=1` or `?preset=performance` to the URL'],
    },
    category: 'start',
    status: 'experimental',
    tags: ['react', 'r3f', 'hook'],
    docs: 'guides/react-three-fiber',
    source: 'examples/r3f/src',
  },

  // ---- features -------------------------------------------------------------------------------------
  {
    slug: 'probes/box-projection',
    path: 'features/probes/box-projection/',
    title: 'Box-projected probe',
    summary: 'One baked probe in a room, projected onto the walls: reflections stay where they belong as you move.',
    description:
      'A probe captures the room from one point. Looked up by direction alone it acts as if the room were infinitely far away, so a reflection is only right ' +
      'for a surface at the capture point. Box projection intersects the reflected ray with the room\'s box (`probe.projectionSize`) and looks up the direction ' +
      'from the capture point to that hit, which fixes the parallax for a box-shaped room. The probe is baked once; the materials sample it through ' +
      '`scene.environmentNode = reflectionProbes(probes)` and the loop is `renderer.render()`.',
    brief: {
      kind: 'feature',
      shows: 'Why a probe is box-projected: without it the windows and walls reflected in the glossy floor sit in the wrong place and slide as the camera moves.',
      tryThis: ['Untick Box projection and orbit: the window reflections slide across the floor', 'Switch the view to Floor and toggle again', 'Show the volumes: the projection box is the room\'s walls'],
      compare: 'Box projection off: the same probe looked up by direction only (reflections at infinity)',
    },
    category: 'features',
    status: 'stable',
    tags: ['probes', 'box projection', 'parallax'],
    docs: 'concepts/reflection-probes',
    source: 'examples/features/probes/box-projection/main.ts',
  },
  {
    slug: 'probes/two-rooms',
    path: 'features/probes/two-rooms/',
    title: 'Two rooms',
    summary: 'Several probes blended by influence box: walk through the doorway.',
    description: 'Planned (E2): rebuilds the denoiser repo\'s reflections-rooms page on `Reflections`.',
    brief: { kind: 'feature', shows: 'Several probes, each with its own influence box, blended across a doorway between two rooms.', tryThis: PLANNED_TRY, compare: 'One probe for both rooms; influence boxes and weights as overlays' },
    category: 'features', status: 'experimental', tags: ['probes', 'blending'], docs: 'concepts/reflection-probes', source: 'examples/features/probes/two-rooms', planned: true,
  },
  {
    slug: 'probes/live',
    path: 'probes/',
    title: 'Live probes',
    summary: 'Reflection probes re-captured as the scene changes: a spinning torus knot and a colour-cycling light, in two rooms.',
    description:
      'A port of three.js #35046\'s example (Ben Houston\'s two rooms joined by a doorway, one probe per room and a doorway probe that wins where they overlap) on ' +
      '`@pmndrs/reflections/three`, re-captured every frame. Also the probe storage options (a real cube array through the #35053 shim, or the 2D array with its seam handling). ' +
      '`?static` freezes, `?grid` shows the test grid, `?refit` the LightProbeGrid re-fit. To be rebuilt to the example rules (docs/EXAMPLES.md, E2).',
    brief: {
      kind: 'feature',
      shows: 'Probes that follow the scene: captured again as objects move and lights change, so reflections of them stay current.',
      tryThis: ['Watch the torus knot and the cycling light in the floor and the mirror sphere', 'Add `?static` to the URL: probes baked once, the reflections freeze'],
      compare: '`?static` (baked once)',
    },
    category: 'features',
    status: 'experimental',
    tags: ['probes', 'live capture', '#35046'],
    docs: 'concepts/reflection-probes',
    source: 'examples/probes/src/main.ts',
  },
  {
    slug: 'probes/exclude',
    path: 'features/probes/exclude/',
    title: 'Keep a mirror out of its own probe',
    summary: 'bake({ exclude }): a moving mirror kept out of its own captures.',
    description: 'Planned (E2).',
    brief: { kind: 'feature', shows: 'A moving mirror kept out of the captures that it reflects, so it does not paint itself into the probe.', tryThis: PLANNED_TRY, compare: 'Without exclude (the mirror paints itself in)' },
    category: 'features', status: 'stable', tags: ['probes', 'exclude'], docs: 'concepts/reflection-probes', source: 'examples/features/probes/exclude', planned: true,
  },
  {
    slug: 'ssr/mirror-floor',
    path: 'features/ssr/mirror-floor/',
    title: 'Screen-space reflections',
    summary: 'Screen-space reflections on a polished floor, over probes.',
    description: 'Planned (E2).',
    brief: { kind: 'feature', shows: 'Screen-space reflections: exact, contact-sharp reflections of what is on screen, over the probe.', tryThis: PLANNED_TRY, compare: 'Probes only' },
    category: 'features', status: 'stable', tags: ['ssr'], docs: 'concepts/screen-space-reflections', source: 'examples/features/ssr/mirror-floor', planned: true,
  },
  {
    slug: 'ssr/what-it-misses',
    path: 'features/ssr/what-it-misses/',
    title: 'What screen space misses',
    summary: 'Off screen, behind, occluded: what screen-space reflections cannot see.',
    description: 'Planned (E2).',
    brief: { kind: 'educational', shows: 'Where screen-space reflections run out: things off screen, behind the camera or hidden behind other objects.', tryThis: PLANNED_TRY, compare: 'Probe fill vs black' },
    category: 'features', status: 'stable', tags: ['ssr', 'misses'], docs: 'concepts/screen-space-reflections', source: 'examples/features/ssr/what-it-misses', planned: true,
  },
  {
    slug: 'rt/fallback',
    path: 'features/rt/fallback/',
    title: 'Ray-traced fallback',
    summary: 'Rays fill what screen space misses.',
    description: 'Planned (E2).',
    brief: { kind: 'feature', shows: 'The ray-traced fallback: rays against a BVH for the pixels screen space could not resolve.', tryThis: PLANNED_TRY, compare: '`rayTracing` off' },
    category: 'features', status: 'experimental', tags: ['ray tracing'], docs: 'concepts/ray-traced-fallback', source: 'examples/features/rt/fallback', planned: true,
  },
  {
    slug: 'rt/animated',
    path: 'features/rt/animated/',
    title: 'Ray tracing moving meshes',
    summary: 'trace.refit() each frame keeps the BVH on moving meshes.',
    description: 'Planned (E2).',
    brief: { kind: 'feature', shows: 'Moving meshes in the ray-traced fallback: the BVH refitted every frame.', tryThis: PLANNED_TRY, compare: 'Refit off (stale reflections)' },
    category: 'features', status: 'experimental', tags: ['ray tracing', 'refit'], docs: 'concepts/ray-traced-fallback', source: 'examples/features/rt/animated', planned: true,
  },
  {
    slug: 'hybrid/explained',
    path: 'features/hybrid/explained/',
    title: 'The hybrid, explained',
    summary: 'Probe, screen space, rays and the composite side by side, with the per-pixel source map.',
    description: 'Planned (E2): rebuilds the denoiser repo\'s reflections-hybrid page on our pipeline.',
    brief: { kind: 'educational', shows: 'How the hybrid resolve picks a source per pixel: screen space where it hits, rays where it misses, the probe where neither reaches.', tryThis: PLANNED_TRY, compare: 'Each source alone' },
    category: 'features', status: 'stable', tags: ['hybrid', 'source map'], docs: 'concepts/hybrid-resolve', source: 'examples/features/hybrid/explained', planned: true,
  },
  {
    slug: 'denoise/glossy',
    path: 'features/denoise/glossy/',
    title: 'Denoising glossy reflections',
    summary: 'The denoiser on glossy surfaces, with a live flicker meter.',
    description:
      'The screen-space tracer sends one ray per 2x2 quad per frame through each glossy pixel\'s lobe, so a single frame is noise and frames in a row ' +
      'shimmer. `Reflections.create(..., { denoiser })` runs a temporal denoiser (`denoiser/ffx`, through the denoise seam) between the trace and the ' +
      'composite: it reprojects the last frames and filters spatially. `reflections.hybrid.denoise = false` shows the raw signal. The meter reads a 1:1 crop ' +
      'of the canvas centre each frame once the camera has settled: the mean change per pixel (8-bit luma) and the share of pixels that change by more than 1/255.',
    brief: {
      kind: 'quality',
      shows: 'What the denoiser does for glossy reflections: the tracer\'s one noisy sample per quad becomes a steady image, and the meter shows how steady.',
      tryThis: ['Tick Denoiser off and watch the middle of the ramp (roughness 0.2 to 0.4) and the meter', 'Switch the view to Floor strips: the chrome strips go from mirror to rough', 'Orbit, let go, and watch the meter settle'],
      compare: 'Denoiser off: the raw signal (one ray per 2x2 quad per frame)',
    },
    category: 'features', status: 'stable', tags: ['denoiser', 'flicker'], docs: 'concepts/denoising-and-upscaling', source: 'examples/features/denoise/glossy/main.ts',
  },
  {
    slug: 'materials/roughness',
    path: 'features/materials/roughness/',
    title: 'Materials',
    summary: 'Roughness, metalness and clearcoat; why basic, Lambert and Phong get no reflections.',
    description:
      'The roughness ramp: gold metal spheres, blue plastic spheres and chrome floor strips from roughness 0 (left) to 1 (right), through `Reflections.create` ' +
      'with a probe and the denoiser. Every reflection the package adds takes the place of three\'s own specular environment term, so it follows the material: ' +
      'metal reflects in its colour, plastic weakly and in white, roughness widens the lobe (above 0.447 the probe alone reflects), and a `MeshPhysicalMaterial` ' +
      'clear coat adds a sharp layer over a rough base. `MeshBasicMaterial`, `MeshLambertMaterial` and `MeshPhongMaterial` get no reflections, by design: they have ' +
      'no physical specular term to replace (README "Which materials get reflections"). Give a surface that should reflect a standard material.',
    brief: {
      kind: 'feature',
      shows: 'Which materials get reflections and how roughness, metalness and clear coat shape them; Basic, Lambert and Phong get none.',
      tryThis: ['Tick Classic materials: the spheres turn Phong and lose their reflections (the highlight is the lights\', not a reflection)', 'Set the Blue row to Physical, clear coat: a sharp coat over a rough base', 'Switch the view to Floor strips: chrome from mirror to rough'],
      compare: 'Classic materials (Phong, Lambert or Basic) on the spheres, the floor strips still standard',
    },
    category: 'features', status: 'stable', tags: ['materials', 'roughness'], docs: 'guides/three', source: 'examples/features/materials/roughness/main.ts',
  },
  {
    slug: 'motion/animated',
    path: 'features/motion/animated/',
    title: 'Animation and camera cuts',
    summary: 'A camera path, moving objects and a camera cut with resetHistory().',
    description:
      'The two rooms of three.js #35046 with a polished floor, the knot turning and the mirror ball on its figure eight; the camera runs three 6 s shots with a cut ' +
      'between each. Reflections are temporal: the denoiser blends each pixel with where it was last frame, and screen-space hits take their colour from last ' +
      'frame\'s image, which keeps motion steady between cuts. At a cut last frame is another shot, so the page calls `reflections.ssr.resetHistory()` and ' +
      '`reflections.hybrid.resetHistory()` (`ScreenSpaceReflectionsPass` and `HybridReflections` when built from the pieces); do the same on a teleport or a scene switch.',
    brief: {
      kind: 'feature',
      shows: 'A whole animated scene, camera path and moving objects, steady between cuts; and why a camera cut needs `resetHistory()`.',
      tryThis: ['Watch the floor through the camera moves and the cuts: steady between cuts, no shimmer', 'Pause: the image holds still (the rest-flicker check holds it to the quick start\'s bound)', 'Tick No history reset and Slow motion, then press Cut to the next shot'],
      compare:
        'No history reset at the cuts. With `denoiser/ffx` the difference is small (measured: 0.08 / 255 mean the frame after the cut, against a 0.07 noise floor): its ' +
        'reprojection rejects history whose depth and normals disagree, so the previous shot barely shows through. The reset is still what a cut needs; a denoiser without that rejection depends on it',
    },
    category: 'features', status: 'stable', tags: ['motion', 'history'], docs: 'guides/flicker-and-stability', source: 'examples/features/motion/animated/main.ts',
    check: { compare: false },
  },
  {
    slug: 'perf/presets',
    path: 'features/perf/presets/',
    title: 'Presets',
    summary: 'default vs performance (half-resolution reflections), GPU ms per pass.',
    description: 'Planned (E3).',
    brief: { kind: 'performance', shows: 'What the performance preset saves and what it costs in quality.', tryThis: PLANNED_TRY, compare: 'The other preset' },
    category: 'features', status: 'stable', tags: ['presets', 'gpu ms'], docs: 'guides/performance-and-quality', source: 'examples/features/perf/presets', planned: true,
  },
  {
    slug: 'perf/upscaler',
    path: 'features/perf/upscaler/',
    title: 'Upscaling',
    summary: 'TAA / upscaling after the composite with @pmndrs/upscaler, jitter wired through.',
    description: 'Planned (E3).',
    brief: { kind: 'performance', shows: 'Rendering below the display size and upscaling after the reflections composite.', tryThis: PLANNED_TRY, compare: 'Upscaler off' },
    category: 'features', status: 'experimental', tags: ['upscaler', 'taa'], docs: 'concepts/denoising-and-upscaling', source: 'examples/features/perf/upscaler', planned: true,
  },
  {
    slug: 'custom/tsl',
    path: 'features/custom/tsl/',
    title: 'Probes in your own TSL material',
    summary: 'sampleReflectionProbes in a custom TSL material (a water or glass surface).',
    description: 'Planned (E3).',
    brief: { kind: 'feature', shows: 'Sampling the probes from your own node material.', tryThis: PLANNED_TRY, compare: 'The stock material' },
    category: 'features', status: 'stable', tags: ['tsl', 'probes'], docs: 'guides/three', source: 'examples/features/custom/tsl', planned: true,
  },
  {
    slug: 'setup/device-limits',
    path: 'features/setup/device-limits/',
    title: 'Device limits',
    summary: 'A plain new WebGPURenderer(): the second lit pass, traceError when ray tracing does not fit.',
    description: 'Planned (E3).',
    brief: { kind: 'informative', shows: 'What changes on a renderer with WebGPU\'s default limits, and how the package degrades.', tryThis: PLANNED_TRY, compare: '`createReflectionsRenderer`' },
    category: 'features', status: 'stable', tags: ['limits', 'setup'], docs: 'guides/troubleshooting', source: 'examples/features/setup/device-limits', planned: true,
  },

  // ---- engines --------------------------------------------------------------------------------------
  {
    slug: 'engines/three',
    path: 'engines/three/',
    title: 'three.js',
    summary: 'three.js WebGPURenderer with every feature, on the shared two-room scene.',
    description: 'Planned (E4).',
    brief: { kind: 'feature', shows: 'The three.js adapter on the scene every engine page shares.', tryThis: PLANNED_TRY, compare: 'Reflections off' },
    category: 'engines', status: 'stable', tags: ['three'], docs: 'guides/three', source: 'examples/engines/three', planned: true,
  },
  {
    slug: 'engines/r3f',
    path: 'engines/r3f/',
    title: 'React Three Fiber',
    summary: 'Everything through the hook; the two rooms as JSX.',
    description: 'Planned (E4).',
    brief: { kind: 'feature', shows: 'The React Three Fiber hook on the scene every engine page shares.', tryThis: PLANNED_TRY, compare: 'Reflections off' },
    category: 'engines', status: 'experimental', tags: ['react', 'r3f'], docs: 'guides/react-three-fiber', source: 'examples/engines/r3f', planned: true,
  },
  {
    slug: 'engines/babylon',
    path: 'babylon/',
    title: 'Babylon.js',
    summary: 'Screen-space reflections and a probe on Babylon.js (WebGPUEngine), as frame-graph tasks.',
    description:
      'The mirrorWall scene rebuilt in Babylon.js with `@pmndrs/reflections/babylon`: core\'s screen-space tracer and probe set on Babylon\'s device, ' +
      'a frame graph of geometry, `FrameGraphReflectionsTask` and `FrameGraphReflectionsCompositeTask`. Babylon is left-handed; the scene negates x so the ' +
      'image matches the three page. `?ssr=0`, `?probes=0`, `?view=…`, `?variant=workgroup`. To be rebuilt on the shared scene (E4).',
    brief: {
      kind: 'feature',
      shows: 'The engine-agnostic core on a second engine: the same tracer and probes, wired into Babylon\'s frame graph.',
      tryThis: ['Add `?ssr=0` to the URL: probes only', 'Compare with the three page on the same scene (lab: ssr, `?scene=mirrorWall`)'],
      compare: '`?ssr=0` / `?probes=0`',
    },
    category: 'engines',
    status: 'experimental',
    tags: ['babylon', 'frame graph'],
    docs: 'guides/babylon',
    source: 'examples/babylon/src/main.ts',
  },
  {
    slug: 'engines/pixi',
    path: 'pixi3d/arcade/',
    title: 'pixi.js + pixi-3d',
    summary: 'A neon arcade in pixi-3d with screen-space reflections, a probe and the denoiser. Needs the closed pixi-3d beta.',
    description:
      'pixi Text and Graphics on 3-D planes as `ContainerTexture`s; pixi-3d draws the scene, its depth and motion; one G-buffer pass adds the normals and ' +
      'materials; core\'s tracer and probe set run on pixi\'s device and a pixi `Filter` composites. Without the beta unpacked in `examples/pixi3d/vendor/` ' +
      'the page shows the setup notice (examples/pixi3d/README.md).',
    brief: {
      kind: 'feature',
      shows: 'The core on pixi.js v8 through pixi-3d: reflections of pixi\'s own 2-D content on a wet 3-D floor.',
      tryThis: ['Add `?ssr=0` or `?probes=0` to the URL', 'Add `?denoise=0`: the raw reflections'],
      compare: '`?ssr=0` / `?probes=0` / `?denoise=0`',
    },
    category: 'engines',
    status: 'experimental',
    tags: ['pixi', 'pixi-3d', 'closed beta'],
    docs: 'guides/pixi',
    source: 'examples/pixi3d/arcade/main.ts',
    devOnly: 'needs the closed pixi-3d beta',
  },
  {
    slug: 'engines/core',
    path: 'engines/core/',
    title: 'Raw WebGPU',
    summary: 'The probe set and the screen-space tracer on a bare GPUDevice, no engine.',
    description: 'Planned (E4).',
    brief: { kind: 'feature', shows: 'The core API with no engine: what an adapter wraps.', tryThis: PLANNED_TRY, compare: 'Reflections off' },
    category: 'engines', status: 'experimental', tags: ['core', 'webgpu'], docs: 'guides/adapters', source: 'examples/engines/core', planned: true,
  },

  // ---- lab ------------------------------------------------------------------------------------------
  lab('ssr', 'ssr/', 'Screen-space test scenes', 'Every kit scene with every switch: SSR, rays, probes, the denoiser and the debug views.',
    'The scene kit (examples/shared) with `ScreenSpaceReflectionsPass` and the hybrid composite. `?scene=mirrorWall|offscreen|contact|roughnessRamp|boxRoom|moving|explainer|rooms|facingMirrors`, `?rt=1`, `?probes=0`, `?denoise=0`.',
    ['ssr', 'ray tracing', 'debug views'], 'examples/ssr/src/main.ts', 'concepts/screen-space-reflections', { kind: 'debugging', status: 'experimental' }),
  lab('scenes', 'scenes/', 'Scene kit and G-buffer', 'The test scenes and every frame-contract target: depth, normals, roughness, motion, scene colour.',
    '`FrameGBuffer` renders the scene once with MRT; a fullscreen pass shows one target or all of them in a grid. `?scene=…`.',
    ['g-buffer', 'frame contract'], 'examples/scenes/src/main.ts', 'concepts/frame-contract'),
  lab('sssr-core', 'sssr-core/', 'Screen-space tracer (core)', 'The core tracer on exact analytic inputs, raw WebGPU: debug views and variant parity.',
    'No engine: analytic depth and normals, the core tracer, its classify / intersect passes and debug views.', ['core', 'ssr'], 'examples/sssr-core/src/main.ts', 'concepts/screen-space-reflections'),
  lab('probe-core', 'probe-core/', 'Probe set (core)', 'The core probe set and its radiance fallback on a bare device.',
    'Layouts and formats against each other, the CPU volume weights, re-fit, specular occlusion and the radiance fallback seam. Runs its checks on demand.', ['core', 'probes'], 'examples/probe-core/src/main.ts', 'concepts/reflection-probes'),
  lab('bc6h', 'bc6h/', 'BC6H encoder', 'The GPU BC6H encoder against the hardware decoder.',
    'Encodes an HDR cube on the GPU (fast and normal modes) and reads it back through the hardware BC decoder.', ['bc6h', 'compression'], 'examples/bc6h/src/main.ts', undefined,
    { requires: ['texture-compression-bc'] }),
  lab('probe-bench', 'probe-bench/', 'Probe layout bench', 'Cube array, 2D array and octahedral layouts; rgba16f, rgb9e5, rg11b10, BC6H.',
    'Error and lookup cost per layout and format. The bench runs on demand (`__p.run()`); the page itself is a log.', ['probes', 'bench'], 'examples/probe-bench/src/main.ts', 'concepts/reflection-probes', { image: false }),
  lab('ssr-bench', 'ssr-bench/', 'SSR bench', 'Ours against three r187\'s SSRNode: error, flicker, GPU ms.',
    'The phase 3 gate bench. Runs on demand.', ['ssr', 'bench'], 'examples/ssr-bench/src/main.ts', 'concepts/screen-space-reflections'),
  lab('regressions', 'regressions/', 'Regressions', 'GPU repros of review bugs, each seen failing before its fix.',
    'Every fix from the reviews has a check here (`pnpm check -- --only regressions`). Runs on demand.', ['tests'], 'examples/regressions/src/main.ts', undefined, { image: false }),
  lab('nrc', 'nrc/', 'Radiance cache study', 'NRC, probes and hit shading of mirror reflections against a path-traced reference.',
    'Needs a sibling pmndrs/pathtracer checkout (its bench modules are not published); without one the page says so.', ['nrc', 'study'], 'examples/nrc/src/main.ts', undefined,
    { devOnly: 'needs a local pathtracer checkout', image: false }),
  lab('showcase/bench', 'showcase/bench.html', 'Tuning bench', 'Every setting on one panel, two methods side by side, measured against the path tracer.',
    'Split, side by side or a difference heat map; Measure per region against the path tracer; Copy as code. Every setting with its default and cost: docs/SETTINGS.md.',
    ['settings', 'bench', 'gltf'], 'examples/showcase/src/bench.ts', 'reference/settings', { network: true, heavy: true, status: 'experimental', query: 'scene=toyCar&left=ours-denoised&right=probes' }),
];

/** A lab entry: a one-line summary is all the brief rules ask of a developer page. */
function lab(
  slug: string, path: string, title: string, summary: string, description: string, tags: string[], source: string, docs?: string,
  o: { kind?: ExampleKind; status?: ExampleStatus; requires?: GPUFeatureName[]; devOnly?: string; image?: boolean; network?: boolean; heavy?: boolean; query?: string } = {},
): ExampleEntry {
  return {
    slug, path, title, summary, description, tags, source, docs,
    brief: { kind: o.kind ?? 'debugging', shows: summary, tryThis: ['Read the source: the page is built for the headless check'] },
    category: 'lab', status: o.status ?? 'research', requires: o.requires, devOnly: o.devOnly, network: o.network, heavy: o.heavy,
    check: o.image === false || o.query ? { image: o.image, query: o.query } : undefined,
  };
}

export const exampleBySlug = (slug: string): ExampleEntry | undefined => EXAMPLES.find((e) => e.slug === slug);

/** The html file of an entry, relative to examples/. */
export const htmlPath = (e: ExampleEntry): string => (e.path.endsWith('/') ? `${e.path}index.html` : e.path);

/** The card image, relative to examples/: `<path>thumb.webp` for a folder, `<name>.thumb.webp` beside an html file. */
export const thumbPath = (e: ExampleEntry): string => e.thumbnail ?? (e.path.endsWith('/') ? `${e.path}thumb.webp` : e.path.replace(/\.html$/, '.thumb.webp'));

/** The entries with a page: everything not planned; for the public site (`site`), also not dev-only. */
export const builtExamples = (site = false): ExampleEntry[] => EXAMPLES.filter((e) => !e.planned && !(site && e.devOnly));

/** A Vite input name for an entry (`probes/box-projection` -> `probes-box-projection`). */
export const inputName = (e: ExampleEntry): string => e.slug.replace(/[^a-z0-9]+/gi, '-');
