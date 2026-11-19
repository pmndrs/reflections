/**
 * Builds the docs website with pmndrs/docs, as the pages workflow does.
 *
 *     pnpm docs:api               # TypeDoc into api-docs/ (optional; copied to <out>/api when present)
 *     pnpm docs:site [out]        # the website into out/ (default docs-site/)
 *     pnpm site:build [out]       # docs + API + the built examples in one folder (tools/site-build.ts)
 *     npx -y serve docs-site      # look at it
 *
 * pmndrs/docs renders every .md and .mdx file under the folder it is given, so the site is built from
 * a copy of docs/site/ (the MDX source; docs/ itself keeps the internal notes, which stay out of the
 * site) without docs/site/snippets (the type-checked code samples, tools/docs-snippets.ts). The pages'
 * relative paths stay the same, so "edit this page" links point at docs/site/<page>.mdx.
 * reference/settings.mdx is generated here from docs/SETTINGS.md (`pnpm settings:doc` keeps that one
 * equal to the examples' settings schema).
 *
 * The site's settings come from the environment where set (NEXT_PUBLIC_URL, MDX_BASEURL,
 * SOURCECODE_BASEURL, EDIT_BASEURL, BASE_PATH, ...: see `npx @pmndrs/docs build --help`), else from the
 * defaults below. BASE_PATH ('/reflections' for pmndrs.github.io/reflections/, empty on a custom domain)
 * is also where the API and the examples are linked from.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE_DOCS = join(ROOT, 'docs', 'site');
const LEFT_OUT = [join(SITE_DOCS, 'snippets')];

/** docs/SETTINGS.md as an MDX page: no HTML comment, no raw `<` or `{` outside code (MDX would parse them). */
export function settingsPage(markdown: string): string {
    const body = markdown
        .replace(/<!--[\s\S]*?-->\n*/g, '')
        .replace(/^# .*\n+/, '')
        .split(/(`[^`\n]*`)/)
        .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : part.replace(/</g, '&lt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')))
        .join('');
    return `---
title: Settings
description: Every tuning knob, its default, what it trades and what it costs.
nav: 90
---

> [!NOTE]
> This page is generated from \`docs/SETTINGS.md\`, which is generated from the settings schema of the
> tuning bench (\`examples/showcase/bench.html\`, run locally: it needs the denoiser and path tracer checkouts, so it is not on this site). The notes name the work items
> they came from (W-numbers and D-numbers); they are the repository's internal ids, kept so each claim can be traced.

${body}`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) main();

function main(): void {
    const out = resolve(ROOT, process.argv[2] ?? 'docs-site');
    const stage = mkdtempSync(join(tmpdir(), 'reflections-docs-'));
    try {
        const mdx = join(stage, 'docs');
        cpSync(SITE_DOCS, mdx, { recursive: true, filter: (source) => !LEFT_OUT.some((dir) => source === dir || source.startsWith(dir + sep)) });
        mkdirSync(join(mdx, 'reference'), { recursive: true });
        writeFileSync(join(mdx, 'reference', 'settings.mdx'), settingsPage(readFileSync(join(ROOT, 'docs', 'SETTINGS.md'), 'utf8')));

        const env = {
            NEXT_PUBLIC_LIBNAME: '@pmndrs/reflections',
            NEXT_PUBLIC_LIBNAME_SHORT: 'reflections',
            NEXT_PUBLIC_LIBNAME_DOTSUFFIX_LABEL: 'docs',
            NEXT_PUBLIC_LIBNAME_DOTSUFFIX_HREF: 'https://docs.pmnd.rs',
            HOME_REDIRECT: '/getting-started/introduction',
            ICON: '🪞',
            GITHUB: 'https://github.com/pmndrs/reflections',
            SOURCECODE_BASEURL: 'https://github.com/pmndrs/reflections/tree/main',
            EDIT_BASEURL: 'https://github.com/pmndrs/reflections/edit/main/docs/site',
            MDX_BASEURL: 'https://github.com/pmndrs/reflections/raw/main/docs/site',
            ...process.env,
        };
        rmSync(out, { recursive: true, force: true });
        const build = spawnSync('npx', ['-y', '@pmndrs/docs@4', 'build', mdx, out, '--format', 'website'], { stdio: 'inherit', env });
        if (build.status !== 0) process.exit(build.status ?? 1);

        const api = join(ROOT, 'api-docs');
        if (existsSync(api)) {
            cpSync(api, join(out, 'api'), { recursive: true });
            console.log(`docs: API reference copied to ${relative(ROOT, join(out, 'api'))}`);
        }
        console.log(`docs: website in ${relative(ROOT, out) || '.'}`);
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
