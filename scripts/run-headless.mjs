#!/usr/bin/env node
// Headless GPU check for the examples (Chrome + WebGPU over CDP, no puppeteer).
//
//   pnpm check                       # starts the examples server if needed, runs every check
//   pnpm check -- --compare <url>    # also diff examples/probes against another build of the same
//                                    # page (e.g. the denoiser repo's three-temporal/reflection-probes.html)
//   pnpm check -- --only scenes      # run one section (probes | bc6h | scenes)
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
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const runs = (section) => !only || only === section;
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

/** examples/sssr-core: subgroup vs workgroup parity, hit fraction on the mirror floor, reverse-Z, GPU ms at 1080p. */
async function sssrCoreChecks(pages) {
  console.log('examples/sssr-core:');
  const s = await openPage(`http://127.0.0.1:${PORT}/sssr-core/`);
  pages.push(s);
  const st = await s.T('window.__p.stats()');
  console.log('  stats', JSON.stringify(st));
  check('sssr: rays traced, denoiser tiles listed', st.rays > 0 && st.tiles > 0, `${st.rays} rays, ${st.tiles} tiles, ${st.misses} misses`);
  check('sssr: sane hit fraction on the mirror floor', st.mirrorHitFraction > 0.5 && st.mirrorHitFraction < 1, `${(st.mirrorHitFraction * 100).toFixed(1)}% of ${st.mirrorPixels} px`);
  check('sssr: no ray above the roughness threshold', st.maxTracedRoughness < 0.2, `max traced alpha ${st.maxTracedRoughness.toFixed(4)}`);
  check('sssr: roughness ramp partly traced', st.rampTracedFraction > 0.2 && st.rampTracedFraction < 0.9, `${(st.rampTracedFraction * 100).toFixed(1)}%`);
  savePng('sssr-core-grid.png', await s.T('window.__p.shot()'));
  const hasSubgroups = await s.T('window.__p.hasSubgroups');
  if (!hasSubgroups) console.log('  device has no subgroups: parity skipped');
  else {
    for (const cfg of [{ minTraversalOccupancy: 0, samplesPerQuad: 1 }, { minTraversalOccupancy: 0, samplesPerQuad: 2 }, { minTraversalOccupancy: 0, samplesPerQuad: 4 }]) {
      const r = await s.T(`window.__p.parity(${JSON.stringify(cfg)})`);
      const tag = `occupancy 0, ${cfg.samplesPerQuad} spq`;
      check(`sssr parity (${tag}): ray, tile, miss lists and tile flags`, r.rayListSame && r.tileListSame && r.missListSame && r.tileFlagsSame,
        `rays ${r.rays}, tiles ${r.tiles}, misses ${r.misses}`);
      check(`sssr parity (${tag}): radiance, hit distance, roughness, pyramid bit for bit`,
        r.radianceDiffPixels === 0 && r.hitDiffPixels === 0 && r.roughnessDiffPixels === 0 && r.pyramidDiffTexels === 0 && r.blueNoiseDiff === 0,
        `differing px: radiance ${r.radianceDiffPixels}, hit ${r.hitDiffPixels}, roughness ${r.roughnessDiffPixels}, pyramid ${r.pyramidDiffTexels}`);
    }
    // Default occupancy (4) counts per subgroup vs per workgroup, so images may differ (D3xx); lists must not.
    const r = await s.T('window.__p.parity({})');
    check('sssr parity (default occupancy): lists', r.rayListSame && r.tileListSame && r.tileFlagsSame, `rays ${r.rays}`);
    console.log(`  default occupancy: radiance differs on ${r.radianceDiffPixels} px, misses ${r.misses.join(' vs ')} (informational)`);
  }
  // Reverse-Z: same scene, max-reduced pyramid; the hit fraction should match the forward-Z page closely.
  const rz = await openPage(`http://127.0.0.1:${PORT}/sssr-core/?reverse`);
  pages.push(rz);
  const sr = await rz.T('window.__p.stats()');
  check('sssr reverse-Z: hit fraction matches forward Z', Math.abs(sr.mirrorHitFraction - st.mirrorHitFraction) < 0.02 && sr.rays === st.rays,
    `${(sr.mirrorHitFraction * 100).toFixed(1)}% vs ${(st.mirrorHitFraction * 100).toFixed(1)}%, rays ${sr.rays} vs ${st.rays}`);
  if (await rz.T('window.__p.hasSubgroups')) {
    const r = await rz.T('window.__p.parity({ minTraversalOccupancy: 0 })');
    check('sssr reverse-Z parity: lists and images', r.rayListSame && r.tileListSame && r.missListSame && r.radianceDiffPixels === 0 && r.hitDiffPixels === 0,
      `radiance ${r.radianceDiffPixels} px`);
  }
  // The radiance-fallback seam with a cube environment in @group(1).
  const env = await openPage(`http://127.0.0.1:${PORT}/sssr-core/?env`);
  pages.push(env);
  const se = await env.T('window.__p.stats()');
  check('sssr cube-environment fallback: same rays and hits', se.rays === st.rays && Math.abs(se.mirrorHitFraction - st.mirrorHitFraction) < 1e-3,
    `rays ${se.rays}, hit ${(se.mirrorHitFraction * 100).toFixed(1)}%`);
  savePng('sssr-core-env.png', await env.T('window.__p.shot()'));
  // GPU ms at 1080p, informational (loop stopped: frames are submitted one at a time).
  const big = await openPage(`http://127.0.0.1:${PORT}/sssr-core/?w=1920&h=1080`);
  pages.push(big);
  const t = await big.T('window.__p.time(30)');
  console.log(`  GPU ms ${t.size.join('x')} (${t.variant}, median of ${t.frames}): ${JSON.stringify(t.ms)}`);
}

/**
 * examples/scenes: every procedural scene (and every downloaded asset scene) renders into the
 * frame-contract G-buffer with no validation errors, and each target holds what the contract says.
 */
async function checkScenes() {
  console.log('examples/scenes:');
  const p = await openPage(`http://127.0.0.1:${PORT}/scenes/?manual&view=grid`);
  const list = await p.T('window.__p.scenes()');
  if (!list.assets.length) console.log('  (no assets downloaded: asset scenes skipped; `pnpm assets` fetches them)');
  for (const id of [...list.procedural, ...list.assets]) {
    const before = results.logs.length;
    const info = await p.T(`window.__p.load(${JSON.stringify(id)})`);
    await p.T('window.__p.step(2)');
    const s = await p.T('window.__p.stats()');
    const procedural = list.procedural.includes(id);
    const lum = (t) => (t.mean[0] + t.mean[1] + t.mean[2]) / 3;
    const fails = [];
    if (!(s.checks.geometry > 0.05)) fails.push(`depth: geometry covers ${(s.checks.geometry * 100).toFixed(1)}%`);
    if (!(s.normalRoughness.nonzero > 0.05)) fails.push('normal empty');
    if (!(s.checks.badNormals < 0.01)) fails.push(`normals not unit on ${(s.checks.badNormals * 100).toFixed(2)}%`);
    if (!(s.normalRoughness.max[3] > 0)) fails.push('roughness all zero');
    if (procedural && !(s.albedoMetalness.max[3] > 0)) fails.push('metalness all zero');
    if (!(s.albedoMetalness.nonzero > 0.05)) fails.push('albedo empty');
    if (!(s.sceneColor.nonzero > 0.05 && lum(s.sceneColor) > 1e-3)) fails.push('scene colour empty');
    if (s.lit && !(lum(s.lit) > 1e-3)) fails.push('lit empty');
    for (const [k, t] of Object.entries(s)) if (t.nan) fails.push(`${k}: ${t.nan} NaN`);
    // static frame: no motion anywhere (up to float noise in the reprojection, ~1e-7 uv)
    const still = Math.max(...s.motion.max.map(Math.abs), ...s.motion.min.map(Math.abs));
    if (still > 1e-5) fails.push(`motion on a still frame (max ${still.toExponential(2)})`);
    // no specular in scene colour: mirror pixels (metal, smooth) have no diffuse, so they're black
    if (s.checks.mirrorPixels > 0.01 && !(s.checks.mirrorSceneColor < 1e-3)) fails.push(`scene colour on mirrors ${s.checks.mirrorSceneColor.toFixed(4)} (specular leaked?)`);
    // camera motion: nudge the camera, the whole frame moves
    await p.T('(window.__p.nudge(0.03, 0.02, 0), true)');
    await p.T('window.__p.step(1)');
    const m = (await p.T('window.__p.stats()')).motion;
    if (!(m.nonzero > s.checks.geometry * 0.5)) fails.push(`camera motion on ${(m.nonzero * 100).toFixed(1)}% of pixels`);
    // object motion (animated scenes): camera still, advance time
    let objectMotion = '';
    if (info.animated) {
      await p.T('window.__p.step(1)');
      await p.T('(window.__p.setTime(0.5), true)');
      await p.T('window.__p.step(1)');
      const mo = (await p.T('window.__p.stats()')).motion;
      objectMotion = `, object motion on ${(mo.nonzero * 100).toFixed(1)}%`;
      if (!(mo.nonzero > 0.001)) fails.push('no object motion');
      await p.T('(window.__p.setTime(0), window.__p.nudge(-0.03, -0.02, 0), true)');
    } else {
      await p.T('(window.__p.nudge(-0.03, -0.02, 0), true)');
    }
    const shot = await p.T('window.__p.shot()');
    savePng(`scenes-${id}.png`, shot);
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    if (errs.length) fails.push(errs.slice(0, 2).join(' | '));
    const detail = `geometry ${(s.checks.geometry * 100).toFixed(0)}%, mirrors ${(s.checks.mirrorPixels * 100).toFixed(1)}% (scene ${s.checks.mirrorSceneColor.toFixed(4)} vs lit ${s.checks.mirrorLit?.toFixed(3) ?? '-'}), camera motion ${(m.nonzero * 100).toFixed(0)}%${objectMotion}`;
    check(`scene ${id}: every target filled per the contract`, fails.length === 0, fails.length ? fails.join('; ') : detail);
  }
  return [p];
}

async function main() {
  setTimeout(() => { console.error('FAILED: timed out'); process.exit(3); }, 600_000).unref();
  let server = null;
  if (!(await up(`http://127.0.0.1:${PORT}/probes/`))) {
    server = spawn('pnpm', ['exec', 'vite', '--config', 'examples/vite.config.ts'], { cwd: ROOT, stdio: 'ignore', detached: true });
    const deadline = Date.now() + 30_000;
    while (!(await up(`http://127.0.0.1:${PORT}/probes/`)) && Date.now() < deadline) await sleep(300);
  }
  const pages = [];
  try {
    if (runs('probes')) {
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
    }

    if (runs('bc6h')) {
      // BC6H encoder smoke check: the hardware-decoded result must be close to the source. Loose
      // bounds that only an encoding bug (garbage blocks) would break; numbers go to the console.
      console.log('examples/bc6h:');
      const b = await openPage(`http://127.0.0.1:${PORT}/bc6h/`);
      pages.push(b);
      const bc = await b.T('window.__p.runAll()');
      check('texture-compression-bc available', bc.supported !== false);
      for (const [k, m] of Object.entries(bc.errors ?? {})) {
        check(`bc6h ${k} decodes close to the source`, m.log2Rmse < 0.3 && m.psnr > 30,
          `log2 RMSE ${m.log2Rmse.toFixed(4)}, log2 max ${m.log2Max.toFixed(3)}, PSNR ${m.psnr.toFixed(2)} dB, per mip ${m.perMipLog2Rmse.map((x) => x.toFixed(3)).join(' ')}`);
      }
      for (const [k, t] of Object.entries(bc.timings ?? {})) console.log(`  encode ${k}: GPU ${t.gpuMs?.toFixed(3) ?? 'n/a'} ms, wall ${t.wallMs.toFixed(3)} ms`);
      savePng('bc6h.png', await b.T('window.__p.shot()'));
    }

    if (runs('scenes')) pages.push(...(await checkScenes()));
    if (runs('sssr-core')) await sssrCoreChecks(pages);

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
