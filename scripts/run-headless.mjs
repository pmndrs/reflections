#!/usr/bin/env node
// Headless GPU check for the examples (Chrome + WebGPU over CDP, no puppeteer).
//
//   pnpm check                       # starts the examples server if needed, runs every check
//   pnpm check -- --compare <url>    # also diff examples/probes against another build of the same
//                                    # page (e.g. the denoiser repo's three-temporal/reflection-probes.html)
//   pnpm check -- --only scenes      # run one section (probes | bc6h | scenes | regressions | sssr-core | ssr | ssr-rt | probe-core | probe-bench)
//   pnpm check -- --only probes --time-lookup   # probe lookup ms at 1080p, core vs the pre-phase-2 TSL node
//   pnpm check -- --only probe-bench --low-roughness   # D101: lookups between mips, two lod mappings
//   pnpm check -- --probe-bench      # the full probe layout x format bench (minutes); JSON to out/probe-bench.json
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
const probeBenchFull = args.includes('--probe-bench');
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
  // roughnessThreshold is perceptual (D43): the tracer squares it, so every traced pixel has alpha below
  // threshold^2 and every untraced ramp pixel is at or above it (both sides, so a missing or doubled square fails).
  check('sssr: no ray above the roughness threshold (perceptual, squared at the pass)',
    st.maxTracedRoughness < st.thresholdAlpha && st.minUntracedRampRoughness >= st.thresholdAlpha && Math.abs(st.thresholdAlpha - 0.2) < 1e-3,
    `max traced alpha ${st.maxTracedRoughness.toFixed(4)} < ${st.thresholdAlpha.toFixed(4)} <= min untraced ramp alpha ${st.minUntracedRampRoughness.toFixed(4)}`);
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
    // Miss counts are exact only at occupancy 0: with the occupancy exit, which rays share a subgroup
    // depends on atomic append order, so the count varies run to run (as in FFX).
    const m1 = await s.T('window.__p.parity({ minTraversalOccupancy: 0 })');
    const m2 = await s.T('window.__p.parity({ minTraversalOccupancy: 0 })');
    check('sssr: miss count deterministic at occupancy 0', m1.misses[0] === m2.misses[0] && m1.misses[1] === m2.misses[1], `${m1.misses.join(', ')} then ${m2.misses.join(', ')}`);
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
  // 4K, every surface a mirror: more than 65535 x 64 rays, so the intersect args must be 2-D
  // (D601). A 1-D dispatch over the limit is skipped without a validation error: radiance stays 0.
  const uhd = await openPage(`http://127.0.0.1:${PORT}/sssr-core/?w=3840&h=2160&allmirror`);
  pages.push(uhd);
  const su = await uhd.T('window.__p.stats()');
  check('sssr 3840x2160 all-mirror: intersect runs past 65535 x 64 rays', su.rays > 65535 * 64 && su.mirrorHitFraction > 0.5 && su.tiles > 65535,
    `${su.rays} rays, ${su.tiles} tiles, mirror floor hit ${(su.mirrorHitFraction * 100).toFixed(1)}%`);
  uhd.close();
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

/**
 * examples/ssr: the three adapter (ScreenSpaceReflectionsPass + screenSpaceComposite) on every
 * procedural scene: no validation errors, finite outputs, rays traced. mirrorWall: the mirror floor
 * shows the wall (SSR hit colour vs the analytic planar reflection). offscreen: the wall mirror,
 * which reflects what is behind the camera, has low confidence. Both variants; GPU ms at 1080p.
 */
async function ssrChecks(pages) {
  console.log('examples/ssr:');
  for (const variant of ['auto', 'workgroup']) {
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&view=grid${variant === 'workgroup' ? '&variant=workgroup' : ''}`);
    pages.push(p);
    const ids = await p.T('window.__p.scenes()');
    for (const id of variant === 'auto' ? ids : ['mirrorWall', 'offscreen']) {
      const before = results.logs.length;
      const info = await p.T(`window.__p.load(${JSON.stringify(id)})`);
      await p.T('window.__p.step(2)');
      const st = await p.T('window.__p.stats()');
      const fails = [];
      if (st.nonFinite) fails.push(`${st.nonFinite} non-finite px`);
      if (!(st.rays > 0)) fails.push('no rays');
      const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
      if (errs.length) fails.push(errs.slice(0, 2).join(' | '));
      const tag = `ssr ${id} (${st.variant})`;
      check(`${tag}: renders, no validation errors, finite outputs`, fails.length === 0,
        fails.length ? fails.join('; ') : `${info.probes} probe(s), ${st.rays} rays, ${st.misses} misses, mean confidence ${st.meanConfidence.toFixed(3)} on geometry, mirror floor ${st.mirrorFloorConfidence.toFixed(3)}`);
      if (id === 'mirrorWall') {
        const w = st.wall;
        check(`${tag}: mirror floor shows the wall`, w.confidentFraction > 0.6 && w.lumCorrelation > 0.8 && w.hitDistanceMedianRelErr < 0.05,
          `${w.pixels} floor px reflect a visible wall point; ${(w.confidentFraction * 100).toFixed(1)}% with confidence >= 0.9; luminance correlation ${w.lumCorrelation.toFixed(3)}, mean abs rel diff ${w.meanAbsRelative.toFixed(3)}; hit distance median rel err ${w.hitDistanceMedianRelErr.toFixed(4)}`);
        // W9: striping on reflected objects. Before D1000 (FFX's mip-1 surface depth in the hit
        // test) every other column of the cube's reflection was rejected: cube ratio 69, sphere 331;
        // with D1000 and the constant 0.015 thickness: 2.1 and 43 (sphere 79% confident); hybrid (D1001): 1.7, 8.0 (92%).
        const o = st.objects;
        const fmt = (k) => `${k} hf ${o[k].hfReflected.toFixed(3)} vs direct ${o[k].hfDirect.toFixed(4)} (ratio ${o[k].stripeRatio.toFixed(1)}), ${(o[k].confident * 100).toFixed(1)}% of ${o[k].reflectedPixels} px confident`;
        check(`${tag}: reflected sphere and cube not striped`, o.cube.stripeRatio < 4 && o.cube.confident > 0.9 && o.sphere.stripeRatio < 20 && o.sphere.confident > 0.85,
          `${fmt('cube')}; ${fmt('sphere')}`);
        if (variant === 'auto') {
          savePng('ssr-mirrorWall-grid.png', await p.T('window.__p.shot()'));
          await p.T("window.__p.setView('final')");
          savePng('ssr-mirrorWall-final.png', await p.T('window.__p.shot()'));
          await p.T("window.__p.setView('noSSR')");
          savePng('ssr-mirrorWall-noSSR.png', await p.T('window.__p.shot()'));
          await p.T("window.__p.setView('grid')");
        }
      }
      if (id === 'facingMirrors' && variant === 'auto') {
        // W9 (D69 / D1002): a mirror seen in a mirror. Hit colour from this frame's specular-free
        // scene colour is black; last frame's composite ('final') shows the reflection, a bounce per frame.
        await p.T("window.__p.setView('final')");
        const f = {};
        for (const m of ['current', 'lit', 'final']) {
          await p.T(`window.__p.setHitColor('${m}')`);
          await p.T('window.__p.step(6)');
          f[m] = (await p.T('window.__p.stats()')).facing;
          savePng(`ssr-facingMirrors-${m}.png`, await p.T('window.__p.shot()'));
        }
        await p.T("(window.__p.setHitColor('current'), window.__p.setView('grid'))");
        const fm = (k) => `${k}: ${(f[k].black * 100).toFixed(1)}% black, mean lum ${f[k].meanLum.toFixed(3)}`;
        check(`${tag}: mirror seen in a mirror is not black with last frame's colour`, f.current.pixels > 1000 && f.current.black > 0.9 && f.final.black < 0.1 && f.lit.black < 0.1,
          `${f.current.pixels} left-mirror px reflect the right mirror (${(f.current.confident * 100).toFixed(1)}% confident); ${fm('current')}; ${fm('lit')}; ${fm('final')}`);
      }
      if (id === 'offscreen') {
        await p.T("window.__p.setPose('mirror')");
        await p.T('window.__p.step(2)');
        const sm = await p.T('window.__p.stats()');
        check(`${tag}: low confidence where the reflection comes from behind the camera`, sm.facingPanelPixels > 1000 && sm.facingPanelConfidence < 0.1,
          `wall mirror (${sm.facingPanelPixels} px, view 'mirror'): mean confidence ${sm.facingPanelConfidence.toFixed(4)}; floor reflecting above the frame (default view): ${st.mirrorFloorConfidence.toFixed(3)}`);
        if (variant === 'auto') savePng('ssr-offscreen-mirror-grid.png', await p.T('window.__p.shot()'));
      } else if (variant === 'auto' && id !== 'mirrorWall') savePng(`ssr-${id}-grid.png`, await p.T('window.__p.shot()'));
    }
  }
  const big = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&timing&w=1920&h=1080`);
  pages.push(big);
  const t = await big.T('window.__p.time(30)');
  console.log(`  GPU ms ${t.size.join('x')} through the three adapter (${t.variant}, mirrorWall, median of ${t.frames}): ${JSON.stringify(t.ms)}`);
}

/** examples/regressions, stream F2 (SSR / RT and probe-core review). Each check failed before its fix. */
function f2Checks(r) {
  const section = (name) => {
    const s = r[name];
    if (s === undefined) return null;
    if (s.error) { check(`${name}: section ran`, false, s.error.split('\n').slice(0, 3).join(' | ')); return null; }
    return s;
  };
  const h = section('ssrHistory');
  if (h) {
    const f = (x) => `${x.stale}/${x.hits} stale, ${x.current} current`;
    check("ssr hitColor 'history': first frame with an app historySource reads no stale history", h.appFirstFrame.hits > 100 && h.appFirstFrame.stale === 0, f(h.appFirstFrame));
    check("ssr hitColor 'history': resetHistory() with an app historySource reads no stale history",
      h.appSecondFrame.stale > 0.5 * h.appSecondFrame.hits && h.appAfterReset.hits > 100 && h.appAfterReset.stale === 0,
      `second frame (valid history) ${f(h.appSecondFrame)}; after reset ${f(h.appAfterReset)}`);
    check("ssr hitColor 'history' -> 'current' -> 'history' reads no stale lit history",
      h.litWhileStale.stale > 0.5 * h.litWhileStale.hits && h.litCurrent.stale === 0 && h.litBackToHistory.hits > 100 && h.litBackToHistory.stale === 0,
      `while stale ${f(h.litWhileStale)}; current ${f(h.litCurrent)}; back to history ${f(h.litBackToHistory)}`);
    check('ssrHistory: no WebGPU errors', h.gpuErrors.length === 0, h.gpuErrors.slice(0, 2).join(' | '));
  }
  const t = section('rtTiles');
  if (t) {
    // yardstick: independent uniform selection at p = budget / tiles; a fair scheme is at most 4 sd
    // above it in tiles never traced and tiles traced every frame (one-sided: fairer is fine)
    const bound = (e) => e.mean + 4 * e.sd;
    const frameSd = Math.sqrt(t.tilesSeen * t.p * (1 - t.p));
    check(`rt tile cap: budget ${t.budget} over ${t.tilesSeen} tiles is spread fairly over ${t.frames} frames`,
      t.tilesSeen > 500 && t.never <= bound(t.expectNever) && t.every <= bound(t.expectEvery),
      `tiles traced in k of ${t.frames} frames ${JSON.stringify(t.hist)}; never ${t.never} (uniform ${t.expectNever.mean.toFixed(1)} +- ${t.expectNever.sd.toFixed(1)}, bound ${bound(t.expectNever).toFixed(1)}), every frame ${t.every} (uniform ${t.expectEvery.mean.toFixed(1)} +- ${t.expectEvery.sd.toFixed(1)}, bound ${bound(t.expectEvery).toFixed(1)})`);
    check('rt tile cap: the frame budget holds and is used', t.traced.every((x) => x <= t.budget && x >= t.budget - 4 * frameSd),
      `traced per frame ${t.traced.join(' ')} (budget ${t.budget}, floor ${(t.budget - 4 * frameSd).toFixed(0)}), tile caps ${t.tileCaps.join(' ')}`);
    check('rtTiles: no WebGPU errors', t.gpuErrors.length === 0, t.gpuErrors.slice(0, 2).join(' | '));
  }
  const l = section('rtLimits');
  if (l) {
    const d = (a) => a.skipped ?? `${a.threw ? `threw "${a.threw.slice(0, 160)}"` : 'built'}${a.validationError ? `; validation error "${a.validationError.slice(0, 120)}"` : ''}`;
    check(`rt limits: 5-buffer provider + probe fallback throws a clear error (default ${l.limits.maxStorageBuffersPerShaderStage} storage buffers)`,
      !!l.fiveBuffersAndProbes.threw && /maxStorageBuffersPerShaderStage/.test(l.fiveBuffersAndProbes.threw) && /requiredLimits/.test(l.fiveBuffersAndProbes.threw) && !l.fiveBuffersAndProbes.validationError,
      d(l.fiveBuffersAndProbes));
    check(`rt limits: a storage texture in the provider throws a clear error (default ${l.limits.maxStorageTexturesPerShaderStage} storage textures)`,
      !!l.oneStorageTexture.threw && /maxStorageTexturesPerShaderStage/.test(l.oneStorageTexture.threw) && !l.oneStorageTexture.validationError,
      d(l.oneStorageTexture));
    check('rt limits: 4-buffer provider + probe fallback (8) and a raised limit (9) build without errors',
      !l.fourBuffersAndProbes.threw && !l.fourBuffersAndProbes.validationError && (l.raised.skipped !== undefined || (!l.raised.threw && !l.raised.validationError)),
      `4 + probes: ${d(l.fourBuffersAndProbes)}; raised: ${d(l.raised)}`);
  }
  const gf = section('gbufferFirstFrame');
  if (gf) {
    for (const k of ['forward', 'reversed']) {
      check(`gbuffer: the first frame's projection is the one three renders with (${k} depth)`, gf[k].maxDiff < 1e-6,
        `max diff ${gf[k].maxDiff.toExponential(2)}; [10], [14]: first frame ${gf[k].firstFrame.map((v) => v.toFixed(4)).join(' ')}, rendered ${gf[k].rendered.map((v) => v.toFixed(4)).join(' ')}`);
    }
  }
  const pd = section('probeEnvDominant');
  if (pd) {
    // all three read the same cube along the same direction; 1e-3 covers the prefilter's fp16 storage
    const f = (x) => x.toExponential(2);
    check('probes: dominant direction bends the environment sample too (inside, fade band, outside agree)',
      pd.insideVsDominant < 1e-3 && pd.fadeVsDominant < 1e-3 && pd.outsideVsDominant < 1e-3 && pd.plainVsDominant > 0.05,
      `max |diff| vs the environment along the dominant direction: inside ${f(pd.insideVsDominant)}, fade ${f(pd.fadeVsDominant)}, outside ${f(pd.outsideVsDominant)}; plain R vs dominant ${f(pd.plainVsDominant)}`);
  }
  const pi = section('probeIrradiance');
  if (pi) {
    // 16384 directions over a constant capture: the estimate is exact up to fp16 storage (< 1e-3)
    const f = (x) => x.map((v) => v.toFixed(4)).join(' ');
    check('probes: two computeIrradiance() calls in one encoder keep their own slots', pi.err0 < 0.01 && pi.err1 < 0.01,
      `slot 0 L00 ${f(pi.slot0)} (expected ${f(pi.expected0)}, rel err ${pi.err0.toExponential(2)}); slot 1 ${f(pi.slot1)} (expected ${f(pi.expected1)}, rel err ${pi.err1.toExponential(2)})`);
  }
  const ps = section('probeScale');
  if (ps) {
    const m = ps.mirrored, z = ps.zeroScale;
    check('probes: a mirrored parent keeps a positive volume (scale -2, 1, 1)', m.centre > 0.999 && m.inside > 0.999 && m.outside < 1e-6,
      `coverage at the centre ${m.centre.toFixed(3)}, 1.5 along x ${m.inside.toFixed(3)}, 2.5 along x ${m.outside.toFixed(3)}`);
    check('probes: a zero-scale parent gives a zero (disabled) volume', z.centre < 1e-6 && z.near < 1e-6,
      `coverage at the centre ${z.centre.toFixed(3)}, 0.3 off ${z.near.toFixed(3)}`);
  }
  const pz = section('probeSourceSize');
  if (pz) {
    const d = (x) => x.ok ? 'ok' : `"${x.error}"`;
    check(`probes: the documented minimum sourceSize (${pz.documented}) works; below it the error names the minimum`,
      pz.atDocumented.ok && !pz.half.ok && pz.half.error.includes(String(pz.documented)) && !pz.s32.ok && pz.s32.error.includes('64') && pz.s64.ok,
      `${pz.documented}: ${d(pz.atDocumented)}; ${pz.documented / 2}: ${d(pz.half)}; 32: ${d(pz.s32)}; 64: ${d(pz.s64)}`);
  }
  const pr = section('probeRebake');
  if (pr) {
    const f = (x) => x.map((v) => v.toFixed(3)).join(' ');
    // blue / red of the wall a probe captured: red room (A) before, blue room (B) after
    const ratio = (x) => x[2] / Math.max(x[0], 1e-6);
    check('probes: a bake that changes layout and environment lights its captures with the new environment',
      ratio(pr.before) < 0.05 && ratio(pr.after) > 20 && ratio(pr.settled) > 20 && Math.abs(pr.after[2] - pr.settled[2]) <= 0.02 * pr.settled[2],
      `wall seen by probe a (rgb): env A ${f(pr.before)}; after env B + new probe ${f(pr.after)}; next bake ${f(pr.settled)}`);
  }
  const rh = section('rtHistory');
  if (rh) {
    check("rt on-screen reuse ignores inputs.history unless hitColor 'history'", rh.current.onScreen > 100 && rh.current.stale === 0 && rh.history.onScreen > 100 && rh.history.stale > 0.5 * rh.history.onScreen,
      `current: ${rh.current.stale}/${rh.current.onScreen} on-screen hits from history; 'history': ${rh.history.stale}/${rh.history.onScreen}`);
    check("rt hitColor 'history' rejects a wrong-size or missing history like the tracer",
      !!rh.wrongSize.threw && /history/.test(rh.wrongSize.threw) && !rh.wrongSize.validationError && !!rh.missing.threw && !rh.missing.validationError,
      `wrong size: ${rh.wrongSize.threw ?? 'no error'}${rh.wrongSize.validationError ? ` (validation: ${rh.wrongSize.validationError.slice(0, 80)})` : ''}; missing: ${rh.missing.threw ?? 'no error'}`);
    check('rtHistory: no WebGPU errors', rh.gpuErrors.length === 0, rh.gpuErrors.slice(0, 2).join(' | '));
  }
  const rs = section('rtStats');
  if (rs) {
    check('rt readStats() reports the last dispatched frame while an earlier read is pending',
      rs.a.onScreenHits > 0 && rs.b.onScreenHits === 0 && rs.c.onScreenHits > 0,
      `on-screen hits: A (reuse on) ${rs.a.onScreenHits}, B (reuse off, read while A's was pending) ${rs.b.onScreenHits}, C (reuse on) ${rs.c.onScreenHits}`);
    check('rtStats: no WebGPU errors', rs.gpuErrors.length === 0, rs.gpuErrors.slice(0, 2).join(' | '));
  }
}

/** examples/regressions: GPU repros of review bugs (stream F1). Each check failed before its fix. */
async function regressionChecks(pages) {
  console.log('examples/regressions:');
  const p = await openPage(`http://127.0.0.1:${PORT}/regressions/`);
  pages.push(p);
  // `--sections ssrHistory,rtTiles` runs only those page sections (default: all)
  const sections = args.includes('--sections') ? args[args.indexOf('--sections') + 1].split(',') : null;
  const r = await p.T(sections ? `window.__p.run(${JSON.stringify(sections)})` : 'window.__p.run()');
  f2Checks(r);
  if (sections && !sections.includes('gbuffer')) return;
  const g = r.gbuffer, e = (x) => Number(x).toExponential(2);
  check('gbuffer: static scene with instanced, skinned, batched meshes has no motion', g.staticScene.max <= 1e-5,
    `max ${e(g.staticScene.max)}, per column (plain, instanced, skinned, batched) ${g.staticScene.perColumn.map(e).join(' ')}`);
  check('gbuffer: moving one instance moves only it', g.movedInstance.inside > 0 && g.movedInstance.outside === 0 && g.afterMove.max <= 1e-5,
    `${g.movedInstance.inside} px inside, ${g.movedInstance.outside} outside (max ${e(g.movedInstance.outsideMax)}), next frame max ${e(g.afterMove.max)}`);
  check('gbuffer: camera cut + resetHistory() gives no motion', g.cutReset.max === 0 && g.afterCut.max <= 1e-5,
    `max ${e(g.cutReset.max)}, next frame ${e(g.afterCut.max)}`);
  check('gbuffer: two render() calls in one frame = one per frame', g.twoRendersOneFrame.maxDiff < 1e-4 && g.twoRendersOneFrame.nonzero > 0 && g.twoRendersOneFrame.cameraPrevIsLastRender,
    JSON.stringify(g.twoRendersOneFrame));
  check('gbuffer: jittered frames with the unjittered projection have no motion', g.jitter.maxMotion <= 1e-5 && g.jitter.projectionUnjitteredAndJitteredExposed,
    JSON.stringify(g.jitter));
  const m = g.materials;
  check('gbuffer: roughnessNode / metalnessNode reach the G-buffer', Math.abs(m.roughnessNode - 0.25) < 0.01 && Math.abs(m.metalnessNode - 0.75) < 0.01,
    `roughness ${m.roughnessNode.toFixed(3)}, metalness ${m.metalnessNode.toFixed(3)}`);
  check('gbuffer: MeshBasic env reflection stays out of scene colour', m.basicEnvSceneColor.every((v) => Math.abs(v - m.basicExpected) < 0.01),
    `${m.basicEnvSceneColor.map((v) => v.toFixed(4)).join(' ')} (diffuse ${m.basicExpected.toFixed(4)})`);
  check('gbuffer: logarithmicDepthBuffer rejected', g.logDepth.threw && /logarithmic/i.test(g.logDepth.message), g.logDepth.message ?? 'no error');
  check('gbuffer: no WebGPU errors', g.gpuErrors.length === 0, g.gpuErrors.slice(0, 2).join(' | '));
  const b = r.bc6h;
  if (b.supported === false) { console.log('  no texture-compression-bc: bc6h regressions skipped'); return; }
  for (const a of b.anchors) {
    check(`bc6h ${a.name}: no anchor index overflows its slot`, a.twoSubsetAnchorOverflow === 0 && a.oneSubsetAnchorOverflow === 0,
      `two-subset ${a.twoSubsetAnchorOverflow} of ${a.twoSubsetBlocks}, one-subset ${a.oneSubsetAnchorOverflow}; hardware log2 RMSE ${a.hardware.log2Rmse.toFixed(4)}, blocks off by > 1 stop ${a.hardware.blocksOverOneStop} of ${a.hardware.blocks}, non-finite ${a.hardware.nonFinite}`);
  }
  check('bc6h: capped scratch gives the same bits', b.cappedScratch.bytesDiffer === 0, `${b.cappedScratch.bytesDiffer} of ${b.cappedScratch.bytes} bytes differ`);
  const o = b.overBindingLimit;
  check(`bc6h: ${(o.blockBytes / 2 ** 20).toFixed(0)} MiB of blocks on default limits (binding ${(b.limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MiB)`,
    !o.validationError && !o.outOfMemory && o.newUncapturedErrors.length === 0 && o.maxRelErr < 0.02,
    `${o.validationError ?? o.outOfMemory ?? o.newUncapturedErrors[0] ?? 'ok'}; max rel err ${o.maxRelErr.toFixed(4)}`);
}

/**
 * examples/ssr?rt=1: the ray-traced pass over the SSSR miss list (three-mesh-bvh provider).
 *  - the provider agrees with three's CPU raycaster on camera rays (ray oracle);
 *  - offscreen, view 'mirror': the wall mirror shows the wall behind the camera with RT on (confidence,
 *    traced hit distance vs the analytic mirror distance, the emissive bars), and doesn't with RT off;
 *  - GPU ms of the trace pass grows with the miss count (same frame, miss threshold varied);
 *  - traced rays never exceed the per-tile cap or the frame budget.
 */
async function ssrRtChecks(pages) {
  console.log('examples/ssr (?rt=1):');
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&view=grid&rt=1`);
  pages.push(p);
  const before = results.logs.length;
  await p.T("window.__p.load('offscreen')");
  const bvh = await p.T('window.__p.bvh');
  const oracle = await p.T('window.__p.rtOracle(4096)');
  check('rt provider (three-mesh-bvh port) agrees with THREE.Raycaster', oracle.agree / oracle.rays > 0.995 && oracle.gpuOnly + oracle.cpuOnly <= oracle.rays * 0.003,
    `${oracle.agree}/${oracle.rays} agree (${oracle.bothMiss} both miss), gpu-only ${oracle.gpuOnly}, cpu-only ${oracle.cpuOnly}, p99 rel ${oracle.p99Rel.toExponential(1)}, max rel ${oracle.maxRel.toExponential(1)}; BVH ${bvh.meshes} meshes, ${bvh.triangles} tris, ${bvh.buildMs.toFixed(0)} ms`);
  await p.T("window.__p.setPose('mirror')");
  await p.T('window.__p.setRT(false)');
  await p.T('window.__p.step(2)');
  const off = await p.T('window.__p.stats()');
  await p.T('window.__p.setRT(true)');
  await p.T('window.__p.step(2)');
  const on = await p.T('window.__p.stats()');
  const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
  check('rt offscreen: renders, no validation errors, finite outputs', errs.length === 0 && on.nonFinite === 0 && on.rt && on.rt.traced > 0,
    errs.length ? errs.slice(0, 2).join(' | ') : `${on.misses} misses -> ${JSON.stringify(on.rt)}`);
  check('rt offscreen: the wall mirror shows the wall behind the camera with RT on, not off',
    on.facingPanelConfidence > 0.9 && off.facingPanelConfidence < 0.1 && on.panel.hitDistanceMedianRelErr < 0.02 && on.panel.within2pc > 0.8,
    `confidence ${off.facingPanelConfidence.toFixed(3)} -> ${on.facingPanelConfidence.toFixed(3)} over ${on.facingPanelPixels} px; traced hit distance vs analytic: median rel err ${on.panel.hitDistanceMedianRelErr.toExponential(2)}, ${(on.panel.within2pc * 100).toFixed(1)}% of ${on.panel.analyticPixels} px within 2%`);
  check('rt offscreen: the emissive bars behind the camera appear in the mirror', on.panel.brightFraction > 0.02 && off.panel.brightFraction < 0.005,
    `panel px with luminance > 1: ${(off.panel.brightFraction * 100).toFixed(2)}% -> ${(on.panel.brightFraction * 100).toFixed(2)}%; mean panel radiance ${off.panel.meanLuminance.toFixed(3)} -> ${on.panel.meanLuminance.toFixed(3)}`);
  savePng('ssr-rt-offscreen-mirror-grid.png', await p.T('window.__p.shot()'));
  await p.T("window.__p.setView('final')");
  savePng('ssr-rt-offscreen-mirror-final.png', await p.T('window.__p.shot()'));
  await p.T("window.__p.setView('source')");
  savePng('ssr-rt-offscreen-mirror-source.png', await p.T('window.__p.shot()'));
  await p.T("window.__p.setView('grid')");

  // per-tile cap: a budget far below the miss count, two frames so the tile feedback settles
  await p.T('window.__p.setTraceSettings({ maxTracedRaysPerFrame: 3000 })');
  await p.T('window.__p.step(3)');
  const cap = await p.T('window.__p.tileCapCheck()');
  check('rt cap: traced rays never exceed the per-tile cap or the frame budget',
    cap.maxPerTile <= cap.stats.tileCap && cap.traced <= 3000 && cap.capped > 0 && cap.traced === cap.stats.traced && cap.other === 0,
    `${cap.entries} misses: ${cap.traced} traced (budget 3000), ${cap.capped} capped; tile cap ${cap.stats.tileCap} over ${cap.stats.tilesWithMisses} tiles with misses, max traced in a tile ${cap.maxPerTile}, ${cap.tilesTraced} tiles traced`);
  await p.T('window.__p.setTraceSettings({})');
  savePng('ssr-rt-offscreen-capped.png', await p.T('window.__p.shot()'));

  // the other scenes still render with RT on; hit-shading error on traced hits the camera also sees
  for (const id of ['mirrorWall', 'contact', 'moving']) {
    const b = results.logs.length;
    await p.T(`window.__p.load(${JSON.stringify(id)})`);
    await p.T('window.__p.step(2)');
    const st = await p.T('window.__p.stats()');
    const e = results.logs.slice(b).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    const extra = id === 'mirrorWall' ? `; wall: ${(st.wall.confidentFraction * 100).toFixed(1)}% confident, corr ${st.wall.lumCorrelation.toFixed(3)}` : '';
    check(`rt ${id}: renders, finite, no validation errors`, e.length === 0 && st.nonFinite === 0, e.length ? e.slice(0, 2).join(' | ') : `${st.misses} misses -> ${JSON.stringify(st.rt)}${extra}`);
    const hs = await p.T('window.__p.hitShadingError()');
    console.log(`  rt ${id}: hit shading vs on-screen colour over ${hs.pixels} traced hits the camera sees: mean ${hs.meanShaded.toFixed(3)} vs ${hs.meanScreen.toFixed(3)} (ratio ${hs.ratio.toFixed(3)}), mean abs rel ${hs.meanAbsRel.toFixed(3)}`);
  }

  // GPU ms vs miss count at 1080p: the same frame, misses varied with the miss-list threshold
  const big = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&timing&w=1920&h=1080&rt=1&scene=offscreen&pose=mirror`);
  pages.push(big);
  const rows = [];
  for (const thr of [0, 0.3, 0.9, 1.01]) {
    await big.T(`window.__p.setSettings({ missConfidenceThreshold: ${thr} })`);
    const t = await big.T('window.__p.time(20)');
    await big.T('window.__p.step(1)');
    const st = await big.T('window.__p.traceStats()');
    rows.push({ thr, misses: st.misses, traced: st.traced, ms: t.ms['rt trace'] ?? NaN, total: t.ms.total });
  }
  console.log(`  rt GPU ms at 1920x1080 (offscreen 'mirror', median of 20): ${rows.map((r) => `threshold ${r.thr}: ${r.misses} misses, trace ${r.ms?.toFixed(3)} ms (all passes ${r.total?.toFixed(3)})`).join('; ')}`);
  const [r0, , , rN] = rows;
  check('rt GPU ms scales with the miss count', r0.misses === 0 && rN.misses > 10000 && rN.ms > 4 * Math.max(r0.ms, 0.01) && rows.every((r, i) => i === 0 || r.misses >= rows[i - 1].misses),
    rows.map((r) => `${r.misses}: ${r.ms?.toFixed(3)} ms`).join(', '));
}

async function main() {
  setTimeout(() => { console.error('FAILED: timed out'); process.exit(3); }, probeBenchFull ? 3_600_000 : 600_000).unref();
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
      // phase 2: the package's lookup is core WGSL; the pre-phase-2 TSL lookup lives in examples/probes/src/legacy.ts
      for (const seam of ['warp', 'none']) {
        await p.T(`(window.__p.setLookup('legacy-${seam}'), window.__p.capture(), true)`);
        const legacy = await p.T('window.__p.shot()');
        const d = await p.T(`(${IMAGE_STATS})(${JSON.stringify(shots[seam])}, ${JSON.stringify(legacy)})`);
        check(`core lookup matches the pre-phase-2 TSL node ('${seam}')`, d.max <= 1, `mean ${d.mean.toFixed(4)}, max ${d.max} / 255`);
      }
      {
        // the probe grid (every sphere box-projected in its own volume) and the mirror sphere in the doorway
        const scene = (lookup) => p.T(`(async () => { const P = window.__p; P.setLookup('${lookup}'); P.setGrid(true, 0.05); P.setObject('Sphere', [0, 1.4, 1.2], 0); P.capture();
          for (let i = 0; i < 3; i++) await P.shot(); const s = await P.shot(); P.setGrid(false); P.setObject('None'); return s; })()`);
        const core = await scene('warp'), legacy = await scene('legacy-warp');
        savePng('probes-grid-core.png', core);
        const d = await p.T(`(${IMAGE_STATS})(${JSON.stringify(core)}, ${JSON.stringify(legacy)})`);
        check('core lookup matches the pre-phase-2 TSL node (grid + mirror sphere)', d.max <= 1, `mean ${d.mean.toFixed(4)}, max ${d.max} / 255`);
      }
      await p.T("window.__p.setLookup('warp')");

      // probe features (examples/probes/src/checks.ts); each restores the page's state
      const C = (name) => p.T(`window.__p.checks.${name}()`);
      const f = (x, d = 3) => Number(x).toFixed(d);
      const sh = await C('shadows');
      check('bake restores shadow autoUpdate', sh.lights === 2 && sh.autoUpdate, JSON.stringify(sh));
      const po = await C('projectionOffset');
      // the room's walls lie on the projection box's faces, so a few texels flip inside/outside by rounding
      check('projectionOffset = moving the probe with the opposite originOffset', po.same.mean < 0.05 && po.same.over < 0.002,
        `mean ${f(po.same.mean, 4)}, ${f(po.same.over * 100)} % of pixels > 2/255`);
      check('projectionOffset changes the image', po.changed.mean > 0.2, `mean ${f(po.changed.mean)} without the offset`);
      const cov = await C('coverage');
      check('coverage: alpha 0 outside every volume, 1 inside, fade between; rgb 0 outside', cov.alphaErr < 1e-4 && cov.rgbOutside === 0 && cov.lum > 0,
        `alpha ${JSON.stringify(cov.alpha)}, max err ${cov.alphaErr.toExponential(1)}`);
      check('coverage: rgb * alpha equals the vec3 form (black environment)', cov.composeErr < 1e-3, `max rel err ${cov.composeErr.toExponential(1)}`);
      const lo = await C('lookupOptions');
      check("lookup option normal: Lagarde's dominant direction (R at r 0, N at r 1)", lo.dom0 < 1e-4 && lo.dom1 < 1e-4 && lo.lum > 0, `max rel err ${lo.dom0.toExponential(1)}, ${lo.dom1.toExponential(1)}`);
      check("lookup option ao: Lagarde's specular occlusion", lo.so < 1e-3, `max rel err ${lo.so.toExponential(1)}`);
      check('lookup option frameIrradiance: re-fit by k / probe L1 irradiance, clamped', lo.refit < 2e-3 && lo.clampErr < 1e-4 && lo.lum > 0 && lo.ratios.every(Number.isFinite) && lo.slots.every((s) => s >= 0),
        `max rel err ${lo.refit.toExponential(1)} (ratios ${lo.ratios.slice(0, 6).join(' ')} ...), clamp ${lo.clampErr.toExponential(1)}`);
      const rf = await p.T(`(async () => { const P = window.__p; P.setGrid(true, 0.3); P.setLookup('warp'); for (let i = 0; i < 3; i++) await P.shot(); const off = await P.shot();
        P.setRefit(true); for (let i = 0; i < 3; i++) await P.shot(); const on = await P.shot(); P.setRefit(false); P.setGrid(false); return { on, off }; })()`);
      savePng('probes-refit-off.png', rf.off);
      savePng('probes-refit-on.png', rf.on);
      const rs = await p.T(`(${IMAGE_STATS})(${JSON.stringify(rf.on)}, ${JSON.stringify(rf.off)})`);
      check('re-fit with LightProbeGrid renders and changes the image', rs.lum > 10 && rs.mean > 0.5, `lum ${rs.lum.toFixed(1)}, mean diff ${rs.mean.toFixed(2)} / 255`);
      const ck = await C('cacheKey');
      check('two probe sets of equal size keep their own programs', ck.left[0] > 200 && ck.left[2] < 50 && ck.right[2] > 200 && ck.right[0] < 50 && ck.keysDiffer,
        `left ${ck.left}, right ${ck.right}, keys differ ${ck.keysDiffer}`);
      const ts = await C('timeSlice');
      // Residual under heavy GPU load from other processes (W7, HANDOFF): ~0.075 % of pixels, scattered
      // over the point-light highlights of the grid spheres, differ between two renders of the same
      // state (seen at max 75-81 / 255). Not the probes: tolerate up to 0.15 % of pixels. A missing or
      // stale slice changes far more (one slice alone: tens of / 255 over the reflections; a stale
      // shadow map: 0.26 % in one compact patch, density 0.3 in its bounding box, against 0.003 for the
      // residual's scatter; the stress check below catches it).
      const pixels = 960 * 540;
      const residual = (d) => d.max <= 1 || (d.over < 0.0015 && d.box && (d.over * pixels) / ((d.box[2] - d.box[0] + 1) * (d.box[3] - d.box[1] + 1)) < 0.05);
      check('time-sliced bake over 3 calls = full bake', residual(ts.slicedVsFull), `max ${ts.slicedVsFull.max} / 255, ${(ts.slicedVsFull.over * 100).toFixed(3)} % px`);
      if (ts.slicedVsFull.max > 1) { console.log(`  box ${ts.slicedVsFull.box}, ${(ts.slicedVsFull.over * 100).toFixed(3)} % px`); savePng('timeslice-sliced.png', ts.slicedVsFull.a); savePng('timeslice-full.png', ts.slicedVsFull.b); }
      check('one slice alone differs from the full bake', ts.oneVsFull.max > 8, `max ${ts.oneVsFull.max} / 255`);
      const tss = await C('timeSliceStress');
      check('bake slices between renders of one frame: the view keeps its own shadows', tss.failures.every(residual), `max per slice ${tss.max.join(' ')} / 255`);
      for (const f of tss.failures) { console.log(`  slice ${f.slice}: box ${f.box}, ${(f.over * 100).toFixed(3)} % px`); savePng(`slice-${f.slice}-same.png`, f.same); savePng(`slice-${f.slice}-fresh.png`, f.fresh); }
      const ev = await C('environment');
      const n = ev.counts;
      check('environment captured only when it changed', n.noEnvironment === 3 && n.added === 4 && n.unchanged === 3 && n.versionBumped === 4 && n.always === 4 && n.slicedUnchanged === 0 && n.removed === 3,
        JSON.stringify(n));
      check('environment reaches the image, and removing it clears the slot', ev.litVsBefore.mean > 1 && ev.afterVsBefore.max <= 1,
        `lit mean ${f(ev.litVsBefore.mean)}, removed max ${ev.afterVsBefore.max} / 255`);
      const hp = await C('helper');
      check('helper draws world-space influence and projection boxes', hp.children === 9 && hp.boxes === 6 && hp.centreErr < 1e-6, JSON.stringify(hp));

      if (args.includes('--time-bake')) {
        // loop stopped (FREEZE); median ms per bake, 5 bakes per submit-wait, 7 bursts
        for (const res of [128, 256]) {
          const t = await p.T(`window.__p.timeBake(${res})`);
          console.log(`  bake, 3 probes at ${res} px: median ${t.median.toFixed(2)} ms (${t.all.map((x) => x.toFixed(2)).join(' ')})`);
        }
        await p.T('(window.__p.setResolution(128), true)');
      }

      if (args.includes('--time-lookup')) {
        // lookup ms at 1080p, loop stopped: frame time with the probe node minus without it (no IBL),
        // the core lookup and the pre-phase-2 TSL node alternated in one page, grid on (432 spheres)
        const t = await openPage(`http://127.0.0.1:${PORT}/probes/?w=1920&h=1080&grid`);
        pages.push(t);
        await t.T(FREEZE);
        const rows = await t.T(`(async () => {
          const P = window.__p, out = { warp: [], 'legacy-warp': [] };
          for (let k = 0; k < 5; k++) for (const lookup of ['legacy-warp', 'warp']) {
            P.setLookup(lookup); P.setGrid(true, 0.08);
            const on = await P.timeFrames(30, 7); P.setEnvNode(false); const off = await P.timeFrames(30, 7); P.setEnvNode(true);
            out[lookup].push({ on: on.wall, off: off.wall, lookup: on.wall - off.wall });
          }
          return out;
        })()`);
        for (const [k, v] of Object.entries(rows)) {
          const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
          console.log(`  lookup ${k}: frame ${med(v.map((r) => r.on)).toFixed(3)} ms, without IBL ${med(v.map((r) => r.off)).toFixed(3)} ms, lookup ${med(v.map((r) => r.lookup)).toFixed(3)} ms (median of ${v.length}; each ${v.map((r) => r.lookup.toFixed(3)).join(' ')})`);
        }
      }

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

    if (runs('regressions')) await regressionChecks(pages);
    if (runs('scenes')) pages.push(...(await checkScenes()));
    if (runs('sssr-core')) await sssrCoreChecks(pages);
    if (runs('ssr')) await ssrChecks(pages);
    if (runs('ssr-rt')) await ssrRtChecks(pages);

    if (runs('probe-core')) {
      // examples/probe-core: the phase 2 probe core on a bare device (layouts x formats, CPU weights,
      // re-fit, specular occlusion, the SSSR radiance-fallback seam)
      console.log('examples/probe-core:');
      const pc = await openPage(`http://127.0.0.1:${PORT}/probe-core/`);
      pages.push(pc);
      const r = await pc.T('window.__p.run()');
      const L = r.layouts;
      check('probe core: coverage matches the CPU volume weights', L.coverageErr < 1e-5 && L.inside > 0 && L.outside > 0 && L.fade > 0 && L.composeErr === 0,
        `max err ${L.coverageErr.toExponential(2)}; ${L.inside} inside, ${L.fade} in a fade, ${L.outside} outside`);
      for (const l of L.layouts) {
        const name = `${l.layout}${l.size ? '@' + l.size : ''} ${l.format}${l.lodMapping ? ' lod ' + l.lodMapping : ''}`;
        // same captures, same plan: only layout / format error (phase 1: mean <= 1, octa's mirror mip p99 ~20)
        check(`probe core: ${name} agrees with cube-hw rgba16float`, l.full.mean < 2 && Number.isFinite(l.full.max), `mean ${l.full.mean.toFixed(3)}, p99 ${l.full.p99.toFixed(2)}, max ${l.full.max.toFixed(1)} / 255`);
      }
      check('probe core: a constant capture looks up as that constant', r.refit.constErr < 2e-3, `max rel err ${r.refit.constErr.toExponential(2)}`);
      check('probe core: re-fit by 2x the probe L1 irradiance doubles the lookup', r.refit.refitErr < 2e-2, `max rel err ${r.refit.refitErr.toExponential(2)}`);
      check("probe core: Lagarde's specular occlusion", r.refit.soErr < 1e-4, `max err ${r.refit.soErr.toExponential(2)}`);
      check('sssr probe fallback: constant probes = constant fallback (to one f16 step)', r.sssr.constantVsProbes === 0, `${r.sssr.constantVsProbes} px differ`);
      check('sssr probe fallback: structured probes reach the fallback pixels', r.sssr.structuredVsConstant > r.sssr.pixels * 0.05, `${r.sssr.structuredVsConstant} of ${r.sssr.pixels} px`);
      const rt = r.sssr.rt;
      check('rt probe fallback (misses + hit shading): constant probes = constant fallback', rt.stats && rt.stats.hits > 0 && rt.stats.tracedMisses > 0 && rt.constantVsProbes === 0,
        `${rt.constantVsProbes} px differ; ${rt.stats?.hits} hits, ${rt.stats?.tracedMisses} traced misses, trace changed ${rt.changedByTrace} px`);
      check('rt probe fallback: structured probes reach the traced frame', rt.structuredVsConstant > r.sssr.pixels * 0.05 && rt.changedByTrace > 0, `${rt.structuredVsConstant} of ${r.sssr.pixels} px`);
    }

    if (runs('probe-bench')) {
      // examples/probe-bench: smoke run (or the full bench with --probe-bench). Not a numbers gate:
      // it must run without validation errors, and the generic prefilter must match ProbePrefilter.
      console.log(`examples/probe-bench${probeBenchFull ? ' (full)' : ' (smoke)'}:`);
      const pb = await openPage(`http://127.0.0.1:${PORT}/probe-bench/`);
      pages.push(pb);
      const bench = await pb.cdp.evalJs(`window.__p.run(${probeBenchFull ? '' : '{ smoke: true }'}).then((r) => JSON.stringify(r))`).then(JSON.parse).catch(async (e) => {
        console.log((await pb.cdp.evalJs('window.__p.log', false).catch(() => '')).replace(/^/gm, '    '));
        console.log('console:\n  ' + [...new Set(results.logs)].slice(0, 12).join('\n  '));
        throw e;
      });
      if (args.includes('--low-roughness')) {
        // D101 experiment: lookups between roughness mips, r187 lod mapping vs 'alpha' (blend linear in r^2)
        await pb.cdp.evalJs('window.__p.lowRoughness().then((r) => JSON.stringify(r))');
        console.log((await pb.cdp.evalJs('window.__p.log', false)).replace(/^/gm, '    '));
      }
      if (process.env.BENCH_LOG || probeBenchFull) console.log((await pb.cdp.evalJs('window.__p.log', false)).replace(/^/gm, '    '));
      if (probeBenchFull) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'probe-bench.json'), JSON.stringify(bench, null, 1));
        console.log('  saved', path.relative(process.cwd(), path.join(OUT, 'probe-bench.json')), `(${bench.seconds.toFixed(0)} s)`);
      }
      check('probe bench ran every layout', new Set(bench.error.map((e) => e.layout)).size === 4 && bench.lookup.length > 0, `${bench.error.length} error rows, ${bench.lookup.length} lookup rows`);
      check('layout prefilter is bit-identical to ProbePrefilter (cube2d)', bench.parity.every((p) => p.differing === 0), bench.parity.map((p) => `${p.layout}@${p.source}: ${p.differing}`).join(', '));
      check('probe bench errors are finite', bench.error.every((e) => Number.isFinite(e.all.mean) && Number.isFinite(e.all.max)));
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
