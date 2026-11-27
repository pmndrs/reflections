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
    summary: 'A probe per room and one in the doorway, blended by their influence boxes: each room reflects itself.',
    description:
      'Ben Houston\'s two rooms from three.js #35046: a warm-lit and a cool-lit room joined by a doorway. Each room has a `ReflectionProbe` whose ' +
      'influence box is the room and whose projection box (`projectionSize`) is its walls; a small doorway probe takes priority where the boxes overlap ' +
      '(the smallest box wins) and fades into the room probes over its `blendDistance`. All three are baked once into one set, and ' +
      '`scene.environmentNode = reflectionProbes(probes)` makes every material look them up at its own position. The mirror ball is kept out of the captures ' +
      '(`userData.reflectionProbeExclude`) because it moves. **Show blend weights** colours each surface by the probes it blends.',
    brief: {
      kind: 'feature',
      shows: 'Why a level needs more than one probe: each room reflects its own walls and light, and the doorway probe blends one room into the other without a seam.',
      tryThis: ['Untick One probe per room: the cool room\'s floor and the mirror ball now show the warm room', 'Show blend weights, then pick Across the doorway: the colours mix where the boxes overlap', 'Watch the mirror ball roll through the doorway: its reflection hands over from one room to the other'],
      compare: 'One probe for both rooms: captured in the warm room, projected onto the whole building',
    },
    category: 'features', status: 'stable', tags: ['probes', 'blending', 'influence volumes', '#35046'], docs: 'concepts/reflection-probes', source: 'examples/features/probes/two-rooms/main.ts',
  },
  {
    slug: 'probes/live',
    path: 'features/probes/live/',
    title: 'Live probes',
    summary: 'Probes re-captured while the scene runs, one per frame: a turning knot and two colour-cycling lights in two rooms.',
    description:
      'Ben Houston\'s two rooms with a probe per room and a doorway probe. Every frame `probes.bake(renderer, scene, { probes: [next], bounces: 1 })` ' +
      're-captures one probe, round-robin (time-sliced): each probe is at most three frames old, at a third of the cost of capturing all of them. ' +
      'One capture pass (`bounces: 1`) because a sliced bake covers only its slice. The moving mirror ball stays out of the captures ' +
      '(`userData.reflectionProbeExclude`). The compare is a second set baked once at load. The lab page `probes/` has every storage and lookup option.',
    brief: {
      kind: 'feature',
      shows: 'Probes that follow the scene: captured again, one probe per frame, as the lights change colour and the knot turns, so the reflections stay current.',
      tryThis: ['Untick Live capture: the floor and the mirror ball keep the light colours of the moment the page loaded', 'Set Probes per frame to all 3: the same image at three times the capture cost'],
      compare: 'Live capture off: the same probes baked once at load',
    },
    category: 'features',
    status: 'stable',
    tags: ['probes', 'live capture', 'time-sliced'],
    docs: 'concepts/reflection-probes',
    source: 'examples/features/probes/live/main.ts',
  },
  {
    slug: 'probes/exclude',
    path: 'features/probes/exclude/',
    title: 'Keep a mirror out of its own probe',
    summary: 'bake({ exclude }): a moving mirror kept out of the live probe it reflects, so it does not paint itself onto the room.',
    description:
      'A mirror floor facing a patterned wall, a polished gold knot sliding in front of it, and the room\'s probe re-captured every frame so the reflections ' +
      'follow the scene. Box projection paints what the probe saw onto the room\'s box: right for the wall and the floor, wrong for anything standing inside. ' +
      '`probes.bake(renderer, scene, { exclude: [knot] })` hides the knot for the capture only; `userData.reflectionProbeExclude = true` does the same for every bake. ' +
      'Screen-space reflections and rays still see it (the ssr/* pages); the probe is the fallback for what they miss.',
    brief: {
      kind: 'feature',
      shows: 'Why moving mirrors are kept out of the probes: captured, the knot is painted onto the wall and the floor, and the mirror floor shows a second, smeared knot where none is.',
      tryThis: ['Untick Exclude the mirror knot: a ghost knot slides across the floor\'s reflection of the wall', 'Untick Move, tick Show the probe and orbit: the ghost is the knot as seen from the capture point (the mirror sphere), painted onto the wall'],
      compare: 'Without exclude: the knot is captured into the probe and painted onto the room',
    },
    category: 'features', status: 'stable', tags: ['probes', 'exclude', 'live capture'], docs: 'concepts/reflection-probes', source: 'examples/features/probes/exclude/main.ts',
  },
  {
    slug: 'ssr/mirror-floor',
    path: 'features/ssr/mirror-floor/',
    title: 'Screen-space reflections',
    summary: 'Screen-space reflections on a polished floor, over a probe: the objects stand on their reflections.',
    description:
      'A polished floor facing a patterned wall, with a sphere, a box and two posts. The box-projected probe gets the wall right (it is the probe\'s box) but leaves ' +
      'out what stands inside the room. Screen-space reflections march each pixel\'s reflected ray through the depth buffer and take the colour of what it hits on ' +
      'screen; where it finds nothing, the probe fills in. `Reflections.create(renderer, scene, { probes, denoiser })` wires the G-buffer, the tracer, the probe fill, ' +
      'the denoiser (`denoiser/ffx`) and the composite; the loop calls `reflections.render(camera)`. The compare shows three\'s own lit image of the same frame ' +
      '(`hybrid.composite().lit`): the probe alone.',
    brief: {
      kind: 'feature',
      shows: 'What screen-space reflections add over a probe: exact, contact-sharp reflections of everything on screen, including the objects a probe leaves out.',
      tryThis: ['Untick Screen-space reflections: the sphere and the box lose their reflections, the wall keeps its own', 'Raise Floor roughness: the reflection blurs with distance from the contact, and the denoiser keeps it steady', 'Pick At the sphere: the floor reflects its underside, which the camera cannot see (the probe fills it)'],
      compare: 'Screen-space reflections off: the probe alone (three\'s lit image of the same frame)',
    },
    category: 'features', status: 'stable', tags: ['ssr', 'probes', 'denoiser', 'Reflections.create'], docs: 'concepts/screen-space-reflections', source: 'examples/features/ssr/mirror-floor/main.ts',
  },
  {
    slug: 'ssr/what-it-misses',
    path: 'features/ssr/what-it-misses/',
    title: 'What screen space misses',
    summary: 'Off screen, behind the camera, hidden: what screen-space reflections cannot see, and the probes filling it in.',
    description:
      'A polished floor and a wall mirror. The floor reflects a glowing ring and a lamp bar above the top of the frame; the mirror reflects three bars on the wall ' +
      'behind the camera. A screen-space ray can only find what is on screen, so all of them are misses, and so is anything hidden behind an object (its back, its ' +
      'underside: ssr/mirror-floor, At the sphere). The composite fills every miss from the probes (box-projected cubes captured inside the room). The compare draws ' +
      'screen space alone from the composite\'s terms (`lit + weight x (ssr - probeSpecular)`, raw tracer hits): black where a ray missed. ' +
      'Rays fill the same misses with the real geometry: **rt/fallback**.',
    brief: {
      kind: 'educational',
      shows: 'Where screen-space reflections run out: things off screen, behind the camera or hidden behind other objects. The probes fill those pixels so the image stays whole.',
      tryThis: ['Untick Fill misses from the probes: the ring in the floor and the whole wall mirror go black', 'Tick Tint the misses: magenta marks how much of each smooth pixel the probes filled', 'Pick Behind the camera: the mirror shows the bars behind you only through the probe'],
      compare: 'Screen space alone, without the probe fill: black where a ray found nothing on screen',
    },
    category: 'features', status: 'stable', tags: ['ssr', 'misses', 'probes'], docs: 'concepts/screen-space-reflections', source: 'examples/features/ssr/what-it-misses/main.ts',
  },
  {
    slug: 'rt/fallback',
    path: 'features/rt/fallback/',
    title: 'Ray-traced fallback',
    summary: 'Rays fill what screen space misses: reflections of things above the frame and behind the camera.',
    description:
      'The wall mirror faces the camera, so it shows what is behind it: a wall of coloured bars, a glow sphere, and the backs of the cylinder and the box. ' +
      'Screen space cannot see any of that, and the floor near the camera reflects a ring above the frame. `Reflections.create(renderer, scene, { probes, rayTracing: true, denoiser })` builds a BVH over every visible mesh once ' +
      '(`@pmndrs/raytracer` and `@pmndrs/bvh`, optional peers) and traces a ray for each pixel screen space misses; hits are lit from the probes and the ' +
      'sun. `reflections.ssr.rayTracing` switches it at run time. Where the device cannot fit the traced pass, it turns itself off with one warning and ' +
      '`reflections.ssr.traceError` says why (shown in the status line); screen space and the probes carry on.',
    brief: {
      kind: 'feature',
      shows: 'What the ray-traced fallback adds over screen space + probes: sharp reflections of things off the screen, in the right place, including objects the probe never captured.',
      tryThis: ['Untick Ray-traced fallback and watch the wall mirror: the cylinder and the box vanish from it (the probe never saw them) and the bars go soft', 'Switch the view to Wall mirror and toggle again', 'Show where each pixel\'s reflection comes from: blue is a traced ray, green screen space, red the probe'],
      compare: 'Ray-traced fallback off (`reflections.ssr.rayTracing = false`): the misses take the probe',
    },
    category: 'features', status: 'experimental', tags: ['ray tracing', 'probes', 'denoiser'], docs: 'concepts/ray-traced-fallback', source: 'examples/features/rt/fallback/main.ts',
    check: { wait: 3000 },
  },
  {
    slug: 'rt/animated',
    path: 'features/rt/animated/',
    title: 'Ray tracing moving meshes',
    summary: 'reflections.trace.refit() each frame keeps the ray-traced reflections of moving meshes where the meshes are.',
    description:
      'A knot slides and turns and a ball bounces over a mirror floor. Screen space reflects what the camera sees of them; the rest (their undersides, parts ' +
      'hidden or off screen) comes from rays against the BVH that `Reflections.create(..., { rayTracing: true })` builds once, from the meshes as they are. ' +
      'Each frame the page moves the meshes, calls `scene.updateMatrixWorld()`, then `reflections.trace.refit()`, which copies every traced mesh\'s world matrix ' +
      'into the BVH. **Refit covers rigid motion** (position, rotation, scale, instanced matrices), not changed geometry: skinned or morphing meshes and edited ' +
      'vertices need a new build. The moving meshes are kept out of the probe (`userData.reflectionProbeExclude`), or it would hold their first pose.',
    brief: {
      kind: 'feature',
      shows: 'Why moving meshes need `trace.refit()` each frame: without it the rays still hit them where they stood at load, so their reflections lag or ghost.',
      tryThis: ['Untick Refit: the traced part of the knot\'s and the ball\'s reflections stays where they started', 'Show traced pixels: those are the ones a stale BVH gets wrong', 'Untick Animate to hold a pose and compare'],
      compare: 'Refit off: the BVH keeps the pose it was built with (stale reflections)',
    },
    category: 'features', status: 'experimental', tags: ['ray tracing', 'refit', 'animation'], docs: 'concepts/ray-traced-fallback', source: 'examples/features/rt/animated/main.ts',
    check: { wait: 3000 },
  },
  {
    slug: 'hybrid/explained',
    path: 'features/hybrid/explained/',
    title: 'The hybrid, explained',
    summary: 'Probe, screen space, rays and the hybrid in one room: where each is right, where it breaks, and which source each pixel took.',
    description:
      'The teaching page, rebuilt from the denoiser repo\'s reflections-hybrid page on this package\'s pipeline. One `Reflections.create(renderer, scene, ' +
      '{ probes, rayTracing: true, denoiser })` over the `explainer` room; each method is a setting on it: **probe only** is three\'s lit image with the probe ' +
      'as its environment, **screen space + probe** is `reflections.ssr.rayTracing = false`, **rays, every pixel** sends every pixel to the ray-traced pass, ' +
      'and the **hybrid** is the default. Seven situations (a mirror, off the top of the screen, things that move, contact, rough surfaces, the source map, ' +
      'explore) set the camera and name the two methods worth comparing. The source map is `HybridReflections.sourceIndex` of the composite. ' +
      'The turning sculpture is refitted into the BVH each frame (`reflections.trace.refit()`).',
    brief: {
      kind: 'educational',
      shows: 'How the hybrid picks a source per pixel: screen space where it hits, rays where it misses, the prefiltered probe for rough surfaces, and why each alone falls short.',
      tryThis: ['Step through the situations and switch between the two methods under the image', 'Show "where reflections come from" and tilt the view down at the floor', 'Drag the roughness cutoff to 1 in "Rough surfaces"'],
      compare: 'Each source alone: probe only, screen space + probe, rays for every pixel (the switch under the image, or "Reflections from")',
    },
    category: 'features', status: 'stable', tags: ['hybrid', 'source map', 'probes', 'ssr', 'ray tracing', 'denoiser'], docs: 'concepts/hybrid-resolve', source: 'examples/features/hybrid/explained/main.ts',
    check: { wait: 3000 },
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
    description:
      'The two rooms with probes, screen-space reflections and the denoiser, built from the pieces (`ScreenSpaceReflectionsPass` with `timestamps: true`, ' +
      '`HybridReflections`, a `RenderPipeline`) so the trace passes report GPU ms. `performance` sets `reflectionResolution: \'half\'`: trace and denoise at half ' +
      'size per axis, then a joint bilateral upsample. At run time `applyReflectionsPreset({ ssr, hybrid }, name)` switches it; when the resolution changes, ' +
      '`hybrid.rebuild()` and a new `hybrid.composite()` (with `Reflections`: `reflections.rebuild()`). GPU ms need `timestamp-query`; compare them on one machine. ' +
      'Trade-offs per scene: docs/SETTINGS.md "Presets".',
    brief: {
      kind: 'performance',
      shows: 'What the performance preset saves (the reflection passes run on a quarter of the pixels) and what it costs: softer reflections, jagged edges in mirrors.',
      tryThis: ['Tick Performance preset and read the GPU ms in the panel', 'Set the view to Mirror ball and toggle again: the ball\'s reflected edges are where half resolution shows', 'Orbit near the floor: the rough floor barely changes'],
      compare: 'The other preset: performance (half-resolution reflections) against default',
    },
    category: 'features', status: 'stable', tags: ['presets', 'gpu ms'], docs: 'guides/performance-and-quality', source: 'examples/features/perf/presets/main.ts',
  },
  {
    slug: 'perf/upscaler',
    path: 'features/perf/upscaler/',
    title: 'Upscaling',
    summary: 'TAA / upscaling after the composite with @pmndrs/upscaler, jitter wired through.',
    description:
      'The two rooms with probes, screen-space reflections and the denoiser render at 1 / 1.5 of the display size per axis (the G-buffer sized by ' +
      '`gbufferOptions`), and `@pmndrs/upscaler` rebuilds the display size after the composite. The upscaler\'s jitter goes in through ' +
      '`ssr.render(scene, camera, { jitter, projection })`: the G-buffer rasterises jittered while its motion, the tracer and the denoiser stay unjittered. ' +
      'The composite is output linear (the upscaler\'s contract) and tone-mapped after it. The upscaler side (jitter, motion in its convention, present) is the ' +
      'examples\' `DisplayAA` helper (examples/shared/antialias.ts). At 1x it is temporal anti-aliasing alone.',
    brief: {
      kind: 'performance',
      shows: 'Rendering the scene and its reflections below the display size and upscaling after the composite: fewer pixels for every reflection pass, and anti-aliasing with it.',
      tryThis: ['Tick Upscaler off: display resolution, no anti-aliasing (edges and the last shimmer return)', 'Set Upscale to Performance (2x): a quarter of the pixels; orbit and let go', 'Set Upscale to Native AA: the upscaler as temporal anti-aliasing only'],
      compare: 'Upscaler off: every pass at the display resolution, no anti-aliasing',
    },
    category: 'features', status: 'experimental', tags: ['upscaler', 'taa'], docs: 'concepts/denoising-and-upscaling', source: 'examples/features/perf/upscaler/main.ts',
  },
  {
    slug: 'custom/tsl',
    path: 'features/custom/tsl/',
    title: 'Probes in your own TSL material',
    summary: 'sampleReflectionProbes in a custom TSL material (a water or glass surface).',
    description:
      'The box room\'s baked probe serves three\'s materials through `scene.environmentNode = reflectionProbes(probes)`. The water in the basin is a ' +
      '`MeshBasicNodeMaterial` that calls the lookup itself: `sampleReflectionProbes(probes, positionWorld, reflected, roughness)` returns the box-projected, ' +
      'blended radiance along any direction, here the view ray reflected about a normal made of travelling waves, mixed with a dark tint by Schlick\'s fresnel. ' +
      'Unlit custom materials get no screen-space reflections from `Reflections` (no physical specular term to replace, README "Which materials get reflections"); ' +
      'the probe sample is their reflection. Probes only, `renderer.render()`.',
    brief: {
      kind: 'feature',
      shows: 'Sampling the reflection probes from your own TSL material: a rippled water surface that reflects the room through `sampleReflectionProbes()`.',
      tryThis: ['Tick Stock material: a glossy MeshStandardMaterial, the same probe through three\'s lighting, flat', 'Untick Ripples: the custom material becomes a fresnel mirror', 'Orbit low over the pool: the fresnel brings the windows up at grazing angles'],
      compare: 'The stock material: a glossy, flat MeshStandardMaterial reflecting the same probe',
    },
    category: 'features', status: 'stable', tags: ['tsl', 'probes'], docs: 'guides/three', source: 'examples/features/custom/tsl/main.ts',
  },
  {
    slug: 'setup/device-limits',
    path: 'features/setup/device-limits/',
    title: 'Device limits',
    summary: 'A plain new WebGPURenderer(): the second lit pass, traceError when ray tracing does not fit.',
    description:
      'A plain `new WebGPURenderer()` asks for WebGPU\'s default limits. On 32 colour-attachment bytes per sample the G-buffer cannot hold three\'s lit image ' +
      'too (it needs 36), so it draws the scene a second time for it and estimates three\'s specular weights; one console warning says so. Ray tracing binds 8 ' +
      'storage buffers per stage with the packed scene copy and runs on the default 8; a setup that needs more (the split copy: 9) turns ray tracing off with one ' +
      'warning and sets `pass.traceError`, and screen space and probes go on. `createReflectionsRenderer()` (or `requiredLimits: reflectionsRequiredLimits(adapter)`) ' +
      'asks for what the passes need. The two images are by nature nearly identical (the quick start measured 0.44 / 255 mean, from the estimated weights); ' +
      'the difference is the extra scene draw per frame, which the panel and the status line show. `?renderer=plain|reflections`, `?rt=1|split|0` (each a reload).',
    brief: {
      kind: 'informative',
      shows: 'What changes on a renderer with WebGPU\'s default limits: a second scene draw for the lit image, estimated specular weights, and ray tracing turning itself off (with `traceError`) when it cannot fit. Nothing fails.',
      tryThis: ['Read the panel, then switch Renderer to createReflectionsRenderer(): one scene draw, specular from the material', 'Set Ray tracing to the 9-buffer scene copy on the plain renderer: the status line shows pass.traceError'],
      compare: '`createReflectionsRenderer()` (a reload). The image barely changes by nature: what differs is the extra scene draw and the estimated specular weights, shown in the panel',
    },
    category: 'features', status: 'stable', tags: ['limits', 'setup'], docs: 'guides/troubleshooting', source: 'examples/features/setup/device-limits/main.ts',
    check: { compare: false },
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
  lab('probes', 'probes/', 'Probe parity page', 'Three.js #35046\'s example on our probes, live-captured: every storage, lookup and capture option, and the probe checks.',
    'A port of #35046\'s webgpu_reflection_probes.html (the two rooms, a test grid, a mirror sphere) on `@pmndrs/reflections/three`, re-captured every frame. ' +
    'Lookups `auto`, `cube-array` (the #35053 shim), the 2D array with `warp` / `none`, the legacy TSL node and a hardware-cube diagnostic; capture resolution, bounces, ' +
    'the LightProbeGrid re-fit. `?static`, `?grid`, `?refit`, `?lookup=`. `pnpm check -- --only probes` runs its checks; `--compare` diffs it against the denoiser repo\'s page.',
    ['probes', '#35046', 'parity'], 'examples/probes/src/main.ts', 'concepts/reflection-probes', { status: 'experimental' }),
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
