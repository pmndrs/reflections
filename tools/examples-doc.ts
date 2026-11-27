/**
 * Writes docs/site/getting-started/examples.mdx from examples/catalog.ts, so the docs page and the gallery never disagree.
 *
 *     pnpm docs:examples                 # rewrite the page
 *     node tools/examples-doc.ts --check # exit 1 when the committed page is stale (part of `pnpm docs:check`)
 *
 * `pnpm site:build` runs it before the docs build. Planned pages are left out; pages that are not on the public site (devOnly)
 * are named in one note. Links to the live pages are site-absolute (`/examples/<path>`), like every other docs page; the docs
 * build puts the base path in front.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, EXAMPLES, REPOSITORY, builtExamples, type ExampleEntry } from '../examples/catalog.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PAGE = join(ROOT, 'docs', 'site', 'getting-started', 'examples.mdx');

/** MDX would parse a raw `<` or `{` outside code. */
const mdx = (text: string): string =>
    text
        .split(/(`[^`\n]*`)/)
        .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : part.replace(/</g, '&lt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')))
        .join('');

const live = (e: ExampleEntry): string => `/examples/${e.path}`;
const sourceUrl = (e: ExampleEntry): string => `${REPOSITORY}/${/\.\w+$/.test(e.source) ? 'blob' : 'tree'}/main/${e.source}`;

function card(e: ExampleEntry): string {
    const lines = [`### ${mdx(e.title)}`, '', mdx(e.summary), '', `**What it shows.** ${mdx(e.brief.shows)}`, ''];
    if (e.brief.compare) lines.push(`**Compare.** ${mdx(e.brief.compare)}`, '');
    if (e.brief.tryThis.length) lines.push('**Try this.**', '', ...e.brief.tryThis.map((t) => `- ${mdx(t)}`), '');
    const links = [`[Open the live page](${live(e)})`, `[Source](${sourceUrl(e)})`];
    if (e.docs) links.push(`[Docs](/${e.docs})`);
    lines.push(links.join(' · '), '');
    return lines.join('\n');
}

function labList(entries: ExampleEntry[]): string {
    return entries.map((e) => `- [${mdx(e.title)}](${live(e)}): ${mdx(e.summary)} ([source](${sourceUrl(e)}))`).join('\n') + '\n';
}

export function examplesPage(): string {
    const out = [
        '---',
        'title: Examples',
        'description: Every live example, what it shows and what to compare it against.',
        'nav: 3',
        '---',
        '',
        '> [!NOTE]',
        '> This page is generated from `examples/catalog.ts` by `pnpm docs:examples`. Edit the catalog, not this file.',
        '',
        'The [example gallery](/examples/) has a card for every page below. Each page opens with a short brief: what it shows, what to try and what to switch off to see the plainer way. The examples need a browser with WebGPU.',
        '',
    ];
    const built = builtExamples(true);
    for (const c of CATEGORIES) {
        const entries = built.filter((e) => e.category === c.id);
        if (!entries.length) continue;
        out.push(`## ${c.title}`, '', mdx(c.blurb), '');
        out.push(c.id === 'lab' ? labList(entries) : entries.map(card).join('\n'));
    }
    const dev = EXAMPLES.filter((e) => !e.planned && e.devOnly);
    if (dev.length) {
        out.push('## Not on the site', '', `${dev.map((e) => `**${mdx(e.title)}**`).join(', ')}: in the repository and the local gallery, left out of the public site (${[...new Set(dev.map((e) => mdx(e.devOnly!)))].join('; ')}).`, '');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const next = examplesPage();
    if (process.argv.includes('--check')) {
        let have = '';
        try {
            have = readFileSync(PAGE, 'utf8');
        } catch {
            /* missing */
        }
        if (have !== next) {
            console.error('docs/site/getting-started/examples.mdx is stale: run `pnpm docs:examples` and commit it.');
            process.exit(1);
        }
        console.log('examples page is current');
    } else {
        writeFileSync(PAGE, next);
        console.log('wrote docs/site/getting-started/examples.mdx');
    }
}
