import { dirname, resolve } from 'path';
import { readdirSync, existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { defineConfig } from 'vite';

// Examples dev server: http://127.0.0.1:5370/<name>/ ($REFLECTIONS_PORT overrides; worktrees use their own) for each examples/<name>/index.html.
// The package is resolved to its source, so edits under packages/ show up without a build.
const root = __dirname;
const pages = Object.fromEntries(
  readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, 'index.html')))
    .map((d) => [d.name, resolve(root, d.name, 'index.html')]),
);

// pixi-3d (`@pixi/3d`) is in closed beta: not on npm, and its code and builds must stay inside the
// beta, so this repo never commits or bundles it. Its examples (examples/pixi3d/<name>/) run against
// a beta tester's own copy unpacked into the gitignored examples/pixi3d/vendor/ (examples/pixi3d/README.md);
// without one, each example's main.ts loads as a setup notice (pixi3d/unavailable.ts), which is
// also what CI and a public build get. The upscaler repo's split, copied.
const pixi3dVendor = resolve(root, 'pixi3d/vendor');
const hasPixi3d = existsSync(resolve(pixi3dVendor, 'package.json'));
const pixi3dDir = resolve(root, 'pixi3d');
if (existsSync(pixi3dDir)) {
  for (const d of readdirSync(pixi3dDir, { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(resolve(pixi3dDir, d.name, 'index.html'))) pages[`pixi3d-${d.name}`] = resolve(pixi3dDir, d.name, 'index.html');
  }
}

// The denoiser (`denoiser` 2.x on npm: `denoiser/ffx`, `denoiser/three`, OIDN at its root) and `@pmndrs/raytracer`
// are devDependencies (W89): no sibling checkout. The OIDN weights (.tza) load from the denoiser's default
// `DEFAULT_TZA_URL` (a pinned CDN copy of the upstream weights).
// The public site build (tools/site-build.ts, EXAMPLES_SITE=1) leaves out pixi (a redirect), nrc (the private pathtracer
// bench, below) and the closed pixi-3d beta.
const siteBuild = process.env.EXAMPLES_SITE === '1';
if (siteBuild) for (const k of Object.keys(pages)) if (k === 'pixi' || k === 'nrc' || k.startsWith('pixi3d-')) delete pages[k];

// The compare page's path-traced reference: three-gpu-pathtracer's WebGPU tracer (`three-gpu-pathtracer/webgpu`,
// 0.0.28, a devDependency: the first release built for three r187). $PATHTRACER_REPO points the alias at another
// checkout or package.
function findPathTracer(): string | null {
  const entry = (repo: string) => resolve(repo, 'src/webgpu/index.js');
  const env = process.env.PATHTRACER_REPO;
  if (env) return existsSync(entry(env)) ? realpathSync(env) : null;
  const installed = resolve(root, '../node_modules/three-gpu-pathtracer');
  return existsSync(entry(installed)) ? realpathSync(installed) : null;
}
const pathTracerRepo = findPathTracer();

// W86 (examples/nrc, experimental, never on the site): pmndrs/pathtracer's bench-only neural/hash radiance cache
// (`bench/nrc/*`) and its bench scene fixtures are not published, so this page alone resolves a sibling `pathtracer`
// checkout (next to this repo or any parent folder, or $NRC_PATHTRACER_REPO = the repo root). Read-only: nothing is
// copied or built. Inside that checkout and examples/nrc, `@pmndrs/raytracer` / `@pmndrs/pathtracer` resolve to the
// checkout's sources (the bench is written against them); everywhere else they are the npm packages. Without a checkout
// `@nrc-bench` aliases to a stub and examples/nrc shows a notice (`__NRC_AVAILABLE__` false).
function findNrcCheckout(): string | null {
  const ok = (repo: string) => existsSync(resolve(repo, 'bench/nrc/hash-grid.ts')) && existsSync(resolve(repo, 'packages/pathtracer/src/index.ts'));
  const env = process.env.NRC_PATHTRACER_REPO;
  if (env) return ok(env) ? realpathSync(env) : null;
  for (let dir = resolve(root, '..'); dirname(dir) !== dir; dir = dirname(dir)) {
    const repo = resolve(dirname(dir), 'pathtracer');
    if (ok(repo)) return realpathSync(repo);
  }
  return null;
}
const nrcRoot = siteBuild ? null : findNrcCheckout();
const nrcPage = resolve(root, 'nrc') + '/';
const nrcSources = {
  name: 'reflections-nrc-sources',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (!nrcRoot || !importer || !(importer.startsWith(nrcRoot + '/') || importer.startsWith(nrcPage))) return null;
    if (source === '@pmndrs/raytracer') return resolve(nrcRoot, 'packages/raytracer/src/index.ts');
    if (source === '@pmndrs/pathtracer') return resolve(nrcRoot, 'packages/pathtracer/src/index.ts');
    return null;
  },
};

// Sources served as-is from outside the dep optimizer (the aliased tracer, the nrc checkout) resolve `three`,
// `@pmndrs/bvh` and `@pmndrs/downsampler` from here, never from their own node_modules: one copy per page.
const outside = [pathTracerRepo, nrcRoot].filter((x): x is string => !!x);
const sharedDeps = {
  name: 'reflections-shared-deps',
  enforce: 'pre' as const,
  async resolveId(this: { resolve: (s: string, i?: string, o?: object) => Promise<unknown> }, source: string, importer?: string) {
    if (!importer || !/^(three|@pmndrs\/bvh|@pmndrs\/downsampler)(\/|$)/.test(source)) return null;
    if (!outside.some((r) => importer.startsWith(r + '/'))) return null;
    return this.resolve(source, resolve(root, 'index.html'), { skipSelf: true });
  },
};

// `@pmndrs/downsampler` and `@pmndrs/bvh` come from npm (W82; they were `link:` checkouts before), so
// nothing outside the repo needs to be on the fs allow list for them.


export default defineConfig({
  root,
  base: process.env.EXAMPLES_BASE ?? '/', // the site build serves the examples under /examples/ (or /<repo>/examples/)
  plugins: [{
    // Without the beta, a pixi-3d example's main.ts is replaced by the notice. Its source, not an
    // import of it: the root package.json's `sideEffects: false` lets a build drop a bare import.
    name: 'pixi3d-optional',
    load(id: string) {
      if (hasPixi3d) return;
      const path = id.split('?')[0].replaceAll('\\', '/');
      if (/\/pixi3d\/[^/]+\/main\.ts$/.test(path)) return readFileSync(resolve(root, 'pixi3d/unavailable.ts'), 'utf8');
    },
  }, nrcSources, sharedDeps],
  server: {
    port: Number(process.env.REFLECTIONS_PORT ?? 5370), strictPort: true, host: '127.0.0.1',
    fs: { allow: [resolve(root, '..'), ...(pathTracerRepo ? [pathTracerRepo] : []), ...(nrcRoot ? [nrcRoot] : [])] },
  },
  define: { __NRC_AVAILABLE__: JSON.stringify(!!nrcRoot), __PATHTRACER_SOURCE__: JSON.stringify(pathTracerRepo ?? '') },
  resolve: {
    alias: [
      ...(hasPixi3d
        ? [
            { find: /^@pixi\/3d$/, replacement: resolve(pixi3dVendor, 'dist/index.mjs') },
            { find: /^@pixi\/3d\/extras$/, replacement: resolve(pixi3dVendor, 'dist/extras/index.mjs') },
          ]
        : []),
      { find: /^@pmndrs\/reflections\/three$/, replacement: resolve(root, '../src/three.ts') },
      { find: /^@pmndrs\/reflections\/core$/, replacement: resolve(root, '../src/core.ts') },
      { find: /^@pmndrs\/reflections\/babylon$/, replacement: resolve(root, '../src/babylon.ts') },
      { find: /^@pmndrs\/reflections\/pixi$/, replacement: resolve(root, '../src/pixi.ts') },
      { find: /^@pmndrs\/reflections$/, replacement: resolve(root, '../src/index.ts') },
      nrcRoot ? { find: /^@nrc-bench\//, replacement: resolve(nrcRoot, 'bench') + '/' } : { find: /^@nrc-bench\/.*$/, replacement: resolve(root, 'shared/nrc-missing.ts') },
      { find: /^three-gpu-pathtracer-webgpu$/, replacement: pathTracerRepo ? resolve(pathTracerRepo, 'src/webgpu/index.js') : resolve(root, 'shared/pathtracer-missing.ts') },
    ],
  },
  // Behind an alias, vite would pre-bundle the tracer with its own copy of
  // three (two three instances: broken TSL). Served as source instead, `sharedDeps` resolves its three.
  optimizeDeps: { exclude: ['three-gpu-pathtracer-webgpu'] },
  build: { target: 'esnext', outDir: resolve(root, process.env.EXAMPLES_OUT ?? 'dist'), emptyOutDir: true, rollupOptions: { input: { ...pages, 'quickstart-probes': resolve(root, 'quickstart/probes.html'), ...(siteBuild ? {} : { 'showcase-compare': resolve(root, 'showcase/compare.html'), 'showcase-bench': resolve(root, 'showcase/bench.html') }) } } },
});
