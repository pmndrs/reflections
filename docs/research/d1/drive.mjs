// usage: node drive.mjs <url> <expr-file> ; prints JSON result
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [url, file] = process.argv.slice(2);
const userDataDir = path.join(os.tmpdir(), `d1-${Date.now()}-${process.pid}`);
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--use-angle=metal','--enable-unsafe-webgpu','--enable-features=Vulkan','--window-size=1100,900','--remote-debugging-port=0',`--user-data-dir=${userDataDir}`, url], { stdio: 'ignore' });
let port = null;
for (const dl = Date.now() + 30000; port === null && Date.now() < dl; await sleep(100)) { try { port = Number(fs.readFileSync(path.join(userDataDir,'DevToolsActivePort'),'utf8').split('\n')[0]) || null; } catch {} }
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = targets.find((t) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.consoleAPICalled') console.error('console:', m.params.args.map(a=>a.value??a.description).join(' ').slice(0,500)); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
const send = (method, params={}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable');
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0,2000)); return r.result?.result?.value; };
for (let i = 0; i < 240 && !(await ev('!!window.__p')); i++) await sleep(500);
if (process.argv[4]) await ev(process.argv[4]);
try { const out = await ev(`(async () => JSON.stringify(await (${fs.readFileSync(file,'utf8')})))()`); console.log(out); }
catch (e) { console.log('ERR', e.message); }
ws.close(); chrome.kill('SIGKILL');
process.exit(0);
