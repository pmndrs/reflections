// W74 drive (copy of W58 / W56 / W55 / W54 / W50's docs/research/w50/scripts/drive.mjs): node drive.mjs <url> <outDir> <jsFile>
// Opens url in headless Chrome (WebGPU), waits for window.__p, runs the async JS body in jsFile
// (it gets `P` = window.__p, `save(name, dataUrl)`, `log(obj)`), saves images as files.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, outDir, jsFile] = process.argv.slice(2);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });
const dir = path.join(os.tmpdir(), `w74-${Date.now()}-${process.pid}`);
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--window-size=1800,1400', '--remote-debugging-port=0', `--user-data-dir=${dir}`, url], { stdio: 'ignore', detached: true });
const kill = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch {} try { spawnSync('pkill', ['-9', '-f', dir]); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on('exit', kill);
for (const s of ['SIGINT', 'SIGTERM', 'SIGALRM']) process.on(s, () => { kill(); process.exit(130); });
let port = null;
for (const end = Date.now() + 30000; !port && Date.now() < end; await sleep(100)) { try { port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null; } catch {} }
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === undefined) {
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (t.startsWith('__save ')) { const [, name, data] = t.split(' '); fs.writeFileSync(path.join(outDir, name), Buffer.from(data.split(',')[1], 'base64')); console.log('saved', name); }
      else if (t.startsWith('__append ')) { const [, name, data] = t.split(' '); fs.appendFileSync(path.join(outDir, name), Buffer.from(data, 'base64')); }
      else if (t.startsWith('__log ')) console.log(t.slice(6));
      else if (['error', 'warning'].includes(m.params.type)) logs.push(t.slice(0, 200));
    }
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception ' + (m.params.exceptionDetails.exception?.description ?? '').slice(0, 300));
    return;
  }
  const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result);
});
const send = (method, params = {}) => new Promise((r, j) => { pend.set(++id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
await send('Runtime.enable');
for (const end = Date.now() + 180000; Date.now() < end; await sleep(500)) { if (await ev('!!window.__p && (window.__p.ready ?? true) && !!(window.__p.kit ?? true)').catch(() => false)) break; }
const body = (process.argv[5] ?? '') + '\n' + fs.readFileSync(jsFile, 'utf8');
try {
  const res = await ev(`(async () => { const P = window.__p; const save = (n, u) => console.log('__save ' + n + ' ' + u); const log = (o) => console.log('__log ' + JSON.stringify(o)); ${body} })()`);
  if (res !== undefined) console.log('result', JSON.stringify(res));
} catch (e) { console.log('ERROR', e.message); }
await sleep(500);
if (logs.length) console.log('page logs:\n' + [...new Set(logs)].slice(0, 15).join('\n'));
ws.close(); kill(); process.exit(0);
