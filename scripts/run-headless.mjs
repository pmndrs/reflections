#!/usr/bin/env node
// Headless GPU check for the examples (Chrome + WebGPU over CDP, no puppeteer).
//
//   pnpm check                       # starts the examples server if needed, runs every check
//   pnpm check -- --compare <url>    # also diff examples/probes against another build of the same
//                                    # page (e.g. the denoiser repo's three-temporal/reflection-probes.html)
//
// Screenshots go to ./out/ (or $OUT). Exit code 1 if a check fails.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.REFLECTIONS_PORT ?? 5370); // set per worktree so parallel checks do not collide
const OUT = process.env.OUT ?? path.join(ROOT, 'out');
const args = process.argv.slice(2);
const compareUrl = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = { checks: [], logs: [] };
const check = (name, ok, detail = '') => {
  results.checks.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
};

async function up(url) { try { return (await fetch(url)).ok; } catch { return false; } }

async function httpJson(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try { return await (await fetch(url)).json(); } catch (e) { lastErr = e; await sleep(250); }
  }
  throw lastErr ?? new Error(`timeout ${url}`);
}

function cdpClient(ws, onEvent) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === undefined) { onEvent?.(msg); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval error');
    return r.result.value;
  };
  return { send, evalJs };
}

const savePng = (name, dataUrl) => {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('  saved', path.relative(process.cwd(), file));
};

/** Open `url` in a fresh headless Chrome; resolves once `window.__p` exists. */
async function openPage(url) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu',
    '--enable-features=Vulkan', '--window-size=1100,900', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(os.tmpdir(), `reflections-${Date.now()}-${port}`)}`, url,
  ], { stdio: 'ignore' });
  const targets = await httpJson(`http://127.0.0.1:${port}/json`);
  const tab = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = cdpClient(ws, (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      results.logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') results.logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) results.logs.push(`log.${msg.params.entry.level}: ${msg.params.entry.text.slice(0, 300)}`);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await cdp.evalJs('!!window.__p', false).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) {
    const status = await cdp.evalJs("document.querySelector('#status')?.textContent", false).catch(() => '');
    throw new Error(`page not ready: ${url}\n${status}\n${results.logs.join('\n')}`);
  }
  const T = (expr) => cdp.evalJs(`(async () => JSON.stringify(await (${expr})))()`).then((s) => (s === undefined ? undefined : JSON.parse(s)));
  const close = () => { try { ws.close(); } catch { /* noop */ } chrome.kill('SIGKILL'); };
  return { cdp, T, close };
}

// One fixed frame: loop stopped, no moving object, default camera.
const FREEZE = "(window.__p.stop(), window.__p.setObject('None'), true)";

/** Mean / max abs difference (0-255) and mean luminance of PNG data URLs, decoded in a page. */
const IMAGE_STATS = `async (a, b) => {
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  const A = await px(a); let lum = 0; for (let k = 0; k < A.length; k += 4) lum += (A[k] + A[k + 1] + A[k + 2]) / 3;
  const out = { lum: lum / (A.length / 4) };
  if (b) { const B = await px(b); let s = 0, m = 0; for (let k = 0; k < A.length; k++) { if ((k & 3) === 3) continue; const d = Math.abs(A[k] - B[k]); s += d; if (d > m) m = d; } out.mean = s / (A.length * 0.75); out.max = m; }
  return out;
}`;

async function main() {
  setTimeout(() => { console.error('FAILED: timed out'); process.exit(3); }, 300_000).unref();
  let server = null;
  if (!(await up(`http://127.0.0.1:${PORT}/probes/`))) {
    server = spawn('pnpm', ['exec', 'vite', '--config', 'examples/vite.config.ts'], { cwd: ROOT, stdio: 'ignore', detached: true });
    const deadline = Date.now() + 30_000;
    while (!(await up(`http://127.0.0.1:${PORT}/probes/`)) && Date.now() < deadline) await sleep(300);
  }
  const pages = [];
  try {
    console.log('examples/probes:');
    const p = await openPage(`http://127.0.0.1:${PORT}/probes/`);
    pages.push(p);
    await p.T(FREEZE);
    const info = await p.T('({ revision: window.__p.THREE.REVISION, probes: window.__p.probes.bakedProbes.length, lookup: window.__p.params.lookup })');
    check('probes baked', info.probes === 3, JSON.stringify(info));
    const shots = {};
    for (const lookup of ['warp', 'none', 'hw']) {
      await p.T(`(window.__p.setLookup('${lookup}'), window.__p.capture(), true)`);
      shots[lookup] = await p.T('window.__p.shot()');
      savePng(`probes-${lookup}.png`, shots[lookup]);
    }
    const stats = await p.T(`(${IMAGE_STATS})(${JSON.stringify(shots.warp)}, ${JSON.stringify(shots.hw)})`);
    check('image is lit', stats.lum > 10, `mean luminance ${stats.lum.toFixed(1)}`);
    check("'warp' lookup matches the hardware cube sampler", stats.mean < 1, `mean ${stats.mean.toFixed(3)}, max ${stats.max} / 255`);
    await p.T("window.__p.setLookup('warp')");

    // BC6H encoder smoke check: the hardware-decoded result must be close to the source. Loose
    // bounds that only an encoding bug (garbage blocks) would break; numbers go to the console.
    console.log('examples/bc6h:');
    const b = await openPage(`http://127.0.0.1:${PORT}/bc6h/`);
    pages.push(b);
    const bc = await b.T('window.__p.runAll()');
    check('texture-compression-bc available', bc.supported !== false);
    for (const [k, m] of Object.entries(bc.errors ?? {})) {
      check(`bc6h ${k} decodes close to the source`, m.log2Rmse < 0.3 && m.psnr > 30,
        `log2 RMSE ${m.log2Rmse.toFixed(4)}, log2 max ${m.log2Max.toFixed(3)}, PSNR ${m.psnr.toFixed(2)} dB`);
    }
    for (const [k, t] of Object.entries(bc.timings ?? {})) console.log(`  encode ${k}: GPU ${t.gpuMs?.toFixed(3) ?? 'n/a'} ms, wall ${t.wallMs.toFixed(3)} ms`);
    savePng('bc6h.png', await b.T('window.__p.shot()'));

    if (compareUrl) {
      console.log(`compare with ${compareUrl}:`);
      const o = await openPage(compareUrl);
      pages.push(o);
      await o.T(FREEZE);
      await o.T("(window.__p.setLookup('warp'), window.__p.capture(), true)");
      await p.T('(window.__p.capture(), true)');
      const a = await p.T('window.__p.shot()');
      const b = await o.T('window.__p.shot()');
      savePng('probes-compare.png', b);
      const d = await p.T(`(${IMAGE_STATS})(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
      check('same image as the other build', d.max <= 2, `mean ${d.mean.toFixed(4)}, max ${d.max} / 255`);
    }

    const validation = results.logs.filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
    check('no WebGPU validation errors or exceptions', validation.length === 0, validation.slice(0, 3).join(' | '));
    if (results.logs.length) console.log('console warnings/errors:\n  ' + [...new Set(results.logs)].slice(0, 12).join('\n  '));
  } finally {
    for (const p of pages) p.close();
    if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* noop */ } }
  }
  const failed = results.checks.filter((c) => !c.ok);
  console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nall checks passed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
