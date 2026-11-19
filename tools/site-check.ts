/**
 * Checks a built site (tools/site-build.ts) the way a visitor meets it: serves the folder, drives
 * headless Chrome with WebGPU over CDP (no puppeteer), and fails on a broken link, a console error,
 * an exception or a WebGPU validation error.
 *
 *     pnpm site:build && pnpm site:check [dir] [--prefix /reflections] [--only showcase]
 *
 *   dir        the built site (default _site)
 *   --prefix   the base path the site was built for (BASE_PATH), served under it
 *   --only     links | docs | examples
 *
 * Needs Chrome ($CHROME overrides the macOS path) and network access (the models load from raw.githubusercontent.com).
 * The port is $REFLECTIONS_PORT (default 5370; worktrees set their own).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dir = resolve(ROOT, args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '_site');
const prefix = (opt('--prefix') ?? '').replace(/\/+$/, '');
const only = opt('--only');
const PORT = Number(process.env.REFLECTIONS_PORT ?? 5370);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
};

// ---- static server ----------------------------------------------------------------------------------
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.hdr': 'application/octet-stream', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
/** The file a URL path serves: the path, path.html (Next's export), or path/index.html. */
function fileFor(urlPath: string): string | null {
  const p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (prefix) { if (p !== prefix && !p.startsWith(prefix + '/')) return null; }
  const rel = p.slice(prefix.length).replace(/^\/+/, '');
  const base = resolve(dir, rel);
  if (!base.startsWith(dir)) return null;
  for (const f of [base, base + '.html', join(base, 'index.html')]) if (existsSync(f) && statSync(f).isFile()) return f;
  return null;
}
const server = createServer((req, res) => {
  const f = fileFor(req.url ?? '/');
  if (!f) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('Content-Type', TYPES[extname(f)] ?? 'application/octet-stream');
  res.end(readFileSync(f));
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
const origin = `http://127.0.0.1:${PORT}${prefix}`;

// ---- links ------------------------------------------------------------------------------------------
function walk(d: string, out: string[] = []): string[] {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.html')) out.push(p);
  }
  return out;
}
function linkCheck() {
  console.log('links:');
  const pages = walk(dir).filter((p) => !p.includes('/api/') && !p.includes('/examples/assets/'));
  const missing = new Map<string, string>();
  let n = 0;
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"#?]+)[^"]*"/g)) {
      const u = m[1];
      if (!u.startsWith('/') || u.startsWith('//')) continue; // external and relative (the examples' own pages are checked by loading them)
      if (page.includes('/examples/') && !u.startsWith(prefix + '/')) continue;
      n++;
      if (!fileFor(u)) missing.set(u, page.slice(dir.length));
    }
  }
  check(`internal links and assets resolve (${n} checked in ${pages.length} pages)`, missing.size === 0, [...missing].slice(0, 8).map(([u, p]) => `${u} (from ${p})`).join('; '));
}

// ---- headless Chrome --------------------------------------------------------------------------------
async function httpJson(url: string) {
  for (const end = Date.now() + 15000; Date.now() < end; await sleep(250)) { try { return await (await fetch(url)).json(); } catch { /* retry */ } }
  throw new Error(`timeout ${url}`);
}
async function openPage(url: string) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'reflections-site-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--window-size=1100,900', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, url], { stdio: 'ignore', detached: true });
  const kill = () => { try { process.kill(-chrome.pid!, 'SIGKILL'); } catch { /* gone */ } try { spawnSync('pkill', ['-9', '-f', userDataDir]); } catch { /* none */ } rmSync(userDataDir, { recursive: true, force: true }); };
  let port: number | null = null;
  for (const end = Date.now() + 30000; port === null && Date.now() < end; await sleep(100)) { try { port = Number(readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null; } catch { /* not yet */ } }
  if (port === null) { kill(); throw new Error('Chrome did not report a DevTools port'); }
  const tab = (await httpJson(`http://127.0.0.1:${port}/json`)).find((t: { type: string }) => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const logs: string[] = [];
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.id !== undefined) { const p = pending.get(msg.id); pending.delete(msg.id); if (p) msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return; }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push(`console.error: ${msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
    if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') logs.push(`log.error: ${msg.params.entry.text.slice(0, 300)} ${msg.params.entry.url ?? ''}`);
  });
  const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression: string) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error'); return r.result.value; };
  await send('Runtime.enable'); await send('Log.enable');
  return { logs, evalJs, close: () => { try { ws.close(); } catch { /* noop */ } kill(); } };
}

async function waitFor(p: { evalJs(e: string): Promise<unknown> }, expr: string, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) { if (await p.evalJs(expr).catch(() => false)) return true; }
  return false;
}

/** A docs page loads and has a heading. */
async function docsChecks() {
  console.log('docs pages:');
  for (const path of ['/', '/getting-started/introduction', '/getting-started/installation', '/concepts/hybrid-resolve', '/guides/troubleshooting', '/reference/settings', '/api/']) {
    const p = await openPage(`${origin}${path}`);
    try {
      const ok = await waitFor(p, "document.readyState === 'complete' && !!document.querySelector('h1, h2, main')", 30000);
      const url = await p.evalJs('location.pathname');
      await sleep(500);
      check(`${path} loads (${url})`, ok && p.logs.length === 0, p.logs.join(' | '));
    } finally { p.close(); }
  }
}

/** The examples on the site render with zero errors; the showcase also has to run the denoiser. */
async function examplesChecks() {
  console.log('examples:');
  const showcase = ['carConcept', 'toyCar', 'chess', 'sponza'];
  for (const scene of showcase) {
    const p = await openPage(`${origin}/examples/showcase/?manual&w=960&h=540&scene=${scene}&rt=1`);
    try {
      const ready = await waitFor(p, '!!window.__p', 240000);
      if (!ready) { check(`showcase ${scene}: ready`, false, (await p.evalJs("document.querySelector('#status')?.textContent").catch(() => '')) + p.logs.join(' | ')); continue; }
      await p.evalJs('window.__p.stop()');
      const info = JSON.parse(await p.evalJs('(async () => JSON.stringify(await window.__p.info()))()'));
      const shot: string = await p.evalJs('window.__p.shot()');
      const lum: number = await p.evalJs(`(async () => { const i = new Image(); i.src = ${JSON.stringify(shot)}; await i.decode(); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, i.width, i.height).data; let s = 0; for (let k = 0; k < d.length; k += 4) s += (d[k] + d[k + 1] + d[k + 2]) / 3; return s / (d.length / 4); })()`);
      check(`showcase ${scene}: renders, denoiser active, no GPU / console errors`, info.gpuErrors === 0 && !!info.denoiser && lum > 8 && p.logs.length === 0, `denoiser=${info.denoiser} lum=${lum.toFixed(1)} bvh=${info.bvh?.kind ?? 'none'} ${p.logs.join(' | ')}`);
    } finally { p.close(); }
  }
  for (const path of ['/examples/', '/examples/ssr/?manual', '/examples/probes/?manual', '/examples/scenes/?manual', '/examples/babylon/?manual']) {
    const p = await openPage(`${origin}${path}`);
    try {
      const ok = await waitFor(p, "document.readyState === 'complete'", 30000);
      if (path !== '/examples/') await waitFor(p, '!!window.__p', 120000);
      await sleep(1000);
      check(`${path} loads without errors`, ok && p.logs.length === 0, p.logs.join(' | '));
    } finally { p.close(); }
  }
}

try {
  if (!only || only === 'links') linkCheck();
  if (!only || only === 'docs') await docsChecks();
  if (!only || only === 'examples') await examplesChecks();
} finally {
  server.close();
}
console.log(failed ? `site: ${failed} check(s) FAILED` : 'site: all checks passed');
process.exit(failed ? 1 : 0);
