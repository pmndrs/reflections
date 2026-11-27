/**
 * The gallery (examples/index.html): examples/catalog.ts grouped by category, with the browser's WebGPU support checked against each
 * page's `requires`. Served at `/` by `pnpm examples` and at `<base>/examples/` by the site build. Planned pages stay hidden unless asked.
 */
import { CATEGORIES, EXAMPLES, SITE_URL, STATUS_LABELS, thumbPath, type ExampleEntry } from './catalog';

declare const __EXAMPLES_SITE__: boolean;

const sections = document.getElementById('sections')!;
const showPlanned = document.getElementById('show-planned') as HTMLInputElement;
const counts = document.getElementById('counts')!;
const gpuBox = document.getElementById('gpu')!;

// The docs sit next to the gallery in the deployed site (`../`); the dev server does not serve them, so link the deployed ones.
if (import.meta.env.DEV) {
  (document.getElementById('docs-link') as HTMLAnchorElement).href = SITE_URL;
  (document.getElementById('settings-link') as HTMLAnchorElement).href = new URL('reference/settings', SITE_URL).href;
}

// Card images (`pnpm check -- --only catalog --thumbs` writes them), bundled with hashed URLs.
const THUMBS = import.meta.glob<string>(['./*/thumb.webp', './*/*.thumb.webp', './*/*/thumb.webp', './*/*/*/thumb.webp'], { eager: true, query: '?url', import: 'default' });

const site = __EXAMPLES_SITE__;
const visible = (e: ExampleEntry) => !(site && e.devOnly);
let features: ReadonlySet<string> | null = null;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Placeholder art until a page has a captured thumbnail: shapes over a horizon and their reflections below it, seeded by the slug. */
function placeholder(entry: ExampleEntry): string {
  let seed = hash(entry.slug);
  const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) ^ Math.imul(seed ^ (seed >>> 13), 3266489909)) >>> 0) / 4294967296);
  const hue = (hash(entry.category) % 360 + 200) % 360;
  const horizon = 104;
  const shapes: string[] = [];
  for (let k = 0; k < 5; k++) {
    const x = 30 + rand() * 260, w = 16 + rand() * 46, hgt = 18 + rand() * 60, light = 48 + rand() * 30, c = `hsl(${(hue + k * 23) % 360} 70% ${light.toFixed(0)}%)`;
    const shape = rand() < 0.5 ? `<rect x="${(x - w / 2).toFixed(1)}" y="${(horizon - hgt).toFixed(1)}" width="${w.toFixed(1)}" height="${hgt.toFixed(1)}" rx="2"` : `<circle cx="${x.toFixed(1)}" cy="${(horizon - w / 2).toFixed(1)}" r="${(w / 2).toFixed(1)}"`;
    shapes.push(`${shape} fill="${c}"/>`);
  }
  const id = `g${hash(entry.slug).toString(36)}`;
  return `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 35% 16%)"/><stop offset="1" stop-color="#08090b"/></linearGradient>
    <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".7" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <mask id="${id}m"><rect y="${horizon}" width="320" height="${180 - horizon}" fill="url(#${id}f)"/></mask></defs>
    <rect width="320" height="180" fill="url(#${id})"/>
    <g>${shapes.join('')}</g>
    <g mask="url(#${id}m)" transform="translate(0 ${2 * horizon}) scale(1 -1)">${shapes.join('')}</g>
    <line x1="0" x2="320" y1="${horizon}" y2="${horizon}" stroke="#ffffff22"/>
  </svg>`;
}

function card(entry: ExampleEntry): HTMLElement {
  const missing = (entry.requires ?? []).filter((f) => features && !features.has(f));
  const node = document.createElement(entry.planned ? 'div' : 'a');
  node.className = `card${missing.length ? ' unavailable' : ''}${entry.planned ? ' planned' : ''}`;
  node.id = entry.slug;
  if (node instanceof HTMLAnchorElement) node.href = entry.path;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const url = THUMBS[`./${thumbPath(entry)}`];
  if (url) {
    const img = document.createElement('img');
    img.src = url; img.alt = ''; img.loading = 'lazy';
    thumb.append(img);
  } else thumb.innerHTML = placeholder(entry);
  const badge = entry.planned ? { cls: 'planned', label: 'Planned', title: 'In the plan (docs/EXAMPLES.md), not built yet' }
    : entry.status !== 'stable' ? { cls: entry.status, label: STATUS_LABELS[entry.status].label, title: STATUS_LABELS[entry.status].blurb } : null;
  if (badge) {
    const b = document.createElement('span');
    b.className = `badge ${badge.cls}`; b.textContent = badge.label; b.title = badge.title;
    thumb.append(b);
  }

  const body = document.createElement('div');
  body.className = 'body';
  const h = document.createElement('h3');
  h.textContent = entry.title;
  const p = document.createElement('p');
  p.textContent = entry.summary;
  body.append(h, p);
  if (missing.length) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = `Needs ${missing.join(', ')}, which this browser does not offer.`;
    body.append(warn);
  }
  const tags = document.createElement('div');
  tags.className = 'tags';
  const marks: [string, string][] = [];
  if (entry.network) marks.push(['streams models', 'Loads models from a CDN (locally: pnpm assets)']);
  if (entry.heavy) marks.push(['heavy', 'Heavy on the GPU']);
  if (entry.devOnly) marks.push(['dev only', entry.devOnly]);
  for (const [t, title] of marks) { const s = document.createElement('span'); s.className = 'mark'; s.textContent = t; s.title = title; tags.append(s); }
  for (const t of entry.tags) { const s = document.createElement('span'); s.textContent = t; tags.append(s); }
  body.append(tags);
  node.append(thumb, body);
  return node;
}

function render(): void {
  sections.replaceChildren();
  const shown = EXAMPLES.filter((e) => visible(e) && (showPlanned.checked || !e.planned));
  for (const category of CATEGORIES) {
    const entries = shown.filter((e) => e.category === category.id);
    if (!entries.length) continue;
    const section = document.createElement('section');
    section.className = 'cat';
    section.id = `category-${category.id}`;
    const h = document.createElement('h2');
    h.textContent = category.title;
    const p = document.createElement('p');
    p.textContent = category.blurb;
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.append(...entries.map(card));
    section.append(h, p, grid);
    sections.append(section);
  }
  const built = EXAMPLES.filter((e) => visible(e) && !e.planned).length, planned = EXAMPLES.filter((e) => visible(e) && e.planned).length;
  counts.textContent = `${built} pages${planned ? `, ${planned} more planned` : ''}`;
}

async function checkGpu(): Promise<void> {
  const OPTIONAL = ['subgroups', 'timestamp-query', 'texture-compression-bc', 'shader-f16'] as const;
  if (!('gpu' in navigator)) {
    gpuBox.className = 'gpu bad';
    gpuBox.innerHTML = '<b>No WebGPU in this browser.</b> The examples need Chrome or Edge 113+, Safari 26+, or Firefox 141+ (Windows).';
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter) {
    gpuBox.className = 'gpu bad';
    gpuBox.innerHTML = '<b>WebGPU is present but no GPU adapter is available</b> (a blocklisted driver or hardware acceleration turned off).';
    return;
  }
  features = new Set([...adapter.features].map(String));
  const name = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || 'GPU';
  gpuBox.innerHTML = `<b>WebGPU ready</b> <span></span>${OPTIONAL.map((f) => `<span class="feat ${features!.has(f) ? 'on' : 'off'}">${f}</span>`).join('')}`;
  gpuBox.querySelector('span')!.textContent = name;
  render();
}

try { showPlanned.checked = new URLSearchParams(location.search).has('planned') || localStorage.getItem('reflections-gallery-planned') === '1'; } catch { /* no storage */ }
showPlanned.addEventListener('change', () => {
  try { localStorage.setItem('reflections-gallery-planned', showPlanned.checked ? '1' : '0'); } catch { /* no storage */ }
  render();
});
render();
void checkGpu();

// headless driver (scripts/run-headless.mjs, section `catalog`): what the gallery shows
(window as unknown as { __p: unknown }).__p = {
  cards: () => [...sections.querySelectorAll<HTMLElement>('.card')].map((c) => ({ slug: c.id, href: (c as HTMLAnchorElement).href ?? null, thumb: !!c.querySelector('img') })),
};
