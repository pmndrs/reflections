#!/usr/bin/env node
// Headless GPU check for the examples (Chrome + WebGPU over CDP, no puppeteer).
//
//   pnpm check                       # starts the examples server if needed, runs every check
//   pnpm check -- --compare <url>    # also diff examples/probes against another build of the same
//                                    # page (e.g. the denoiser repo's three-temporal/reflection-probes.html)
//   pnpm check -- --only scenes      # run one section (probes | bc6h | scenes | regressions | sssr-core | ssr | hybrid | ssr-rt | babylon | ssr-rt-bvh | pixi3d | probe-core | probe-bench | ssr-bench | showcase | showcase-compare)
//   pnpm check -- --only probes --time-lookup   # probe lookup ms at 1080p: core on the 2D array (warp), core on the cube array, the pre-phase-2 TSL node
//   pnpm check -- --only mirror-bias --mirror-bias   # W32 / D49: mirrorBias noise / bias sweep (minutes), JSON to out/mirror-bias.json
//   pnpm check -- --only seam        # W26 / D53: the SSR-to-probe seam sweep (Lagarde's options off / on), JSON to out/seam.json (SEAM_SHOTS=1: images)
//   pnpm check -- --only probes --probes-layout cube2d   # run the probe feature checks on the 2D array (default: 'auto', a cube array through the shim)
//   pnpm check -- --only probe-bench --low-roughness   # D101: lookups between mips, two lod mappings
//   pnpm check -- --probe-bench      # the full probe layout x format bench (minutes); JSON to out/probe-bench.json
//   pnpm check -- --only ssr-bench --ssr-bench   # the phase 3 gate bench: ours vs three's SSRNode (minutes); JSON to out/ssr-bench.json
//                                    # (--ssr-scenes rooms,mirrorWall to narrow it)
//   pnpm check -- --only ssr-rt --rt-shadow-timing   # D903: GPU ms of hit shadow rays, kit scenes, 960x540 + 1080p (also ssr-rt-bvh)
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
const ssrBenchFull = args.includes('--ssr-bench');
const mirrorBiasFull = args.includes('--mirror-bias'); // W32 (D49): the full mirrorBias noise / bias sweep
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
async function openPage(url, extraArgs = []) {
  // Port 0: Chrome picks a free port and writes it to DevToolsActivePort. A random fixed port could
  // collide with another worktree's Chrome, and then this run drove that run's page (F2).
  const userDataDir = path.join(os.tmpdir(), `reflections-${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu',
    '--enable-features=Vulkan', '--window-size=1100,900', '--remote-debugging-port=0', ...extraArgs,
    `--user-data-dir=${userDataDir}`, url,
  ], { stdio: 'ignore' });
  let port = null;
  for (const deadline = Date.now() + 30_000; port === null && Date.now() < deadline; await sleep(100)) {
    try { port = Number(fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null; } catch { /* not written yet */ }
  }
  if (port === null) throw new Error(`Chrome did not report a DevTools port (${userDataDir})`);
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
  /** Load another URL in the same browser (same profile, so IndexedDB carries over); resolves once its `__p` exists. */
  const navigate = async (next) => {
    await cdp.send('Page.navigate', { url: next });
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      if (await cdp.evalJs(`location.href === ${JSON.stringify(next)} && !!window.__p`, false).catch(() => false)) return;
      await sleep(300);
    }
    const status = await cdp.evalJs("document.querySelector('#status')?.textContent", false).catch(() => '');
    throw new Error(`page not ready: ${next}\n${status}`);
  };
  return { cdp, T, close, navigate };
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
  // fallbackRoughness (D1806): 'surface' takes misses' fallback at the pixel's roughness (the rough-path
  // lookup), 'mirror' is FFX's roughness 0. Mirrors and confidence-1 pixels must not change.
  const fr = await env.T('window.__p.fallbackRoughness()');
  console.log('  fallbackRoughness', JSON.stringify(fr));
  check("sssr fallbackRoughness 'surface': glossy misses at the probe lookup of their own roughness",
    fr.misses > 1000 && fr.missSurface.p99 < 1 && fr.missMirror.mean > fr.missSurface.mean && fr.partialSurface.p99 < 1,
    `misses ${fr.misses}: |radiance - lookup(r)| mean / p99 (/255) mirror ${fr.missMirror.mean} / ${fr.missMirror.p99}, surface ${fr.missSurface.mean} / ${fr.missSurface.p99}; ` +
    `partial confidence ${fr.partials}: mirror ${fr.partialMirror.mean} / ${fr.partialMirror.p99}, surface ${fr.partialSurface.mean} / ${fr.partialSurface.p99}`);
  check("sssr fallbackRoughness 'surface': mirrors and confidence-1 pixels unchanged", fr.mirrors > 1000 && fr.mirrorsDiffer === 0 && fr.confidentDiffer === 0,
    `${fr.mirrorsDiffer} of ${fr.mirrors} mirror px, ${fr.confidentDiffer} of ${fr.confident} confidence-1 px differ`);
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
/**
 * examples/ssr hybrid resolve + denoise seam (phase 5, W10): smoke only. Rooms and mirrorWall with
 * the denoiser on: renders, no validation errors; screenshots of the denoised composite, the raw one,
 * a left-raw / right-denoised split and the source-per-pixel view.
 */
async function hybridChecks(pages) {
  console.log('examples/ssr (hybrid + denoise):');
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=1`);
  pages.push(p);
  const name = await p.T('window.__p.denoiserName');
  check('hybrid: denoiser found', !!name, name ?? 'none (no sibling Denoiser repo): the composite runs the raw signal');
  for (const id of ['rooms', 'mirrorWall', 'explainer']) {
    const before = results.logs.length;
    await p.T(`window.__p.load(${JSON.stringify(id)})`);
    await p.T('window.__p.step(24)');
    for (const v of ['final', 'raw', 'split', 'source', 'confidence']) {
      await p.T(`window.__p.setView(${JSON.stringify(v)})`);
      savePng(`hybrid-${id}-${v}.png`, await p.T('window.__p.shot()'));
    }
    await p.T("window.__p.setView('final')");
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    check(`hybrid ${id}: denoised composite renders, no validation errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
  }
  // W12: mirrorWall 'low', where the floor reflects the wall behind the sphere and screen space
  // can't see it. Those px fall back to the probe; they were dark (the floor sat in the probe box's
  // blend fade at coverage 0.2, the rest a dim environment): hole/wall 0.55, now ~0.8.
  await p.T("window.__p.load('mirrorWall')");
  await p.T("window.__p.setPose('low')");
  await p.T('window.__p.step(24)');
  const shots = {};
  for (const v of ['final', 'noSSR', 'source']) {
    await p.T(`window.__p.setView('${v}')`);
    shots[v] = await p.T('window.__p.shot()');
  }
  await p.T("window.__p.setView('final')");
  savePng('hybrid-mirrorWall-low-final.png', shots.final);
  const hole = await p.T(`(${HOLE_STATS})(${JSON.stringify(shots.final)}, ${JSON.stringify(shots.noSSR)}, ${JSON.stringify(shots.source)})`);
  check('hybrid mirrorWall low: the probe fallback behind the sphere is not dark', hole.px > 500 && hole.final > 0.7 * hole.wall && hole.final > 0.8 * hole.noSSR,
    `${hole.px} fallback px around the sphere's reflection: mean ${hole.final.toFixed(1)} / 255 (probes-only ${hole.noSSR.toFixed(1)}), wall ${hole.wall.toFixed(1)}`);
  // W22: mirrorWall 'lowSphere'. Floor px whose exact reflection hits the sphere (raycast) got the
  // box-projected probe (the wall's cells) for 1 - confidence; the depth-aware blend (D2400) keeps
  // the probe off hits it lies behind. Bounded cost: px whose reflection passes behind the sphere
  // to the wall (the probe was right) get more of the hit. FFX's blend (depth-aware off): sphere
  // probe weight 0.048, behind px hit weight 0.009; on: 0.004, 0.095.
  await p.T("window.__p.setPose('lowSphere')");
  const blend = {};
  for (const on of [false, true]) {
    await p.T(`window.__p.setDepthAware(${on})`);
    await p.T('window.__p.hybrid.resetHistory()');
    await p.T('window.__p.step(16)');
    blend[on] = await p.T('window.__p.blendStats()');
  }
  savePng('hybrid-mirrorWall-lowSphere-final.png', await p.T('window.__p.shot()'));
  const b = blend.true, f = blend.false;
  check('hybrid mirrorWall lowSphere: the probe does not show through the reflected sphere', b.sphere.px > 5000 && b.sphereProbe < 0.02 && b.behindSSR < 0.2,
    `${b.sphere.px} px reflect the sphere: probe weight ${b.sphereProbe.toFixed(3)} (FFX blend ${f.sphereProbe.toFixed(3)}); ${b.behind.px} px reflect the wall behind it: hit weight ${b.behindSSR.toFixed(3)} (FFX ${f.behindSSR.toFixed(3)})`);
  await p.T('window.__p.setDepthAware(true)');
  await seamChecks(p);
}

/**
 * W26 (D53): the SSR-to-probe seam, examples/ssr `seamStats` (8-bit luma step |final - lit| on 8x8
 * blocks of confident glossy hits: the jump the image makes where the hit's weight fades to the
 * probe), with Lagarde's options off and on. The check: glossy mirrorWall (floor r 0.3), distance
 * roughness (the default since W26) narrows the step (W26: 15.87 -> 15.21).
 * `--seam` sweeps scenes, poses, floor roughness and each option alone (the D53 numbers).
 */
const SEAM_MODES = { off: [false, false], dist: [true, false], lerp: [false, true], both: [true, true], 'off again': [false, false] };
async function seamChecks(p, sweep = args.includes('--seam')) {
  const run = async (scene, pose, floor, modes) => {
    await p.T(`window.__p.load(${JSON.stringify(scene)})`);
    if (pose) await p.T(`window.__p.setPose(${JSON.stringify(pose)})`);
    if (floor !== null) await p.T(`window.__p.setFloorRoughness(${floor})`);
    const defaults = await p.T('window.__p.getSeamOptions()');
    const out = {};
    for (const m of modes) {
      const [d, l] = SEAM_MODES[m];
      await p.T(`window.__p.setSeamOptions(${d}, ${l})`);
      out[m] = await p.T(`window.__p.seamStats({ rmin: 0.05, rmax: 0.45, shots: ${!!process.env.SEAM_SHOTS} })`);
      if (out[m].shots) {
        const tag = `seam-${scene}${pose ? '-' + pose : ''}${floor !== null ? '-r' + floor : ''}-${m.replace(' ', '-')}`;
        savePng(`${tag}-final.png`, out[m].shots.final); savePng(`${tag}-lit.png`, out[m].shots.lit);
        delete out[m].shots;
      }
    }
    await p.T(`window.__p.setSeamOptions(${defaults[0]}, ${defaults[1]})`);
    return out;
  };
  const fmt = (r) => Object.entries(r).map(([m, v]) => `${m} ${v.step.toFixed(2)} (bias ${v.bias.toFixed(2)})`).join(', ');
  // `final - lit` at confident hits is w (hit - the composite's probe term), so a change here also
  // shows the composite follows the set's option (lit and composite call one lookup, D1501)
  const r = await run('mirrorWall', null, 0.3, ['off', 'dist']);
  console.log(`  seam mirrorWall floor r 0.3: ${r.off.blocks} blocks, step ${fmt(r)} / 255 luma`);
  check('hybrid seam (D53): glossy mirrorWall floor, distance roughness (the default) narrows the SSR-to-probe step', r.off.blocks > 1000 && r.dist.blocks > 1000 && r.dist.step < r.off.step - 0.2,
    `step off ${r.off.step.toFixed(2)} -> distanceRoughness ${r.dist.step.toFixed(2)} / 255 over ${r.dist.blocks} blocks (run-to-run <= 0.15)`);
  if (!sweep) return;
  const cases = [
    ['mirrorWall', null, 0.1], ['mirrorWall', null, 0.2], ['mirrorWall', null, 0.3], ['mirrorWall', null, 0.4],
    ['mirrorWall', 'low', 0.2], ['contact', null, 0.2], ['contact', 'low', 0.3], ['roughnessRamp', 'strips', null], ['boxRoom', null, 0.25],
  ];
  const all = [];
  for (const [scene, pose, floor] of cases) {
    const res = await run(scene, pose, floor, Object.keys(SEAM_MODES));
    all.push({ scene, pose, floor, res });
    console.log(`  seam ${scene}${pose ? ' ' + pose : ''}${floor !== null ? ` floor r ${floor}` : ''}: ${res.off.blocks} blocks; ${fmt(res)}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'seam.json'), JSON.stringify(all, null, 1));
}

/**
 * W12: mean sRGB (0-255) of `final` and `noSSR` over the probe / environment fallback px (source
 * view orange or magenta) in the box around mirrorWall 'low''s sphere reflection, and of `final` on
 * a patch of the wall above. Boxes in fractions of the frame.
 */
const HOLE_STATS = `async (fin, noSSR, src) => {
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return { w: i.width, h: i.height, d: g.getImageData(0, 0, i.width, i.height).data }; };
  const F = await px(fin), N = await px(noSSR), S = await px(src);
  const { w, h } = F;
  const box = (x0, x1, y0, y1) => [Math.floor(x0 * w), Math.floor(x1 * w), Math.floor(y0 * h), Math.floor(y1 * h)];
  const lum = (d, k) => (d[k] + d[k + 1] + d[k + 2]) / 3;
  let n = 0, f = 0, q = 0;
  const [ax, bx, ay, by] = box(380 / 960, 580 / 960, 300 / 540, 420 / 540);
  for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) {
    const k = (y * w + x) * 4, r = S.d[k], g = S.d[k + 1], b = S.d[k + 2];
    const fallback = (r > 230 && g > 115 && g < 165 && b < 60) || (r > 190 && r < 240 && g < 100 && b > 150);
    if (!fallback) continue;
    n++; f += lum(F.d, k); q += lum(N.d, k);
  }
  let wl = 0, wn = 0;
  const [cx, dx, cy, dy] = box(600 / 960, 800 / 960, 150 / 540, 200 / 540);
  for (let y = cy; y < dy; y++) for (let x = cx; x < dx; x++) { wl += lum(F.d, (y * w + x) * 4); wn++; }
  return { px: n, final: n ? f / n : 0, noSSR: n ? q / n : 0, wall: wl / wn };
}`;

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
        // the hit-colour modes on the screen colour as is (hitShading 'off', W44); then the default re-shade
        for (const m of ['current', 'lit', 'final', 'reshade']) {
          await p.T(m === 'reshade' ? "(window.__p.setSettings({ hitShading: 'reshade' }), window.__p.setHitColor('current'))" : `(window.__p.setSettings({ hitShading: 'off' }), window.__p.setHitColor('${m}'))`);
          await p.T('window.__p.step(6)');
          f[m] = (await p.T('window.__p.stats()')).facing;
          savePng(`ssr-facingMirrors-${m}.png`, await p.T('window.__p.shot()'));
        }
        await p.T("(window.__p.setSettings({ hitShading: 'reshade' }), window.__p.setHitColor('current'), window.__p.setView('grid'))");
        const fm = (k) => `${k}: ${(f[k].black * 100).toFixed(1)}% black, mean lum ${f[k].meanLum.toFixed(3)}`;
        check(`${tag}: mirror seen in a mirror is not black with last frame's colour`, f.current.pixels > 1000 && f.current.black > 0.9 && f.final.black < 0.1 && f.lit.black < 0.1,
          `${f.current.pixels} left-mirror px reflect the right mirror (${(f.current.confident * 100).toFixed(1)}% confident), hitShading 'off'; ${fm('current')}; ${fm('lit')}; ${fm('final')}`);
        // W44 (D3540): with the re-shade, a mirror hit returns its specular along the ray (probes / environment), this frame's colour
        check(`${tag}: mirror seen in a mirror is not black with the re-shade (this frame's colour)`, f.reshade.black < 0.1, `hitShading 'reshade', hitColor 'current': ${fm('reshade')}`);
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
  await mirrorBiasChecks(pages);
  await denoiserGateChecks(pages);
}

/**
 * D1402 (W34): examples/ssr rebuilds the FFX denoiser when the tracer's roughness threshold changes,
 * so its gate follows. At threshold 0.8 on the roughnessRamp strips, the denoiser must change pixels
 * between 0.447 and 0.8 (it passes pixels above its gate through unchanged) and leave those above 0.8.
 */
async function denoiserGateChecks(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=1`);
  pages.push(p);
  if (!(await p.T('window.__p.denoiserName'))) { console.log('  ssr denoiser gate: no denoiser (no sibling Denoiser repo), skipped'); return; }
  await p.T("window.__p.load('roughnessRamp')");
  await p.T("window.__p.setPose('strips')");
  const r = await p.T('window.__p.denoiserGateCheck(0.8)');
  const after = await p.T('window.__p.denoiserGate');
  const b = r.bands;
  const fmt = (k) => `${k} ${(b[k].changed * 100).toFixed(1)}% of ${b[k].px} px`;
  check('ssr denoiser gate follows the roughness threshold (D1402)',
    r.gate === 0.8 && after === 0.447 && b.between.px > 1000 && b.between.changed > 0.5 && b.above.changed < 0.01 && b.glossy.changed > 0.5,
    `threshold 0.8: gate ${r.gate}, denoised (output != input): ${['glossy', 'between', 'above'].map(fmt).join(', ')}; gate back to ${after}`);
}

/**
 * W32 (D49): `settings.mirrorBias`, examples/ssr `mirrorBiasStats` (8-bit luma of the final image,
 * static camera: temporal std, flicker, bias against the mean of many bias-0 frames). The check:
 * the knob is not a silent no-op, 0 is the default path, and 0.5 cuts the raw noise on the
 * roughnessRamp strips (r 0.2-0.4). `--mirror-bias` runs the full sweep (roughnessRamp strips and
 * the mirrorWall floor at r 0.2 / 0.3 / 0.4, bias 0 / 0.25 / 0.5 / 0.75, denoise off and on) into out/mirror-bias.json.
 */
async function mirrorBiasChecks(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0`);
  pages.push(p);
  await p.T("window.__p.load('roughnessRamp')");
  await p.T("window.__p.setPose('strips')");
  // occupancy 0: with the occupancy exit, which rays share a subgroup (atomic list order) changes the output run to run (D301)
  await p.T('window.__p.setSettings({ minTraversalOccupancy: 0, temporalVarianceGuidedTracing: false })');
  await p.T('window.__p.step(4)');
  const h = {};
  for (const [k, b] of [['unset', null], ['unset again', null], ['0', 0], ['0.5', 0.5]]) {
    await p.T(b === null ? '(delete window.__p.ssr.settings.mirrorBias, true)' : `window.__p.setSettings({ mirrorBias: ${b} })`);
    h[k] = await p.T('window.__p.radianceHash(7)');
  }
  await p.T('(["mirrorBias", "minTraversalOccupancy", "temporalVarianceGuidedTracing"].forEach((k) => delete window.__p.ssr.settings[k]), true)');
  check('ssr mirrorBias: 0 is the default path, 0.5 changes the rays', h.unset === h['unset again'] && h.unset === h['0'] && h['0'] !== h['0.5'], JSON.stringify(h));
  const q = await p.T('window.__p.mirrorBiasStats({ biases: [0, 0.5], bins: [0.2, 0.3, 0.4], frames: 16, refFrames: 32, denoise: [false] })');
  const [b0, b5] = q.results;
  const ratio = b0.bins.map((b, k) => b5.bins[k].std / b.std);
  check('ssr mirrorBias 0.5: less raw noise on the roughnessRamp strips (r 0.2-0.4)', ratio.every((r) => r < 0.9) && b0.bins.every((b) => b.px > 1000),
    b0.bins.map((b, k) => `r ${b.roughness}: std ${b.std.toFixed(2)} -> ${b5.bins[k].std.toFixed(2)} (${b.px} px)`).join('; '));
  if (!mirrorBiasFull) return;
  const all = [];
  const cases = [
    { scene: 'roughnessRamp', pose: 'strips', bins: [0.1, 0.2, 0.3, 0.4] },
    ...[0.2, 0.3, 0.4].map((r) => ({ scene: 'mirrorWall', pose: 'default', floor: r, bins: [r] })),
  ];
  const p2 = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=1`);
  pages.push(p2);
  for (const c of cases) {
    await p2.T(`window.__p.load('${c.scene}')`);
    await p2.T(`window.__p.setPose('${c.pose}')`);
    if (c.floor !== undefined) await p2.T(`window.__p.setFloorRoughness(${c.floor})`);
    const r = await p2.T(`window.__p.mirrorBiasStats({ bins: ${JSON.stringify(c.bins)} })`);
    all.push({ ...c, ...r });
    console.log(`  mirrorBias ${c.scene}${c.floor !== undefined ? ` floor r ${c.floor}` : ''} (${r.seconds.toFixed(0)} s, ${r.frames} frames vs a ${r.refFrames}-frame bias-0 raw reference; 8-bit luma):`);
    for (const row of r.results) {
      console.log(`    denoise ${row.denoise ? 'on ' : 'off'} bias ${row.mirrorBias.toFixed(2)}: ${row.bins.map((b) => `r ${b.roughness} std ${b.std.toFixed(2)} flicker ${b.flicker.toFixed(2)} bias ${b.bias.toFixed(2)} (signed ${b.signed.toFixed(2)}, added ${b.added?.toFixed(2) ?? '-'}) rmse ${b.rmse.toFixed(2)}`).join(' | ')}`);
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'mirror-bias.json'), JSON.stringify(all, null, 1));
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
  const hz = section('hiZLimits');
  if (hz) {
    const f = (x) => `${x.mips} mips: ${x.differ} texels differ between devices, copy ${x.copyDiffer}, vs CPU fold ${x.oracleDiffer}; odd footprints change ${x.oddWider} texels vs a plain 2x2`;
    for (const k of ['forward', 'reverse']) {
      check(`depth pyramid (${k} Z, 1917x1079): same on ${hz.storageTextures[0]} and ${hz.storageTextures[1]} storage textures per stage; mip 0 a copy; mips = CPU fold incl. odd rows/columns`,
        hz[k].differ === 0 && hz[k].copyDiffer === 0 && hz[k].oracleDiffer === 0 && hz[k].oddWider > 0 && hz.errors.length === 0, `${f(hz[k])}${hz.errors.length ? `; ${hz.errors[0]}` : ''}`);
    }
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
  // W27 (D603): the composite's specular swap vs three's own term (examples/regressions/src/swap.ts)
  const sw = section('specularSwap');
  if (sw) {
    const fmt = (m) => `blend ${m.blend.mean}/${m.blend.p99}/${m.blend.max} (lin ${m.blend.meanLinear} of T ${m.blend.meanT}), full ${m.full.mean}/${m.full.p99}/${m.full.max}`;
    const R = sw.results;
    const c0 = Object.values(R).flatMap((v) => Object.values(v).map((m) => m.c0Max));
    check('specular swap: confidence 0 gives lit exactly (every term)', sw.litMismatch < 20 && c0.every((x) => x === 0), `max |final - lit| ${Math.max(...c0)}, mask mismatch ${sw.litMismatch} px`);
    for (const term of Object.keys(R.gbuffer)) {
      const g = R.gbuffer[term], e = R.estimate?.[term], mr = R.materialRoughness?.[term];
      // 8-bit sRGB, mean / p99 / max over the sphere: the halo where SSR blends in (c = 0.5, black hit)
      check(`specular swap: ${term} halo (c 0.5) mean < 0.15, p99 < 1 /255`, g.blend.mean < 0.15 && g.blend.p99 < 1,
        `${sw.specularTarget ? 'G-buffer' : 'estimate (no specular target)'}: ${fmt(g)}${mr ? `; material roughness: ${fmt(mr)}` : ''}${e ? `; estimate: ${fmt(e)}` : ''}`);
    }
    check('specularSwap: no WebGPU errors', sw.gpuErrors.length === 0, sw.gpuErrors.slice(0, 2).join(' | '));
  }
  const sa = section('specularSwapAssets');
  if (sa) {
    const fmt = (m) => `${m.blend.mean}/${m.blend.p99}/${m.blend.max} (${m.blend.px} px)`;
    for (const [id, s] of Object.entries(sa)) {
      if (id === 'gpuErrors') continue;
      if (s.skipped) { console.log(`  specular swap ${id}: skipped (${s.skipped})`); continue; }
      const g = s.results.gbuffer, e = s.results.estimate;
      const parts = ['inScope', 'specularOrIor', 'aoMap', 'outOfScope', 'all'].map((k) => `${k} ${fmt(g[k])}${e ? ` [estimate ${fmt(e[k])}]` : ''}`);
      check(`specular swap ${id}: confidence 0 gives lit exactly; in-scope halo (c 0.5) mean < 0.25 /255`, g.all.c0Max === 0 && g.inScope.blend.mean < 0.25,
        `census ${JSON.stringify(s.census)}; blend mean/p99/max: ${parts.join('; ')}`);
    }
    check('specularSwapAssets: no WebGPU errors', sa.gpuErrors.length === 0, sa.gpuErrors.slice(0, 2).join(' | '));
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
  const tr = g.transmission;
  if (tr.skipped) console.log(`  gbuffer transmission: skipped (${tr.skipped})`);
  else check('gbuffer: glass refracts the metal behind it into lit as a plain render does (W42, D3520)',
    tr.plain[0] > 0.1 && tr.lit.every((v, c) => Math.abs(v - tr.plain[c]) <= 0.02 * tr.plain[c] + 1e-3),
    `centre rgb lit ${tr.lit.map((v) => v.toFixed(4)).join(' ')}, plain ${tr.plain.map((v) => v.toFixed(4)).join(' ')}`);
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
/** D903: the provider's any-hit walk (`traceAny`) agrees with its own first-hit walk, camera + scene rays. */
async function rtAnyHitChecks(p, label) {
  for (const kind of ['camera', 'scene']) {
    const a = await p.T(`window.__p.rtAnyHitOracle(4096, '${kind}')`);
    check(`rt ${label}: traceAny agrees with traceFirstHit, ${kind} rays`,
      a.agree === a.rays && a.nearOk >= a.positive * 0.999 && a.farOk >= a.positive * 0.999,
      `hit/miss ${a.agree}/${a.rays} (${a.hits} hits); nothing before 0.5 t ${a.nearOk}/${a.positive}, something before 1.5 t ${a.farOk}/${a.positive}`);
  }
}

/**
 * D1700 (W28): the provider's shading normal (`traceHitShadingNormal`) against three's interpolated
 * `intersection.normal` on the same rays (contact: a 6-sided cone, a sphere, a torus, a cylinder);
 * the flat geometric normal's mean angle to it is what the shading normal removes.
 */
async function rtShadingNormalChecks(p, label) {
  for (const kind of ['camera', 'scene']) {
    const o = await p.T(`window.__p.rtOracle(4096, '${kind}')`);
    const s = o.shading;
    check(`rt ${label}: shading normal = three's interpolated normal, contact, ${kind} rays (D1700)`, s.capability && s.compared > 0 && s.agree >= s.compared * 0.995,
      `${s.agree}/${s.compared} hits within cos 0.999, mean ${s.meanDeg.toExponential(1)} deg (flat geometric normal: mean ${s.flatMeanDeg.toFixed(3)} deg)`);
  }
}

/**
 * D903: hit shading vs the on-screen colour of the same hits, shadow rays off and on (one
 * reference frame, both shadings on the same rays). A shadow ray can only darken a hit.
 */
async function rtHitShadingLines(p, id) {
  const fmt = (hs) => `mean ${hs.meanShaded.toFixed(3)} vs ${hs.meanScreen.toFixed(3)} (ratio ${hs.ratio.toFixed(3)}), mean abs rel ${hs.meanAbsRel.toFixed(3)}`;
  // off, on, off again: the second 'off' is the frame-to-frame noise of this per-pixel comparison
  // (not zero with reuse off on 'contact'); information, the check is on the shaded hits below
  const hs = await p.T('window.__p.hitShadingError({ hitSpecular: false }, [{ hitShadows: false }, { hitShadows: true }, { hitShadows: false }])');
  const [off, on, again] = hs.variants;
  console.log(`  rt ${id}: hit shading vs on-screen colour over ${on.pixels} traced hits the camera sees: shadows off ${fmt(off)}; on ${fmt(on)}; `
    + `> 1% darker with shadows ${(on.darker * 100).toFixed(1)}% (off vs off ${(again.darker * 100).toFixed(1)}%), brighter ${(on.brighter * 100).toFixed(2)}% (off vs off ${(again.brighter * 100).toFixed(2)}%)`);
  // the hits the hit shading shades this frame (reuse on): deterministic, a shadow ray can only darken
  const fx = await p.T('window.__p.rtShadowEffect()');
  check(`rt ${id}: shadow rays only darken shaded hits (D903)`, fx.on.pixels > 0 && fx.noise.darker + fx.noise.brighter < 0.001 && fx.on.brighter < 0.001 && fx.on.mean <= fx.on.meanOff + 1e-6,
    `${fx.on.pixels} shaded hits: ${(fx.on.darker * 100).toFixed(1)}% > 1% darker, ${(fx.on.brighter * 100).toFixed(2)}% brighter (same rays twice without shadows: ${(fx.noise.darker * 100).toFixed(2)}% / ${(fx.noise.brighter * 100).toFixed(2)}%); mean ${fx.on.meanOff.toFixed(3)} -> ${fx.on.mean.toFixed(3)}`);
  // D901 (W28): the kit scenes are lit by their probes (scene.environmentNode), so traced hits are
  // too; the environment mean (no bounce from the lit room) read 0.67-0.91x. Shadows on for both.
  await p.T('window.__p.setHitProbes(false)'); await p.T('window.__p.step(2)'); // rebuilds the traced pass
  // the on-screen colour (hitColor 'current') has no specular: compare the diffuse part (W41, D3510)
  const env = await p.T('window.__p.hitShadingError({ hitSpecular: false })');
  await p.T('window.__p.setHitProbes(true)'); await p.T('window.__p.step(2)');
  check(`rt ${id}: traced hits lit by the probes at the hit match the on-screen brightness (D901)`,
    hs.source === 'probes' && env.source === 'environment' && Math.abs(1 - on.ratio) <= 0.1 && Math.abs(1 - on.ratio) < Math.abs(1 - env.ratio),
    `${hs.source}: ${fmt(on)}; environment mean: ${fmt(env)}`);
  return { on, off, fx, env };
}

/**
 * D903: GPU ms of the trace pass with shadow rays on vs off, per kit scene, at 960x540 and 1080p
 * (loop stopped, median of 20 frames, alternating off / on twice and averaging). With on-screen
 * reuse (default) only off-screen hits are shaded; 'all shaded' turns reuse off (every hit sends one).
 * Opt-in (`--rt-shadow-timing`): ~2 minutes per provider.
 */
async function rtShadowTiming(label, bvhParam) {
  const scenes = [['offscreen', 'mirror'], ['mirrorWall', ''], ['contact', ''], ['moving', '']];
  const url = (w, h, scene, pose) => `http://127.0.0.1:${PORT}/ssr/?manual&timing&w=${w}&h=${h}&rt=1${bvhParam}&scene=${scene}${pose ? `&pose=${pose}` : ''}`;
  const page = await openPage(url(960, 540, ...scenes[0]));
  for (const [w, h] of [[960, 540], [1920, 1080]]) {
    const parts = [];
    for (const [scene, pose] of scenes) {
      if (!(w === 960 && scene === scenes[0][0])) await page.navigate(url(w, h, scene, pose));
      const row = [];
      for (const reuse of [true, false]) {
        const ms = { on: [], off: [] };
        for (const shadows of [false, true, false, true]) {
          await page.T(`window.__p.setTraceSettings({ hitShadows: ${shadows}, reuseOnScreenHits: ${reuse} })`);
          const t = await page.T('window.__p.time(20)');
          ms[shadows ? 'on' : 'off'].push(t.ms['rt trace'] ?? NaN);
        }
        await page.T('window.__p.step(1)');
        const st = await page.T('window.__p.traceStats()');
        const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
        row.push(`${reuse ? 'reuse' : 'all shaded'} ${(st.hits - st.onScreenHits)} shaded hits: ${mean(ms.off).toFixed(3)} -> ${mean(ms.on).toFixed(3)} ms (+${(mean(ms.on) - mean(ms.off)).toFixed(3)})`);
      }
      parts.push(`${scene}: ${row.join(', ')}`);
    }
    console.log(`  rt ${label} shadow rays, GPU ms of 'rt trace' at ${w}x${h} (off -> on, median of 20, loop stopped): ${parts.join('; ')}`);
  }
  page.close();
}

async function ssrRtChecks(pages) {
  console.log('examples/ssr (?rt=1):');
  // probes at 128 px: the size W25 / W28 measured the hit-shading checks at (the page follows the
  // 256 px default since 443e35d; at 256 contact's D901 ratio reads 1.10 with @pmndrs/bvh, HANDOFF backlog)
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&view=grid&rt=1&probeRes=128`);
  pages.push(p);
  const before = results.logs.length;
  await p.T("window.__p.load('offscreen')");
  const bvh = await p.T('window.__p.bvh');
  const oracle = await p.T('window.__p.rtOracle(4096)');
  check('rt provider (three-mesh-bvh port) agrees with THREE.Raycaster', oracle.agree / oracle.rays > 0.995 && oracle.gpuOnly + oracle.cpuOnly <= oracle.rays * 0.003,
    `${oracle.agree}/${oracle.rays} agree (${oracle.bothMiss} both miss), gpu-only ${oracle.gpuOnly}, cpu-only ${oracle.cpuOnly}, p99 rel ${oracle.p99Rel.toExponential(1)}, max rel ${oracle.maxRel.toExponential(1)}; BVH ${bvh.meshes} meshes, ${bvh.triangles} tris, ${bvh.buildMs.toFixed(0)} ms`);
  await rtAnyHitChecks(p, 'three-mesh-bvh port');
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
    await rtHitShadingLines(p, id);
    if (id === 'contact') await rtShadingNormalChecks(p, 'three-mesh-bvh port');
  }
  if (args.includes('--rt-shadow-timing')) await rtShadowTiming('three-mesh-bvh', '');
  await missFillChecks(pages);

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

/**
 * W37 (D4301): facingMirrors' SSR misses (rays behind an object or off screen) fall back to the
 * probe. Mean abs difference (sRGB 0-255, per channel) of `final` over the miss px (the 'misses'
 * view's red, RT off) against the same frame with the ray-traced fill (`setRT(true)`), per pose and
 * probe bake: `all` = every object captured (main before W37), `kit` = the kit's own exclusions.
 */
const MISS_FILL = `async (poses, variants) => {
  const p = window.__p;
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  const out = {};
  for (const pose of poses) {
    p.setPose(pose);
    p.setRT(false); p.setView('misses'); await p.step(3);
    const M = await px(await p.shot());
    out[pose] = {};
    for (const [name, v] of Object.entries(variants)) {
      await p.rebake(v);
      p.setView('final'); p.setRT(true); await p.step(3);
      const R = await px(await p.shot());
      p.setRT(false); await p.step(3);
      const F = await px(await p.shot());
      let n = 0, d = 0;
      for (let k = 0; k < M.length; k += 4) {
        if (!(M[k] > 200 && M[k + 1] < 80 && M[k + 2] < 80)) continue;
        n++; d += (Math.abs(F[k] - R[k]) + Math.abs(F[k + 1] - R[k + 1]) + Math.abs(F[k + 2] - R[k + 2])) / 3;
      }
      out[pose][name] = { px: n, mad: n ? d / n : 0 };
    }
  }
  p.setView('grid');
  return out;
}`;

async function missFillChecks(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&rt=1&denoise=0&scene=facingMirrors`);
  pages.push(p);
  const r = await p.T(`(${MISS_FILL})(['default', 'left'], { all: { include: true }, kit: {} })`);
  const line = (k) => `${k}: ${r[k].kit.px} miss px, all captured ${r[k].all.mad.toFixed(2)} -> kit ${r[k].kit.mad.toFixed(2)}`;
  check('facingMirrors: the probe fallback in the SSR misses stays near the ray-traced fill (objects out of the captures, D4301)',
    ['default', 'left'].every((k) => r[k].kit.px > 10000 && r[k].kit.mad < MISS_FILL_MAX[k] && r[k].kit.mad < r[k].all.mad - 1),
    `mean abs diff / 255 vs rt=1 over the misses; ${line('default')}; ${line('left')} (limits ${JSON.stringify(MISS_FILL_MAX)})`);
}
/** D4301: limits for {@link missFillChecks}, from W37's measurement (see DIVERGES D4301). */
const MISS_FILL_MAX = { default: 22.5, left: 27 };

/**
 * examples/ssr?rt=1&bvh=pmndrs (W14): core's @pmndrs/bvh provider.
 *  - the ray oracle against THREE.Raycaster (camera rays and rays spread through the scene): first
 *    hit, triangle, normal, frontFace, instance and material, for each builder (auto, tinybvh);
 *  - the offscreen wall mirror with RT on, as for three-mesh-bvh;
 *  - SPEC phase 4 gate: the @pmndrs/bvh walk vs three-mesh-bvh's on the same rays, per scene
 *    (`--rt-compare-rays N`, default 16384 per ray set).
 */
async function ssrRtBvhChecks(pages) {
  console.log('examples/ssr (?rt=1&bvh=pmndrs):');
  const nCompare = args.includes('--rt-compare-rays') ? Number(args[args.indexOf('--rt-compare-rays') + 1]) : 16384;
  const fmtOracle = (o) => `${o.agree}/${o.rays} agree (${o.bothMiss} both miss), gpu-only ${o.gpuOnly}, cpu-only ${o.cpuOnly}, p99 rel ${o.p99Rel.toExponential(1)}; of ${o.compared} hits: triangle ${o.triangle}, normal ${o.normalSigned} (same line ${o.normalAbs}), frontFace ${o.frontFace}, instance ${o.instance}, material ${o.material}`;
  // Where both hit within 1e-3 the attributes must agree, but for ties: rays spread through a scene
  // hit contact lines and coincident faces, where either answer is right (D1704).
  const oracleOk = (o) => o.agree / o.rays > 0.995 && o.gpuOnly + o.cpuOnly <= o.rays * 0.003
    && [o.triangle, o.normalSigned, o.frontFace, o.instance, o.material].every((k) => k >= o.compared * 0.995);
  for (const builder of ['auto', 'tinybvh']) {
    // probes at 128 px, as the three-mesh-bvh section above (D901 hit-shading checks)
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&view=grid&rt=1&bvh=pmndrs&bvhBuilder=${builder}&probeRes=128`);
    pages.push(p);
    const before = results.logs.length;
    await p.T("window.__p.load('offscreen')");
    const bvh = await p.T('window.__p.bvh');
    for (const kind of ['camera', 'scene']) {
      const o = await p.T(`window.__p.rtOracle(4096, '${kind}')`);
      check(`rt @pmndrs/bvh (${bvh.builder}) agrees with THREE.Raycaster, ${kind} rays`, oracleOk(o),
        `${fmtOracle(o)}; BVH ${bvh.meshes} meshes, ${bvh.triangles} tris, ${bvh.buildMs.toFixed(0)} ms${bvh.fallbackReason ? ` (${bvh.fallbackReason})` : ''}`);
    }
    if (builder !== 'auto') continue;
    await rtAnyHitChecks(p, `@pmndrs/bvh (${bvh.builder})`);
    await p.T("window.__p.setPose('mirror')");
    await p.T('window.__p.setRT(false)');
    await p.T('window.__p.step(2)');
    const off = await p.T('window.__p.stats()');
    await p.T('window.__p.setRT(true)');
    await p.T('window.__p.step(2)');
    const on = await p.T('window.__p.stats()');
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    check('rt @pmndrs/bvh offscreen: renders, no validation errors, finite outputs', errs.length === 0 && on.nonFinite === 0 && on.rt && on.rt.traced > 0,
      errs.length ? errs.slice(0, 2).join(' | ') : `${on.misses} misses -> ${JSON.stringify(on.rt)}`);
    check('rt @pmndrs/bvh offscreen: the wall mirror shows the wall behind the camera',
      on.facingPanelConfidence > 0.9 && off.facingPanelConfidence < 0.1 && on.panel.hitDistanceMedianRelErr < 0.02 && on.panel.within2pc > 0.8 && on.panel.brightFraction > 0.02,
      `confidence ${off.facingPanelConfidence.toFixed(3)} -> ${on.facingPanelConfidence.toFixed(3)}; hit distance median rel err ${on.panel.hitDistanceMedianRelErr.toExponential(2)}, ${(on.panel.within2pc * 100).toFixed(1)}% within 2%; bright ${(on.panel.brightFraction * 100).toFixed(2)}%`);
    await p.T("window.__p.setView('final')");
    savePng('ssr-rt-bvh-offscreen-mirror-final.png', await p.T('window.__p.shot()'));
    await p.T("window.__p.setView('grid')");

    // the phase 4 gate: same rays through both walks, per scene
    const assets = fs.existsSync(path.join(ROOT, 'examples/assets/Sponza')) ? ['sponza'] : [];
    for (const id of ['offscreen', 'mirrorWall', 'contact', 'boxRoom', 'moving', 'facingMirrors', 'rooms', ...assets]) {
      const b = results.logs.length;
      await p.T(`window.__p.load(${JSON.stringify(id)})`);
      await p.T('window.__p.step(1)');
      const big = assets.includes(id);
      if (big) {
        // Which walk is right where they disagree? THREE.Raycaster (brute force per mesh) on fewer rays,
        // ours first: building three-mesh-bvh's BVH reorders the geometry's index buffer in place,
        // after which our triangle ids (taken before) no longer match three's faceIndex.
        for (const which of ['pmndrs', 'three-mesh-bvh']) {
          const o = await p.T(`window.__p.rtOracle(1024, 'camera', '${which}')`);
          if (which === 'pmndrs') check(`rt @pmndrs/bvh vs THREE.Raycaster, ${id}, camera rays`, oracleOk(o), fmtOracle(o));
          else console.log(`  (info) three-mesh-bvh vs THREE.Raycaster, ${id}, camera rays - ${fmtOracle(o)}`);
        }
      }
      for (const kind of ['camera', 'scene']) {
        const c = await p.T(`window.__p.rtCompare(${nCompare}, '${kind}')`);
        const e = results.logs.slice(b).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
        const detail = `${c.agree}/${c.rays} agree (${c.bothMiss} both miss), pmndrs-only ${c.pmndrsOnly}, three-mesh-bvh-only ${c.tmbOnly}, p99 rel ${c.p99Rel.toExponential(1)}, max rel ${c.maxRel.toExponential(1)}; of ${c.compared} hits: normal ${c.normal}, frontFace ${c.frontFace}; ${c.triangles} tris, ${c.builder}, build ${c.buildMs.pmndrs.toFixed(0)} vs ${c.buildMs.threeMeshBvh.toFixed(0)} ms`;
        // On the asset the stopgap misses the nearest hit on some rays (D1705); the oracle above is its check.
        if (big && e.length === 0) { console.log(`  (info) rt @pmndrs/bvh vs three-mesh-bvh, ${id}, ${kind} rays - ${detail}`); continue; }
        check(`rt @pmndrs/bvh vs three-mesh-bvh, ${id}, ${kind} rays`,
          e.length === 0 && c.agree / c.rays > 0.995 && c.pmndrsOnly + c.tmbOnly <= c.rays * 0.003 && c.normal >= c.compared * 0.995,
          e.length ? e.slice(0, 2).join(' | ') : detail);
      }
      // D903: the same hit-shading measurement as the ssr-rt section, on this provider
      if (['mirrorWall', 'contact', 'moving'].includes(id)) { await p.T('window.__p.step(2)'); await rtHitShadingLines(p, `${id} (@pmndrs/bvh)`); }
      if (id === 'contact') await rtShadingNormalChecks(p, '@pmndrs/bvh');
    }
  }
  if (args.includes('--rt-shadow-timing')) await rtShadowTiming('@pmndrs/bvh', '&bvh=pmndrs');

  // Information, not a gate: trace-pass GPU ms of both walks on the same frame (1080p, offscreen
  // 'mirror', every confidence below 1.01 traced), loop stopped, median of 20.
  const ms = {};
  for (const bvh of ['three-mesh-bvh', 'pmndrs']) {
    const t = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&timing&w=1920&h=1080&rt=1&bvh=${bvh}&scene=offscreen&pose=mirror`);
    pages.push(t);
    await t.T('window.__p.setSettings({ missConfidenceThreshold: 1.01 })');
    const r = await t.T('window.__p.time(20)');
    await t.T('window.__p.step(1)');
    ms[bvh] = { trace: r.ms['rt trace'], misses: (await t.T('window.__p.traceStats()')).misses };
  }
  console.log(`  (info) rt trace GPU ms at 1920x1080, offscreen 'mirror', ${ms.pmndrs.misses} misses: @pmndrs/bvh ${ms.pmndrs.trace?.toFixed(3)} ms, three-mesh-bvh ${ms['three-mesh-bvh'].trace?.toFixed(3)} ms`);
}

/**
 * examples/ssr-bench (phase 3 gate, docs/research/ssr-gate.md). The smoke (section `ssr-bench`):
 * every method renders on mirrorWall with finite output and no validation error; not a numbers gate.
 */
const SSR_BENCH_METHODS = ['ours', 'ours-accum', 'ours-denoise', 'three-blur', 'three-stoch', 'three-denoise'];
async function ssrBenchSmoke(pages) {
  console.log('examples/ssr-bench (smoke):');
  const url = (m) => `http://127.0.0.1:${PORT}/ssr-bench/?scene=mirrorWall&method=${m}`;
  const s = await openPage(url('reference'));
  pages.push(s);
  for (const m of ['reference', ...SSR_BENCH_METHODS]) {
    if (m !== 'reference') await s.navigate(url(m));
    const r = await s.T('window.__p.smoke(3)');
    check(`ssr-bench ${m}: renders, finite, no GPU errors`, r.nonFinite === 0 && r.gpuErrors === 0 && r.meanTone > 0.01, `mean tone ${r.meanTone.toFixed(3)}, ${r.nonFinite} non-finite`);
  }
}

/** The full bench (`--ssr-bench`): references, metrics per scene and method, GPU ms at 1080p. */
async function ssrBench() {
  const scenes = args.includes('--ssr-scenes') ? args[args.indexOf('--ssr-scenes') + 1].split(',') : ['rooms', 'explainer', 'mirrorWall', 'roughnessRamp'];
  const timingOnly = args.includes('--ssr-timing-only'); // repeat the 1080p timing without the metrics
  // --ssr-methods ours,ours-denoise,three-denoise: only these methods (and their pipelines' baselines)
  const methods = args.includes('--ssr-methods') ? args[args.indexOf('--ssr-methods') + 1].split(',') : SSR_BENCH_METHODS;
  const baseOf = (m) => (m.startsWith('ours') ? 'ours' : m === 'three-blur' ? 'three-blur' : 'three-stoch');
  const out = { started: new Date().toISOString(), scenes: {}, timing: [] };
  const file = path.join(OUT, timingOnly ? 'ssr-bench-timing.json' : 'ssr-bench.json');
  const save = () => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 1)); };
  const page = await openPage(`http://127.0.0.1:${PORT}/ssr-bench/?scene=${scenes[0]}&method=reference`, ['--enable-webgpu-developer-features']);
  try {
    out.device = await page.cdp.evalJs('(async () => { const a = await navigator.gpu.requestAdapter(); return JSON.stringify({ ...a.info, ua: navigator.userAgent }); })()').then(JSON.parse);
    for (const scene of scenes) {
      const res = (out.scenes[scene] = { methods: {} });
      const url = (m, extra = '') => `http://127.0.0.1:${PORT}/ssr-bench/?scene=${scene}&method=${m}${extra}`;
      if (!timingOnly) {
        await page.navigate(url('reference'));
        res.reference = await page.T('window.__p.reference()');
        console.log(`  ${scene} reference:`, JSON.stringify(res.reference));
        savePng(`ssr-bench-${scene}-reference.png`, await page.T('window.__p.shot()'));
        save();
        for (const m of methods) {
          await page.navigate(url(m));
          res.methods[m] = await page.T('window.__p.measure()');
          const r = res.methods[m];
          console.log(`  ${scene} ${m}: still bias ${r.still.bias.toFixed(4)} rmse ${r.still.rmse.toFixed(4)} std ${r.still.stdMean.toFixed(4)}/${r.still.stdP99.toFixed(4)} | orbit std ${r.orbit.stdMean.toFixed(4)}/${r.orbit.stdP99.toFixed(4)} |de| ${r.orbit.meanAbsDelta.toFixed(4)}`);
          savePng(`ssr-bench-${scene}-${m}.png`, await page.T('window.__p.shot()'));
          save();
        }
      }
      // GPU ms at 1920x1080, loop stopped: each method, and each pipeline's own G-buffer + lit baseline
      const runsT = [...methods.map((m) => [m, '']), ...[...new Set(methods.map(baseOf))].map((b) => [b, '&base=1'])];
      for (const [m, extra] of runsT) {
        await page.navigate(url(m, `${extra}&w=1920&h=1080`));
        const t = await page.T('window.__p.time(30)');
        out.timing.push(t);
        console.log(`  ${scene} ${m}${extra} 1080p: ${t.gpuMs?.toFixed(3)} ms (min ${t.gpuMin?.toFixed(3)}, p90 ${t.gpuP90?.toFixed(3)}, cpu ${t.cpuMs?.toFixed(2)})`);
        save();
      }
    }
    out.finished = new Date().toISOString();
    save();
    console.log('  saved', path.relative(process.cwd(), file));
  } finally {
    page.close();
  }
}

/**
 * examples/showcase (smoke): every downloaded asset scene renders with reflections on and off, then
 * with the ray-traced fallback on, with no GPU errors and a non-black image. Screenshots go to
 * out/showcase-<scene>-{on,off,rt}.png. Skipped when `pnpm assets` hasn't been run. Not a pixel check.
 */
async function showcaseChecks(pages) {
  console.log('examples/showcase:');
  const p = await openPage(`http://127.0.0.1:${PORT}/showcase/?manual&w=1280&h=720`);
  pages.push(p);
  const ids = await p.T('window.__p.entries()');
  if (!ids.length) { console.log('  (no assets downloaded: showcase skipped; `pnpm assets` fetches them)'); return; }
  const tone = `(async (url) => { const img = new Image(); img.src = url; await img.decode(); const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 160, 90); const d = g.getImageData(0, 0, 160, 90).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; })`;
  for (const id of ids) {
    const before = results.logs.length;
    const info = await p.T(`window.__p.load(${JSON.stringify(id)})`);
    const shots = {};
    for (const [name, setup] of [['on', "window.__p.setView('final')"], ['off', "window.__p.setView('off')"], ['rt', "(window.__p.setView('final'), window.__p.setSources({ rt: true }))"]]) {
      await p.T(setup);
      await p.T('window.__p.step(8)'); // a few frames of denoiser history
      shots[name] = await p.T('window.__p.shot()');
      savePng(`showcase-${id}-${name}.png`, shots[name]);
    }
    const s = await p.T('window.__p.info()');
    await p.T('window.__p.setSources({ rt: false })');
    const lum = await p.T(`(${tone})(${JSON.stringify(shots.on)})`);
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
    check(`showcase ${id}: renders on / off / rt, no GPU errors`, s.gpuErrors === 0 && errs.length === 0 && lum > 8 && !!s.bvh,
      `${info.probes} probes (${info.layout}, ${info.bakeMs.toFixed(0)} ms), denoiser ${s.denoiser ?? 'none'}, mean ${lum.toFixed(0)}/255, BVH ${s.bvh?.triangles} tris; reflections ${(s.timings.total ?? NaN).toFixed(2)} ms${errs.length ? '; ' + errs[0] : ''}`);
  }
  // W40 (D3500), W36 (D4201): reflections at rest stay still. Consecutive frames of a still camera, 8-bit
  // display luma: share of pixels whose mean |frame - previous| is over 1/255. Without anti-aliasing the
  // denoised mirror floor keeps a 1-3/255 shimmer (about 1% of the frame, 9% of the floor's reflection of the
  // car). The default anti-aliasing (@pmndrs/upscaler, NativeAA) must settle it; W40's TAA is reported beside it.
  if (ids.includes('carConcept')) {
    await p.T(`window.__p.load('carConcept')`);
    const still = `(async (mode) => {
      const P = window.__p; P.setView('final'); P.setAA(mode); await P.step(90);
      const c = document.createElement('canvas'); const g = c.getContext('2d', { willReadFrequently: true });
      let prev = null, acc = null, n = 0;
      for (let k = 0; k < 9; k++) {
        const img = new Image(); img.src = await P.shot(); await img.decode();
        c.width = img.width; c.height = img.height; g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        const l = new Float32Array(d.length / 4); for (let i = 0; i < l.length; i++) l[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
        if (prev) { acc ??= new Float32Array(l.length); for (let i = 0; i < l.length; i++) acc[i] += Math.abs(l[i] - prev[i]); n++; }
        prev = l;
      }
      let over = 0; for (let i = 0; i < acc.length; i++) if (acc[i] / n > 1) over++;
      return over / acc.length * 100;
    })`;
    const off = await p.T(`(${still})('off')`);
    const taa = await p.T(`(${still})('taa')`);
    const on = await p.T(`(${still})('upscaler')`);
    check('showcase carConcept: still camera, reflections settle under anti-aliasing (upscaler; < 0.3% of pixels flicker > 1/255)', on < 0.3,
      `upscaler ${on.toFixed(2)}%, W40 TAA ${taa.toFixed(2)}%, off ${off.toFixed(2)}% of pixels with mean |frame - previous| > 1/255`);
    // W36: upscaling (G-buffer and reflections at the render size) renders
    const before = results.logs.length;
    const up = await openPage(`http://127.0.0.1:${PORT}/showcase/?manual&w=1280&h=720&scene=carConcept&upscale=performance`);
    pages.push(up);
    await up.T('window.__p.step(8)');
    const ui = await up.T('window.__p.info()');
    const upShot = await up.T('window.__p.shot()');
    savePng('showcase-carConcept-upscale-performance.png', upShot);
    const upLum = await up.T(`(${tone})(${JSON.stringify(upShot)})`);
    const upErrs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
    check('showcase carConcept: ?upscale=performance renders (G-buffer at half size, upscaled)', ui.gpuErrors === 0 && upErrs.length === 0 && ui.renderSize[0] === 640 && ui.renderSize[1] === 360 && upLum > 8,
      `render ${ui.renderSize.join('x')} -> ${ui.size.join('x')}, mean ${upLum.toFixed(0)}/255${upErrs.length ? '; ' + upErrs[0] : ''}`);
  }
}

/**
 * examples/showcase/compare.html (smoke, W21/W23): the split renders with our denoised pipeline on the
 * left and three's SSRNode + FFX on the right, with no GPU errors and a non-black image; the WebGPU
 * path tracer stops at the page's max samples (no more samples or dispatches at rest) and its OIDN
 * frame is far less speckled than the raw one. Skipped without assets.
 * Screenshots: out/showcase-compare-{split,pathtraced,pathtraced-raw}.png.
 */
async function showcaseCompareChecks(pages) {
  console.log('examples/showcase/compare.html:');
  const p = await openPage(`http://127.0.0.1:${PORT}/showcase/compare.html?manual&scene=toyCar&left=ours-denoised&right=three-ffx`);
  pages.push(p);
  const ids = await p.T('window.__p.entries()');
  if (!ids.length) { console.log('  (no assets downloaded: compare skipped)'); return; }
  const before = results.logs.length;
  await p.T('window.__p.freeze(true)');
  await p.T('window.__p.step(16)');
  const split = await p.T('window.__p.shot()');
  savePng('showcase-compare-split.png', split);
  // the reference (W23): WebGPU tracer to the page's default cap, then OIDN once, then idle
  const conv = await p.T('window.__p.converge()');
  const pt = await p.T("window.__p.shotOf('pathtraced')");
  savePng('showcase-compare-pathtraced.png', pt);
  await p.T('window.__p.showDenoised(false)');
  const raw = await p.T("window.__p.shotOf('pathtraced')");
  savePng('showcase-compare-pathtraced-raw.png', raw);
  await p.T('window.__p.showDenoised(true)');
  // a few more frames at rest: no further samples and no further tracer dispatches
  await p.T("window.__p.setSides('ours-denoised', 'pathtraced')");
  await p.T('window.__p.step(12)');
  const after = await p.T("window.__p.ptInfo()");
  const lum = async (url) => p.T(`(async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const g = c.getContext('2d'); g.drawImage(i, 0, 0, 160, 90); const d = g.getImageData(0, 0, 160, 90).data; let s = 0; for (let k = 0; k < d.length; k += 4) s += d[k] + d[k + 1] + d[k + 2]; return s / (d.length / 4) / 3; })(${JSON.stringify(url)})`);
  // speckle: mean 3x3 local variance of luma at full resolution (denoised << raw at 8 spp)
  const speckle = async (url) => p.T(`(async (u) => { const i = new Image(); i.src = u; await i.decode(); const w = i.width, h = i.height; const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, w, h).data; const L = (x, y) => { const o = (y * w + x) * 4; return 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; };
    let acc = 0, n = 0; for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) { let s = 0, s2 = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const l = L(x + dx, y + dy); s += l; s2 += l * l; } const m = s / 9; acc += s2 / 9 - m * m; n++; } return acc / n; })(${JSON.stringify(url)})`);
  const [ls, lp] = [await lum(split), await lum(pt)];
  const [nRaw, nDen] = [await speckle(raw), await speckle(pt)];
  const errs = (await p.T('window.__p.gpuErrors()')).concat(results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception/i.test(l)));
  check('showcase compare: split and path tracer render, no GPU errors', errs.length === 0 && ls > 8 && lp > 8,
    `split mean ${ls.toFixed(0)}/255, path traced mean ${lp.toFixed(0)}/255${errs.length ? '; ' + errs[0] : ''}`);
  const stopped = conv.done && conv.samples === conv.maxSamples && after.samples === conv.samples && after.dispatches === conv.dispatches;
  check('showcase compare: path tracer stops at max samples (no more dispatches at rest)', stopped,
    `${conv.samples} / ${conv.maxSamples} spp in ${conv.seconds.toFixed(1)} s (trace ${conv.traceMs} ms); 12 frames later ${after.samples} spp, dispatches ${conv.dispatches} -> ${after.dispatches}`);
  check('showcase compare: reference is OIDN-denoised once at the cap', conv.denoised && !!conv.denoiser && nDen < 0.6 * nRaw,
    `${conv.denoiser ?? 'no denoiser'}, ${conv.denoiseMs} ms; 3x3 luma variance raw ${nRaw.toFixed(1)} -> denoised ${nDen.toFixed(1)}`);
}

/**
 * examples/babylon (W15, SPEC phase 6): the mirrorWall scene on Babylon's WebGPUEngine through
 * @pmndrs/reflections/babylon. Smoke: renders, no validation errors, finite outputs, rays traced;
 * the mirror floor shows the wall (confident SSR); the adapter's cube captures (Babylon's Y-mirror
 * undone, probes.ts) sample as world directions under core's plain cube lookup; the velocity texture
 * reprojects with motionVectorScale [-1, -1] (conventions.ts). Screenshots of the final image, SSR
 * off (probes + environment only), probes off, and the debug views.
 */
async function babylonChecks(pages) {
  console.log('examples/babylon:');
  for (const variant of ['auto', 'workgroup']) {
    const before = results.logs.length;
    const p = await openPage(`http://127.0.0.1:${PORT}/babylon/?manual${variant === 'workgroup' ? '&variant=workgroup' : ''}`);
    pages.push(p);
    await p.T('window.__p.step(2)');
    const st = await p.T('window.__p.stats()');
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    const fails = [];
    if (st.nonFinite) fails.push(`${st.nonFinite} non-finite values`);
    if (!(st.rays > 0)) fails.push('no rays');
    if (st.gpuErrors) fails.push(`${st.gpuErrors} GPU errors`);
    if (errs.length) fails.push(errs.slice(0, 2).join(' | '));
    const tag = `babylon (${st.variant})`;
    check(`${tag}: renders, no validation errors, finite outputs`, fails.length === 0,
      fails.length ? fails.join('; ') : `${st.rays} rays, mean confidence ${st.meanConfidence.toFixed(3)} on geometry`);
    check(`${tag}: mirror floor reflects the scene (confident SSR)`, st.mirrorPixels > 1000 && st.mirrorConfident > 0.3,
      `${st.mirrorPixels} mirror px, ${(st.mirrorConfident * 100).toFixed(1)}% with confidence >= 0.9`);
    if (variant === 'auto') {
      const o = await p.T('window.__p.orientation()');
      check('babylon: adapter cube captures (Y-mirror undone) sample as world directions', o.ok,
        o.ok ? `${o.rows.length} directions` : o.rows.filter((r) => !r.ok).slice(0, 4).map((r) => `${r.dir.join(',')}: got ${r.got.join('')} want ${r.expect.join('')}`).join('; '));
      const mc = await p.T('window.__p.motionCheck()');
      const err = Object.fromEntries(mc.rows.map((r) => [r.scale, r.meanError]));
      check('babylon: velocity reprojects with motionVectorScale [-1, -1]', mc.best === '-1,-1' && err['-1,-1'] < 0.5 * err['0,0'],
        `${mc.pixels} px; mean colour error ${mc.rows.map((r) => `[${r.scale}] ${r.meanError.toFixed(4)}`).join(', ')}`);
      const shot = async (name) => savePng(`babylon-${name}.png`, await p.T('window.__p.shot()'));
      await shot('final');
      await p.T('window.__p.setSSR(false)');
      await shot('ssr-off');
      await p.T('window.__p.setProbes(false)');
      await shot('ssr-off-probes-off');
      await p.T('window.__p.setSSR(true)');
      await shot('probes-off');
      await p.T('window.__p.setProbes(true)');
      for (const v of ['lit', 'reflection', 'radiance', 'confidence', 'normal', 'roughness']) {
        await p.T(`window.__p.setView(${JSON.stringify(v)})`);
        await shot(`view-${v}`);
      }
      await p.T("window.__p.setView('final')");
      const t = await p.T('window.__p.time(20)').catch(() => null);
      if (t) console.log(`  babylon tracer GPU ms (960x540, loop stopped): ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
  }
  // D1804 (W29): the composite with SSR and probes off (environment slot only) against Babylon's own
  // specular IBL, on AO / normal-mapped metal, rough, clear-coat, sheen and bent-normal materials.
  for (const sky of ['flat', 'gradient']) {
    const before = results.logs.length;
    const p = await openPage(`http://127.0.0.1:${PORT}/babylon/?manual&scene=ibl&sky=${sky}`);
    pages.push(p);
    await p.T('window.__p.step(2)');
    const c = await p.T('window.__p.iblCompare()');
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    const fmt = (g) => `${g.pixels} px: before mean ${g.before.mean} p99 ${g.before.p99} -> after mean ${g.after.mean} p99 ${g.after.p99} (/255)`;
    console.log(`  babylon ibl (${sky} sky) vs Babylon's own specular IBL: geometry ${fmt(c.geometry)}; specular factor < 1 ${fmt(c.occluded)}; energy compensation only ${fmt(c.energyOnly)}`);
    if (sky === 'flat') {
      // flat sky: any prefilter of a constant is itself, so only the weight can differ
      check('babylon: composite matches Babylon\'s own specular IBL (AO, horizon occlusion, multi-scatter applied)',
        errs.length === 0 && c.occluded.pixels > 1000 && c.geometry.after.mean < 0.5 && c.geometry.after.mean < c.geometry.before.mean && c.occluded.after.mean < c.occluded.before.mean,
        errs.length ? errs.slice(0, 2).join(' | ') : `geometry mean ${c.geometry.before.mean} -> ${c.geometry.after.mean}, p99 ${c.geometry.before.p99} -> ${c.geometry.after.p99} (/255)`);
      const shot = async (name) => savePng(`babylon-ibl-${name}.png`, await p.T('window.__p.shot()'));
      await p.T('window.__p.setSSR(false)');
      await p.T('window.__p.setProbes(false)');
      await shot('final');
      await p.T("window.__p.setView('specularFactor')");
      await shot('view-specularFactor');
    }
  }
}

/**
 * examples/pixi3d/arcade (W19, SPEC phase 6): a neon arcade built with pixi-3d (`@pixi/3d`, closed
 * beta) through @pmndrs/reflections/pixi (the frame contract from a View3D's outputs, core SSR + probes
 * on pixi's device, the composite as a pixi Filter). Without the beta in examples/pixi3d/vendor/ the
 * page is a setup notice, and the check asserts that the notice renders. With it: renders, no
 * validation errors, finite outputs, rays traced; the glossy floor reflects the signs (confident SSR);
 * the G-buffer carries the material values; the contract's camera reprojects onto pixi-3d's own
 * pixels and its normals agree with the depth; the probe captures sample as world directions and
 * draw the view's sky behind the geometry (W33: black-sky texels and the composite's change logged); the
 * motion texture reprojects with motionVectorScale [1, 1]. Screenshots of the final image (denoised
 * when the sibling Denoiser repo is there, and raw), SSR off, probes off and the debug views.
 */
async function pixi3dChecks(pages) {
  console.log('examples/pixi3d/arcade:');
  const hasBeta = fs.existsSync(path.join(ROOT, 'examples/pixi3d/vendor/package.json'));
  if (!hasBeta) {
    const p = await openPage(`http://127.0.0.1:${PORT}/pixi3d/arcade/`);
    pages.push(p);
    const notice = await p.T("({ flag: !!window.__p.pixi3dUnavailable, text: document.getElementById('badge')?.textContent ?? '' })");
    check('pixi3d: no beta in examples/pixi3d/vendor/, the setup notice renders', notice.flag && /closed beta/.test(notice.text), notice.text.slice(0, 80));
    return;
  }
  for (const variant of ['auto', 'workgroup']) {
    const before = results.logs.length;
    const p = await openPage(`http://127.0.0.1:${PORT}/pixi3d/arcade/?manual${variant === 'workgroup' ? '&variant=workgroup' : ''}`);
    pages.push(p);
    await p.T('window.__p.step(3)');
    const st = await p.T('window.__p.stats()');
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    const fails = [];
    if (st.nonFinite) fails.push(`${st.nonFinite} non-finite values`);
    if (!(st.rays > 0)) fails.push('no rays');
    if (st.gpuErrors) fails.push(`${st.gpuErrors} GPU errors`);
    if (errs.length) fails.push(errs.slice(0, 2).join(' | '));
    const tag = `pixi3d (${st.variant})`;
    check(`${tag}: renders, no validation errors, finite outputs`, fails.length === 0,
      fails.length ? fails.join('; ') : `${st.rays} rays, ${st.geometryPx} geometry px, mean confidence ${st.meanConfidence.toFixed(3)}`);
    check(`${tag}: glossy floor reflects the signs (confident SSR)`, st.glossyFloor > 1000 && st.glossyConfident > 0.2,
      `${st.glossyFloor} glossy floor px, ${(st.glossyConfident * 100).toFixed(1)}% with confidence >= 0.9`);
    if (variant === 'auto') {
      check('pixi3d: the G-buffer carries the material values (mirror sphere, gold torus)', st.mirrorPx > 200 && st.goldPx > 200, `${st.mirrorPx} mirror px, ${st.goldPx} gold px`);
      const cc = await p.T('window.__p.cameraCheck()');
      check("pixi3d: the contract's camera lands on pixi-3d's pixels; G-buffer normals agree with the depth", cc.meanPixelError < 0.05 && cc.meanNormalDot > 0.95,
        `${cc.pixels} px, mean reprojection error ${cc.meanPixelError.toFixed(4)} px; ${cc.normals} px, mean N·N(depth) ${cc.meanNormalDot.toFixed(4)}`);
      const sc = await p.T('window.__p.sceneColorCheck()');
      check("pixi3d: the scene-colour bit takes the environment's specular out", sc.without > 0.05 && sc.withBit < 0.15 * sc.without,
        `green under a white sky: ${sc.withBit.toFixed(4)} with the bit, ${sc.without.toFixed(4)} without`);
      const o = await p.T('window.__p.orientation()');
      check('pixi3d: probe captures (six pixi-3d cameras) sample as world directions', o.ok,
        o.ok ? `${o.rows.length} directions` : o.rows.filter((r) => !r.ok).slice(0, 4).map((r) => `${r.dir.join(',')}: got ${r.got.join('')} want ${r.expect.join('')}`).join('; '));
      // W33 (D2104): the capture cameras draw the view's background behind the geometry
      const ps = await p.T('window.__p.probeSkyCheck()');
      check("pixi3d: probe faces draw the view's sky, equal to the environment slot's", ps.sky.maxError < 2e-3 * Math.max(1, ps.sky.maxValue),
        `${ps.sky.texels} texels, max |faces - captureHemisphere| ${ps.sky.maxError.toExponential(2)} (mean ${ps.sky.meanError.toExponential(2)}, sky up to ${ps.sky.maxValue.toFixed(3)})`);
      const pct = (k) => `${(100 * k / ps.probe.texels).toFixed(1)}%`;
      check('pixi3d: the arcade probe sees the sky (no black-sky texels)', ps.probe.skyTexels > 0 && ps.probe.skyBlackAfter === 0,
        `${ps.probe.skyTexels} sky texels (${pct(ps.probe.skyTexels)} of ${ps.probe.texels}); black texels ${ps.probe.blackBefore} (${pct(ps.probe.blackBefore)}) without the sky -> ${ps.probe.blackAfter} (${pct(ps.probe.blackAfter)}) with it; black sky texels ${ps.probe.skyBlackBefore} -> ${ps.probe.skyBlackAfter}`);
      for (const [k, label] of [['ssr', 'SSR on'], ['ssrOff', 'SSR off']]) {
        const c = ps.composite[k], aa = ps.composite[`${k}AA`];
        console.log(`  pixi3d probe sky, composite ${label} (${c.glossyPx} glossy px, 0-255): black sky -> sky mean ${c.mean.toFixed(2)} / p99 ${c.p99} / max ${c.max}; ${c.changedPx} px change >= 2 (mean ${c.changedMean.toFixed(2)}, p99 ${c.changedP99}); A/A mean ${aa.mean.toFixed(3)} / p99 ${aa.p99} / max ${aa.max}`);
      }
      const mc = await p.T('window.__p.motionCheck()');
      const err = Object.fromEntries(mc.rows.map((r) => [r.scale, r.meanError]));
      check('pixi3d: motion reprojects with motionVectorScale [1, 1]', mc.best === '1,1' && err['1,1'] < 0.5 * err['0,0'],
        `${mc.pixels} px; mean colour error ${mc.rows.map((r) => `[${r.scale}] ${r.meanError.toFixed(4)}`).join(', ')}`);
      const shot = async (name) => savePng(`pixi3d-${name}.png`, await p.T('window.__p.shot()'));
      await shot('final');
      const denoiser = await p.T('window.__p.denoiserName');
      console.log(`  denoiser: ${denoiser ?? 'none (no sibling Denoiser repo): raw signal'}`);
      if (denoiser) { await p.T('window.__p.setDenoise(false)'); await shot('raw'); await p.T('window.__p.setDenoise(true)'); }
      await p.T('window.__p.setSSR(false)');
      await shot('ssr-off');
      await p.T('window.__p.setProbes(false)');
      await shot('ssr-off-probes-off');
      await p.T('window.__p.setSSR(true)');
      await shot('probes-off');
      await p.T('window.__p.setProbes(true)');
      for (const v of ['lit', 'reflection', 'radiance', 'confidence', 'normal', 'roughness', 'metalness', 'albedo', 'motion', 'weight']) {
        await p.T(`window.__p.setView(${JSON.stringify(v)})`);
        await shot(`view-${v}`);
      }
      await p.T("window.__p.setView('final')");
      const t = await p.T('window.__p.time(20)').catch(() => null);
      if (t) console.log(`  pixi3d tracer GPU ms (960x540, loop stopped): ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
  }
}

async function main() {
  setTimeout(() => { console.error('FAILED: timed out'); process.exit(3); }, probeBenchFull || ssrBenchFull || mirrorBiasFull ? 3_600_000 : 600_000).unref();
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
      const ca = await p.T('window.__p.cubeArray');
      check('cube-array support installed and self-tested (W20 shim)', ca.mode === 'shim' || ca.mode === 'native', `${ca.mode}: ${ca.reason}`);
      // the storage and pre-phase-2 parity checks compare lookups without Lagarde's seam options (the
      // 'hw' and legacy nodes don't have them; W26 made distanceRoughness the default, D53) and with
      // r187's lod mapping (theirs; W31 made 'alpha' the default, D101)
      const seamDefaults = await p.T('[window.__p.probes.distanceRoughness, window.__p.probes.roughnessLerp]');
      const lodDefault = await p.T('window.__p.probes.lodMapping');
      await p.T("(window.__p.setSeamOptions(false), window.__p.setLodMapping('r187'), true)");
      const shots = {};
      for (const lookup of ['warp', 'none', 'hw', 'cube-array', 'auto']) {
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
      // W20 checks after the 2D-array parity checks above, so those run in the same order as before W20
      {
        // W20: the cube array is what 'hw' emulates (hardware cube sampling of cube2d-none's texels)
        const cs = await p.T(`(${IMAGE_STATS})(${JSON.stringify(shots['cube-array'])}, ${JSON.stringify(shots.hw)})`);
        check("'cube-array' lookup matches the hardware cube sampler (closer than 'warp')", cs.max <= 1 && cs.mean <= stats.mean / 4,
          `mean ${cs.mean.toFixed(4)}, max ${cs.max} / 255 (warp: mean ${stats.mean.toFixed(4)}, max ${stats.max})`);
        const au = await p.T(`(${IMAGE_STATS})(${JSON.stringify(shots.auto)}, ${JSON.stringify(shots['cube-array'])})`);
        const auLayout = await p.T("(window.__p.setLookup('auto'), window.__p.capture(), window.__p.cubeArray.bakedLayout)");
        check("layout 'auto' bakes a cube array when the shim is active", auLayout === 'cube-array' && au.max === 0, `bakedLayout ${auLayout}, vs 'cube-array' max ${au.max} / 255`);
        // fallback: without the shim, 'auto' is today's 2D array ('warp'), 'cube-array' throws; reversible and idempotent
        const fb = await p.T(`(async () => {
          const P = window.__p, R = P.renderer, b = R.backend;
          const owners = () => [R._textures, b.textureUtils, b.bindingUtils, Object.getPrototypeOf(b.createNodeBuilder(new P.THREE.Mesh(), R))];
          const names = [['getSize', 'getMipLevels'], ['createDefaultTexture', 'createTexture', 'updateTexture'], ['_createLayoutEntries', 'createBindGroup'], ['generateTextureLod', 'getUniformFromNode', 'getUniforms']];
          const patched = () => owners().reduce((n, o, i) => n + names[i].filter((m) => o[m]?.cubeArrayShim === true).length, 0);
          const before = patched();
          await P.setShim(false);
          const after = patched();
          P.setLookup('auto'); P.capture();
          const layout = P.cubeArray.bakedLayout;
          const shot = await P.shot();
          let forced = null;
          try { P.setLookup('cube-array'); } catch (e) { forced = String(e.message ?? e); }
          const a = P.installShim(), c = P.installShim();
          const ok = await a;
          P.setLookup('auto'); P.capture();
          return { before, after, layout, shot, forced, same: a === c, ok, again: patched(), relayout: P.cubeArray.bakedLayout };
        })()`);
        const fd = await p.T(`(${IMAGE_STATS})(${JSON.stringify(fb.shot)}, ${JSON.stringify(shots.warp)})`);
        check("without the shim, 'auto' falls back to the 2D array ('warp' image)", fb.layout === 'cube2d' && fd.max === 0, `bakedLayout ${fb.layout}, vs 'warp' max ${fd.max} / 255`);
        check("without the shim, layout 'cube-array' throws", typeof fb.forced === 'string' && fb.forced.includes('installCubeArraySupport'), String(fb.forced).slice(0, 90));
        check('shim is reversible and idempotent', fb.before === 10 && fb.after === 0 && fb.same && fb.ok && fb.again === 10 && fb.relayout === 'cube-array',
          `patched methods ${fb.before} -> ${fb.after} -> ${fb.again}, same promise ${fb.same}, re-install ${fb.ok}, layout ${fb.relayout}`);
        // a failing self-test (read-back sabotaged) uninstalls and reports false; the next install works again
        const st = await p.T(`(async () => {
          const P = window.__p, R = P.renderer;
          await P.setShim(false);
          R.readRenderTargetPixelsAsync = async () => new Uint8Array(48 * 4);
          let ok;
          try { ok = await P.installShim(); } finally { delete R.readRenderTargetPixelsAsync; }
          const failed = { ...P.cubeArray };
          P.setLookup('auto'); P.capture();
          const layout = P.cubeArray.bakedLayout;
          const again = await P.setShim(true);
          return { ok, failed, layout, again, relayout: P.cubeArray.bakedLayout };
        })()`);
        check('a failing self-test uninstalls the shim and reports false; auto falls back', st.ok === false && st.failed.mode === 'none' && st.layout === 'cube2d' && st.again === true && st.relayout === 'cube-array',
          `${st.failed.reason}; then auto ${st.layout}, re-install ${st.again} (${st.relayout})`);
      }
      await p.T(`(window.__p.setSeamOptions(${seamDefaults[0]}, ${seamDefaults[1]}), window.__p.setLodMapping(${JSON.stringify(lodDefault)}), true)`);
      check('seam options default: distanceRoughness on, roughnessLerp off (W26, D53)', seamDefaults[0] === true && seamDefaults[1] === false, JSON.stringify(seamDefaults));
      check("lod mapping default: 'alpha' (W31, D101)", lodDefault === 'alpha', JSON.stringify(lodDefault));
      // W20: the feature checks run on one storage: 'auto' (the cube array through the shim, default) or the 2D array
      const probesLayout = args.includes('--probes-layout') ? args[args.indexOf('--probes-layout') + 1] : 'cube-array';
      if (probesLayout === 'cube2d') await p.T("(async () => { await window.__p.setShim(false); window.__p.setLookup('warp'); return true; })()");
      else await p.T("window.__p.setLookup('auto')");
      const featureLayout = await p.T('window.__p.cubeArray.bakedLayout');
      check(`probe feature checks run on the requested layout (${probesLayout})`, featureLayout === probesLayout, featureLayout);

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
      check('lookup option refit: false keeps a lookup with frameIrradiance plain (D803)', lo.refitOff < 1e-5, `max rel err ${lo.refitOff.toExponential(1)}`);
      // W26 (D53): Lagarde's seam options against the plain lookup fed the CPU's r' and lerped direction
      const so = await C('seamOptions');
      check("lookup options distanceRoughness / roughnessLerp: Lagarde 2014 Listing 25 / App. F", so.err.dist < 2e-3 && so.err.lerp < 2e-3 && so.err.both < 2e-3 && so.err.off < 2e-3 && so.lum > 0 && so.changedDist > 0.01 && so.changedLerp > 0.01,
        `max rel err dist ${so.err.dist.toExponential(1)}, lerp ${so.err.lerp.toExponential(1)}, both ${so.err.both.toExponential(1)}, geometry ${so.err.off.toExponential(1)}; changes the lookup by up to ${f(so.changedDist)} / ${f(so.changedLerp)}`);
      const rf = await p.T(`(async () => { const P = window.__p; P.setGrid(true, 0.3); P.setLookup('${probesLayout === 'cube2d' ? 'warp' : 'auto'}'); for (let i = 0; i < 3; i++) await P.shot(); const off = await P.shot();
        P.setRefit(true); for (let i = 0; i < 3; i++) await P.shot(); const on = await P.shot(); P.setRefit(false); P.setGrid(false); return { on, off }; })()`);
      savePng('probes-refit-off.png', rf.off);
      savePng('probes-refit-on.png', rf.on);
      const rs = await p.T(`(${IMAGE_STATS})(${JSON.stringify(rf.on)}, ${JSON.stringify(rf.off)})`);
      check('re-fit with LightProbeGrid renders and changes the image', rs.lum > 10 && rs.mean > 0.5, `lum ${rs.lum.toFixed(1)}, mean diff ${rs.mean.toFixed(2)} / 255`);
      // W31 (D25): bake({ bounces: 2 }) re-captures with the first pass's probes visible: the rooms'
      // interreflection reaches the probes (brighter); 1 is the plain bake
      const bo = await p.T(`(async () => { const P = window.__p; P.setGrid(true, 0.08); const one = await P.shot();
        P.setBounces(2); const two = await P.shot(); P.setBounces(1); const back = await P.shot(); P.setGrid(false); return { one, two, back }; })()`);
      savePng('probes-bounces-2.png', bo.two);
      const b2 = await p.T(`(${IMAGE_STATS})(${JSON.stringify(bo.two)}, ${JSON.stringify(bo.one)})`);
      const b1 = await p.T(`(${IMAGE_STATS})(${JSON.stringify(bo.back)}, ${JSON.stringify(bo.one)})`);
      check('bake bounces: 2 adds the probes\' interreflection; back to 1 restores the plain bake (D25)', b2.mean > 1 && b2.lum > b1.lum && b1.mean < 0.01, // (< 0.01: the grid's known highlight scatter, W7)
        `bounce 2 vs 1: mean ${b2.mean.toFixed(2)} / 255, lum ${b1.lum.toFixed(1)} -> ${b2.lum.toFixed(1)}; back to 1: max ${b1.max} / 255`);
      // W35 (D805): probe sets of different layouts in one shader, each as in its own shader
      const ml = await C('mixedLayouts');
      // (to float rounding: the shader compiler may fold a function differently next to another one)
      check(`probe sets of ${ml.sets.length} layouts in one shader match their own lookups (D805)`, ml.sets.length >= 2 && ml.sets.every((s) => s.q255 === 0 && s.maxAbs < 1e-6 && s.lum > 0),
        ml.sets.map((s) => `${s.layout} max ${s.q255} / 255 (float ${s.maxAbs.toExponential(1)}, tone-mapped ${s.max255.toExponential(1)} / 255, lum ${s.lum.toFixed(2)})`).join(', '));
      // W35 (D2204): the cube-array atlas is only ever bound as 'cube-array' (bake, irradiance, materials)
      const ab = await C('atlasBindings');
      check("probe atlas bound only as its layout's view dimension (D2204)", ab.dims.every((d) => d.length > 0 && d.every((x) => x === (ab.layout === 'cube-array' ? 'cube-array' : '2d-array'))),
        `${ab.layout}: ${ab.dims.map((d) => d.join('+')).join(', ')}`);
      check('bake irradiance through the cube-array view = the 2D-array path (D2204)', ab.irradiance.rel < 1e-2 && ab.irradiance.scale > 0,
        `max |diff| ${ab.irradiance.maxErr.toExponential(2)} of ${ab.irradiance.scale.toFixed(3)} (rel ${ab.irradiance.rel.toExponential(2)})`);
      const cs = await C('compatShim');
      check("compatibility-mode renderer: the cube-array shim declines, 'auto' bakes the 2D array (D2204)", cs.available && cs.compat && cs.installed === false && cs.supported === false && cs.storage === 'cube2d', JSON.stringify(cs));
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
        const res0 = await p.T('window.__p.params.resolution');
        for (const res of [128, 256]) {
          const t = await p.T(`window.__p.timeBake(${res})`);
          console.log(`  bake, 3 probes at ${res} px: median ${t.median.toFixed(2)} ms (${t.all.map((x) => x.toFixed(2)).join(' ')})`);
        }
        await p.T(`(window.__p.setResolution(${res0}), true)`);
      }

      if (args.includes('--time-lookup')) {
        // lookup ms at 1080p, loop stopped: frame time with the probe node minus without it (no IBL),
        // the core lookup and the pre-phase-2 TSL node alternated in one page, grid on (432 spheres)
        // (W20: also GPU timestamps, ?ts: render-pass ms per frame, median of 40, less exposed to a shared machine's wall-clock noise)
        const t = await openPage(`http://127.0.0.1:${PORT}/probes/?w=1920&h=1080&grid&ts`);
        pages.push(t);
        await t.T(FREEZE);
        const rows = await t.T(`(async () => {
          const P = window.__p, out = { warp: [], 'cube-array': [], 'cube-array+seam': [], 'legacy-warp': [] };
          // 'cube-array+seam': the same with Lagarde's distanceRoughness + roughnessLerp (W26, D53)
          for (let k = 0; k < 5; k++) for (const lookup of ['legacy-warp', 'warp', 'cube-array', 'cube-array+seam']) {
            P.setSeamOptions(lookup.endsWith('+seam'));
            P.setLookup(lookup.replace('+seam', '')); P.setGrid(true, 0.08);
            const on = await P.timeFrames(30, 7); P.setEnvNode(false); const off = await P.timeFrames(30, 7); P.setEnvNode(true);
            out[lookup].push({ on: on.wall, off: off.wall, lookup: on.wall - off.wall, gpu: on.gpu - off.gpu, gpuOn: on.gpu });
          }
          return out;
        })()`);
        for (const [k, v] of Object.entries(rows)) {
          const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
          console.log(`  lookup ${k}: frame ${med(v.map((r) => r.on)).toFixed(3)} ms, without IBL ${med(v.map((r) => r.off)).toFixed(3)} ms, lookup ${med(v.map((r) => r.lookup)).toFixed(3)} ms (median of ${v.length}; each ${v.map((r) => r.lookup.toFixed(3)).join(' ')})`);
          console.log(`    gpu: frame ${med(v.map((r) => r.gpuOn)).toFixed(3)} ms, lookup ${med(v.map((r) => r.gpu)).toFixed(3)} ms (each ${v.map((r) => r.gpu.toFixed(3)).join(' ')})`);
        }
      }

      if (compareUrl) {
        console.log(`compare with ${compareUrl}:`);
        const o = await openPage(compareUrl);
        pages.push(o);
        await o.T(FREEZE);
        await o.T("(window.__p.setLookup('warp'), window.__p.capture(), true)");
        // the other build has no seam options (D53), r187's lod mapping (D101) and bakes at 128 px (D23)
        await p.T("(window.__p.setSeamOptions(false), window.__p.setLodMapping('r187'), window.__p.setResolution(128), true)");
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
    if (runs('hybrid')) await hybridChecks(pages);
    if (only === 'mirror-bias') await mirrorBiasChecks(pages); // W32: the mirrorBias check alone (also part of ssr)
    if (only === 'denoiser-gate') await denoiserGateChecks(pages); // W34: the D1402 check alone (also part of ssr)
    if (only === 'seam') {
      // W26: the D53 seam sweep alone (examples/ssr, denoised)
      const sp = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=1`);
      pages.push(sp);
      if (!args.includes('--seam-pt-only')) await seamChecks(sp, true);
      if (args.includes('--seam-pt') || args.includes('--seam-pt-only')) {
        // vs the path-traced reference (examples/showcase/compare.html Measure, W21/W23): MAD / bias of
        // 'probes only' and 'ours denoised' over the glossy px, Lagarde's options off (?seam=0), each alone, both
        const rows = [];
        // SEAM_PT_SCENES=chess,sponza runs a subset (the four together pass the script's 10 min limit)
        const ptScenes = process.env.SEAM_PT_SCENES?.split(',');
        for (const [scene, floor] of [['toyCar', 0.25], ['carConcept', 0.25], ['chess', 0.25], ['sponza', null]].filter(([id]) => !ptScenes || ptScenes.includes(id))) {
          for (const seam of ['0', 'dist', 'lerp', '1']) {
            const page = await openPage(`http://127.0.0.1:${PORT}/showcase/compare.html?manual&scene=${scene}&left=ours-denoised&right=probes&seam=${seam}${floor !== null ? `&floorRoughness=${floor}` : ''}`);
            if (!(await page.T('window.__p.entries()')).length) { page.close(); console.log('  (no showcase assets: --seam-pt skipped)'); break; }
            await page.T('window.__p.freeze(true)');
            const m = await page.T("window.__p.measure({ samples: 32, warmup: 24, frames: 8, methods: ['probes', 'ours-denoised'], orbitFrames: 0 })");
            page.close();
            const fmt = m.rows.map((r) => `${r.method} MAD ${r.mad.toFixed(2)} bias ${r.bias.toFixed(2)}`).join(', ');
            console.log(`  vs path traced ${scene}${floor !== null ? ` floor r ${floor}` : ''} seam ${seam}: ${m.glossyPixels} glossy px, ${fmt}`);
            rows.push({ scene, floor, seam, glossyPixels: m.glossyPixels, rows: m.rows.map(({ method, mad, bias, stdMean }) => ({ method, mad, bias, stdMean })) });
          }
        }
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'seam-pt.json'), JSON.stringify(rows, null, 1));
      }
    }
    if (runs('ssr-rt')) await ssrRtChecks(pages);
    if (runs('babylon')) await babylonChecks(pages);
    if (runs('ssr-rt-bvh')) await ssrRtBvhChecks(pages);
    if (runs('pixi3d')) await pixi3dChecks(pages);
    if (ssrBenchFull) await ssrBench();
    else if (runs('ssr-bench')) await ssrBenchSmoke(pages);
    if (runs('showcase')) await showcaseChecks(pages);
    if (runs('showcase-compare')) await showcaseCompareChecks(pages);

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
      check('probe core: a frame irradiance provider turns the re-fit on; refit: false keeps it off (D803)', r.refit.autoErr < 2e-2 && r.refit.offErr < 2e-3,
        `auto x2 max rel err ${r.refit.autoErr.toExponential(2)}, off x1 ${r.refit.offErr.toExponential(2)}`);
      check('probe core: sets of three layouts in one module match their own modules (D805)', r.mixed.length === 3 && r.mixed.every((m) => m.maxAbs === 0),
        r.mixed.map((m) => `${m.layout} max ${m.maxAbs}`).join(', '));
      {
        // W35 (D1805 / D2104): captures in three's, Babylon's and pixi-3d's conventions through the capture transform
        const T = r.transform, row = (n) => T.rows.find((x) => x.name.startsWith(n));
        const fmt = (x) => `float max ${x.exact.toExponential(1)}; full mean ${x.full.mean.toFixed(3)}, p99 ${x.full.p99.toFixed(2)}, max ${x.full.max.toFixed(1)} / 255, SH ${x.irr.toExponential(1)}`;
        check('capture transform: mirrorX is an alias of captureTransform CAPTURE_MIRROR_X; both at once throws', T.aliasErr === 0 && T.both.includes('not both'), `max ${T.aliasErr}; ${T.both.slice(0, 60)}`);
        // a face remap reproduces the WebGPU cube exactly, so the set is the plain one
        for (const n of ['babylon faces', 'pixi-3d camera faces']) check(`capture transform: ${n} = the plain set`, row(n).exact === 0, `max ${row(n).exact}`);
        // a mirror at lookup: the same world, prefiltered mirrored (up to the GGX sample pattern, D1805)
        for (const n of ['three axes', 'babylon axes']) check(`capture transform: ${n} looks up the plain set's world`, row(n).full.mean < 0.05 && row(n).full.max <= 1 && row(n).irr < 1e-3, fmt(row(n)));
      }
      {
        // W35 (D2204): a compatibility-mode device (headless Chrome gives one: featureLevel
        // 'compatibility', no 'core-features-and-limits') fixes each texture's binding view dimension
        const cm = await pc.T('window.__p.compat()');
        check('compat mode: the device enforces the binding view dimension and has no cube-array views', cm.available && cm.isCompat && cm.dims.arrayAsCube.startsWith('bind:')
          && cm.dims.arrayAs2dArray === 'ok' && cm.dims.cubeAsCube === 'ok' && cm.dims.cubeArrayAsCubeArray.startsWith('create:'), JSON.stringify(cm.dims).slice(0, 200));
        check('compat mode: ProbeSet defaults to cube2d-warp there (D2204)', cm.sets[0].layout === 'cube2d-warp', JSON.stringify(cm.sets[0]).slice(0, 120));
        check('compat mode: the prefilter path for it (GGX levels from a cube-only source copy) = the default path (D4100)', cm.prefilterDiffering === 0, `${cm.prefilterDiffering} of ${cm.prefilterValues} half values differ`);
        // not yet: the downsampler reads and writes mips of one texture in one dispatch, which compat rejects (D4100)
        console.log(`  compat mode, open (D4100): ${cm.sets.map((x) => `${x.asked}: ${(x.error ?? x.throws ?? `ok, vs core max ${x.vsCore}`).slice(0, 110)}`).join(' | ')}`);
      }
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
