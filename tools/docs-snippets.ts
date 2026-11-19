/**
 * Keeps the docs site's code blocks equal to the type-checked samples in
 * docs/site/snippets/*.ts (`pnpm docs:check` type-checks them: tsconfig.snippets.json).
 * Copied from the bvh repo's tools/docs-snippets.ts.
 *
 *     node tools/docs-snippets.ts           # copy every region into the MDX pages
 *     node tools/docs-snippets.ts --check   # exit 1 if a page differs
 *     node tools/docs-snippets.ts --check --strict   # also fail on a ts block with no marker
 *
 * A sample is a region of a snippet file:
 *
 *     // #region name
 *     ...
 *     // #endregion
 *
 * A name may have several regions in one file (imports at the top, the body in
 * a function); they join with a blank line, each dedented on its own. In a
 * page, the code block right after `{/* snippet: name *\/}` is that sample
 * (`<!-- snippet: name -->` in README.md, which is plain Markdown). Every `ts`
 * code block in a page or the README must have such a marker, so no sample
 * goes unchecked.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DOCS_DIR = join(ROOT, 'docs', 'site');
export const SNIPPETS_DIR = join(DOCS_DIR, 'snippets');
/** Plain Markdown files whose code blocks are samples too. */
export const MARKDOWN_FILES: string[] = [];

export interface Sample {
    readonly name: string;
    readonly file: string;
    readonly code: string;
}

function dedent(lines: readonly string[]): string[] {
    const indents = lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length);
    const cut = indents.length ? Math.min(...indents) : 0;
    return lines.map((line) => line.slice(cut));
}

function trimBlankEdges(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') start++;
    while (end > start && lines[end - 1].trim() === '') end--;
    return lines.slice(start, end);
}

/** Every sample in docs/site/snippets, by name. Throws on an unclosed region or a name used in two files. */
export function collectSamples(dir = SNIPPETS_DIR): Map<string, Sample> {
    const samples = new Map<string, Sample>();
    for (const entry of readdirSync(dir).filter((name) => name.endsWith('.ts')).sort()) {
        const file = join(dir, entry);
        const parts = new Map<string, string[][]>();
        let open: { name: string; lines: string[] } | null = null;
        for (const [at, line] of readFileSync(file, 'utf8').split('\n').entries()) {
            const start = /^\s*\/\/ #region (\S+)\s*$/.exec(line);
            const end = /^\s*\/\/ #endregion\s*$/.test(line);
            if (start) {
                if (open) throw new Error(`${entry}:${at + 1}: region ${start[1]} opens inside region ${open.name}`);
                open = { name: start[1], lines: [] };
            } else if (end) {
                if (!open) throw new Error(`${entry}:${at + 1}: #endregion without a region`);
                const list = parts.get(open.name) ?? [];
                list.push(trimBlankEdges(dedent(open.lines)));
                parts.set(open.name, list);
                open = null;
            } else if (open) {
                open.lines.push(line);
            }
        }
        if (open) throw new Error(`${entry}: region ${open.name} is never closed`);
        for (const [name, list] of parts) {
            const other = samples.get(name);
            if (other) throw new Error(`sample ${name} is in both ${relative(dir, other.file)} and ${entry}`);
            samples.set(name, { name, file, code: list.map((lines) => lines.join('\n')).join('\n\n') });
        }
    }
    return samples;
}

/** Every .mdx page under docs/. */
export function docPages(dir = DOCS_DIR): string[] {
    const pages: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'snippets') pages.push(...docPages(path));
        else if (entry.name.endsWith('.mdx')) pages.push(path);
    }
    return pages.sort();
}

const MARKER = /^(?:\{\/\* snippet: (\S+) \*\/\}|<!-- snippet: (\S+) -->)\s*$/;
const FENCE = /^```(\S*)/;

export interface PageProblem {
    readonly page: string;
    readonly line: number;
    readonly message: string;
}

/**
 * The page with every marked code block replaced by its sample, and what was
 * wrong: unknown samples, marked blocks that differ, and `ts` blocks without
 * a marker.
 */
export function syncPage(page: string, text: string, samples: ReadonlyMap<string, Sample>, strict = false): { text: string; problems: PageProblem[]; used: string[] } {
    const lines = text.split('\n');
    const out: string[] = [];
    const problems: PageProblem[] = [];
    const used: string[] = [];
    let pending: string | null = null;
    for (let at = 0; at < lines.length; at++) {
        const line = lines[at];
        const marker = MARKER.exec(line);
        if (marker) {
            pending = marker[1] ?? marker[2];
            out.push(line);
            continue;
        }
        const fence = FENCE.exec(line);
        if (!fence) {
            out.push(line);
            continue;
        }
        // A code block: find its end.
        let close = at + 1;
        while (close < lines.length && !/^```\s*$/.test(lines[close])) close++;
        if (close >= lines.length) {
            problems.push({ page, line: at + 1, message: 'a code block is never closed' });
            out.push(...lines.slice(at));
            break;
        }
        const body = lines.slice(at + 1, close).join('\n');
        const language = fence[1];
        if (pending !== null) {
            const sample = samples.get(pending);
            if (!sample) {
                problems.push({ page, line: at + 1, message: `no sample named ${pending} in docs/site/snippets` });
                out.push(...lines.slice(at, close + 1));
            } else {
                used.push(pending);
                if (body !== sample.code) problems.push({ page, line: at + 1, message: `the code block differs from sample ${pending} (run pnpm docs:snippets)` });
                out.push(line, sample.code, lines[close]);
            }
        } else {
            if (strict && (language === 'ts' || language === 'typescript' || language === 'js' || language === 'tsx')) {
                problems.push({ page, line: at + 1, message: `a ${language} code block has no {/* snippet: name */} marker` });
            }
            out.push(...lines.slice(at, close + 1));
        }
        pending = null;
        at = close;
    }
    return { text: out.join('\n'), problems, used };
}

/** Syncs (or, with `check`, only checks) every page. Returns the problems left. */
export function syncDocs(check: boolean, strict = false): { problems: PageProblem[]; unused: string[] } {
    const samples = collectSamples();
    const problems: PageProblem[] = [];
    const used = new Set<string>();
    for (const page of [...docPages(), ...MARKDOWN_FILES]) {
        const text = readFileSync(page, 'utf8');
        const result = syncPage(relative(ROOT, page), text, samples, strict);
        result.used.forEach((name) => used.add(name));
        if (check) {
            problems.push(...result.problems);
        } else {
            problems.push(...result.problems.filter((problem) => !problem.message.startsWith('the code block differs')));
            if (result.text !== text) writeFileSync(page, result.text);
        }
    }
    return { problems, unused: [...samples.keys()].filter((name) => !used.has(name)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const check = process.argv.includes('--check');
    const { problems, unused } = syncDocs(check, process.argv.includes('--strict'));
    for (const problem of problems) console.error(`${problem.page}:${problem.line}: ${problem.message}`);
    for (const name of unused) console.error(`sample ${name} is not used by any page`);
    if (problems.length || unused.length) process.exit(1);
    console.log(check ? 'docs: every code block matches its sample' : 'docs: code blocks copied from docs/site/snippets');
}
