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
  check?: { query?: string; wait?: number; image?: boolean; thumbQuery?: string; /** false: don't require `__p.setCompare` to change the image (the brief says why). */ compare?: boolean };
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
    summary: 'All the reflection sources on real models: a car concept, a toy car, a chess set on a mirror floor, and Sponza with a polished floor.',
    description:
      'Each scene bakes its reflection probes, then traces screen-space reflections using last frame\'s image for the colour of what a ray hits. Where a ray finds ' +
      'nothing on screen, the composite takes the ray-traced fallback (`@pmndrs/raytracer`, set up on first use) and the probes. The denoiser smooths the result. ' +
      'The panel switches each source, the denoiser and the anti-aliasing, shows debug views, and reports the GPU time of each pass. ' +
      'Sponza uses eleven 128 px probes (floor slabs and a grid). ' +
      'URL options: `?scene=carConcept|toyCar|chess|sponza`, `?rt=1` (ray-traced fallback on), `?denoise=0`, `?off` (reflections off), ' +
      '`?carProbes=wheels` (a small probe in each car wheel well: closer to the path tracer, a little more flicker), `?probeLayout=shipped` (Sponza\'s seven hand-placed probes).',
    brief: {
      kind: 'showcase',
      shows: 'The full package on real models: probes, screen-space reflections, the ray-traced fallback and the denoiser, combined per pixel, with the GPU time of each pass.',
      tryThis: [
        'Press Off, then On: the difference is every reflection the package adds',
        'Turn off Screen-space (SSR) and turn on the Ray-traced fallback, then the other way round',
        'Set Debug view to the source map to see which source each pixel took',
      ],
      compare: 'Press Off for the baseline, or untick a source\'s checkbox to see the image without it',
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
    summary: 'Real-time reflections next to a path-traced reference of the same view, split by a draggable divider.',
    description:
      'Two methods side by side, each with its own renderer and its own copy of the scene, sharing one orbit camera. The methods are: this package raw, denoised and with the ' +
      'ray-traced fallback; probes only; three.js\'s own `SSRNode` with and without its denoisers; and the path tracer (`@pmndrs/pathtracer`, stopped at a sample cap and ' +
      'denoised with OIDN). **Freeze camera** lets the path tracer finish converging; **Measure** reads the error against it over the glossy pixels. ' +
      'URL options: `?scene=`, `?left=`, `?right=`, `?split=`.',
    brief: {
      kind: 'quality',
      shows: 'How close the real-time reflections get to a path-traced reference of the same view, and where they differ.',
      tryThis: [
        'Freeze the camera, wait for the path tracer to converge, then drag the divider',
        'Set the left side to three.js SSR and compare it with this package',
      ],
      compare: 'The right side is the path tracer, the reference. Drag the divider to move between it and the left side.',
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
    summary: 'Reflections on an ordinary three.js scene: one `Reflections.create()` and `reflections.render(camera)`.',
    description:
      'The scene is plain three.js. `Reflections.create(renderer, scene)` renders it into a G-buffer (the scene\'s depth, normals and materials), traces screen-space reflections, ' +
      'fills what the screen cannot see from a baked probe, denoises, and composites. The render loop calls `reflections.render(camera)` instead of `renderer.render()`. ' +
      'URL options: `?rt=1` adds the ray-traced fallback, `?preset=performance` uses half-resolution reflections, `?denoise=0` turns the denoiser off.',
    brief: {
      kind: 'educational',
      shows: 'The smallest complete program: an existing three.js scene gets screen-space reflections, a probe for what the screen cannot see, and the denoiser, all from one object.',
      tryThis: [
        'Untick the reflections checkbox: three.js draws the scene alone, with the probe as its environment',
        'Add `?rt=1` to the URL for the ray-traced fallback, or `?preset=performance` for half-resolution reflections',
      ],
      compare: 'The reflections checkbox. Unticked, three.js draws the scene without this package.',
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
    summary: 'One baked reflection probe and your own `renderer.render()`: the cheapest way, with no extra passes.',
    description:
      'There is no G-buffer and no extra pass. The probe is baked once into a cube map, and every physical material samples it as its environment, ' +
      'box-projected and blurred by roughness (`scene.environmentNode = reflectionProbes(probes)`). It shows what the scene held at bake time, so bake again when the scene changes.',
    brief: {
      kind: 'educational',
      shows: 'The cheapest reflections: one baked, box-projected probe that every material samples, with the render loop you already have.',
      tryThis: [
        'Orbit the camera: the reflections in the floor stay where they belong (that is box projection)',
        'Open the quick start in another tab: screen-space reflections add the sharp contact reflections a probe cannot hold',
      ],
      compare: 'The quick start page, which adds screen-space reflections and the denoiser on top of the probe',
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
    summary: 'The quick start in React Three Fiber v10, with a `useReflections()` hook.',
    description:
      'React Three Fiber v10 renders with `WebGPURenderer`. Its `renderer` prop takes `createReflectionsRenderer`, which asks the GPU for the limits the passes need. ' +
      '`useReflections()` (in the example, `src/useReflections.ts`) creates `Reflections` once the environment is ready and takes over the frame loop. ' +
      'The URL options are the same as the quick start.',
    brief: {
      kind: 'educational',
      shows: 'The same reflections in React Three Fiber: a plain scene and one hook.',
      tryThis: [
        'Orbit around the spinning knot: its reflection on the floor follows it (that is screen-space reflections)',
        'Add `?rt=1` or `?preset=performance` to the URL',
      ],
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
    summary: 'One baked probe in a room, projected onto the walls, so reflections stay put as you move.',
    description:
      'A probe captures the room from one point. If you look it up by direction alone, it behaves as if the room were infinitely far away, so a reflection is only right ' +
      'for a surface at the capture point. Box projection intersects the reflected ray with the room\'s box (`probe.projectionSize`) and looks up the direction ' +
      'from the capture point to that hit. That fixes the parallax for a box-shaped room. The probe is baked once, the materials sample it through ' +
      '`scene.environmentNode = reflectionProbes(probes)`, and the render loop is `renderer.render()`.',
    brief: {
      kind: 'feature',
      shows: 'Why a probe is box-projected. Without it, the windows and walls reflected in the glossy floor sit in the wrong place and slide as the camera moves.',
      tryThis: [
        'Untick Box projection and orbit: the window reflections slide across the floor',
        'Switch the view to Floor and toggle Box projection again',
        'Turn on the volumes: the projection box is the room\'s walls',
      ],
      compare: 'Untick Box projection. The same probe is then looked up by direction only, so reflections behave as if infinitely far away.',
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
    summary: 'A probe in each room and one in the doorway, blended by their influence boxes: each room reflects itself.',
    description:
      'The two-room scene from the three.js reflection probe example (by Ben Houston): a warm-lit room and a cool-lit room joined by a doorway. Each room has a `ReflectionProbe` whose ' +
      'influence box is the room and whose projection box (`projectionSize`) is its walls. A small doorway probe wins where the boxes overlap ' +
      '(the smallest box wins) and fades into the room probes over its `blendDistance`. All three are baked once into one set, and ' +
      '`scene.environmentNode = reflectionProbes(probes)` makes every material look them up at its own position. The mirror ball is kept out of the captures ' +
      '(`userData.reflectionProbeExclude`) because it moves. **Show blend weights** colours each surface by the probes it blends.',
    brief: {
      kind: 'feature',
      shows: 'Why a level needs more than one probe: each room reflects its own walls and light, and the doorway probe blends one room into the other without a seam.',
      tryThis: [
        'Untick One probe per room: the cool room\'s floor and the mirror ball now show the warm room',
        'Turn on Show blend weights, then pick Across the doorway: the colours mix where the boxes overlap',
        'Watch the mirror ball roll through the doorway: its reflection hands over from one room to the other',
      ],
      compare: 'Untick One probe per room. One probe, captured in the warm room, is then projected onto the whole building.',
    },
    category: 'features',
    status: 'stable',
    tags: ['probes', 'blending', 'influence volumes', 'two rooms'],
    docs: 'concepts/reflection-probes',
    source: 'examples/features/probes/two-rooms/main.ts',
  },
  {
    slug: 'probes/live',
    path: 'features/probes/live/',
    title: 'Live probes',
    summary: 'Probes captured again while the scene runs, one per frame: a turning knot and two colour-cycling lights in two rooms.',
    description:
      'The two rooms, with a probe in each room and one in the doorway. Every frame, `probes.bake(renderer, scene, { probes: [next], bounces: 1 })` ' +
      'captures one probe again, in turn (time-sliced). Each probe is at most three frames old, at a third of the cost of capturing all of them. ' +
      'It uses one capture pass (`bounces: 1`), because a sliced bake only covers its own slice. The moving mirror ball is kept out of the captures ' +
      '(`userData.reflectionProbeExclude`). The comparison is a second set of probes baked once at load. The lab page `probes/` has every storage and lookup option.',
    brief: {
      kind: 'feature',
      shows: 'Probes that follow the scene. One probe is captured again each frame as the lights change colour and the knot turns, so the reflections stay current.',
      tryThis: [
        'Untick Live capture: the floor and the mirror ball keep the light colours from when the page loaded',
        'Set Probes per frame to all 3: the same image at three times the capture cost',
      ],
      compare: 'Untick Live capture. The same probes are then baked once at load and never updated.',
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
    summary: '`bake({ exclude })` keeps a moving mirror out of the live probe it reflects, so it does not paint itself onto the room.',
    description:
      'A mirror floor faces a patterned wall. A polished gold knot slides in front of it, and the room\'s probe is captured again every frame so the reflections ' +
      'follow the scene. Box projection paints what the probe saw onto the room\'s box. That is right for the wall and the floor and wrong for anything standing inside the room. ' +
      '`probes.bake(renderer, scene, { exclude: [knot] })` hides the knot for the capture only. Setting `userData.reflectionProbeExclude = true` does the same for every bake. ' +
      'Screen-space reflections and ray-traced reflections still see the knot (see the screen-space and ray-traced pages); the probe is only the fallback for what they miss.',
    brief: {
      kind: 'feature',
      shows: 'Why moving mirrors are kept out of probes. Captured, the knot is painted onto the wall and the floor, and the mirror floor shows a second, smeared knot where there is none.',
      tryThis: [
        'Untick Exclude the mirror knot: a ghost knot slides across the floor\'s reflection of the wall',
        'Untick Move, tick Show the probe and orbit: the ghost is the knot as seen from the capture point (the mirror sphere), painted onto the wall',
      ],
      compare: 'Untick Exclude the mirror knot. The knot is then captured into the probe and painted onto the room.',
    },
    category: 'features',
    status: 'stable',
    tags: ['probes', 'exclude', 'live capture'],
    docs: 'concepts/reflection-probes',
    source: 'examples/features/probes/exclude/main.ts',
  },
  {
    slug: 'ssr/mirror-floor',
    path: 'features/ssr/mirror-floor/',
    title: 'Screen-space reflections',
    summary: 'Screen-space reflections on a polished floor, over a probe: the objects stand on their reflections.',
    description:
      'A polished floor faces a patterned wall, with a sphere, a box and two posts. The box-projected probe gets the wall right (the wall is the probe\'s box) but leaves ' +
      'out what stands inside the room. Screen-space reflections march each pixel\'s reflected ray through the depth buffer and take the colour of whatever it hits on ' +
      'screen. Where it finds nothing, the probe fills in. `Reflections.create(renderer, scene, { probes, denoiser })` sets up the G-buffer, the tracer, the probe fill, ' +
      'the denoiser and the composite, and the render loop calls `reflections.render(camera)`. The comparison is three.js\'s own lit image of the same frame ' +
      '(`hybrid.composite().lit`): the probe alone.',
    brief: {
      kind: 'feature',
      shows: 'What screen-space reflections add over a probe: sharp reflections of everything on screen, including the objects a probe leaves out.',
      tryThis: [
        'Untick Screen-space reflections: the sphere and the box lose their reflections, and the wall keeps its own',
        'Raise Floor roughness: the reflection blurs with distance from the contact point, and the denoiser keeps it steady',
        'Pick At the sphere: the floor reflects the sphere\'s underside, which the camera cannot see (the probe fills it in)',
      ],
      compare: 'Untick Screen-space reflections. You then see the probe alone (three.js\'s lit image of the same frame).',
    },
    category: 'features',
    status: 'stable',
    tags: ['ssr', 'probes', 'denoiser', 'Reflections.create'],
    docs: 'concepts/screen-space-reflections',
    source: 'examples/features/ssr/mirror-floor/main.ts',
  },
  {
    slug: 'ssr/what-it-misses',
    path: 'features/ssr/what-it-misses/',
    title: 'What screen space misses',
    summary: 'Off screen, behind the camera, hidden: what screen-space reflections cannot see, and the probes that fill it in.',
    description:
      'A polished floor and a wall mirror. The floor reflects a glowing ring and a lamp bar above the top of the frame. The mirror reflects three bars on the wall ' +
      'behind the camera. A screen-space ray can only find what is on screen, so these are all misses, and so is anything hidden behind an object (its back or ' +
      'underside; see the Screen-space reflections page, At the sphere). The composite fills every miss from the probes (box-projected cube maps captured inside the room). ' +
      'The comparison draws screen space alone from the composite\'s terms (`lit + weight x (ssr - probeSpecular)`, the raw tracer hits): black where a ray missed. ' +
      'The Ray-traced fallback page fills the same misses with the real geometry.',
    brief: {
      kind: 'educational',
      shows: 'Where screen-space reflections run out: things off screen, behind the camera or hidden behind other objects. The probes fill those pixels so the image stays whole.',
      tryThis: [
        'Untick Fill misses from the probes: the ring in the floor and the whole wall mirror go black',
        'Tick Tint the misses: magenta marks how much of each smooth pixel the probes filled',
        'Pick Behind the camera: the mirror shows the bars behind you only through the probe',
      ],
      compare: 'Untick Fill misses from the probes. You then see screen space alone, black wherever a ray found nothing on screen.',
    },
    category: 'features',
    status: 'stable',
    tags: ['ssr', 'misses', 'probes'],
    docs: 'concepts/screen-space-reflections',
    source: 'examples/features/ssr/what-it-misses/main.ts',
  },
  {
    slug: 'rt/fallback',
    path: 'features/rt/fallback/',
    title: 'Ray-traced fallback',
    summary: 'Rays fill what screen space misses: reflections of things above the frame and behind the camera.',
    description:
      'The wall mirror faces the camera, so it shows what is behind it: a wall of coloured bars, a glowing sphere, and the backs of the cylinder and the box. ' +
      'Screen space cannot see any of that, and the floor near the camera reflects a ring above the frame. `Reflections.create(renderer, scene, { probes, rayTracing: true, denoiser })` builds a BVH (a ray-tracing acceleration structure) over every visible mesh once ' +
      '(`@pmndrs/raytracer` and `@pmndrs/bvh`, optional peer dependencies) and traces a ray for each pixel that screen space misses. Hits are lit from the probes and the ' +
      'sun. `reflections.ssr.rayTracing` switches it at run time. If the device cannot fit the ray-traced pass, it turns itself off with one warning, and ' +
      '`reflections.ssr.traceError` says why (shown in the status line). Screen-space reflections and probes carry on.',
    brief: {
      kind: 'feature',
      shows: 'What the ray-traced fallback adds over screen space plus probes: sharp reflections of things off screen, in the right place, including objects the probe never captured.',
      tryThis: [
        'Untick Ray-traced fallback and watch the wall mirror: the cylinder and the box vanish from it (the probe never saw them) and the bars go soft',
        'Switch the view to Wall mirror and toggle the fallback again',
        'Turn on the view that shows where each pixel\'s reflection comes from: blue is a traced ray, green is screen space, red is the probe',
      ],
      compare: 'Untick Ray-traced fallback (`reflections.ssr.rayTracing = false`). The misses then take the probe instead.',
    },
    category: 'features',
    status: 'experimental',
    tags: ['ray tracing', 'probes', 'denoiser'],
    docs: 'concepts/ray-traced-fallback',
    source: 'examples/features/rt/fallback/main.ts',
    check: { wait: 3000 },
  },
  {
    slug: 'rt/animated',
    path: 'features/rt/animated/',
    title: 'Ray tracing moving meshes',
    summary: '`reflections.trace.refit()` each frame keeps the ray-traced reflections of moving meshes where the meshes are.',
    description:
      'A knot slides and turns and a ball bounces over a mirror floor. Screen space reflects what the camera sees of them. The rest (their undersides, and parts ' +
      'that are hidden or off screen) comes from rays traced against the BVH that `Reflections.create(..., { rayTracing: true })` builds once, from the meshes as they are at load. ' +
      'Each frame the page moves the meshes, calls `scene.updateMatrixWorld()`, then calls `reflections.trace.refit()`, which copies every traced mesh\'s world matrix ' +
      'into the BVH. **Refit covers rigid motion** (position, rotation, scale and instanced matrices), not changed geometry: skinned or morphing meshes and edited ' +
      'vertices need a new build. The moving meshes are kept out of the probe (`userData.reflectionProbeExclude`), or it would hold their first pose.',
    brief: {
      kind: 'feature',
      shows: 'Why moving meshes need `trace.refit()` each frame. Without it, rays still hit them where they stood at load, so their reflections lag or ghost.',
      tryThis: [
        'Untick Refit: the traced part of the knot\'s and the ball\'s reflections stays where they started',
        'Turn on Show traced pixels: those are the pixels a stale BVH gets wrong',
        'Untick Animate to hold a pose and compare',
      ],
      compare: 'Untick Refit. The BVH then keeps the pose it was built with, and the reflections go stale.',
    },
    category: 'features',
    status: 'experimental',
    tags: ['ray tracing', 'refit', 'animation'],
    docs: 'concepts/ray-traced-fallback',
    source: 'examples/features/rt/animated/main.ts',
    check: { wait: 3000 },
  },
  {
    slug: 'hybrid/explained',
    path: 'features/hybrid/explained/',
    title: 'The hybrid, explained',
    summary: 'Probe, screen space, rays and the hybrid in one room: where each is right, where each breaks, and which source each pixel took.',
    description:
      'The teaching page. One `Reflections.create(renderer, scene, { probes, rayTracing: true, denoiser })` over the `explainer` room, and each method is a setting on it. ' +
      '**Probe only** is three.js\'s lit image with the probe as its environment. **Screen space + probe** is `reflections.ssr.rayTracing = false`. ' +
      '**Rays, every pixel** sends every pixel to the ray-traced pass. The **hybrid** is the default. Seven situations (a mirror, off the top of the screen, things that move, contact, rough surfaces, the source map and ' +
      'free exploring) set the camera and name the two methods worth comparing. The source map is `HybridReflections.sourceIndex` of the composite. ' +
      'The turning sculpture is refitted into the BVH each frame (`reflections.trace.refit()`).',
    brief: {
      kind: 'educational',
      shows: 'How the hybrid picks a source for each pixel: screen space where a ray hits, rays where it misses, the blurred probe for rough surfaces. It also shows why each source alone falls short.',
      tryThis: [
        'Step through the situations and switch between the two methods under the image',
        'Turn on "where reflections come from" and tilt the view down at the floor',
        'In "Rough surfaces", drag the roughness cutoff to 1',
      ],
      compare: 'Each source alone: probe only, screen space + probe, or rays for every pixel. Use the switch under the image, or "Reflections from".',
    },
    category: 'features',
    status: 'stable',
    tags: ['hybrid', 'source map', 'probes', 'ssr', 'ray tracing', 'denoiser'],
    docs: 'concepts/hybrid-resolve',
    source: 'examples/features/hybrid/explained/main.ts',
    check: { wait: 3000 },
  },
  {
    slug: 'denoise/glossy',
    path: 'features/denoise/glossy/',
    title: 'Denoising glossy reflections',
    summary: 'The denoiser on glossy surfaces, with a live flicker meter.',
    description:
      'The screen-space tracer sends one ray per 2x2 block of pixels per frame through each glossy pixel\'s reflection lobe, so a single frame is noise and a run of frames ' +
      'shimmers. `Reflections.create(..., { denoiser })` runs a temporal denoiser between the trace and the ' +
      'composite. It reprojects the last frames and filters spatially. `reflections.hybrid.denoise = false` shows the raw signal. The meter reads a 1:1 crop ' +
      'of the canvas centre each frame, once the camera has settled. It reports the mean change per pixel (8-bit luma) and the share of pixels that change by more than 1/255.',
    brief: {
      kind: 'quality',
      shows: 'What the denoiser does for glossy reflections. The tracer\'s one noisy sample per 2x2 block becomes a steady image, and the meter shows how steady.',
      tryThis: [
        'Tick Denoiser off and watch the middle of the ramp (roughness 0.2 to 0.4) and the meter',
        'Switch the view to Floor strips: the chrome strips go from mirror to rough',
        'Orbit, let go, and watch the meter settle',
      ],
      compare: 'Tick Denoiser off. You then see the raw signal: one ray per 2x2 block of pixels per frame.',
    },
    category: 'features',
    status: 'stable',
    tags: ['denoiser', 'flicker'],
    docs: 'concepts/denoising-and-upscaling',
    source: 'examples/features/denoise/glossy/main.ts',
  },
  {
    slug: 'materials/roughness',
    path: 'features/materials/roughness/',
    title: 'Materials',
    summary: 'How roughness, metalness and clear coat change reflections, and why basic, Lambert and Phong materials get none.',
    description:
      'A roughness ramp, from 0 (left) to 1 (right): gold metal spheres, blue plastic spheres and chrome floor strips, drawn through `Reflections.create` ' +
      'with a probe and the denoiser. Every reflection the package adds takes the place of three.js\'s own specular environment term, so it follows the material. ' +
      'Metal reflects in its own colour, plastic weakly and in white. Roughness widens the reflection (above 0.447 the probe alone reflects). A `MeshPhysicalMaterial` ' +
      'clear coat adds a sharp layer over a rough base. `MeshBasicMaterial`, `MeshLambertMaterial` and `MeshPhongMaterial` get no reflections, by design: they have ' +
      'no physical specular term to replace (see "Which materials get reflections" in the README). Give a surface that should reflect a standard or physical material.',
    brief: {
      kind: 'feature',
      shows: 'Which materials get reflections, and how roughness, metalness and clear coat shape them. Basic, Lambert and Phong get none.',
      tryThis: [
        'Tick Classic materials: the spheres turn Phong and lose their reflections (the highlight is from the lights, not a reflection)',
        'Set the Blue row to Physical, clear coat: a sharp coat over a rough base',
        'Switch the view to Floor strips: chrome goes from mirror to rough',
      ],
      compare: 'Tick Classic materials. The spheres switch to Phong, Lambert or Basic, while the floor strips stay standard.',
    },
    category: 'features',
    status: 'stable',
    tags: ['materials', 'roughness'],
    docs: 'guides/three',
    source: 'examples/features/materials/roughness/main.ts',
  },
  {
    slug: 'motion/animated',
    path: 'features/motion/animated/',
    title: 'Animation and camera cuts',
    summary: 'A camera path, moving objects and a camera cut with `resetHistory()`.',
    description:
      'The two rooms with a polished floor, the knot turning and the mirror ball moving in a figure eight. The camera runs three 6-second shots with a cut ' +
      'between each. Reflections are temporal: the denoiser blends each pixel with where it was last frame (using the G-buffer\'s motion vectors and the camera\'s ' +
      'matrices), which keeps a moving camera and moving objects steady. At a cut, the last frame is another shot, so the page calls `reflections.ssr.resetHistory()` and ' +
      '`reflections.hybrid.resetHistory()` (on `ScreenSpaceReflectionsPass` and `HybridReflections` when you build from the pieces). Do the same on a teleport or a scene ' +
      'switch, and nowhere else. Unlike a path tracer\'s accumulation, the history is not reset when the camera moves.',
    brief: {
      kind: 'feature',
      shows: 'A whole animated scene, with a camera path and moving objects, staying steady through the moves. `resetHistory()` runs at the camera cuts and only there.',
      tryThis: [
        'Watch the floor through the camera moves and the cuts: it stays steady, with no shimmer',
        'Tick Reset history on camera moves: the floor sparkles until the shot ends',
        'Pause: the image holds still',
      ],
      compare:
        'Tick Reset history on camera moves. The denoiser then never gets past its first frame, and the glossy floor shows the tracer\'s raw noise while the camera moves. ' +
        '(Leaving out the reset at a cut barely shows, because the denoiser rejects history whose depth and normals disagree. A cut still needs it.)',
    },
    category: 'features',
    status: 'stable',
    tags: ['motion', 'history'],
    docs: 'guides/flicker-and-stability',
    source: 'examples/features/motion/animated/main.ts',
  },
  {
    slug: 'perf/presets',
    path: 'features/perf/presets/',
    title: 'Presets',
    summary: 'The `default` and `performance` presets (half-resolution reflections), with GPU time per pass.',
    description:
      'The two rooms with probes, screen-space reflections and the denoiser through `Reflections.create` with `timestamps: true`, so the trace passes report GPU time ' +
      '(`reflections.ssr.readTimings()`). The `performance` preset sets `reflectionResolution: \'half\'`: it traces and denoises at half size on each axis, then upsamples with a joint bilateral filter. ' +
      'At run time, `applyReflectionsPreset(reflections, name)` switches it and rebuilds the composite when the resolution changes. (When you build from the pieces, call ' +
      '`applyReflectionsPreset({ ssr, hybrid }, name)`, then `hybrid.rebuild()` and a new `hybrid.composite()`.) GPU times need the `timestamp-query` feature, and you should compare them on one machine. ' +
      'The trade-offs per scene are in docs/SETTINGS.md, "Presets".',
    brief: {
      kind: 'performance',
      shows: 'What the performance preset saves (the reflection passes run on a quarter of the pixels) and what it costs: softer reflections and jagged edges in mirrors.',
      tryThis: [
        'Tick Performance preset and read the GPU times in the panel',
        'Set the view to Mirror ball and toggle again: the ball\'s reflected edges are where half resolution shows',
        'Orbit near the floor: the rough floor barely changes',
      ],
      compare: 'Toggle Performance preset: it switches between the `performance` preset (half-resolution reflections) and `default`.',
    },
    category: 'features',
    status: 'stable',
    tags: ['presets', 'gpu ms'],
    docs: 'guides/performance-and-quality',
    source: 'examples/features/perf/presets/main.ts',
  },
  {
    slug: 'perf/upscaler',
    path: 'features/perf/upscaler/',
    title: 'Upscaling',
    summary: 'Temporal anti-aliasing and upscaling after the composite, with `@pmndrs/upscaler` and its jitter wired through.',
    description:
      'The two rooms with probes, screen-space reflections and the denoiser (`Reflections.create`) render at 1/1.5 of the display size on each axis (the G-buffer size is set with ' +
      '`gbufferOptions`). `@pmndrs/upscaler` then rebuilds the display size after the composite. The upscaler\'s jitter goes in through ' +
      '`reflections.render(camera, { jitter, projection })`: the G-buffer is drawn jittered, while its motion vectors, the tracer and the denoiser stay unjittered. ' +
      'The composite renders into the upscaler\'s input in linear colour (`reflections.pipeline.outputColorTransform = false`, which is what the upscaler expects), and is tone-mapped after it. ' +
      'The upscaler side (jitter, motion in its convention, presenting the result) is the examples\' `DisplayAA` helper (examples/shared/antialias.ts). At 1x it is temporal anti-aliasing alone.',
    brief: {
      kind: 'performance',
      shows: 'Rendering the scene and its reflections below the display size, then upscaling after the composite. Every reflection pass handles fewer pixels, and you get anti-aliasing with it.',
      tryThis: [
        'Tick Upscaler off: the image is at display resolution with no anti-aliasing (edges and the last shimmer return)',
        'Set Upscale to Performance (2x), orbit, then let go: this is a quarter of the pixels',
        'Set Upscale to Native AA: the upscaler works as temporal anti-aliasing only',
      ],
      compare: 'Tick Upscaler off. Every pass then runs at the display resolution, with no anti-aliasing.',
    },
    category: 'features',
    status: 'experimental',
    tags: ['upscaler', 'taa'],
    docs: 'concepts/denoising-and-upscaling',
    source: 'examples/features/perf/upscaler/main.ts',
  },
  {
    slug: 'custom/tsl',
    path: 'features/custom/tsl/',
    title: 'Probes in your own TSL material',
    summary: '`sampleReflectionProbes` in a custom TSL material, here a water surface.',
    description:
      'The box room\'s baked probe serves three.js\'s materials through `scene.environmentNode = reflectionProbes(probes)`. The water in the basin is a ' +
      '`MeshBasicNodeMaterial` that calls the lookup itself: `sampleReflectionProbes(probes, positionWorld, reflected, roughness)` returns the box-projected, ' +
      'blended light along any direction. Here the direction is the view ray reflected about a normal made of travelling waves, mixed with a dark tint by Schlick\'s fresnel. ' +
      'Unlit custom materials get no screen-space reflections from `Reflections` (they have no physical specular term to replace; see "Which materials get reflections" in the README), ' +
      'so the probe sample is their reflection. The page uses probes only, with `renderer.render()`.',
    brief: {
      kind: 'feature',
      shows: 'Sampling the reflection probes from your own TSL material: a rippled water surface that reflects the room through `sampleReflectionProbes()`.',
      tryThis: [
        'Tick Stock material: a glossy MeshStandardMaterial replaces the water, using the same probe through three.js\'s lighting, flat',
        'Untick Ripples: the custom material becomes a fresnel mirror',
        'Orbit low over the pool: the fresnel brings the windows up at grazing angles',
      ],
      compare: 'Tick Stock material. A glossy, flat MeshStandardMaterial then reflects the same probe.',
    },
    category: 'features',
    status: 'stable',
    tags: ['tsl', 'probes'],
    docs: 'guides/three',
    source: 'examples/features/custom/tsl/main.ts',
  },
  {
    slug: 'setup/device-limits',
    path: 'features/setup/device-limits/',
    title: 'Device limits',
    summary: 'What a plain `new WebGPURenderer()` costs: a second lit pass, and `traceError` when ray tracing does not fit.',
    description:
      'A plain `new WebGPURenderer()` asks for WebGPU\'s default limits. At the default 32 bytes of colour attachments per sample, the G-buffer cannot hold three.js\'s lit image ' +
      'too (that needs 36), so the package draws the scene a second time for it and estimates the specular weights. One console warning says so. Ray tracing uses 8 ' +
      'storage buffers per shader stage with the packed scene copy, which fits the default 8. A setup that needs more (the split copy needs 9) turns ray tracing off with one ' +
      'warning and sets `pass.traceError`, and screen-space reflections and probes go on. `createReflectionsRenderer()` (or `requiredLimits: reflectionsRequiredLimits(adapter)`) ' +
      'asks the GPU for what the passes need. The two images are nearly identical (the quick start measured 0.44/255 mean difference, from the estimated weights). ' +
      'What differs is the extra scene draw per frame, which the panel and the status line show. URL options: `?renderer=plain|reflections`, `?rt=1|split|0` (each reloads the page).',
    brief: {
      kind: 'informative',
      shows: 'What changes on a renderer with WebGPU\'s default limits: a second scene draw for the lit image, estimated specular weights, and ray tracing turning itself off (with `traceError`) when it does not fit. Nothing fails.',
      tryThis: [
        'Read the panel, then set Renderer to createReflectionsRenderer(): one scene draw, with specular taken from the material',
        'On the plain renderer, set Ray tracing to the 9-buffer scene copy: the status line shows pass.traceError',
      ],
      compare: 'Set Renderer to createReflectionsRenderer() (the page reloads). The image barely changes. What differs is the extra scene draw and the estimated specular weights, which the panel shows.',
    },
    category: 'features',
    status: 'stable',
    tags: ['limits', 'setup'],
    docs: 'guides/troubleshooting',
    source: 'examples/features/setup/device-limits/main.ts',
    check: { compare: false },
  },

  // ---- engines --------------------------------------------------------------------------------------
  {
    slug: 'engines/three',
    path: 'engines/three/',
    title: 'three.js',
    summary: 'three.js `WebGPURenderer` with every feature, on the two rooms that all the engine pages share.',
    description:
      'The two rooms (`examples/shared/rooms.ts`): a `ReflectionProbes` set with one probe per room and one in the doorway, baked once. The loop then uses ' +
      '`Reflections.create(renderer, scene, { probes, denoiser, rayTracing })` and `reflections.render(camera)`. The ray-traced switch rebuilds ' +
      'it with a BVH (`@pmndrs/raytracer`) and refits it as the ball moves. This is the reference the other engine pages are measured against. ' +
      'React Three Fiber has everything here. Babylon.js and raw WebGPU have probes and screen-space reflections (no ray tracing, and Babylon.js has no denoiser). ' +
      'pixi.js needs the closed pixi-3d beta (the table is in the adapters guide). Each feature has its own page: box-projected probe, screen-space reflections, and the showcase.',
    brief: {
      kind: 'feature',
      shows: 'The three.js adapter with everything on: probes per room, screen-space reflections, the denoiser and, on a switch, the ray-traced fallback. The other engine pages draw this scene from the same views.',
      tryThis: [
        'Turn Screen space off: the floor keeps the probes\' blurrier, box-projected reflections',
        'Turn the Ray-traced fallback on, set View to ball, and watch what the screen cannot see',
        'Open the Babylon.js or Raw WebGPU page at the same View and compare',
      ],
      compare: 'Turn Screen space off (probes only); every engine page has this switch. Or open another engine page at the same View.',
    },
    category: 'engines',
    status: 'stable',
    tags: ['three', 'probes', 'ssr', 'ray tracing', 'denoiser'],
    docs: 'guides/three',
    source: 'examples/engines/three',
  },
  {
    slug: 'engines/r3f',
    path: 'engines/r3f/',
    title: 'React Three Fiber',
    summary: 'The two rooms as JSX, with every feature of the three.js page through the `useReflections` hook.',
    description:
      'React Three Fiber v10 uses `WebGPURenderer` by default (the `renderer` prop calls `createReflectionsRenderer` for the device limits). The rooms of ' +
      '`examples/shared/rooms.ts` are written as JSX, and so are the probes (`extend(ReflectionProbes)`, `extend(ReflectionProbe)`), baked in an effect once the ' +
      'rooms are mounted. `useReflections` (in examples/r3f) calls `Reflections.create` and draws each frame through it. Ray tracing is fixed when `Reflections` is created, ' +
      'so its switch remounts the hook\'s component (through a `key`). Nothing is missing compared with the three.js page: React Three Fiber is the three.js adapter under a `<Canvas>`.',
    brief: {
      kind: 'feature',
      shows: 'Everything the three.js page has, in React: the rooms and their probes as JSX, and reflections from one hook.',
      tryThis: [
        'Turn Screen space off: probes only',
        'Turn the Ray-traced fallback on (the hook\'s component remounts with a BVH)',
        'Open the three.js page next to it at the same View',
      ],
      compare: 'Turn Screen space off (probes only). Or open the three.js page, which should look the same.',
    },
    category: 'engines',
    status: 'experimental',
    tags: ['react', 'r3f', 'probes', 'ssr', 'ray tracing', 'denoiser'],
    docs: 'guides/react-three-fiber',
    source: 'examples/engines/r3f',
  },
  {
    slug: 'engines/babylon',
    path: 'engines/babylon/',
    title: 'Babylon.js',
    summary: 'The two rooms built in Babylon.js: probes and screen-space reflections as frame-graph tasks.',
    description:
      'The rooms of `examples/shared/rooms.ts` rebuilt in Babylon.js on a `WebGPUEngine` (same sizes, colours, roughness, point lights with cube shadow maps), ' +
      'x negated for Babylon\'s left-handed world so the image matches three\'s. `BabylonProbeSet` captures the same three probes with Babylon cube renders; ' +
      'a frame graph renders the G-buffer, then `FrameGraphReflectionsTask` (core\'s tracer, the probes as its fallback) and ' +
      '`FrameGraphReflectionsCompositeTask` (lit + split-sum weight x radiance), then ACES. **Missing against engines/three** (`guides/adapters`): ' +
      'the ray-traced fallback, the denoiser (the glossy floor shows the tracer\'s raw samples), presets, the hybrid resolve. Bounce light comes from the ' +
      'probes (`probeIrradiance` on every PBR material), as three\'s does; the rooms still read darker than three\'s: without bounce light three\'s ' +
      'image is about twice as bright as Babylon\'s (direct light, shadows or tone mapping; not yet traced). The older mirror-wall page (lab: babylon) keeps the adapter\'s orientation and IBL checks.',
    brief: {
      kind: 'feature',
      shows: 'The engine-agnostic core on Babylon.js: the same probes and tracer as engines/three, wired into Babylon\'s frame graph, on the same two rooms.',
      tryThis: ['Turn Screen space off: probes only, as on the three page', 'Set Debug to radiance or confidence: what the tracer hands the composite', 'Open engines/three at the same View: the difference is lighting, shadows and the missing denoiser'],
      compare: 'Screen space off (probes only); and engines/three at the same View',
    },
    category: 'engines',
    status: 'experimental',
    tags: ['babylon', 'frame graph', 'probes', 'ssr'],
    docs: 'guides/babylon',
    source: 'examples/engines/babylon',
  },
  {
    slug: 'engines/pixi',
    path: 'pixi3d/arcade/',
    title: 'pixi.js + pixi-3d',
    summary: 'A neon arcade in pixi-3d with screen-space reflections, a probe and the denoiser. Needs the closed pixi-3d beta.',
    description:
      'pixi Text and Graphics are drawn on 3D planes as `ContainerTexture`s. pixi-3d draws the scene, its depth and its motion. One G-buffer pass adds the normals and ' +
      'materials. The core tracer and probe set run on pixi\'s GPU device, the denoiser runs as on the other engine pages, and a pixi `Filter` composites the result (`ReflectionsView`). ' +
      '**Missing compared with the three.js page** (see the adapters guide): the ray-traced fallback, presets, the hybrid resolve and a one-call setup. Unlike the other engine ' +
      'pages, it is not on the two rooms. pixi-3d is a closed beta, so the page cannot be rebuilt or checked without it. Without the beta unpacked in ' +
      '`examples/pixi3d/vendor/`, it shows a setup notice (examples/pixi3d/README.md), and the public site leaves it out.',
    brief: {
      kind: 'feature',
      shows: 'The core on pixi.js v8 through pixi-3d: reflections of pixi\'s own 2D content on a wet 3D floor, denoised. It has probes, screen-space reflections and the denoiser, but no ray tracing.',
      tryThis: [
        'Add `?ssr=0` to the URL: probes only (every engine page has this switch)',
        'Add `?denoise=0`: the raw reflections, without the denoiser',
        'Add `?view=radiance` or `?view=confidence`: what the tracer hands to the composite',
      ],
      compare: 'Add `?ssr=0` (probes only) or `?denoise=0` (no denoiser). Open the three.js page to see what pixi lacks.',
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
    summary: 'The probe set and the screen-space tracer on a bare `GPUDevice`, with no engine, on the two rooms.',
    description:
      '`@pmndrs/reflections/core` with a renderer written for the page (examples/engines/core/renderer.ts). One forward pass fills the frame contract ' +
      '(depth, world normal and roughness, base colour and metalness, motion, and the scene colour: direct light with its specular, cube shadow maps, and the probes\' ' +
      'diffuse light as bounce light). The core `ProbeSet` takes the renderer\'s 90-degree captures (two bounces, as three.js bakes) and blurs them by roughness. ' +
      '`createScreenSpaceReflections` traces, with `probeRadianceFallback(probes)` behind it. `createReflectionDenoiseSeam` runs the denoiser. ' +
      'The composite adds the split-sum weight times the radiance, and tone-maps with three.js\'s ACES curve. Not on this page: the ray-traced fallback (core has it, as ' +
      '`RaytracerTraceProvider`, but the page is kept to probes and the tracer), the hybrid resolve and presets (they are three.js objects). ' +
      'The page is about 700 lines in three files (scene 200, renderer 320, main 190). It writes out once what an adapter does for an engine.',
    brief: {
      kind: 'feature',
      shows: 'The core API with no engine, which is what every adapter wraps. A minimal renderer fills the frame contract, and the core\'s probes, tracer and denoiser do the rest.',
      tryThis: [
        'Turn Screen space off: probes only',
        'Set Show to lit, then reflection: the scene colour the tracer reads, and what the composite adds',
        'Open the three.js page at the same View',
      ],
      compare: 'Turn Screen space off (probes only). Or open the three.js page at the same View.',
    },
    category: 'engines',
    status: 'experimental',
    tags: ['core', 'webgpu', 'probes', 'ssr', 'denoiser'],
    docs: 'concepts/frame-contract',
    source: 'examples/engines/core',
  },

  // ---- lab ------------------------------------------------------------------------------------------
  lab('ssr', 'ssr/', 'Screen-space test scenes', 'Every test scene with every switch: screen-space reflections, rays, probes, the denoiser and the debug views.',
    'The shared scene kit (examples/shared) with `ScreenSpaceReflectionsPass` and the hybrid composite. URL options: `?scene=mirrorWall|offscreen|contact|roughnessRamp|boxRoom|moving|explainer|rooms|facingMirrors`, `?rt=1`, `?probes=0`, `?denoise=0`.',
    ['ssr', 'ray tracing', 'debug views'], 'examples/ssr/src/main.ts', 'concepts/screen-space-reflections', { kind: 'debugging', status: 'experimental' }),
  lab('probes', 'probes/', 'Probe parity page', 'The three.js reflection probe example running on this package\'s probes, captured live: every storage, lookup and capture option, and the probe checks.',
    'A port of three.js\'s `webgpu_reflection_probes` example (the two rooms, a test grid, a mirror sphere) on `@pmndrs/reflections/three`, with the probes captured again every frame. ' +
    'It has the lookups `auto`, `cube-array`, the 2D array with `warp` or `none`, the older TSL node and a hardware-cube diagnostic, plus capture resolution, bounces and ' +
    'the LightProbeGrid re-fit. URL options: `?static`, `?grid`, `?refit`, `?lookup=`. `pnpm check -- --only probes` runs its checks, and `--compare` compares it against the same page in the denoiser repository.',
    ['probes', 'three.js example', 'parity'], 'examples/probes/src/main.ts', 'concepts/reflection-probes', { status: 'experimental' }),
  lab('scenes', 'scenes/', 'Scene kit and G-buffer', 'The test scenes and every target of the frame contract: depth, normals, roughness, motion and scene colour.',
    '`FrameGBuffer` draws the scene once into several render targets. A fullscreen pass then shows one target, or all of them in a grid. URL option: `?scene=`.',
    ['g-buffer', 'frame contract'], 'examples/scenes/src/main.ts', 'concepts/frame-contract'),
  lab('babylon', 'babylon/', 'Babylon.js adapter checks', 'The mirror-wall scene on Babylon.js: the adapter\'s orientation, motion and environment-lighting checks.',
    'The first Babylon.js page: the mirror-wall scene with a gradient sky. `?scene=ibl` compares the composite with Babylon.js\'s own specular environment lighting. `pnpm check -- --only babylon` runs on it. The page for users is engines/babylon.',
    ['babylon', 'frame graph'], 'examples/babylon/src/main.ts', 'guides/babylon', { kind: 'debugging', status: 'experimental' }),
  lab('sssr-core', 'sssr-core/', 'Screen-space tracer (core)', 'The core tracer on exact analytic inputs, on raw WebGPU: debug views and variant parity.',
    'No engine: analytic depth and normals, the core tracer, its classify and intersect passes, and debug views.', ['core', 'ssr'], 'examples/sssr-core/src/main.ts', 'concepts/screen-space-reflections'),
  lab('probe-core', 'probe-core/', 'Probe set (core)', 'The core probe set and its radiance fallback on a bare GPU device.',
    'Compares layouts and formats, the CPU volume weights, re-fit, specular occlusion and the radiance fallback. Runs its checks on demand.', ['core', 'probes'], 'examples/probe-core/src/main.ts', 'concepts/reflection-probes'),
  lab('bc6h', 'bc6h/', 'BC6H encoder', 'The GPU BC6H encoder checked against the hardware decoder.',
    'Encodes an HDR cube map on the GPU (fast and normal modes) and reads it back through the hardware BC decoder.', ['bc6h', 'compression'], 'examples/bc6h/src/main.ts', undefined,
    { requires: ['texture-compression-bc'] }),
  lab('probe-bench', 'probe-bench/', 'Probe layout bench', 'Cube array, 2D array and octahedral layouts, with rgba16f, rgb9e5, rg11b10 and BC6H formats.',
    'Measures the error and the lookup cost of each layout and format. The bench runs on demand (`__p.run()`); the page itself is a log.', ['probes', 'bench'], 'examples/probe-bench/src/main.ts', 'concepts/reflection-probes', { image: false }),
  lab('ssr-bench', 'ssr-bench/', 'Screen-space reflections bench', 'This package\'s screen-space reflections against three.js r187\'s `SSRNode`: error, flicker and GPU time.',
    'The bench behind the screen-space reflections milestone. Runs on demand.', ['ssr', 'bench'], 'examples/ssr-bench/src/main.ts', 'concepts/screen-space-reflections'),
  lab('regressions', 'regressions/', 'Regressions', 'GPU reproductions of bugs found in review, each seen failing before its fix.',
    'Every fix from the reviews has a check here (`pnpm check -- --only regressions`). Runs on demand.', ['tests'], 'examples/regressions/src/main.ts', undefined, { image: false }),
  lab('nrc', 'nrc/', 'Radiance cache study', 'A radiance cache (NRC), probes and hit shading of mirror reflections, each against a path-traced reference.',
    'Needs a sibling `pmndrs/pathtracer` checkout (its bench modules are not published). Without one, the page says so.', ['nrc', 'study'], 'examples/nrc/src/main.ts', undefined,
    { devOnly: 'needs a local pathtracer checkout', image: false }),
  lab('showcase/bench', 'showcase/bench.html', 'Tuning bench', 'Every setting on one panel, two methods side by side, measured against the path tracer.',
    'Split view, side by side, or a difference heat map. Measure compares regions against the path tracer, and Copy as code gives you the settings. Every setting with its default and cost is in docs/SETTINGS.md.',
    ['settings', 'bench', 'gltf'], 'examples/showcase/src/bench.ts', 'reference/settings', { network: true, heavy: true, status: 'experimental', query: 'scene=toyCar&left=ours-denoised&right=probes' }),
];

/** A lab entry: a one-line summary is all the brief rules ask of a developer page. */
function lab(
  slug: string, path: string, title: string, summary: string, description: string, tags: string[], source: string, docs?: string,
  o: { kind?: ExampleKind; status?: ExampleStatus; requires?: GPUFeatureName[]; devOnly?: string; image?: boolean; network?: boolean; heavy?: boolean; query?: string } = {},
): ExampleEntry {
  return {
    slug, path, title, summary, description, tags, source, docs,
    brief: { kind: o.kind ?? 'debugging', shows: summary, tryThis: ['Read the source: this is a developer check, not a demo'] },
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
