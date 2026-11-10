import { dirname, resolve } from 'path';
import { readdirSync, existsSync, readFileSync, realpathSync } from 'fs';
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

// The denoiser (an optional peer, never a dependency) is resolved from the sibling `Denoiser` repo's
// source when one sits next to this repo or next to any parent folder (worktrees sit deeper), or at
// $DENOISER_REPO. Otherwise `@pmndrs/denoiser-ffx` resolves to a stub and the pages run undenoised.
function findDenoiser(): string | null {
  const entry = (repo: string) => resolve(repo, 'packages/denoiser-ffx/src/index.ts');
  const env = process.env.DENOISER_REPO;
  if (env) return existsSync(entry(env)) ? resolve(env) : null;
  for (let dir = resolve(root, '..'); dirname(dir) !== dir; dir = dirname(dir)) {
    const repo = resolve(dirname(dir), 'Denoiser');
    if (existsSync(entry(repo))) return repo;
  }
  return null;
}
const denoiserRepo = findDenoiser();
// denoiser/three's `ffxReflections()` TSL helper (examples/showcase compare page, method "three SSR +
// FFX"), from the same Denoiser checkout. Only its temporal/ffx.ts module graph is used.
const denoiserThreeFfx = denoiserRepo && existsSync(resolve(denoiserRepo, 'packages/denoiser-three/src/temporal/ffx.ts'))
  ? resolve(denoiserRepo, 'packages/denoiser-three/src/temporal/ffx.ts') : null;

// three-gpu-pathtracer (the compare page's path-traced reference, WebGL in its own canvas): a sibling
// checkout found like the Denoiser repo, or $PATHTRACER_REPO; else a null stub.
function findPathTracer(): string | null {
  const entry = (repo: string) => resolve(repo, 'src/core/WebGLPathTracer.js');
  const env = process.env.PATHTRACER_REPO;
  if (env) return existsSync(entry(env)) ? resolve(env) : null;
  for (let dir = resolve(root, '..'); dirname(dir) !== dir; dir = dirname(dir)) {
    const repo = resolve(dirname(dir), 'three-gpu-pathtracer');
    if (existsSync(entry(repo))) return repo;
  }
  return null;
}
const pathTracerRepo = findPathTracer();

// Sources served from outside this repo (the Denoiser checkout, three-gpu-pathtracer) resolve `three`
// and `three-mesh-bvh` from here, never from their own node_modules: one three instance per page.
const outside = [denoiserRepo, pathTracerRepo].filter((x): x is string => !!x);
const sharedDeps = {
  name: 'reflections-shared-deps',
  enforce: 'pre' as const,
  async resolveId(this: { resolve: (s: string, i?: string, o?: object) => Promise<unknown> }, source: string, importer?: string) {
    if (!importer || !/^(three|three-mesh-bvh)(\/|$)/.test(source)) return null;
    if (!outside.some((r) => importer.startsWith(r + '/'))) return null;
    return this.resolve(source, resolve(root, 'index.html'), { skipSelf: true });
  },
};

// `downsampler` is linked (packages/core: `link:` to a checkout outside this repo); vite serves it
// from its real path, so that checkout has to be on the allow list.
const downsamplerLink = resolve(root, '../packages/core/node_modules/downsampler');
const downsamplerRepo = existsSync(downsamplerLink) ? realpathSync(downsamplerLink) : null;
// @pmndrs/bvh is linked the same way (the bvh-worktrees/reflections-integration checkout).
const bvhLink = resolve(root, '../packages/core/node_modules/@pmndrs/bvh');
const bvhRepo = existsSync(bvhLink) ? realpathSync(bvhLink) : null;

export default defineConfig({
  root,
  plugins: [{
    // Without the beta, a pixi-3d example's main.ts is replaced by the notice. Its source, not an
    // import of it: the root package.json's `sideEffects: false` lets a build drop a bare import.
    name: 'pixi3d-optional',
    load(id: string) {
      if (hasPixi3d) return;
      const path = id.split('?')[0].replaceAll('\\', '/');
      if (/\/pixi3d\/[^/]+\/main\.ts$/.test(path)) return readFileSync(resolve(root, 'pixi3d/unavailable.ts'), 'utf8');
    },
  }, sharedDeps],
  server: {
    port: Number(process.env.REFLECTIONS_PORT ?? 5370), strictPort: true, host: '127.0.0.1',
    fs: { allow: [resolve(root, '..'), ...(denoiserRepo ? [denoiserRepo] : []), ...(pathTracerRepo ? [pathTracerRepo] : []), ...(downsamplerRepo ? [downsamplerRepo] : []), ...(bvhRepo ? [bvhRepo] : [])] },
  },
  define: { __DENOISER_SOURCE__: JSON.stringify(denoiserRepo ?? ''), __PATHTRACER_SOURCE__: JSON.stringify(pathTracerRepo ?? '') },
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
      {
        find: /^@pmndrs\/denoiser-ffx$/,
        replacement: denoiserRepo ? resolve(denoiserRepo, 'packages/denoiser-ffx/src/index.ts') : resolve(root, 'shared/denoiser-missing.ts'),
      },
      { find: /^@pmndrs\/denoiser-three-ffx$/, replacement: denoiserThreeFfx ?? resolve(root, 'shared/denoiser-three-missing.ts') },
      { find: /^three-gpu-pathtracer-webgl$/, replacement: pathTracerRepo ? resolve(pathTracerRepo, 'src/core/WebGLPathTracer.js') : resolve(root, 'shared/pathtracer-missing.ts') },
    ],
  },
  build: { outDir: resolve(root, 'dist'), emptyOutDir: true, rollupOptions: { input: { ...pages, 'showcase-compare': resolve(root, 'showcase/compare.html') } } },
});
