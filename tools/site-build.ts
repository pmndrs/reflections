/**
 * Assembles the whole public site into one folder, the way the pages workflow does:
 *
 *     /            the docs (pmndrs/docs, docs/site/*.mdx)          tools/docs-site.ts
 *     /api/        the TypeDoc API reference                        `pnpm docs:api` (run it first)
 *     /examples/   the built examples (landing page + the demos)    vite build, examples/vite.config.ts
 *
 *     pnpm docs:api && pnpm site:build [out]     # out defaults to _site/
 *     npx -y serve _site
 *
 * The denoiser is the `denoiser` package from npm (a devDependency since W89), bundled like any other dependency;
 * tools/site-check.ts fails a showcase that runs without it.
 *
 * Environment:
 *   BASE_PATH      where the site is served from: '' (default, a custom domain such as
 *                  https://reflections.docs.pmnd.rs) or '/reflections' (pmndrs.github.io/reflections).
 *   KHRONOS_REF    the glTF-Sample-Assets commit the models are loaded from at runtime (pinned below).
 *   ASSETS_CDN     where Khronos models load from (default: raw.githubusercontent.com at the pinned commit). Set to 'local' to bundle examples/assets
 *                  instead (`pnpm assets` first; about 160 MB).
 *
 * Why the models load from a CDN: they are ~160 MB (Sponza alone is 44 MB), all public Khronos files that
  * raw.githubusercontent.com serves with CORS (jsDelivr was tried first: it answers 403 for Sponza and ABeautifulGame), and a Pages artifact should stay small and fast to
 * deploy. Only the two Poly Haven HDRIs (CC0, 3 MB) and the asset manifest ship with the site.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS } from '../scripts/fetch-assets.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** KhronosGroup/glTF-Sample-Assets, pinned so a force-push or a renamed model cannot break the site. */
const KHRONOS_REF = process.env.KHRONOS_REF ?? 'f0920f5b32d172a30efe3f9257e965918831e6ea';

const out = resolve(ROOT, process.argv[2] ?? '_site');
const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
const examplesBase = `${basePath}/examples/`;
const local = process.env.ASSETS_CDN === 'local';

const run = (cmd: string, args: string[], env: Record<string, string | undefined> = {}) => {
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    if (r.status !== 0) {
        console.error(`site: \`${cmd} ${args.join(' ')}\` failed`);
        process.exit(r.status ?? 1);
    }
};

// 1. docs + api
run('node', ['tools/docs-site.ts', out], { BASE_PATH: basePath || undefined });

// 2. examples (EXAMPLES_SITE=1: leaves out the pages that need the pixi-3d beta or the private pathtracer bench)
const dist = join(out, 'examples');
const remote: Record<string, string> = {};
if (!local) for (const a of ASSETS) if (a.khronos && !a.devOnly) remote[a.dir] = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${KHRONOS_REF}/Models/${a.khronos}/${a.variant}/`;
run('pnpm', ['exec', 'vite', 'build', '--config', 'examples/vite.config.ts'], {
    EXAMPLES_SITE: '1',
    EXAMPLES_BASE: examplesBase,
    EXAMPLES_OUT: dist,
    VITE_REMOTE_ASSETS: JSON.stringify(remote),
});

// 3. assets: the HDRIs and the manifest (the models are remote unless ASSETS_CDN=local)
const assetsOut = join(dist, 'assets');
mkdirSync(assetsOut, { recursive: true });
const shipped = ASSETS.filter((a) => !a.devOnly && (a.url || local));
if (shipped.some((a) => !a.url) && !existsSync(join(ROOT, 'examples/assets'))) {
    console.error('site: ASSETS_CDN=local needs `pnpm assets` first');
    process.exit(1);
}
const fetched = new Set<string>();
for (const a of shipped) {
    const dest = join(assetsOut, a.dir, a.file);
    mkdirSync(join(assetsOut, a.dir), { recursive: true });
    if (a.url) {
        const have = join(ROOT, 'examples/assets', a.dir, a.file);
        if (existsSync(have)) cpSync(have, dest);
        else {
            const res = await fetch(a.url);
            if (!res.ok) throw new Error(`site: ${res.status} ${a.url}`);
            writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        }
    } else if (!fetched.has(a.dir)) {
        cpSync(join(ROOT, 'examples/assets', a.dir), join(assetsOut, a.dir), { recursive: true });
        fetched.add(a.dir);
    }
}
// the manifest lists what the showcase may offer: every public model (remote or bundled) and the HDRIs
const manifest = ASSETS.filter((a) => !a.devOnly).map(({ dir, file, license }) => ({ dir, file, license, devOnly: false }));
writeFileSync(join(assetsOut, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 4. the examples' landing page, and the showcase's links to pages this site leaves out
const docsHref = `${basePath}/`;
writeFileSync(join(dist, 'index.html'), readFileSync(join(ROOT, 'tools/site-index.html'), 'utf8').replaceAll('__DOCS__', docsHref));
const showcase = join(dist, 'showcase/index.html');
writeFileSync(showcase, readFileSync(showcase, 'utf8').replace(/<a href="\.\/compare\.html">[^<]*<\/a> · <a href="\.\/bench\.html">[^<]*<\/a> · /, ''));

// 5. GitHub Pages: no Jekyll
writeFileSync(join(out, '.nojekyll'), '');
if (!existsSync(join(out, 'index.html'))) throw new Error('site: the docs build left no index.html');
console.log(`site: ${relative(ROOT, out)} ready (docs at ${docsHref}, API at ${docsHref}api/, examples at ${examplesBase})`);
