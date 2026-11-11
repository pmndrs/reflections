// Minimal CDP driver (copied from scripts/run-headless.mjs openPage) for W39's measurements.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PORT = Number(process.env.REFLECTIONS_PORT ?? 5425);
export const BASE = `http://127.0.0.1:${PORT}`;

async function httpJson(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try { return await (await fetch(url)).json(); } catch (e) { lastErr = e; await sleep(250); }
  }
  throw lastErr ?? new Error(`timeout ${url}`);
}

export async function openPage(url) {
  const userDataDir = path.join(os.tmpdir(), `w39-${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu',
    '--enable-features=Vulkan', '--window-size=1400,1000', '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`, url,
  ], { stdio: 'ignore' });
  let port = null;
  for (const deadline = Date.now() + 30_000; port === null && Date.now() < deadline; await sleep(100)) {
    try { port = Number(fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null; } catch { /* */ }
  }
  const targets = await httpJson(`http://127.0.0.1:${port}/json`);
  const tab = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === undefined) {
      if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
      if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type)) logs.push(`error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval error');
    return r.result.value;
  };
  await send('Runtime.enable');
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await evalJs('!!window.__p && (!window.__p.kit || !!window.__p.kit)', false).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error(`page not ready ${url}\n${logs.join('\n')}`);
  const T = (expr) => evalJs(`(async () => JSON.stringify(await (${expr})))()`).then((s) => (s === undefined ? undefined : JSON.parse(s)));
  const close = () => { try { ws.close(); } catch { /* */ } chrome.kill('SIGKILL'); };
  return { evalJs, T, close, logs };
}

export const savePng = (file, dataUrl) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64')); };
