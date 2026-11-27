/**
 * The shell every example page mounts: a nav pill (back to the gallery, the breadcrumb, the status, Info, Docs, Source, previous /
 * next in the category) and the info panel with the page's brief from examples/catalog.ts. The panel opens on a visitor's first
 * look at a page (remembered per page in localStorage; without storage it stays closed).
 *
 *     import { mountShell } from '../shell';           // the path from your page
 *     mountShell('probes/box-projection');              // the catalog slug; a corner or 'inline' as the second argument
 *
 * `placement`: a full-window canvas takes a corner (default 'top-left'); a page that flows like a document takes 'inline' (a bar at
 * the top of the body). `?thumb` in the URL mounts nothing (the card images are captured without it, scripts/run-headless.mjs).
 */
import { CATEGORIES, KIND_LABELS, REPOSITORY, SITE_URL, STATUS_LABELS, builtExamples, exampleBySlug, type ExampleEntry } from '../catalog';

declare const __EXAMPLES_SITE__: boolean;

export type ShellPlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'inline';
export interface ShellOptions {
  placement?: ShellPlacement;
  /** Distance from the corner, CSS (default '12px'). */
  inset?: string;
}
export interface Shell {
  entry: ExampleEntry;
  /** Opens or closes the info panel. */
  info(open: boolean): void;
}

const STYLE = `
.rx-nav { position: fixed; z-index: 100000; display: flex; align-items: center; gap: 2px; padding: 4px; max-width: calc(100vw - 24px); box-sizing: border-box;
  background: #0d0f13e6; border: 1px solid #ffffff1a; border-radius: 999px; backdrop-filter: blur(6px);
  font: 13px/1 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #e6e6e6; user-select: none; }
.rx-nav.inline { position: static; margin: 0 0 12px; width: fit-content; }
.rx-nav a, .rx-nav button, .rx-nav .crumb { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0; border-radius: 999px;
  background: none; color: inherit; font: inherit; text-decoration: none; cursor: pointer; white-space: nowrap; }
.rx-nav a:hover, .rx-nav button:hover, .rx-nav a:focus-visible, .rx-nav button:focus-visible { background: #7aa7ff26; color: #7aa7ff; outline: none; }
.rx-nav .logo { padding: 0 6px 0 4px; }
.rx-nav .logo svg { width: 22px; height: 22px; display: block; }
.rx-nav .crumb { color: #9aa0a8; cursor: default; overflow: hidden; text-overflow: ellipsis; }
.rx-nav .crumb b { color: #e6e6e6; font-weight: 600; }
.rx-nav .sep { width: 1px; height: 18px; background: #ffffff1a; margin: 0 2px; }
.rx-nav .status { margin: 0 4px; padding: 1px 8px; border: 1px solid currentColor; border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 16px; }
.rx-nav .status.experimental { color: #ffc35a; }
.rx-nav .status.research { color: #c9a7ff; }
.rx-nav a[aria-disabled=true] { opacity: .35; pointer-events: none; }
.rx-info { position: fixed; z-index: 100000; width: min(420px, calc(100vw - 24px)); max-height: calc(100vh - 80px); overflow: auto; padding: 14px 16px; box-sizing: border-box;
  border-radius: 10px; background: #0d0f13f2; border: 1px solid #ffffff1a; backdrop-filter: blur(6px); color: #e6e6e6; font: 13px/1.55 system-ui, -apple-system, sans-serif; }
.rx-info[hidden] { display: none; }
.rx-info h2 { margin: 0 26px 6px 0; font-size: 15px; }
.rx-info h3 { margin: 10px 0 4px; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #9aa0a8; }
.rx-info p { margin: 0 0 8px; color: #cfd3d8; }
.rx-info ul { margin: 0 0 8px; padding-left: 18px; color: #cfd3d8; }
.rx-info li { margin: 2px 0; }
.rx-info .kind { display: inline-block; margin-left: 8px; padding: 0 7px; border: 1px solid #ffffff40; border-radius: 999px; font-size: 11px; font-weight: 500; vertical-align: 2px; color: #9aa0a8; }
.rx-info .how, .rx-info .note { font-size: 12px; color: #9aa0a8; }
.rx-info code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #7aa7ff; }
.rx-info .close { position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; border: 0; border-radius: 999px; background: none; color: #9aa0a8; font-size: 18px; cursor: pointer; }
.rx-info .close:hover { color: #e6e6e6; background: #ffffff14; }
@media (max-width: 1000px) { .rx-nav .label { display: none; } }
@media (max-width: 760px) { .rx-nav .crumb .cat { display: none; } }
@media (max-width: 520px) { .rx-nav .crumb { display: none; } }
`;

const icon = (path: string): string =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICONS = {
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#1b1e24"/><path d="M6 20h20" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M10 15l6-8 6 8z" fill="#fff"/><path d="M10 25l6 3 6-3" stroke="#fff" stroke-opacity=".45" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  info: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  docs: icon('<path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>'),
  source: icon('<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>'),
  prev: icon('<path d="m15 6-6 6 6 6"/>'),
  next: icon('<path d="m9 6 6 6-6 6"/>'),
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, html?: string): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  if (html !== undefined) node.innerHTML = html;
  return node;
}

/** The catalog's text uses `code` and **bold**: escape it, then render those two. */
function inline(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** The gallery root from this page's place in the catalog: works under any deploy base. */
export function galleryRoot(entry: ExampleEntry): URL {
  return new URL('../'.repeat((entry.path.match(/\//g) ?? []).length) || './', location.href);
}

/** The docs page: next to the gallery in the deployed site; in dev the docs are not served, so the deployed ones. */
export function docsUrl(entry: ExampleEntry): string | undefined {
  if (!entry.docs) return undefined;
  return import.meta.env.DEV ? new URL(entry.docs, SITE_URL).href : new URL(`../${entry.docs}`, galleryRoot(entry)).href;
}

export function mountShell(slug: string, options: ShellOptions = {}): Shell | null {
  const entry = exampleBySlug(slug);
  if (!entry) {
    console.warn(`mountShell: '${slug}' is not in examples/catalog.ts`);
    return null;
  }
  if (new URLSearchParams(location.search).has('thumb')) return null;
  const placement = options.placement ?? 'top-left';
  const inset = options.inset ?? '12px';
  const root = galleryRoot(entry);

  document.head.append(el('style', {}, STYLE));
  const nav = el('nav', { className: `rx-nav${placement === 'inline' ? ' inline' : ''}`, ariaLabel: 'Example navigation' });
  const info = el('aside', { className: 'rx-info', hidden: true, ariaLabel: 'About this example' });
  const [v, h] = placement === 'inline' ? ['top', 'left'] : placement.split('-');
  if (placement !== 'inline') { nav.style[v as 'top' | 'bottom'] = inset; nav.style[h as 'left' | 'right'] = inset; }
  info.style[v as 'top' | 'bottom'] = `calc(${placement === 'inline' ? '0px' : inset} + 48px)`;
  info.style[h as 'left' | 'right'] = inset;

  // nav: home, crumb, status
  nav.append(el('a', { className: 'logo', href: root.href, title: 'All examples', ariaLabel: 'All examples' }, ICONS.logo));
  const crumb = el('span', { className: 'crumb' }, `<span class="cat"></span> <b></b>`);
  crumb.querySelector('.cat')!.textContent = `${CATEGORIES.find((c) => c.id === entry.category)?.title ?? ''} /`;
  crumb.querySelector('b')!.textContent = entry.title;
  nav.append(crumb);
  if (entry.status !== 'stable') nav.append(el('span', { className: `status ${entry.status}`, title: STATUS_LABELS[entry.status].blurb, textContent: STATUS_LABELS[entry.status].label }));
  nav.append(el('span', { className: 'sep' }));

  // the info panel: the brief, then how it works
  const title = el('h2', { textContent: entry.title });
  title.append(el('span', { className: 'kind', textContent: KIND_LABELS[entry.brief.kind] }));
  info.append(title);
  const section = (name: string, node: HTMLElement) => info.append(el('h3', { textContent: name }), node);
  section('What this shows', el('p', {}, inline(entry.brief.shows)));
  section('Try this', el('ul', {}, entry.brief.tryThis.map((t) => `<li>${inline(t)}</li>`).join('')));
  if (entry.brief.compare) section('Compare against', el('p', {}, inline(entry.brief.compare)));
  section('How it works', el('p', { className: 'how' }, inline(entry.description)));
  if (entry.status !== 'stable') info.append(el('p', { className: 'note', textContent: `${STATUS_LABELS[entry.status].label}: ${STATUS_LABELS[entry.status].blurb}` }));
  const close = el('button', { type: 'button', className: 'close', title: 'Close', ariaLabel: 'Close' }, '×');
  info.append(close);

  const infoButton = el('button', { type: 'button', title: 'About this example', ariaExpanded: 'false' }, `${ICONS.info}<span class="label">Info</span>`);
  const setOpen = (open: boolean) => { info.hidden = !open; infoButton.ariaExpanded = String(open); };
  infoButton.addEventListener('click', () => setOpen(info.hidden));
  close.addEventListener('click', () => setOpen(false));
  addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  try {
    const key = `reflections-example-seen:${entry.slug}`;
    if (!localStorage.getItem(key)) { setOpen(true); localStorage.setItem(key, '1'); }
  } catch { /* no storage: closed */ }
  nav.append(infoButton);

  const docs = docsUrl(entry);
  if (docs) nav.append(el('a', { href: docs, title: 'Documentation' }, `${ICONS.docs}<span class="label">Docs</span>`));
  nav.append(el('a', { href: `${REPOSITORY}/tree/main/${entry.source}`, target: '_blank', rel: 'noopener', title: 'Source on GitHub' }, `${ICONS.source}<span class="label">Source</span>`));

  // previous / next among the built pages of this category
  const siblings = builtExamples(typeof __EXAMPLES_SITE__ !== 'undefined' && __EXAMPLES_SITE__).filter((e) => e.category === entry.category);
  const at = siblings.findIndex((e) => e.slug === entry.slug);
  if (siblings.length > 1 && at >= 0) {
    nav.append(el('span', { className: 'sep' }));
    const link = (target: ExampleEntry | undefined, which: 'prev' | 'next') => {
      const a = el('a', { title: target ? `${which === 'prev' ? 'Previous' : 'Next'}: ${target.title}` : '', ariaLabel: which === 'prev' ? 'Previous example' : 'Next example' }, ICONS[which]);
      if (target) a.href = new URL(target.path, root).href;
      else a.setAttribute('aria-disabled', 'true');
      return a;
    };
    nav.append(link(siblings[at - 1], 'prev'), link(siblings[at + 1], 'next'));
  }

  if (placement === 'inline') document.body.prepend(nav);
  else document.body.append(nav);
  document.body.append(info);
  return { entry, info: setOpen };
}
