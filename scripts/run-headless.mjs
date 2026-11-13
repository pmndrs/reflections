#!/usr/bin/env node
// Headless GPU check for the examples (Chrome + WebGPU over CDP, no puppeteer).
//
//   pnpm check                       # starts the examples server if needed, runs every check
//   pnpm check -- --compare <url>    # also diff examples/probes against another build of the same
//                                    # page (e.g. the denoiser repo's three-temporal/reflection-probes.html)
//   pnpm check -- --only scenes      # run one section (probes | bc6h | scenes | regressions | sssr-core | ssr | hybrid | ssr-rt | babylon | ssr-rt-bvh | pixi3d | probe-core | probe-bench | ssr-bench | showcase | showcase-compare | bench | probe-layouts)
//   pnpm check -- --only ssr-exp-metrics         # X0 (W70): the experiment metrics smoke (examples/shared/metrics); ssr-exp-baseline = the full baseline (scripts/ssr-exp.mjs)
//   pnpm check -- --only halo-options            # W52: the halo options (visibility ray on screen, lobe filter where hits mix, re-shade occlusion)
//   pnpm check -- --only ssr-exp-x1              # W71 (X1): each X1 setting at its default = absent on examples/ssr; (W76: historyEdgeConfidence and hitLobeFilterGrazing removed)
//   pnpm check -- --only ssr-exp-grazing         # W71 (X1 #3) / W76: grazing sweep 5/15/30/60 deg vs the path tracer, hitColorConeGrazing 0 / 0.5 / 1 (minutes)
//   pnpm check -- --only brdf-prefilter          # W78: the tracer's sample direction + pdf and FFX's BRDF prefilter weights (needs the Denoiser repo's W78 branch)
//   pnpm check -- --only hit-source              # W53: the denoiser's hit source through the seam (needs the Denoiser repo's W53 branch)
//   pnpm check -- --only probe-bindings          # W62: Sponza's three-size probe set at the default 16 sampled textures
//   pnpm check -- --only probe-bindings-measure  # W62: Sponza with fewer probe sizes vs the path tracer (MAD, PSNR), lookup ms; out/w62-probe-bindings.json
//   pnpm check -- --only probe-layouts-measure   # W61: probe layouts at equal memory, error vs RT / path tracer, seams, timing (minutes); out/w61-probe-layouts.json
//   pnpm check -- --only probes --time-lookup   # probe lookup ms at 1080p: core on the 2D array (warp), core on the cube array, the pre-phase-2 TSL node
//   pnpm check -- --only mirror-bias --mirror-bias   # W32 / D49: mirrorBias noise / bias sweep (minutes), JSON to out/mirror-bias.json
//   pnpm check -- --only ray-reuse                    # W73 / D5040: rayReuse 'copy' is the default path, 'ratio' runs and lowers raw noise
//   pnpm check -- --only seam        # W26 / D53: the SSR-to-probe seam sweep (Lagarde's options off / on), JSON to out/seam.json (SEAM_SHOTS=1: images)
//   pnpm check -- --only probes --probes-layout cube2d   # run the probe feature checks on the 2D array (default: 'auto', a cube array through the shim)
//   pnpm check -- --only probe-bench --low-roughness   # D101: lookups between mips, two lod mappings
//   pnpm check -- --probe-bench      # the full probe layout x format bench (minutes); JSON to out/probe-bench.json
//   pnpm check -- --only probe-bench --probe-atlas   # W62: mixed probe sizes in one 2D octahedral atlas vs cube arrays; out/w62-probe-atlas.json
//   pnpm check -- --only ssr-bench --ssr-bench   # the phase 3 gate bench: ours vs three's SSRNode (minutes); JSON to out/ssr-bench.json
//                                    # (--ssr-scenes rooms,mirrorWall to narrow it)
//   pnpm check -- --only ssr-rt --rt-shadow-timing   # D903: GPU ms of hit shadow rays, kit scenes, 960x540 + 1080p (also ssr-rt-bvh)
//   pnpm check -- --only rt-materials [--rt-material-assets]   # W49: per-triangle hit materials, both providers (+ the asset survey)
//
// Screenshots go to ./out/ (or $OUT). Exit code 1 if a check fails.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ssrExpBaseline, ssrExpMetricsSmoke, ssrExpRun } from './ssr-exp.mjs'; // X0 (W70)

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

/**
 * Every Chrome this run started (process -> its temp profile). Every exit path (a page's close(), the
 * normal end, a failure, the global timeout, SIGINT / SIGTERM / SIGHUP) kills each one's process group
 * (its GPU / renderer helpers too: SIGKILL of the browser alone left them running under PID 1) plus any
 * process still naming its profile, then removes the profile (W61).
 */
const liveChromes = new Map();
function killChrome(chrome) {
  const dir = liveChromes.get(chrome);
  liveChromes.delete(chrome);
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* group gone */ }
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  if (dir) {
    try { spawnSync('pkill', ['-9', '-f', dir]); } catch { /* none left */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
const killAllChromes = () => { for (const c of [...liveChromes.keys()]) killChrome(c); };
process.on('exit', killAllChromes);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killAllChromes(); process.exit(130); });
/** Open `url` in a fresh headless Chrome; resolves once `window.__p` exists. */
async function openPage(url, extraArgs = []) {
  // Port 0: Chrome picks a free port and writes it to DevToolsActivePort. A random fixed port could
  // collide with another worktree's Chrome, and then this run drove that run's page (F2).
  const userDataDir = path.join(os.tmpdir(), `reflections-${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu',
    '--enable-features=Vulkan', '--window-size=1100,900', '--remote-debugging-port=0', ...extraArgs,
    `--user-data-dir=${userDataDir}`, url,
  ], { stdio: 'ignore', detached: true });
  liveChromes.set(chrome, userDataDir);
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
  const close = () => { try { ws.close(); } catch { /* noop */ } killChrome(chrome); };
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
    for (const cfg of [{ minTraversalOccupancy: 0, samplesPerQuad: 1 }, { minTraversalOccupancy: 0, samplesPerQuad: 2 }, { minTraversalOccupancy: 0, samplesPerQuad: 4 },
      // W80 (D5180): the candidate restart is in both variants' loops
      { minTraversalOccupancy: 0, samplesPerQuad: 1, maxCandidates: 4 }, { minTraversalOccupancy: 0, samplesPerQuad: 4, maxCandidates: 8 }]) {
      const r = await s.T(`window.__p.parity(${JSON.stringify(cfg)})`);
      const tag = `occupancy 0, ${cfg.samplesPerQuad} spq${cfg.maxCandidates ? `, maxCandidates ${cfg.maxCandidates}` : ''}`;
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
  await x1CoreChecks(s, hasSubgroups); // W71 (X1)
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
  const graz = await env.T('window.__p.identity({}, { hitColorConeGrazing: 1 })'); // W76 (X1 #3 on the cone, D5100)
  check('sssr W76 hitColorConeGrazing 1 (default 0) changes the cone hits only (cube environment: same lists)', graz.radianceDiffPixels > 0 && graz.listsSame && graz.hitDiffPixels === 0,
    `radiance ${graz.radianceDiffPixels} px differ, hit distance ${graz.hitDiffPixels}, lists same ${graz.listsSame}`);
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
 * W71 (X1, D5000-D5003) on examples/sssr-core: each setting at its default gives the same lists and
 * images bit for bit as the setting absent; the rotated quad bases keep the variants' parity.
 */
async function x1CoreChecks(s, hasSubgroups) {
  // (W76 removed historyEdgeConfidence, D5003)
  // (W76 removed hitLobeFilterGrazing and historyEdgeConfidence; its cone shrink hitColorConeGrazing defaults to 0)
  const X1_DEFAULTS = { quadBaseRotation: 'fixed', thicknessDepthFactor: 0, thicknessDepthMode: 'add', hitColorConeGrazing: 0 };
  // 'relative' at k 0 is off (review: thickness 0 would make smoothstep(0, 0, d) undefined)
  for (const [name, def] of [...Object.entries(X1_DEFAULTS), ['all of them', X1_DEFAULTS], ['relative at k 0', { thicknessDepthMode: 'relative', thicknessDepthFactor: 0 }]]) {
    const r = await s.T(`window.__p.identity({}, ${JSON.stringify(typeof def === 'object' ? def : { [name]: def })})`);
    check(`sssr X1 ${name}: default ${JSON.stringify(def)} = absent, bit for bit`, r.listsSame && r.radianceDiffPixels === 0 && r.hitDiffPixels === 0,
      `rays ${r.rays.join(' / ')}, misses ${r.misses.join(' / ')}, differing px radiance ${r.radianceDiffPixels}, hit ${r.hitDiffPixels}`);
  }
  // W76: the new defaults resolve as documented (core resolveScreenSpaceSettings): absent = the explicit cone +
  // compensation at 0.5; hitColorFilter 'off' alone = the explicit pre-W76 path; with missesTraced (RT on) an unset
  // thickness = 'relative' 0.02, and an explicit 'add' (or factor 0) = the pre-W76 test
  const W76_CASES = [
    ['absent = cone + compensate + bias 0.5', {}, { hitColorFilter: 'cone', mirrorBiasCompensate: true, mirrorBias: 0.5 }],
    ["hitColorFilter 'off' = the pre-W76 explicit path", { hitColorFilter: 'off' }, { hitColorFilter: 'off', mirrorBiasCompensate: false, mirrorBias: 0 }],
    // review: an explicit mirrorBias keeps D49's truncation (compensation defaults off with it); a bias of 0 is never compensated
    ['explicit mirrorBias 0.5 = cone + truncation (no compensation)', { mirrorBias: 0.5 }, { hitColorFilter: 'cone', mirrorBiasCompensate: false, mirrorBias: 0.5 }],
    ['explicit mirrorBias 0 + compensate = the cone alone', { mirrorBias: 0, mirrorBiasCompensate: true }, { mirrorBiasCompensate: false, mirrorBias: 0 }],
    ["missesTraced: unset thickness = 'relative' 0.02", { missesTraced: true }, { missesTraced: true, thicknessDepthMode: 'relative', thicknessDepthFactor: 0.02 }],
    ["missesTraced + thicknessDepthMode 'add' = RT off's thickness", { missesTraced: true, thicknessDepthMode: 'add' }, {}],
    ['missesTraced + thicknessDepthFactor 0 = RT off\'s thickness', { missesTraced: true, thicknessDepthFactor: 0 }, {}],
  ];
  for (const [name, a, b] of W76_CASES) {
    const r = await s.T(`window.__p.identity(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    check(`sssr W76 defaults: ${name}, bit for bit`, r.listsSame && r.radianceDiffPixels === 0 && r.hitDiffPixels === 0,
      `rays ${r.rays.join(' / ')}, misses ${r.misses.join(' / ')}, differing px radiance ${r.radianceDiffPixels}, hit ${r.hitDiffPixels}`);
  }
  const rtThick = await s.T('window.__p.identity({}, { missesTraced: true })');
  const cone = await s.T("window.__p.identity({ hitColorFilter: 'off' }, {})");
  check('sssr W76 defaults act: RT on changes the thickness (more misses), the cone default changes the hits vs off',
    rtThick.misses[1] > rtThick.misses[0] && cone.radianceDiffPixels > 1000,
    `misses ${rtThick.misses.join(' to ')} with missesTraced; off vs default: ${cone.radianceDiffPixels} px differ, misses ${cone.misses.join(' / ')}`);
  // the settings act (the grazing filter on the ?env page,
  // since the constant fallback looks the same at every roughness)
  const thick = await s.T('window.__p.identity({}, { thicknessDepthFactor: 0.05 })');
  const rel = await s.T("window.__p.identity({}, { thicknessDepthFactor: 0.001, thicknessDepthMode: 'relative' })");
  check('sssr X1 thicknessDepthFactor and its relative mode change the hits (k 0.05 added: fewer misses; relative 0.001: more)',
    thick.misses[1] < thick.misses[0] && rel.misses[1] > rel.misses[0],
    `misses ${thick.misses.join(' to ')} at k 0.05, ${rel.misses.join(' to ')} relative 0.001`);
  // quadBaseRotation (D5000): which corner carries the copies, over 4 frames
  const corners = {};
  for (const rot of ['fixed', 'frame', 'pattern']) {
    corners[rot] = [];
    for (let f = 0; f < 4; f++) corners[rot].push((await s.T(`window.__p.quadCorners({ quadBaseRotation: '${rot}', frameIndex: ${f} })`)).corners);
  }
  const share = (c) => { const n = c.reduce((a, b) => a + b, 0) || 1; return c.map((v) => v / n); };
  const fixedOk = corners.fixed.every((c) => c[0] > 0 && c[1] + c[2] + c[3] === 0);
  const order = [0, 3, 1, 2]; // quadCorner(k): tl, br, tr, bl (index tl 0, tr 1, bl 2, br 3)
  const frameOk = corners.frame.every((c, f) => share(c)[order[f]] > 0.99);
  const patternOk = corners.pattern.every((c) => share(c).every((v) => v > 0.15 && v < 0.35));
  check('sssr X1 quadBaseRotation: fixed = top-left, frame cycles the corner, pattern spreads all four per frame', fixedOk && frameOk && patternOk,
    `copy-carrying rays per corner [tl, tr, bl, br]: fixed ${JSON.stringify(corners.fixed[0])}, frame ${corners.frame.map((c) => JSON.stringify(c)).join(' ')}, pattern f0 ${JSON.stringify(corners.pattern[0])}`);
  if (!hasSubgroups) return;
  for (const cfg of [{ quadBaseRotation: 'frame', frameIndex: 5 }, { quadBaseRotation: 'pattern', frameIndex: 6 }, { quadBaseRotation: 'pattern', frameIndex: 6, samplesPerQuad: 2 },
    { quadBaseRotation: 'pattern', frameIndex: 3, quadCopy: 'sameSurface' }]) {
    const r = await s.T(`window.__p.parity(${JSON.stringify({ minTraversalOccupancy: 0, ...cfg })})`);
    check(`sssr X1 parity (${Object.entries(cfg).map(([k, v]) => `${k} ${v}`).join(', ')}): lists and images`,
      r.rayListSame && r.tileListSame && r.missListSame && r.tileFlagsSame && r.radianceDiffPixels === 0 && r.hitDiffPixels === 0,
      `rays ${r.rays}, misses ${r.misses}, radiance ${r.radianceDiffPixels} px`);
  }
}

/**
 * `--only ssr-exp-x1` (W71, X1: D5000-D5002): on examples/ssr (denoised, AA off, hit colour from last
 * frame, re-shade off; RT off and on), every X1 setting at its default renders the same image as the
 * setting absent (max 0/255; the absent run repeated gives the noise floor). W76 removed X1 #4
 * (historyEdgeConfidence, D5003) and its edge-pan check; with RT on the thickness defaults are W76's
 * ('relative' 0.02), so there the explicit RT-off values are not the defaults and are not compared.
 */
const X1_KEYS = ['quadBaseRotation', 'thicknessDepthFactor', 'thicknessDepthMode', 'hitColorConeGrazing'];
const X1_DEFAULT_SETTINGS = { quadBaseRotation: 'fixed', thicknessDepthFactor: 0, thicknessDepthMode: 'add', hitColorConeGrazing: 0 };
const X1_DEFAULT_SETTINGS_RT = { quadBaseRotation: 'fixed', thicknessDepthFactor: 0.02, thicknessDepthMode: 'relative', hitColorConeGrazing: 0 };
const X1_SHOT = `async (keys, settings, n, pan) => {
  const p = window.__p;
  p.stop();
  for (const k of keys) delete p.ssr.settings[k];
  p.setSettings({ frameIndex: 7, minTraversalOccupancy: 0, ...settings });
  const cam = p.kit.camera, c = p.controls;
  if (!window.__x1Pose) window.__x1Pose = { pos: cam.position.clone(), target: c.target.clone() };
  cam.position.copy(window.__x1Pose.pos); c.target.copy(window.__x1Pose.target); c.update();
  // W76: the cone (default) builds its intersect variant asynchronously: wait until the tracer runs it
  for (let i = 0; i < 100 && (p.ssr.settings.hitColorFilter ?? 'cone') === 'cone' && !p.ssr.tracer?.outputs.hitColorFilterActive; i++) { await p.step(1); await new Promise((r) => setTimeout(r, 30)); }
  p.ssr.resetHistory(); p.hybrid.resetHistory(); p.aa?.reset?.();
  for (let i = 0; i < n; i++) {
    if (pan) { const a = pan * (i - n + 1); const d = window.__x1Pose.target.clone().sub(window.__x1Pose.pos); d.applyAxisAngle(new p.THREE.Vector3(0, 1, 0), a); c.target.copy(window.__x1Pose.pos).add(d); c.update(); }
    await p.step(1);
  }
  return p.shot();
}`;
async function x1Checks(pages) {
  for (const [scene, rt] of [['mirrorWall', 0], ['mirrorWall', 1], ['facingMirrors', 0]]) {
    const pg = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&scene=${scene}&rt=${rt}&denoise=1&aa=off&hit=final&reshade=off`);
    pages.push(pg);
    const shot = (s, n = 8, pan = 0) => pg.T(`(${X1_SHOT})(${JSON.stringify(X1_KEYS)}, ${JSON.stringify(s)}, ${n}, ${pan})`);
    const diff = (a, b) => pg.T(`(${IMAGE_STATS})(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    const A = await shot({}), A2 = await shot({});
    const floor = await diff(A, A2);
    const rows = [];
    const defaults = rt ? X1_DEFAULT_SETTINGS_RT : X1_DEFAULT_SETTINGS;
    for (const [k, v] of [...Object.entries(defaults), ['all', defaults]]) {
      const d = await diff(A, await shot(typeof v === 'object' ? v : { [k]: v }));
      rows.push(`${k} ${d.max}`);
      check(`X1 ${scene}${rt ? ' rt' : ''}: ${k} at its default = absent (max /255)`, d.max === 0 || d.max <= floor.max, `max ${d.max}, mean ${d.mean.toFixed(4)}; absent twice: max ${floor.max}`);
    }
    pg.close();
  }
}

/**
 * `--only ssr-exp-grazing` (W71, X1 #3, D5002; the maintainer's test case for the grazing shrink, on the cone since W76):
 * the bench (showcase/bench.html), one glossy floor seen at camera elevations 5 / 15 / 30 / 60 deg
 * (the floor point under the scene's centre as target, the hero pose's heading and distance), the
 * bench's Measure vs the path tracer (OIDN) per elevation over the glossy px and the lower half of the
 * frame (the floor), with hitColorConeGrazing 0 / 0.5 / 1 and hitLobeFilterMixed off (1) / on (0),
 * methods ours denoised and ours + RT. X0's grazing sweep (gradient energy) and line spread are not
 * on main yet: this is the error half, shaped so X0 can absorb it (one row per scene x elevation x
 * setting). GRAZING_SCENES=toyCar,carConcept, GRAZING_FLOOR=<roughness> (default 0.2),
 * GRAZING_SPP (default 32). JSON to out/w71-grazing.json.
 */
async function grazingSweep(pages) {
  const scenes = (process.env.GRAZING_SCENES ?? 'toyCar').split(',');
  const floorR = Number(process.env.GRAZING_FLOOR ?? 0.2), spp = Number(process.env.GRAZING_SPP ?? 32);
  const rows = [];
  for (const scene of scenes) {
    const p = await openPage(`http://127.0.0.1:${PORT}/showcase/bench.html?manual&scene=${scene}&pose=hero&left=ours-denoised&right=pathtraced&aa=off&floorRoughness=${floorR}`);
    pages.push(p);
    if (!(await p.T('window.__p.entries()')).length) { console.log('  (no showcase assets: grazing sweep skipped)'); p.close(); return; }
    await p.T(`(async () => { const P = window.__p; P.addRegion('floorHalf', [0, 0.5, 1, 0.5]); await P.step(2); })()`);
    for (const elev of [5, 15, 30, 60]) {
      await p.T(`(async () => {
        const P = window.__p, [pos, t] = P.view(), e = ${elev} * Math.PI / 180;
        const h = [pos[0] - t[0], pos[2] - t[2]], hl = Math.hypot(...h), d = Math.hypot(pos[0] - t[0], pos[1] - t[1], pos[2] - t[2]);
        if (!window.__g0) window.__g0 = { h: [h[0] / hl, h[1] / hl], d, t };
        const g = window.__g0, target = [g.t[0], 0.001, g.t[2]];
        P.setView([target[0] + g.d * Math.cos(e) * g.h[0], target[1] + g.d * Math.sin(e), target[2] + g.d * Math.cos(e) * g.h[1]], target);
        await P.step(2);
      })()`);
      savePng(`w71-grazing-${scene}-${elev}.png`, await p.T('window.__p.shot()'));
      for (const mixed of [1, 0]) {
        for (const g of [0, 0.5, 1]) {
          const m = await p.T(`(async () => { const P = window.__p;
            P.setSetting('s.hitLobeFilterMixed', ${mixed === 1 ? 'null' : mixed}); P.setSetting('s.hitColorConeGrazing', ${g === 0 ? 'null' : g});
            await P.step(2);
            return P.measure({ samples: ${spp}, warmup: 24, frames: 8, methods: ['ours-denoised', 'ours-rt'] }); })()`);
          const by = Object.fromEntries(m.rows.map((r) => [r.region, r]));
          const row = { scene, elevation: elev, floorRoughness: floorR, hitColorConeGrazing: g, hitLobeFilterMixed: mixed, spp: m.referenceSamples,
            regions: Object.fromEntries(['glossy', 'floorHalf'].map((k) => [k, { px: by[k]?.px, ptLuma: by[k]?.refLuma, methods: by[k]?.methods }])) };
          rows.push(row);
          const f = (k, id) => { const v = by[k]?.methods[id]; return v ? `${v.mad.toFixed(2)}/${v.luma.toFixed(1)}` : '-'; };
          console.log(`  ${scene} ${String(elev).padStart(2)} deg mix ${mixed} graz ${g}: glossy MAD/luma dn ${f('glossy', 'ours-denoised')} rt ${f('glossy', 'ours-rt')} (PT ${by.glossy?.refLuma.toFixed(1)}); floor half dn ${f('floorHalf', 'ours-denoised')} rt ${f('floorHalf', 'ours-rt')} (PT ${by.floorHalf?.refLuma.toFixed(1)})`);
        }
      }
    }
    const errs = await p.T('window.__p.gpuErrors()');
    check(`grazing sweep ${scene}: ran every elevation x setting, no GPU errors`, errs.length === 0 && rows.filter((r) => r.scene === scene).length === 24, errs[0] ?? `${rows.length} rows`);
    p.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'w71-grazing.json'), JSON.stringify(rows, null, 1));
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
  await halfResChecks(pages); // W75 (X5, D5080)
  await presetChecks(pages); // W77
}

/**
 * Reflection-region deltas of PNG data URLs (decoded in a page), max channel / 255: the region is where the
 * full-res composite differs from the probe-only one by > 8 (where reflections show); `ref` = mean
 * |full - probe| there, `test` = mean |test - probe|, `diff` = mean |test - full|, `max` = max |test - full| anywhere.
 */
const REGION_DELTA = `async (full, probe, test) => {
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  const F = await px(full), Pr = await px(probe), T = await px(test);
  const d = (A, B, k) => Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2]));
  let n = 0, ref = 0, tst = 0, diff = 0, max = 0;
  for (let k = 0; k < F.length; k += 4) {
    max = Math.max(max, d(T, F, k));
    if (d(F, Pr, k) <= 8) continue;
    n++; ref += d(F, Pr, k); tst += d(T, Pr, k); diff += d(T, F, k);
  }
  return { px: n, ref: ref / Math.max(1, n), test: tst / Math.max(1, n), diff: diff / Math.max(1, n), max };
}`;

/**
 * W75 (X5, D5080; review fix 3): `reflectionResolution: 'half'` (examples/ssr ?res=half), with the denoiser
 * and the ray-traced pass. On the reflection region (full vs probe-only > 8/255) the half-res composite must
 * carry the reflection (its delta from probe-only >= 60 % of full's: a zero residual fails) and stay near full
 * (mean |half - full| < 35 % of that delta). Also an odd size (961x541) and a runtime full -> half -> full
 * switch that must end identical to the first full frame. (W75's 'mixed' check went with halfResMinRoughness:
 * W76, D5084.)
 */
/** W76: step the page until its tracer runs the cone (the default, built asynchronously), at most ~6 s; a no-op with it off. */
// (a frame first: after a resolution switch the pass recreates its tracer on the next trace, and the old one's flag would pass)
const CONE_READY = `(async () => { const p = window.__p; for (let i = 0; i < 60; i++) { await p.step(1); if ((p.ssr.settings.hitColorFilter ?? 'cone') !== 'cone' || p.ssr.tracer?.outputs.hitColorFilterActive) break; await new Promise((r) => setTimeout(r, 100)); } return true; })()`;
async function halfResChecks(pages) {
  const full = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=1&rt=1`);
  const half = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=1&rt=1&res=half`);
  const odd = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=1&rt=1&w=961&h=541`);
  pages.push(full, half, odd);
  const shotOf = async (p, prep = '') => {
    if (prep) await p.T(prep);
    await p.T(CONE_READY); // W76: the default cone builds async; a shot before it runs 'off'
    await p.T('(window.__p.ssr.settings.frameIndex = 5, window.__p.ssr.settings.minTraversalOccupancy = 0, window.__p.ssr.resetHistory(), window.__p.hybrid.resetHistory(), true)');
    await p.T('window.__p.step(24)');
    return p.T('window.__p.shot()');
  };
  const probeOnly = async (p) => { await p.T('window.__p.setSSR(false)'); const s = await shotOf(p); await p.T('window.__p.setSSR(true)'); return s; };
  const judge = (name, r, extra = true, more = '') => check(name, extra && r.px > 2000 && r.test >= 0.6 * r.ref && r.diff < 0.35 * r.ref,
    `${r.px} reflection px: full vs probe-only ${r.ref.toFixed(2)}, this vs probe-only ${r.test.toFixed(2)}, this vs full ${r.diff.toFixed(2)} (max ${r.max})${more}`);
  for (const id of ['mirrorWall', 'contact']) {
    const before = results.logs.length;
    await full.T(`window.__p.load(${JSON.stringify(id)})`);
    await half.T(`window.__p.load(${JSON.stringify(id)})`);
    const fShot = await shotOf(full), pShot = await probeOnly(full);
    const hShot = await shotOf(half);
    savePng(`half-res-${id}-final.png`, hShot);
    const info = await half.T('({ res: window.__p.ssr.resolution, w: window.__p.ssr.tracer.width, h: window.__p.ssr.tracer.height, gw: window.__p.ssr.gbuffer.width, gh: window.__p.ssr.gbuffer.height })');
    const st = await half.T('window.__p.ssr.readTraceStats()');
    const r = await full.T(`(${REGION_DELTA})(${JSON.stringify(fShot)}, ${JSON.stringify(pShot)}, ${JSON.stringify(hShot)})`);
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    judge(`half-res ${id}: traced and denoised at half size, the upsampled residual carries the reflection and stays near full res`, r,
      errs.length === 0 && info.res === 'half' && info.w === Math.ceil(info.gw / 2) && info.h === Math.ceil(info.gh / 2) && (st?.traced ?? 0) > 0,
      errs.length ? ` | ${errs.slice(0, 2).join(' | ')}` : `; tracer ${info.w}x${info.h} of ${info.gw}x${info.gh}, ${st?.traced} traced rays`);
  }
  // W75 (coordinator): half-res + W73's rayReuse 'ratio' + W74's tracedMissRate 'half' together, never run before
  {
    const before = results.logs.length;
    await half.T("window.__p.load('contact')");
    await half.T("(Object.assign(window.__p.ssr.settings, { rayReuse: 'ratio' }), window.__p.ssr.traceSettings.tracedMissRate = 'half', true)");
    // the fill's pipelines compile asynchronously (W74 review): 'full' until they are ready
    await half.T('(async () => { for (let i = 0; i < 100 && !(window.__p.ssr.traced && window.__p.ssr.traced.halfRateReady); i++) await window.__p.step(2); return true; })()');
    await half.T('window.__p.step(30)');
    const fin = await half.T(`(async () => {
      const P = window.__p, dev = P.ssr.device, r = P.renderer;
      const read = async (tex) => {
        const bpp = tex.format === 'rgba16float' ? 8 : 4, w = tex.width, h = tex.height, bpr = Math.ceil(w * bpp / 256) * 256;
        const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = dev.createCommandEncoder(); enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]); dev.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ); const dv = new DataView(buf.getMappedRange().slice(0)); buf.unmap(); buf.destroy();
        let bad = 0, n = 0, nz = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w * (bpp === 8 ? 4 : 1); x++) {
          const o = y * bpr + x * (bpp === 8 ? 2 : 4);
          let v; if (bpp === 8) { const u = dv.getUint16(o, true), e = (u >> 10) & 31; v = e === 31 ? NaN : 1; if (u & 0x7fff) nz++; } else { v = dv.getFloat32(o, true); if (v !== 0) nz++; }
          n++; if (!Number.isFinite(v)) bad++;
        }
        return { n, bad, nz };
      };
      const g = (t) => r.backend.get(t).texture;
      const up = P.hybrid.upsampled;
      return { radiance: await read(g(P.ssr.radiance)), confidence: await read(g(P.ssr.confidence)), residual: await read(g(up.residual)), upConf: await read(g(up.confidence)), stats: await P.ssr.readTraceStats() };
    })()`);
    const shot = await half.T('window.__p.shot()');
    savePng('half-res-ratio-halfrate-contact.png', shot);
    await half.T("(delete window.__p.ssr.settings.rayReuse, delete window.__p.ssr.traceSettings.tracedMissRate, true)");
    const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    const bad = ['radiance', 'confidence', 'residual', 'upConf'].reduce((a, k) => a + fin[k].bad, 0);
    check("half-res + rayReuse 'ratio' + tracedMissRate 'half' (contact, rt): all finite, the fill ran, no validation errors",
      errs.length === 0 && bad === 0 && fin.residual.nz > 0 && (fin.stats?.halfRateSkipped ?? 0) > 0 && (fin.stats?.traced ?? 0) > 0,
      errs.length ? errs.slice(0, 2).join(' | ') : `non-finite ${bad}; traced ${fin.stats?.traced}, half-rate skipped ${fin.stats?.halfRateSkipped}, filled ${fin.stats?.filled}; residual non-zero ${fin.residual.nz} of ${fin.residual.n}`);
  }
  // odd size and the runtime switch on one page (setResolution rebuilds the page's composites)
  const before = results.logs.length;
  await odd.T("window.__p.load('contact')");
  const f0 = await shotOf(odd), p0 = await probeOnly(odd);
  const h1 = await shotOf(odd, "window.__p.setResolution('half')");
  const oddInfo = await odd.T('({ w: window.__p.ssr.tracer.width, h: window.__p.ssr.tracer.height, up: window.__p.hybrid.upsampled && window.__p.hybrid.upsampled.residual.width })');
  const f2 = await shotOf(odd, "window.__p.setResolution('full')");
  const upAfter = await odd.T('(window.__p.hybrid.upsampled ? window.__p.hybrid.upsampled.residual.width : 1)');
  const ro = await odd.T(`(${REGION_DELTA})(${JSON.stringify(f0)}, ${JSON.stringify(p0)}, ${JSON.stringify(h1)})`);
  const same = await odd.T(`(${IMAGE_STATS})(${JSON.stringify(f2)}, ${JSON.stringify(f0)})`);
  const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
  judge('half-res odd size 961x541 contact: tracer 481x271, reflection carried, near full', ro, errs.length === 0 && oddInfo.w === 481 && oddInfo.h === 271,
    errs.length ? ` | ${errs.slice(0, 2).join(' | ')}` : `; tracer ${oddInfo.w}x${oddInfo.h}`);
  check('half-res runtime switch full -> half -> full ends identical to full, half-res targets released', errs.length === 0 && same.max === 0 && oddInfo.up === 961 && upAfter === 1,
    `final after the switch back vs before: mean ${same.mean.toFixed(3)}, max ${same.max}/255; upsampled targets ${oddInfo.up} px wide at half, ${upAfter} after`);
}

/**
 * W77: the presets (core REFLECTION_PRESETS) through the three adapter, on examples/ssr (contact, RT, FFX):
 * - ?preset=performance traces at half size and renders bit for bit what ?res=half renders; the denoiser's
 *   options (FFX's public `options`; the check fails without them) are untouched: 'performance' has no hit source;
 * - explicit ?res=full wins over the preset; an unknown ?preset= warns and renders as no preset;
 * - at runtime (__p.setPreset = applyReflectionsPreset) the page's own construction settings are the base:
 *   on ?res=half&hitSource=hits, 'performance' with a hit-source override 'all' -> 'default' returns to half +
 *   'hits' (the FFX options the page built), not to the package defaults;
 * - a hit source that can't reach a denoiser without setOptions sets hybrid.hitSourceUnsupported (and warns).
 */
async function presetChecks(pages) {
  const base = `http://127.0.0.1:${PORT}/ssr/?manual&denoise=1&rt=1&scene=contact`;
  const pre = await openPage(`${base}&preset=performance`);
  const hand = await openPage(`${base}&res=half`);
  const over = await openPage(`${base}&preset=performance&res=full`);
  const own = await openPage(`${base}&res=half&hitSource=hits`);
  pages.push(pre, hand, over, own);
  const before = results.logs.length;
  const state = (p) => p.T(`(() => { const P = window.__p, d = P.hybrid.denoiser, o = d && d.options;
    return { res: P.ssr.settings.reflectionResolution ?? 'full', w: P.ssr.tracer && P.ssr.tracer.width, gw: P.ssr.gbuffer.width, mode: P.hybrid.denoiserHitSourceMode, hs: P.hybrid.denoiserHitSource,
      dn: o ? [!!o.separateHitSources, !!o.missesMatchAnySource] : null, unsupported: P.hybrid.hitSourceUnsupported }; })()`);
  const shot = async (p) => {
    await p.T(CONE_READY); // W76: the default cone builds asynchronously (and again after a resolution change)
    await p.T('(window.__p.ssr.settings.frameIndex = 5, window.__p.ssr.settings.minTraversalOccupancy = 0, window.__p.ssr.resetHistory(), window.__p.hybrid.resetHistory(), true)');
    await p.T('window.__p.step(24)');
    return p.T('window.__p.shot()');
  };
  const sPre = await shot(pre), sHand = await shot(hand);
  await shot(over); await shot(own);
  const a = await state(pre), h = await state(hand), o = await state(over), w = await state(own);
  const same = await pre.T(`(${IMAGE_STATS})(${JSON.stringify(sPre)}, ${JSON.stringify(sHand)})`);
  const dn = (x, sep, any) => x.dn !== null && x.dn[0] === sep && x.dn[1] === any; // fails without a denoiser exposing options
  const fmt = (x) => `${x.res} ${x.w}/${x.gw} px, hit source ${x.mode ?? 'own'} (${x.hs}), FFX options ${x.dn ? x.dn.join('/') : 'MISSING'}`;
  let errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
  check("preset 'performance' (?preset=): half-res trace, same frame as ?res=half, the denoiser's options untouched (no hit source)",
    errs.length === 0 && a.res === 'half' && a.w === Math.ceil(a.gw / 2) && a.mode === null && !a.hs && dn(a, false, false) && same.max === 0 && h.res === 'half',
    errs.length ? errs.slice(0, 2).join(' | ') : `preset: ${fmt(a)}; by hand: ${fmt(h)}; frame vs by hand mean ${same.mean.toFixed(3)}, max ${same.max}/255`);
  check("preset 'performance' + explicit ?res=full: the explicit setting wins", errs.length === 0 && o.res === 'full' && o.w === o.gw, fmt(o));
  // an unknown name: a warning, then no preset
  const b1 = results.logs.length;
  const bad = await openPage(`${base}&preset=fast`);
  pages.push(bad);
  await shot(bad);
  const x = await state(bad);
  const warned = results.logs.slice(b1).some((l) => /unknown preset 'fast'/.test(l));
  errs = results.logs.slice(b1).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
  check("an unknown ?preset= warns and renders as no preset", errs.length === 0 && warned && x.res === 'full' && x.w === x.gw && x.mode === null && dn(x, false, false),
    errs.length ? errs.slice(0, 2).join(' | ') : `warned ${warned}; ${fmt(x)}`);
  // runtime, from the page's own base (half + 'hits' set at construction)
  const b2 = results.logs.length;
  await own.T("(window.__p.setPreset('performance', { denoiser: { hitSource: 'all' } }), true)"); await shot(own);
  const r1 = await state(own);
  await own.T("(window.__p.setPreset('default'), true)"); await shot(own);
  const r2 = await state(own);
  await pre.T("(window.__p.setPreset('default'), true)"); await shot(pre);
  const r3 = await state(pre);
  // W76: a cleared preset key falls back to core's resolution, so the tracer runs W76's defaults (RT on here)
  const w76 = await pre.T(`(() => { const s = window.__p.ssr.tracer.outputs.settings ?? {};
    return { hitColorFilter: s.hitColorFilter, mirrorBias: s.mirrorBias, mirrorBiasCompensate: s.mirrorBiasCompensate, thicknessDepthMode: s.thicknessDepthMode, thicknessDepthFactor: s.thicknessDepthFactor }; })()`);
  check("preset 'default' after 'performance': the tracer runs the package defaults from core's resolution (W76: cone + compensation at 0.5; 'relative' 0.02 with RT)",
    w76.hitColorFilter === 'cone' && w76.mirrorBias === 0.5 && w76.mirrorBiasCompensate === true && w76.thicknessDepthMode === 'relative' && w76.thicknessDepthFactor === 0.02, JSON.stringify(w76));
  errs = results.logs.slice(b2).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
  check("applyReflectionsPreset at runtime rebuilds from the page's own settings: performance + 'all' -> default returns to its half + 'hits'; a ?preset=performance page goes to the package default",
    errs.length === 0 && w.res === 'half' && w.hs && dn(w, true, true) && r1.res === 'half' && r1.mode === 'all' && dn(r1, true, false)
      && r2.res === 'half' && r2.mode === null && r2.hs && dn(r2, true, true) && r3.res === 'full' && r3.w === r3.gw && dn(r3, false, false),
    errs.length ? errs.slice(0, 2).join(' | ') : `own: ${fmt(w)}; performance + all: ${fmt(r1)}; default: ${fmt(r2)}; ?preset=performance page -> default: ${fmt(r3)}`);
  // a denoiser without setOptions: the flag (and a warning), then the real denoiser back
  const b3 = results.logs.length;
  const u = await pre.T(`(() => { const P = window.__p, real = P.hybrid.denoiser;
    const stub = { name: 'stub', device: real.device, configure() {}, dispatch() { throw new Error('stub'); }, resetHistory() {}, dispose() {} };
    P.hybrid.setDenoiser(stub); const before = P.hybrid.hitSourceUnsupported; P.hybrid.setDenoiserHitSource('hits');
    const after = P.hybrid.hitSourceUnsupported; P.hybrid.setDenoiserHitSource('off'); P.hybrid.setDenoiser(real); P.hybrid.restoreDenoiserHitSource();
    return { before, after }; })()`);
  const warnedU = results.logs.slice(b3).some((l) => /needs a denoiser that takes it/.test(l));
  await shot(pre);
  errs = results.logs.slice(b3).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
  check('a hit source a denoiser without setOptions cannot take: hybrid.hitSourceUnsupported is set and a warning logged', errs.length === 0 && !u.before && u.after && warnedU,
    errs.length ? errs.slice(0, 2).join(' | ') : `before ${u.before}, after ${u.after}, warned ${warnedU}`);
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
  await rayReuseChecks(pages);
  await hitColorFilterChecks(pages); // W72
  await denoiserGateChecks(pages);
  await specOccChecks(pages);
}

/**
 * W73 (X3, D5040): `settings.rayReuse`. 'copy' (and unset) is FFX's quad copy bit for bit; 'ratio' runs the
 * resolve (no validation error), changes the radiance, and lowers the raw temporal std on the roughnessRamp
 * strips (examples/ssr `mirrorBiasStats` at bias 0: 8-bit luma of the final image, denoiser off).
 */
async function rayReuseChecks(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0`);
  pages.push(p);
  await p.T("window.__p.load('roughnessRamp')");
  await p.T("window.__p.setPose('strips')");
  // W76: the cone (default) builds async and would change the hash mid-check; this tests rayReuse, so the cone is off
  await p.T("window.__p.setSettings({ minTraversalOccupancy: 0, temporalVarianceGuidedTracing: false, hitColorFilter: 'off' })");
  await p.T('window.__p.step(4)');
  const h = {};
  for (const [k, v] of [['unset', null], ['copy', "'copy'"], ['ratio (first frame)', "'ratio'"], ['ratio', "'ratio'"], ['copy again', "'copy'"]]) {
    await p.T(v === null ? '(delete window.__p.ssr.settings.rayReuse, true)' : `window.__p.setSettings({ rayReuse: ${v} })`);
    h[k] = await p.T('window.__p.radianceHash(7)');
    // the 'ratio' pipelines build asynchronously from the first 'ratio' frame (it copies meanwhile)
    if (k === 'ratio (first frame)') await p.T('new Promise((r) => setTimeout(r, 1500))');
  }
  check("ssr rayReuse: 'copy' is the default path, 'ratio' copies until its pipelines are built, then changes the radiance",
    h.unset === h.copy && h.copy === h['copy again'] && h['ratio (first frame)'] === h.copy && h.copy !== h.ratio, JSON.stringify(h));
  // raw (denoiser off), against one reference: the mean of 32 raw copy@4 frames (every px its own ray)
  const q = await p.T(`window.__p.configStats({ configs: [{ name: 'copy', settings: { rayReuse: 'copy' } }, { name: 'ratio', settings: { rayReuse: 'ratio' } }],
    ref: { rayReuse: 'copy', samplesPerQuad: 4 }, bins: [0.2, 0.3, 0.4], frames: 16, refFrames: 32, denoise: [false] })`);
  const [cp, ra] = ['copy', 'ratio'].map((n) => q.results.find((x) => x.name === n).bins);
  await p.T('(["rayReuse", "minTraversalOccupancy", "temporalVarianceGuidedTracing"].forEach((k) => delete window.__p.ssr.settings[k]), true)');
  check("ssr rayReuse 'ratio': less raw noise on the roughnessRamp strips (r 0.2-0.4)", cp.every((b, k) => b.px > 1000 && ra[k].std < b.std),
    cp.map((b, k) => `r ${b.roughness}: std ${b.std.toFixed(2)} -> ${ra[k].std.toFixed(2)} (${b.px} px)`).join('; '));
  // a dimming or biased estimator also lowers the std: its mean must stay at copy@4's (8-bit luma; the
  // smoother signal reads ~0.5 brighter through the tone curve, W73 phase 1)
  check("ssr rayReuse 'ratio': mean luma within 1.5 / 255 of copy@4 on the same strips (no dimming, no bias)", ra.every((b) => Math.abs(b.signed) < 1.5) && cp.every((b) => Math.abs(b.signed) < 1.5),
    cp.map((b, k) => `r ${b.roughness}: copy ${b.signed.toFixed(2)}, ratio ${ra[k].signed.toFixed(2)} (copy@4 mean ${q.refStats[k].mean.toFixed(1)})`).join('; '));
}

/**
 * W39 (D66, D4510): examples/ssr `?specOcc=1` / `__p.setSpecOcc()` hands the composite GTAO (on the
 * G-buffer) for Lagarde's specular occlusion on the probe part. On the contact scene (objects on a
 * mirror floor, AA off) turning it on must darken pixels, and those must sit where the AO input
 * (the `ao` view) says the surface is occluded; elsewhere the image stays put. No GPU errors.
 */
async function specOccChecks(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&scene=contact`);
  pages.push(p);
  const r = await p.T(`(async () => {
    const P = window.__p;
    const luma = async () => {
      const img = new Image(); img.src = await P.shot(); await img.decode();
      const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data; const l = new Float32Array(img.width * img.height);
      for (let i = 0; i < l.length; i++) l[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
      return l;
    };
    P.setView('final'); await P.step(40); const off = await luma();
    P.setSpecOcc(true); await P.step(40); const on = await luma();
    P.setView('ao'); await P.step(2); const ao = await luma();
    P.setView('specularOcclusion'); await P.step(2); const so = await luma();
    P.setSpecOcc(false); P.setView('final'); await P.step(2);
    let darker = 0, darkerInAO = 0, outside = 0, outsidePx = 0, soMin = 255, aoMin = 255;
    for (let i = 0; i < off.length; i++) {
      const d = off[i] - on[i];
      if (d > 4) { darker++; if (ao[i] < 0.95 * 255) darkerInAO++; }
      if (ao[i] > 0.97 * 255) { outsidePx++; outside += Math.abs(d); }
      soMin = Math.min(soMin, so[i]); aoMin = Math.min(aoMin, ao[i]);
    }
    return { px: off.length, darker, darkerInAO, outsideMean: outside / Math.max(1, outsidePx), soMin, aoMin, errors: P.gpuErrors.length };
  })()`);
  check('ssr specOcc (GTAO -> Lagarde, probe part): darkens the contact creases only, no GPU errors',
    r.errors === 0 && r.darker > r.px * 0.003 && r.darkerInAO > 0.8 * r.darker && r.outsideMean < 0.5 && r.aoMin < 0.5 * 255 && r.soMin < 0.8 * 255,
    `${(100 * r.darker / r.px).toFixed(2)}% px darker > 4/255, ${(100 * r.darkerInAO / Math.max(1, r.darker)).toFixed(0)}% of them where AO < 0.95; mean |change| where AO > 0.97: ${r.outsideMean.toFixed(3)}; min AO ${(r.aoMin / 255).toFixed(2)}, min factor ${(r.soMin / 255).toFixed(2)}; GPU errors ${r.errors}`);
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
/**
 * W72 (X2, D5020-D5024) / W76 (cone + compensation at 0.5 by default): hitColorFilter / mirrorBiasCompensate.
 * examples/ssr roughnessRamp strips, raw, occupancy 0 (D301).
 * - Unset, the explicit cone + compensation 0.5, 'cone' alone and unset again give the same radiance bit for bit
 *   (W76's defaults); 'off' and 'off' + compensate (ignored without the cone) give the pre-W76 path; the cone without
 *   compensation differs from both (the cone variant builds async: frames run as 'off' until
 *   `outputs.hitColorFilterActive`).
 * - The mean of the glossy radiance with 'cone' stays within 10 % of 'off' (a black or wrong pyramid fails).
 * - 'cone' + rayReuse 'ratio' differs from 'ratio' alone (the ratio intersect variant reads the pyramid).
 * - hitColor 'history' with hitShading 'off' (the pyramid of last frame's colour) changes the hits.
 * - ?rt=1: 'cone' differs from 'off' after the traced pass (on-screen reused hits read the pyramid), defaults unchanged.
 * - A 97x61 canvas and the pixi3d arcade (when its vendor build is there) run 'cone'. No GPU errors anywhere.
 */
const HCF_PAGE = `async (cmd) => {
  const p = window.__p;
  const keys = ['hitColorFilter', 'hitColorConeScale', 'mirrorBias', 'mirrorBiasCompensate', 'rayReuse', 'hitShading'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const set = (s) => { for (const k of keys) delete p.ssr.settings[k]; p.setSettings(s); };
  // until the tracer runs the cone (and ray reuse's own async build), at most ~6 s
  // ray reuse has no ready flag: give its async build 2 s
  const settle = async (wantCone0, minSteps) => { const wantCone = wantCone0 ?? true; for (let i = 0; i < 60; i++) { await p.step(1); if ((!wantCone || p.ssr.tracer.outputs.hitColorFilterActive) && i >= minSteps) break; await sleep(100); } return !wantCone || !!p.ssr.tracer.outputs.hitColorFilterActive; };
  const mean = async () => {
    const t = p.ssr.tracer.outputs, dev = p.ssr.device;
    const read = async (tex, bpp) => { const bpr = Math.ceil(tex.width * bpp / 256) * 256; const b = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); const e = dev.createCommandEncoder(); e.copyTextureToBuffer({ texture: tex }, { buffer: b, bytesPerRow: bpr }, [tex.width, tex.height]); dev.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ); const out = new Uint8Array(tex.width * tex.height * bpp); const src = new Uint8Array(b.getMappedRange()); for (let y = 0; y < tex.height; y++) out.set(src.subarray(y * bpr, y * bpr + tex.width * bpp), y * tex.width * bpp); b.unmap(); b.destroy(); return out; };
    const h2f = (h) => { const e = (h >> 10) & 31, f = h & 1023; return e === 0 ? f * 5.96e-8 : (1 + f / 1024) * 2 ** (e - 15); };
    const r = new Uint16Array((await read(t.radiance, 8)).buffer), a = new Float32Array((await read(t.extractedRoughness, 4)).buffer);
    let s = 0, n = 0; for (let i = 0; i < a.length; i++) if (a[i] > 1e-4 && a[i] < 0.2) { s += 0.2126 * h2f(r[i * 4]) + 0.7152 * h2f(r[i * 4 + 1]) + 0.0722 * h2f(r[i * 4 + 2]); n++; }
    return n ? s / n : 0;
  };
  const out = {};
  for (const [name, s] of cmd) {
    set(s);
    const active = await settle((s.hitColorFilter ?? 'cone') === 'cone', s.rayReuse ? 20 : 4);
    out[name] = { hash: await p.radianceHash(7), active, mean: await mean() };
  }
  set({});
  return { out, errors: p.gpuErrors.length };
}`;
async function hitColorFilterChecks(pages) {
  const base = { minTraversalOccupancy: 0, temporalVarianceGuidedTracing: false };
  const off = { hitColorFilter: 'off' }, coneAlone = { hitColorFilter: 'cone', mirrorBiasCompensate: false }, comp = { hitColorFilter: 'cone', mirrorBias: 0.5, mirrorBiasCompensate: true };
  const run = async (url, cmd, scene = 'roughnessRamp') => {
    const p = await openPage(url);
    pages.push(p);
    await p.T(`window.__p.load('${scene}')`);
    if (scene === 'roughnessRamp') await p.T("window.__p.setPose('strips')");
    await p.T(`window.__p.setSettings(${JSON.stringify(base)})`);
    await p.T('window.__p.step(4)');
    return p.T(`(${HCF_PAGE})(${JSON.stringify(cmd)})`);
  };
  const a = await run(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0&hit=current`, [
    ['unset', {}], ['off', off], ['off + compensate (ignored)', { ...off, mirrorBiasCompensate: true }],
    ['off + bias 0.5', { ...off, mirrorBias: 0.5 }], ['off + bias 0.5 + compensate (ignored)', { ...off, mirrorBias: 0.5, mirrorBiasCompensate: true }],
    ['cone', { hitColorFilter: 'cone' }], ['cone + compensate 0.5 (explicit)', comp], ['cone alone', coneAlone], ['unset again', {}],
    ['ratio, off', { ...off, rayReuse: 'ratio' }], ['ratio (default cone)', { rayReuse: 'ratio' }], ['ratio, cone alone', { ...coneAlone, rayReuse: 'ratio' }]]);
  const h = Object.fromEntries(Object.entries(a.out).map(([k, v]) => [k, v.hash]));
  const ratioMean = a.out['cone alone'].mean / a.out.off.mean, compMean = a.out.unset.mean / a.out.off.mean;
  check("ssr hitColorFilter / mirrorBiasCompensate (W72, W76 defaults): unset = cone + compensation 0.5 bit for bit, 'off' = the old path (compensation ignored), the cone changes the hits, means within 10 % of off, no GPU errors",
    h.unset === h['cone + compensate 0.5 (explicit)'] && h.unset === h.cone && h.unset === h['unset again'] && a.out.unset.active
    && h.off === h['off + compensate (ignored)'] && h['off + bias 0.5'] === h['off + bias 0.5 + compensate (ignored)'] && h.off !== h['off + bias 0.5']
    && a.out['cone alone'].active && h['cone alone'] !== h.off && h['cone alone'] !== h.unset && h.unset !== h.off
    // the cone alone keeps the mean (a black or wrong pyramid fails); with compensation the narrower sample validates more
    // hits, and raw radiance is confidence x hit over a black fallback, so its mean rises (+13 % on these strips)
    && Math.abs(ratioMean - 1) < 0.1 && compMean > 0.9 && compMean < 1.25 && a.errors === 0,
    `${JSON.stringify(h)}; glossy mean cone alone / off ${ratioMean.toFixed(4)}, default / off ${compMean.toFixed(4)}; GPU errors ${a.errors}`);
  check("ssr hitColorFilter 'cone' with rayReuse 'ratio' (W72 + W73): the ratio intersect variant reads the pyramid",
    a.out['ratio (default cone)'].active && h['ratio, off'] !== h.off && h['ratio (default cone)'] !== h['ratio, off'] && h['ratio, cone alone'] !== h['ratio (default cone)'] && a.errors === 0,
    `ratio off ${h['ratio, off']}, ratio + default cone ${h['ratio (default cone)']}, ratio + cone alone ${h['ratio, cone alone']}`);
  const b = await run(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0&hit=final`, [['off', { ...off, hitShading: 'off' }], ['cone', { ...coneAlone, hitShading: 'off' }], ['off again', { ...off, hitShading: 'off' }]]);
  check("ssr hitColorFilter 'cone' with hitColor 'history' and hitShading 'off' (the pyramid of last frame's colour)",
    b.out.cone.active && b.out.cone.hash !== b.out.off.hash && Math.abs(b.out.cone.mean / b.out.off.mean - 1) < 0.1 && b.errors === 0,
    `off ${b.out.off.hash} / cone ${b.out.cone.hash}, mean ratio ${(b.out.cone.mean / b.out.off.mean).toFixed(4)}; GPU errors ${b.errors}`);
  const c = await run(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0&hit=current&rt=1`, [['unset', {}], ['off', off], ['cone', coneAlone], ['comp 0.5', comp], ['unset again', {}]], 'contact');
  check("ssr hitColorFilter 'cone' with ?rt=1 (traced pass after the tracer): unset = explicit cone + compensation 0.5, stable; off and the cone alone differ",
    c.out.cone.active && c.out.unset.active && c.out.unset.hash === c.out['unset again'].hash && c.out.unset.hash === c.out['comp 0.5'].hash
    && c.out.cone.hash !== c.out.unset.hash && c.out.off.hash !== c.out.unset.hash && c.errors === 0,
    `${JSON.stringify(Object.fromEntries(Object.entries(c.out).map(([k, v]) => [k, v.hash])))}; GPU errors ${c.errors}`);
  const d = await run(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0&hit=current&w=97&h=61`, [['off', off], ['cone', {}]], 'mirrorWall');
  check("ssr hitColorFilter 'cone' on a 97x61 canvas (odd sizes, a short pyramid)", d.out.cone.active && d.errors === 0, `active ${d.out.cone.active}, GPU errors ${d.errors}`);
  if (fs.existsSync(path.join(ROOT, 'examples/pixi3d/vendor/package.json'))) {
    const q = await openPage(`http://127.0.0.1:${PORT}/pixi3d/arcade/`);
    pages.push(q);
    // W76: the pixi adapter gets the core defaults (cone + compensation 0.5) with no settings, and 'off' still switches it off
    const r = await q.T(`(async () => { const P = window.__p; P.stop();
      let active = false; for (let i = 0; i < 60 && !active; i++) { await P.step(1); active = !!P.view.ssr.core.outputs.hitColorFilterActive; await new Promise((r) => setTimeout(r, 100)); }
      const ran = P.view.ssr.core.outputs.settings ?? {};
      P.view.ssr.settings.hitColorFilter = 'off'; await P.step(2); const off = !P.view.ssr.core.outputs.hitColorFilterActive;
      delete P.view.ssr.settings.hitColorFilter; await P.step(2);
      return { active, off, back: !!P.view.ssr.core.outputs.hitColorFilterActive, ran: { hitColorFilter: ran.hitColorFilter, mirrorBias: ran.mirrorBias, mirrorBiasCompensate: ran.mirrorBiasCompensate }, errors: P.gpuErrors.length }; })()`);
    check("pixi3d arcade: the cone + compensation 0.5 is the default without settings, 'off' turns it off without a rebuild (W72, W76)",
      r.active && r.off && r.back && r.ran.hitColorFilter === 'cone' && r.ran.mirrorBias === 0.5 && r.ran.mirrorBiasCompensate === true && r.errors === 0, JSON.stringify(r));
  }
}

async function mirrorBiasChecks(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0`);
  pages.push(p);
  await p.T("window.__p.load('roughnessRamp')");
  await p.T("window.__p.setPose('strips')");
  // occupancy 0: with the occupancy exit, which rays share a subgroup (atomic list order) changes the output run to run (D301)
  // W76: D49's truncation is the knob with the cone off (with the default cone + compensation the bias narrows the lobe instead)
  await p.T("window.__p.setSettings({ minTraversalOccupancy: 0, temporalVarianceGuidedTracing: false, hitColorFilter: 'off' })");
  await p.T('window.__p.step(4)');
  const h = {};
  for (const [k, b] of [['unset', null], ['unset again', null], ['0', 0], ['0.5', 0.5]]) {
    await p.T(b === null ? '(delete window.__p.ssr.settings.mirrorBias, true)' : `window.__p.setSettings({ mirrorBias: ${b} })`);
    h[k] = await p.T('window.__p.radianceHash(7)');
  }
  await p.T('(["mirrorBias", "minTraversalOccupancy", "temporalVarianceGuidedTracing"].forEach((k) => delete window.__p.ssr.settings[k]), true)');
  check("ssr mirrorBias (hitColorFilter 'off'): 0 is the default path, 0.5 changes the rays", h.unset === h['unset again'] && h.unset === h['0'] && h['0'] !== h['0.5'], JSON.stringify(h));
  const q = await p.T('window.__p.mirrorBiasStats({ biases: [0, 0.5], bins: [0.2, 0.3, 0.4], frames: 16, refFrames: 32, denoise: [false] })');
  const [b0, b5] = q.results;
  const ratio = b0.bins.map((b, k) => b5.bins[k].std / b.std);
  await p.T('(delete window.__p.ssr.settings.hitColorFilter, true)');
  check("ssr mirrorBias 0.5 (hitColorFilter 'off', D49): less raw noise on the roughnessRamp strips (r 0.2-0.4)", ratio.every((r) => r < 0.9) && b0.bins.every((b) => b.px > 1000),
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
    // with the library's limits the pipeline builds: the probe lookup's includes are kept once and the hit
    // shading's copy has its own names (W64, D4901; before, 'redeclaration of pl_faceDirUV')
    check(`sssr limits: a ${l.sampled.atlases}-size probe set as fallback + hit shading (18 sampled textures) throws a clear error at ${l.sampled.limit}, builds without errors with reflectionsRequiredLimits (W62, D4900; W64, D4901)`,
      l.sampled.atlases === 4 && !!l.sampled.threw && /maxSampledTexturesPerShaderStage/.test(l.sampled.threw) && /18 sampled textures/.test(l.sampled.threw) && !l.sampled.validationError
        && (l.sampledRaised.skipped !== undefined || (!l.sampledRaised.threw && !l.sampledRaised.validationError)),
      `default: ${d(l.sampled)}; library limits (${l.sampledRaised.limit ?? '-'}): ${d(l.sampledRaised)}`);
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
  // W76: these compare hit shading on the same rays, calibrated on the pre-W76 ray set (D901's +-10 %): the new
  // defaults (narrower compensated sample, 'relative' thickness with RT) move which pixels are traced (contact
  // @pmndrs/bvh 1.08 -> 1.10), so this runs the pre-W76 tracer
  await p.T("(window.__p.setSettings({ hitColorFilter: 'off', thicknessDepthFactor: 0 }), true)");
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
  await p.T("(['hitColorFilter', 'thicknessDepthFactor'].forEach((k) => delete window.__p.ssr.settings[k]), true)");
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

/**
 * W49 (D1701 / D1702): per-triangle materials at traced hits. examples/ssr's `multiMaterial` scene:
 * one box geometry whose groups take two materials (red, green emissive), on two boxes with the
 * array swapped, and a one-material sphere. Every material must come back at its own triangles
 * (`traceHitMaterial` vs three's `face.materialIndex`), camera rays and rays spread through the scene.
 * With `oracle`, also rtOracle on the scene (triangle, instance and material ids vs THREE.Raycaster).
 */
async function rtMaterialChecks(p, label, oracle) {
  const b = results.logs.length;
  await p.T("window.__p.load('multiMaterial')");
  await p.T('window.__p.step(2)');
  const fmt = (r) => r.materials.map((m) => `${m.material}${m.multi ? '' : ' (alone)'} ${m.own}/${m.hits}${m.multi ? ` (first material's colour ${m.first})` : ''}`).join(', ');
  for (const kind of ['camera', 'scene']) {
    const r = await p.T(`window.__p.rtMaterialCheck(4096, '${kind}')`);
    const e = results.logs.slice(b).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
    const multi = r.materials.filter((m) => m.multi);
    check(`rt ${label}: each material of a multi-material mesh at its own triangles, ${kind} rays (D1701)`,
      e.length === 0 && multi.length === 2 && r.materials.every((m) => m.hits > 0 && m.own >= m.hits * 0.995),
      e.length ? e.slice(0, 2).join(' | ') : `of ${r.compared} hits (${r.multiMaterialMeshes} multi-material meshes, ${r.groups} groups): ${fmt(r)}`);
  }
  if (oracle) {
    const o = await p.T("window.__p.rtOracle(4096, 'camera')");
    check(`rt ${label}: multiMaterial vs THREE.Raycaster, camera rays (triangle, instance, material ids)`, oracle(o),
      `${o.agree}/${o.rays} agree; of ${o.compared} hits: triangle ${o.triangle}, instance ${o.instance}, material ${o.material}`);
  }
  // the final image with screen space off (no traversal steps: every reflection ray is traced)
  const was = await p.T('window.__p.ssr.settings.maxTraversalIntersections');
  await p.T("window.__p.setView('final')");
  await p.T('window.__p.setSettings({ maxTraversalIntersections: 0 })');
  await p.T('window.__p.step(2)');
  savePng(`ssr-rt-multi-material-${label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}.png`, await p.T('window.__p.shot()'));
  await p.T(was == null ? 'delete window.__p.ssr.settings.maxTraversalIntersections' : `window.__p.setSettings({ maxTraversalIntersections: ${was} })`);
  await p.T("window.__p.setView('grid')");
}

/**
 * W49: does any real asset have a multi-material mesh, and do its hits carry the right material?
 * Opt-in (`--rt-material-assets`): loads every downloaded asset scene on the page's provider.
 */
async function rtMaterialAssetSurvey(p, label) {
  // `--rt-material-ids chess,helmet` narrows it (each asset loads and bakes: ~1-3 minutes)
  const want = args.includes('--rt-material-ids') ? args[args.indexOf('--rt-material-ids') + 1].split(',') : null;
  const ids = ((await p.T('window.__p.assets ? window.__p.assets() : []')) ?? []).filter((id) => !want || want.includes(id));
  for (const id of ids) {
    await p.T(`window.__p.load(${JSON.stringify(id)})`);
    await p.T('window.__p.step(1)');
    const r = await p.T("window.__p.rtMaterialCheck(4096, 'camera')");
    const wrong = r.materials.reduce((n, m) => n + m.hits - m.own, 0);
    console.log(`  (info) rt ${label} materials, ${id}: ${r.meshes} meshes, ${r.multiMaterialMeshes} with a material array (${r.groups} groups); ${r.compared} camera hits on ${r.materials.length} materials, ${wrong} with another material's colour`);
  }
}

/** `--only rt-materials`: {@link rtMaterialChecks} on three-mesh-bvh and @pmndrs/bvh (auto, tinybvh), each on its own page. */
async function rtMaterialsAlone(pages) {
  console.log('examples/ssr (?rt=1, multiMaterial):');
  const oracleOk = (o) => o.agree / o.rays > 0.995 && [o.triangle, o.instance, o.material].every((k) => k >= o.compared * 0.995);
  for (const [bvhParam, builder] of [['&bvh=three-mesh-bvh', null], ['&bvh=pmndrs', 'auto'], ['&bvh=pmndrs', 'tinybvh']]) {
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&view=grid&rt=1${bvhParam}${builder ? `&bvhBuilder=${builder}` : ''}&probeRes=128&scene=multiMaterial`);
    pages.push(p);
    const bvh = await p.T('window.__p.bvh');
    const label = builder ? `@pmndrs/bvh (${bvh.builder})` : 'three-mesh-bvh port';
    // the survey (materials arrays are the scene's, not the walk's) on the first provider only
    if (args.includes('--rt-material-assets')) { await rtMaterialAssetSurvey(p, label); return; }
    await rtMaterialChecks(p, label, builder ? oracleOk : null);
  }
}

/** W74 (X4, D5060): traceSettings.tracedMissRate 'half' on contact (glossy floor): fewer traced rays, the skipped quads filled. */
async function halfRateChecks(p) {
  const before = results.logs.length;
  await p.T("window.__p.load('contact')");
  await p.T("window.__p.setTraceSettings({ tracedMissRate: 'full' })");
  await p.T('window.__p.step(3)');
  const full = await p.T('window.__p.traceStats()');
  await p.T("window.__p.setTraceSettings({ tracedMissRate: 'half' })");
  await p.T('window.__p.ssr.traced.prepareHalfRate()'); // the fill compiles asynchronously (review fix 4)
  await p.T('window.__p.step(3)');
  const half = await p.T('window.__p.traceStats()');
  await p.T('window.__p.setTraceSettings({})');
  const errs = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|error/i.test(l));
  check("rt tracedMissRate 'half': fewer traced rays, the skipped quads filled from their traced neighbours, no validation errors",
    errs.length === 0 && half.halfRateSkipped > 0 && half.traced < full.traced && half.filled > 0 && half.filled > 4 * half.fillFallbacks && half.fillOverflow === 0,
    errs.length ? errs.slice(0, 2).join(' | ') : `traced ${full.traced} -> ${half.traced}, ${half.halfRateSkipped} quads on the fill list, ${half.filled} px filled, ${half.fillFallbacks} kept the probe, overflow ${half.fillOverflow}`);
  // W74 review fix 6: content. A still frame (frameIndex fixed, no occupancy exit, AA off) at full and at half rate:
  // only the filled px differ. Per px a fill vs that px's own full-rate ray is sample noise (~1x the mean), so the
  // check reads means: the signed radiance bias over the changed px and the 8x8 block means (docs/research/w74/scripts/content.js).
  // W74 contact (stochastic fill): bias -0.08 over the changed px, almost all of it the 583 fallback px (black in three's
  // radiance; the composite adds their probe); successful fills alone +0.7 % (docs/research/w74/scripts/bias.js),
  // blocks 0.14, confidence 0.665 vs 0.706 (the confidence-0 bug of 4e7e6dd would read ~0).
  const aaMode = await p.T('window.__p.aa.mode');
  await p.T("window.__p.setAA('off')");
  const body = fs.readFileSync(path.join(ROOT, 'docs/research/w74/scripts/content.js'), 'utf8');
  const c = await p.T(`(async () => { const P = window.__p; const SCENE = 'contact'; ${body} })()`);
  await p.T(`window.__p.setAA(${JSON.stringify(aaMode)})`);
  check("rt tracedMissRate 'half': filled px match full-rate tracing on average (contact, still frame: radiance bias and 8x8 block means)",
    c.changed > 1000 && c.bias > -0.3 && c.bias < 0.3 && c.blockErr < 0.3 && c.confHalf > 0.7 * c.confFull,
    `${c.changed} px changed (${c.filled} filled, ${c.fallbacks} kept the probe): bias ${(c.bias * 100).toFixed(1)} %, 8x8 block mean error ${(c.blockErr * 100).toFixed(1)} % over ${c.blocks} blocks, confidence ${c.confHalf.toFixed(3)} vs ${c.confFull.toFixed(3)}`);
}

async function ssrRtChecks(pages) {
  console.log('examples/ssr (?rt=1):');
  // probes at 128 px: the size W25 / W28 measured the hit-shading checks at (the page follows the
  // 256 px default since 443e35d; at 256 contact's D901 ratio reads 1.10 with @pmndrs/bvh, HANDOFF backlog)
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&view=grid&rt=1&bvh=three-mesh-bvh&probeRes=128`);
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
  await halfRateChecks(p); // W74 (X4, D5060)
  await rtMaterialChecks(p, 'three-mesh-bvh port'); // W49 (D1701 / D1702)
  if (args.includes('--rt-material-assets')) await rtMaterialAssetSurvey(p, 'three-mesh-bvh');
  if (args.includes('--rt-shadow-timing')) await rtShadowTiming('three-mesh-bvh', '&bvh=three-mesh-bvh');
  await missFillChecks(pages);
  await offscreenFillChecks(pages);
  await rtHitAtlasChecks(pages); // W47 (D4702)

  // GPU ms vs miss count at 1080p: the same frame, misses varied with the miss-list threshold
  const big = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&timing&w=1920&h=1080&rt=1&bvh=three-mesh-bvh&scene=offscreen&pose=mirror`);
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
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&rt=1&bvh=three-mesh-bvh&denoise=0&scene=facingMirrors`);
  pages.push(p);
  const r = await p.T(`(${MISS_FILL})(['default', 'left'], { all: { include: true }, kit: {} })`);
  const line = (k) => `${k}: ${r[k].kit.px} miss px, all captured ${r[k].all.mad.toFixed(2)} -> kit ${r[k].kit.mad.toFixed(2)}`;
  check('facingMirrors: the probe fallback in the SSR misses stays near the ray-traced fill (objects out of the captures, D4301)',
    ['default', 'left'].every((k) => r[k].kit.px > 10000 && r[k].kit.mad < MISS_FILL_MAX[k] && r[k].kit.mad < r[k].all.mad - 1),
    `mean abs diff / 255 vs rt=1 over the misses; ${line('default')}; ${line('left')} (limits ${JSON.stringify(MISS_FILL_MAX)})`);
}
/**
 * `--only halo-options` (W52, D3640-D3642): the halo options run and do what they say, RT on,
 * denoiser and AA off, a fixed frame index so two runs trace the same rays.
 * - hitShadeVisibility 'all': facingMirrors' mirror seen in a mirror takes the visibility ray (the
 *   facing mirror blocks R: black stripes) where 'offscreen' (default) leaves it lit.
 * - hitShadeOcclusion 'screen': an occlusion test only darkens (contact scene, final view).
 * - hitLobeFilterMixed 0: rebuilds the tracer with last frame's hit source and changes the glossy px
 *   next to traced hits, without validation errors.
 */
// One frame with these settings; with `keep` the pixels stay on the page as the reference, else the
// page returns the share of px > 2/255 darker / brighter in luma than that reference (no pixel arrays
// over CDP: a 1100x900 frame by value took minutes).
const HALO_FRAME = `async (settings, trace, keep) => {
  const p = window.__p;
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  p.setSettings({ frameIndex: 7, hitShadeOcclusion: 'off', hitLobeFilterMixed: 1, ...settings });
  p.setTraceSettings(trace);
  p.setView('final');
  await p.step(4);
  const B = await px(await p.shot());
  const facing = (await p.stats()).facing;
  if (keep) { window.__haloRef = B; return { facing }; }
  const A = window.__haloRef, lum = (a, k) => 0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2];
  let darker = 0, brighter = 0, n = 0;
  for (let k = 0; k < A.length; k += 4) { n++; const d = lum(B, k) - lum(A, k); if (d < -2) darker++; else if (d > 2) brighter++; }
  return { facing, darker: darker / n, brighter: brighter / n };
}`;
async function haloOptionChecks(pages) {
  const fm = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&rt=1&denoise=0&aa=off&scene=facingMirrors`);
  pages.push(fm);
  const off = await fm.T(`(${HALO_FRAME})({}, {}, true)`);
  const all = await fm.T(`(${HALO_FRAME})({}, { hitShadeVisibility: 'all' }, true)`);
  check('halo options: hitShadeVisibility all gives on-screen re-shaded hits the visibility ray (facingMirrors mirror in mirror, D3640)',
    off.facing.pixels > 1000 && off.facing.black < 0.05 && all.facing.black > 0.2,
    `${off.facing.pixels} px of the left mirror reflecting the right one: black ${(off.facing.black * 100).toFixed(1)}% (lum ${off.facing.meanLum.toFixed(3)}) with 'offscreen' -> ${(all.facing.black * 100).toFixed(1)}% (lum ${all.facing.meanLum.toFixed(3)}) with 'all'`);
  const ct = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&rt=1&denoise=0&aa=off&scene=contact`);
  pages.push(ct);
  await ct.T(`(${HALO_FRAME})({}, {}, true)`);
  const dOcc = await ct.T(`(${HALO_FRAME})({ hitShadeOcclusion: 'screen' }, {}, false)`);
  check('halo options: hitShadeOcclusion screen only darkens re-shaded hits (contact, D3642)', dOcc.darker > 0.001 && dOcc.brighter < 0.0005,
    `px > 2/255 darker ${(dOcc.darker * 100).toFixed(2)}%, brighter ${(dOcc.brighter * 100).toFixed(3)}%`);
  await ct.T(`(${HALO_FRAME})({ hitLobeFilterMixed: 0 }, {}, false)`); // the tracer rebuilds with the hit source; next frames read it
  const dMix = await ct.T(`(${HALO_FRAME})({ hitLobeFilterMixed: 0 }, {}, false)`);
  check('halo options: hitLobeFilterMixed 0 changes the glossy px next to traced hits (contact, D3641)', dMix.darker + dMix.brighter > 0.0005,
    `px > 2/255 darker ${(dMix.darker * 100).toFixed(2)}%, brighter ${(dMix.brighter * 100).toFixed(2)}%`);
}

/**
 * `--only hit-source` (W53, D3660-D3662): the showcase, carConcept at W50's view, RT on, AA off,
 * 960x540. Off, the seam hands the denoiser no hit source; on (`setHitSource`), it builds one with
 * screen-space and traced codes, the FFX denoiser takes it, and the frame changes, with no
 * validation errors. Skipped (a note) when the denoiser has no `setOptions` (Denoiser repo before W53).
 */
async function hitSourceChecks(pages) {
  const sc = await openPage(`http://127.0.0.1:${PORT}/showcase/?manual&scene=carConcept&rt=1&aa=off&w=960&h=540`);
  pages.push(sc);
  const r = await sc.T(`(async () => {
    const p = window.__p;
    if (!p.hybrid.denoiser?.setOptions) return { skip: true };
    const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
    const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    p.stop(); await p.setSources({ rt: true }); p.setCamera([0.491, 2.302, 5.617], [0, 0.25, 0]);
    await p.step(60);
    const A = await px(await p.shot());
    const offSource = p.hybrid.denoiseSeam.hitSource;
    p.setHitSource({ hitSource: true }); await p.step(60);
    const B = await px(await p.shot());
    const t = p.hybrid.denoiseSeam.hitSource, dev = p.ssr.device;
    const bpr = Math.ceil(t.width * 4 / 256) * 256;
    const buf = dev.createBuffer({ size: bpr * t.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder(); enc.copyTextureToBuffer({ texture: t }, { buffer: buf, bytesPerRow: bpr }, [t.width, t.height]); dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const counts = [0, 0, 0, 0];
    const raw = buf.getMappedRange();
    for (let y = 0; y < t.height; y++) { const f = new Float32Array(raw, y * bpr, t.width); for (const v of f) counts[Math.min(3, Math.max(0, Math.round(v)))]++; }
    buf.unmap(); buf.destroy();
    const lum = (a, k) => 0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2];
    let changed = 0; for (let k = 0; k < A.length; k += 4) if (Math.abs(lum(A, k) - lum(B, k)) > 2) changed++;
    p.setHitSource({ hitSource: false }); await p.step(2);
    return { offSource: !!offSource, counts, changed: changed / (A.length / 4), opts: p.hybrid.denoiser.options, offAgain: !!p.hybrid.denoiseSeam.hitSource, errors: p.gpuErrors.length };
  })()`);
  if (r.skip) { console.log('  note: hit-source skipped (the denoiser has no setOptions: point DENOISER_REPO at the W53 branch)'); return; }
  const n = r.counts.reduce((a, b) => a + b, 0);
  check('hit source (W53): off, the seam hands the denoiser none; on, screen-space and traced codes and the frame changes; off again clears the FFX option and the input',
    !r.offSource && r.counts[1] > 0.01 * n && r.counts[2] > 0.01 * n && r.counts[3] === 0 && r.opts.separateHitSources === false && !r.offAgain && r.changed > 0.001 && r.errors === 0,
    `codes miss ${(r.counts[0] / n * 100).toFixed(1)}% / screen ${(r.counts[1] / n * 100).toFixed(1)}% / traced ${(r.counts[2] / n * 100).toFixed(1)}%; px changed > 2/255: ${(r.changed * 100).toFixed(2)}%; errors ${r.errors}`);
}

/**
 * `--only brdf-prefilter` (W78, D5140-D5146): examples/ssr mirrorWall, floor r 0.3, AA off, denoiser on. Off, the
 * tracer writes no sample direction; with `denoiserBrdf: 'replace'` (and the gate at 0, so every glossy px takes the
 * weights) most glossy px carry a sample (pdf > 0, unit direction) and the denoised output changes; at
 * reflectionResolution 'half' the hybrid warns once that it doesn't hand the direction on. No validation errors.
 * Skipped (a note) when the denoiser has no `brdfWeights` option (Denoiser repo before W78).
 */
async function brdfPrefilterChecks(pages) {
  const pg = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=1&aa=off`);
  pages.push(pg);
  const r = await pg.T(`(async () => {
    const p = window.__p;
    if (!p.hybrid.denoiser || !('brdfWeights' in p.hybrid.denoiser.options)) return { skip: true };
    const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, s = (h & 0x8000) ? -1 : 1; return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15); };
    const read = async (tex) => {
      const dev = p.ssr.device, bytes = tex.format === 'rgba16float' ? 8 : tex.format === 'rgba32float' ? 16 : 4, ch = bytes === 4 ? 1 : 4;
      const bpr = Math.ceil(tex.width * bytes / 256) * 256;
      const buf = dev.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = dev.createCommandEncoder(); enc.copyTextureToBuffer({ texture: tex, aspect: tex.format.startsWith('depth') ? 'depth-only' : 'all' }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]); dev.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const dv = new DataView(buf.getMappedRange()), out = new Float32Array(tex.width * tex.height * ch);
      for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) for (let c = 0; c < ch; c++) { const o = y * bpr + x * bytes; out[(y * tex.width + x) * ch + c] = bytes === 8 ? half(dv.getUint16(o + c * 2, true)) : dv.getFloat32(o + c * 4, true); }
      buf.unmap(); buf.destroy(); return out;
    };
    const warns = []; const warn0 = console.warn; console.warn = (...a) => { warns.push(String(a[0])); warn0(...a); };
    await p.load('mirrorWall'); p.setFloorRoughness(0.3);
    // deterministic frames (a fixed blue-noise frame, FFX's occupancy exit off), so off vs off is equal and any change is the option's
    const keep = { ...p.ssr.settings, frameIndex: 5, minTraversalOccupancy: 0 };
    const runOff = async () => { p.ssr.settings = { ...keep, denoiserBrdf: 'off' }; p.ssr.resetHistory(); p.hybrid.resetHistory(); await p.step(40); return read(p.renderer.backend.get(p.hybrid.denoised).texture); };
    await runOff();
    const offSample = !!p.ssr.tracer.outputs.sampleDirection;
    const A = await runOff();
    const A2 = await runOff();
    const t = p.ssr.gbuffer.gpuTextures(); const [dep, nr] = [await read(t.depth), await read(t.normal)];
    const inv = p.ssr.gbuffer.conventions.depthInverted;
    p.ssr.settings = { ...keep, denoiserBrdf: 'replace', denoiserBrdfMin: 0 }; p.ssr.resetHistory(); p.hybrid.resetHistory(); await p.step(40);
    const S = p.ssr.tracer.outputs.sampleDirection; const sm = S ? await read(S) : null;
    const B = await read(p.renderer.backend.get(p.hybrid.denoised).texture);
    let glossy = 0, withPdf = 0, unit = 0, changed = 0, nonFinite = 0, offDiff = 0;
    const lum = (f, i) => 0.2126 * f[i * 4] + 0.7152 * f[i * 4 + 1] + 0.0722 * f[i * 4 + 2];
    for (let i = 0; i < dep.length; i++) {
      if ((inv ? dep[i] <= 0 : dep[i] >= 1) || !(nr[i * 4 + 3] < 0.447)) continue;
      glossy++;
      if (sm && sm[i * 4 + 3] > 0) { withPdf++; if (Math.abs(Math.hypot(sm[i * 4], sm[i * 4 + 1], sm[i * 4 + 2]) - 1) < 1e-3) unit++; }
      const b = lum(B, i); if (!Number.isFinite(b)) nonFinite++; else if (Math.abs(b - lum(A, i)) > 0.01 * Math.max(lum(A, i), 0.05)) changed++;
      if (Math.abs(lum(A2, i) - lum(A, i)) > 0.01 * Math.max(lum(A, i), 0.05)) offDiff++;
    }
    await p.setResolution('half'); await p.step(4);
    const halfWarned = warns.some((w) => w.includes("isn't handed on at reflectionResolution 'half'"));
    await p.setResolution('full'); delete keep.frameIndex; delete keep.minTraversalOccupancy; p.ssr.settings = keep; await p.step(2);
    console.warn = warn0;
    return { offSample, hasSample: !!S, glossy, withPdf, unit, changed, offDiff, nonFinite, halfWarned, errors: p.gpuErrors.length };
  })()`);
  if (r.skip) { console.log('  note: brdf-prefilter skipped (the denoiser has no brdfWeights: point DENOISER_REPO at the W78 branch)'); return; }
  check('BRDF prefilter (W78): off, no sample direction; on, most glossy px carry a unit direction and pdf > 0, and the denoised output changes; no NaN, no validation errors',
    !r.offSample && r.hasSample && r.withPdf > 0.8 * r.glossy && r.unit === r.withPdf && r.offDiff < 0.001 * r.glossy && r.changed > 0.05 * r.glossy && r.nonFinite === 0 && r.errors === 0,
    `glossy px ${r.glossy}: with pdf ${(r.withPdf / r.glossy * 100).toFixed(1)}%, unit ${r.unit === r.withPdf}; denoised changed > 1%: ${(r.changed / r.glossy * 100).toFixed(1)}% (off vs off: ${(r.offDiff / r.glossy * 100).toFixed(2)}%); non-finite ${r.nonFinite}; errors ${r.errors}`);
  check("BRDF prefilter (W78): at reflectionResolution 'half' the hybrid warns that the direction isn't handed on", r.halfWarned && r.errors === 0, `warned ${r.halfWarned}`);
}

/** D4301: limits for {@link missFillChecks}, from W37's measurement (see DIVERGES D4301). */
const MISS_FILL_MAX = { default: 22.5, left: 27 };

/**
 * W38 (D4400): offscreen keeps its emissives in the probe captures and places them with probes (a
 * floor probe lidded at the ring's height, a wall-mirror probe). Per pose, over the SSR miss px
 * (RT off), the RT-off `final` against the same frame with `?rt=1`: mean abs diff / 255, and the
 * ring's px (warm: r > 200, r - b > 60) in the RT frame, the RT-off frame and both. `single` bakes
 * the room's probe alone (the kit before W38, emissives in) for the comparison.
 */
const OFFSCREEN_FILL = `async (poses, rects, variants = { single: { probes: [0] }, kit: {} }, ringRects = {}) => {
  const p = window.__p;
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const px = async (u) => { const i = await load(u); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  const warm = (d, k) => d[k] > 200 && d[k] - d[k + 2] > 60;
  p.setHitColor('current'); p.setDenoise(false);
  const out = {};
  for (const pose of poses) {
    p.setPose(pose);
    p.setRT(false); p.setView('misses'); await p.step(3);
    const M = await px(await p.shot());
    p.setView('final');
    out[pose] = {};
    // a variant: some of the kit's probes ('probes', indices), per-probe sizes ('sizes', W60) and the
    // set's default size ('resolution'); {} is the kit as it ships
    for (const [name, v] of Object.entries(variants)) {
      const volumes = (v.probes ? v.probes.map((i) => p.kit.probes[i]) : p.kit.probes).map((x, i) => (v.sizes ? { ...x, resolution: v.sizes[i] } : x));
      const baked = await p.setProbeVolumes(volumes, v.resolution ? { resolution: v.resolution } : {});
      p.setRT(true); await p.step(3);
      const R = await px(await p.shot());
      p.setRT(false); await p.step(3);
      const F = await px(await p.shot());
      const rc = rects[pose], W = 960;
      // W60: the floor ring alone (ringRects[pose], all px, not only misses): its warm px in each frame
      const rr = ringRects[pose];
      let ring = null;
      if (rr) {
        ring = { rt: 0, off: 0, both: 0 };
        for (let y = rr[1]; y < rr[3]; y++) for (let x = rr[0]; x < rr[2]; x++) {
          const k = (y * W + x) * 4, a = warm(R, k), b = warm(F, k);
          ring.rt += a; ring.off += b; ring.both += a && b;
        }
      }
      let n = 0, d = 0, ringRT = 0, ringOff = 0, both = 0;
      for (let k = 0; k < M.length; k += 4) {
        if (!(M[k] > 200 && M[k + 1] < 80 && M[k + 2] < 80)) continue;
        const x = (k >> 2) % W, y = ((k >> 2) / W) | 0;
        if (rc && !(x >= rc[0] && y >= rc[1] && x < rc[2] && y < rc[3])) continue;
        n++; d += (Math.abs(F[k] - R[k]) + Math.abs(F[k + 1] - R[k + 1]) + Math.abs(F[k + 2] - R[k + 2])) / 3;
        const a = warm(R, k), b = warm(F, k);
        ringRT += a; ringOff += b; both += a && b;
      }
      out[pose][name] = { px: n, mad: n ? d / n : 0, ringRT, ringOff, both, probes: p.probes.bakedProbes.length, sizes: p.probes.bakedResolutions, bytes: baked.bytes, bakeMs: baked.ms, ring };
    }
  }
  p.setView('grid');
  return out;
}`;

/**
 * D4400: limits for {@link offscreenFillChecks}: the measurement plus ~1 / 255 (W60, floor and wall
 * mirror probes at 512 px: default 17.34, the wall mirror's upper part 13.27; W38 at 256: 17.8 / 13.4),
 * and below the room probe alone by a margin (26.7 / 17.5). The
 * 'mirror' pose counts only the wall mirror's upper part (the bars and the glow sphere, 960x540 px
 * [335, 185, 630, 300]): below it the mirror shows the floor, where the RT reference is black (a
 * metal hit seen in a mirror, D3513).
 */
const OFFSCREEN_FILL_MAX = { default: 18.3, mirror: 14.2 }; // W60: 17.34 / 13.27 with the floor and mirror probes at 512 (was 19 / 14.5 over W38's 17.8 / 13.4)
const OFFSCREEN_FILL_MARGIN = { default: 5, mirror: 2 };
const OFFSCREEN_FILL_RECT = { mirror: [335, 185, 630, 300] };
/** W60: the floor ring's box in the default view (960x540), for its warm px alone (the miss-wide count also takes the wall mirror's yellow bar). */
const OFFSCREEN_RING_RECT = { default: [390, 430, 570, 540] };

/**
 * W60 (D4700): offscreen with per-probe sizes (kit order: room, floor, wall mirror). Each variant is a
 * clean bake (`setProbeVolumes`); per pose W38's numbers ({@link OFFSCREEN_FILL}) plus the atlas bytes
 * and bake ms, then GPU ms of three's render passes at 960x540 (`?gpuTime`, loop stopped, median of
 * 30; the G-buffer runs every material's probe lookup, the composite its own). JSON to out/w60-offscreen.json.
 * `pnpm check -- --only offscreen-sizes`.
 */
const OFFSCREEN_SIZE_VARIANTS = {
  all256: { sizes: [256, 256, 256] },
  floor512: { sizes: [256, 512, 256] },
  floor512mirror512: { sizes: [256, 512, 512] },
  all512: { sizes: [512, 512, 512], resolution: 512 },
  floor1024: { sizes: [256, 1024, 256] },
};
async function offscreenSizeMeasure(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&rt=1&bvh=three-mesh-bvh&denoise=0&gpuTime&scene=offscreen`);
  pages.push(p);
  const r = await p.T(`(${OFFSCREEN_FILL})(['default', 'mirror'], ${JSON.stringify(OFFSCREEN_FILL_RECT)}, ${JSON.stringify(OFFSCREEN_SIZE_VARIANTS)}, ${JSON.stringify(OFFSCREEN_RING_RECT)})`);
  const timing = {};
  for (const [name, v] of Object.entries(OFFSCREEN_SIZE_VARIANTS)) {
    timing[name] = await p.T(`(async () => { const p = window.__p; p.setPose('default'); p.setRT(false); p.setView('final');
      const vols = p.kit.probes.map((x, i) => ({ ...x, resolution: ${JSON.stringify(v.sizes)}[i] }));
      const bakes = [];
      for (let k = 0; k < 3; k++) bakes.push((await p.setProbeVolumes(vols, ${v.resolution ? `{ resolution: ${v.resolution} }` : '{}'})).ms);
      bakes.sort((a, b) => a - b);
      // the shots as the metric takes them (3 frames after a clean bake), then the timing
      p.setRT(true); await p.step(3); const on = await p.shot();
      p.setRT(false); await p.step(3); const off = await p.shot();
      p.setView('noSSR'); await p.step(3); const noSSR = await p.shot(); p.setView('ssr'); await p.step(3); const ssrv = await p.shot(); p.setView('final');
      const render = await p.renderTime(30);
      return { render, bakeMs: bakes[1], bakes, off, on, noSSR, ssrv }; })()`);
    savePng(`w60-offscreen-${name}-rtoff.png`, timing[name].off);
    savePng(`w60-offscreen-${name}-nossr.png`, timing[name].noSSR); savePng(`w60-offscreen-${name}-ssr.png`, timing[name].ssrv);
    delete timing[name].noSSR; delete timing[name].ssrv;
    if (name === 'all256') savePng('w60-offscreen-rt.png', timing[name].on);
    delete timing[name].off; delete timing[name].on;
  }
  for (const pose of ['default', 'mirror']) {
    for (const [name, v] of Object.entries(r[pose])) {
      console.log(`  offscreen ${pose} ${name} [${v.sizes}]: mad ${v.mad.toFixed(2)} over ${v.px} px; warm px rt ${v.ringRT}, rt-off ${v.ringOff}, both ${v.both}${v.ring ? `; floor ring rt ${v.ring.rt}, rt-off ${v.ring.off}, both ${v.ring.both}` : ''}; atlas ${(v.bytes / 1e6).toFixed(1)} MB${pose === 'default' ? `; bake ${timing[name].bakeMs.toFixed(1)} ms (${timing[name].bakes.map((x) => x.toFixed(1)).join(', ')}), render GPU ${timing[name].render?.ms?.toFixed(3)} ms (p10 ${timing[name].render?.p10?.toFixed(3)}, p90 ${timing[name].render?.p90?.toFixed(3)})` : ''}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'w60-offscreen.json'), JSON.stringify({ fill: r, timing }, null, 2));
}

/**
 * W61: probe layouts at an equal memory budget (examples/shared/probeLayouts.ts) on examples/ssr
 * `?probeLayout=`: every layout on rooms, offscreen and the showcase's Sponza (when its assets are
 * there) bakes and renders with no GPU errors; the non-shipped layouts' atlases are within 10 % of
 * the budget and equal to the plan; the debug views' volume weights sum to the composite's own
 * coverage (core's walk, so the views can't drift from the lookup); the views and the volume overlay
 * render. Then WebGPU's default 256 array layers per atlas: 41 probes + the environment at one size
 * bake, 42 throw the bake's own error (and the page keeps its set); 42 in an atlas without the
 * environment bake, 43 throw.
 */
const PROBE_LAYOUT_SCENES = [['rooms', 'default'], ['offscreen', 'default'], ['showcaseSponza', 'courtyard']];
/** Page-side: px stats of the views of the current set (probeCheck max, probeData count mean / max). */
const LAYOUT_VIEW_STATS = `async () => {
  const p = window.__p;
  const px = async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  const mark = (m) => { window.__w61 = m; };
  mark('check view'); p.setView('probeCheck'); await p.step(2); mark('check shot'); const C = await px(await p.shot());
  mark('data view'); p.setView('probeData'); await p.step(2); mark('data shot'); const D = await px(await p.shot());
  mark('stats');
  let checkMax = 0, geo = 0, sum = 0, max = 0, env = 0; const seen = new Set();
  for (let k = 0; k < D.length; k += 4) {
    checkMax = Math.max(checkMax, C[k]);
    if (D[k] === 0) continue; // background
    geo++; const n = D[k + 1]; sum += n; max = Math.max(max, n); if (n === 0) env++; seen.add(D[k] - 1);
  }
  // the shots stay in the page (window.__w61shots) and come back one per call: several Sponza PNGs in one
  // CDP reply (~5 MB) never arrived (W61: the page reached the end, the evaluation never returned)
  window.__w61shots = {};
  for (const v of ['final', 'probeIndex', 'probeCount']) { mark('shot ' + v); p.setView(v); await p.step(2); window.__w61shots[v] = await p.shot(); }
  mark('done');
  p.setView('final');
  return { checkMax, geo, countMean: geo ? sum / geo : 0, countMax: max, envOnly: env, dominantSeen: seen.size };
}`;
async function probeLayoutChecks(pages) {
  console.log('examples/ssr ?probeLayout (W61):');
  const sponza = await fetch(`http://127.0.0.1:${PORT}/assets/manifest.json`).then((r) => r.json()).then((l) => l.some((a) => a.dir === 'Sponza')).catch(() => false);
  const only = process.env.W61_SCENES?.split(',');
  for (const [scene, pose] of PROBE_LAYOUT_SCENES) {
    if (only && !only.includes(scene)) continue;
    if (scene === 'showcaseSponza' && !sponza) { console.log('  (no Sponza assets: showcaseSponza skipped)'); continue; }
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0&probeLayout=shipped&probeVolumes=1&scene=${scene}&pose=${pose}`);
    pages.push(p);
    const before = results.logs.length;
    const budget = await p.T('window.__p.layoutBudget');
    console.log(`  ${scene}: page ready (${new Date().toISOString().slice(11, 19)})`);
    for (const name of await p.T('window.__p.layoutNames()')) {
      const t0 = Date.now();
      const r = await p.T(`window.__p.setProbeLayout('${name}')`);
      const t1 = Date.now();
      const v = await p.T(`(${LAYOUT_VIEW_STATS})()`);
      if (process.env.W61_VERBOSE) console.log(`  ${scene} ${name}: bake + first frame ${((t1 - t0) / 1000).toFixed(1)} s, views ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      for (const k of ['final', 'probeIndex', 'probeCount']) savePng(`w61-${scene}-${name}-${k}.png`, await p.T(`window.__w61shots.${k}`));
      const errs = (await p.T('window.__p.gpuErrors')).length;
      const share = r.bytes / budget - 1;
      const memOk = name === 'shipped' || Math.abs(share) <= 0.1;
      check(`probe layout ${scene} '${name}': bakes and renders, ${name === 'shipped' ? 'the scene\'s own set' : 'atlases within 10 % of the budget'}, views' weights = the lookup's coverage`,
        errs === 0 && r.bytes === r.planned && memOk && v.checkMax <= 13 && v.geo > 1000 && v.countMax >= 1,
        `${r.probes} probes (${r.description}), ${(r.bytes / 1e6).toFixed(2)} MB (plan ${(r.planned / 1e6).toFixed(2)}, budget ${(budget / 1e6).toFixed(2)}, ${(share * 100).toFixed(1)} %), bake ${r.ms.toFixed(0)} ms; `
        + `|sum - coverage| x 50 max ${v.checkMax} / 255; volumes per px mean ${v.countMean.toFixed(2)}, max ${v.countMax}, env-only px ${v.envOnly}; ${v.dominantSeen} probes dominant somewhere${errs ? `; ${errs} GPU errors` : ''}`);
    }
    if (scene === 'rooms') {
      // WebGPU's default maxTextureArrayLayers (256): 6 layers per cube, so 42 cubes per atlas, the environment one of them in the set default's
      const limit = await p.T(`(async () => {
        const p = window.__p, lim = p.renderer.backend.device.limits.maxTextureArrayLayers;
        const grid = (n, res) => Array.from({ length: n }, (_, i) => ({ position: [-7.5 + (i % 8) * 2, 2.5, -3.5 + Math.floor(i / 8) * 1.4], influenceSize: [2, 5, 1.4], blendDistance: 0.2, resolution: res }));
        const tryBake = async (n, res, setRes) => { try { const b = await p.setProbeVolumes(grid(n, res), { resolution: setRes }); return { ok: true, probes: b.probes }; } catch (e) { return { ok: false, error: String(e.message ?? e).slice(0, 160), probes: p.probes?.bakedProbes.length ?? 0 }; } };
        const out = { lim, d41: await tryBake(41, 128, 128), d42: await tryBake(42, 128, 128), o42: await tryBake(42, 128, 256), o43: await tryBake(43, 128, 256) };
        await p.setProbeLayout('shipped'); await p.step(2); out.after = p.probes.bakedProbes.length;
        return out; })()`);
      check('probe sets at the array-layer limit: 41 + environment at one size bake, 42 throw a clear error; 42 in an atlas of their own bake, 43 throw (W61)',
        limit.d41.ok && limit.d41.probes === 41 && !limit.d42.ok && /array layers/.test(limit.d42.error) && limit.o42.ok && !limit.o43.ok && /array layers/.test(limit.o43.error) && limit.after === 3,
        `maxTextureArrayLayers ${limit.lim}; 41 x 128 (env 128): ${limit.d41.ok ? 'ok' : limit.d41.error}; 42 x 128 (env 128): ${limit.d42.ok ? 'baked' : `"${limit.d42.error}"`}, page kept its ${limit.d42.probes}; `
        + `42 x 128 (env 256): ${limit.o42.ok ? 'ok' : limit.o42.error}; 43 x 128 (env 256): ${limit.o43.ok ? 'baked' : 'throws'}; shipped re-baked after: ${limit.after}`);
    }
    const bad = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
    check(`probe layouts ${scene}: no validation errors or exceptions`, bad.length === 0, bad.slice(0, 2).join(' | '));
    p.close();
    pages.splice(pages.indexOf(p), 1);
  }
}

/**
 * W61 measurement (`--only probe-layouts-measure`): per scene, layout and pose on examples/ssr at
 * 960x540, denoise off, hit colour 'current':
 *  - error of the RT-off `final` against `?rt=1` over the px RT traced to a hit and that the RT frame
 *    shows lit (luma > 10 / 255: a traced hit on a metal or mirror is black, D3513). The traced hits are
 *    shaded by one fixed set (the scene's shipped volumes, all at 256 px: one atlas, so D4702 can't drop
 *    any) for every layout, so the reference moves only with the lit image both frames share;
 *  - seams: the same error split into px in a blend band (>= 2 volumes, or within 2 px of a change of
 *    dominant volume) and the rest; the gradient excess of RT-off over RT (mean |grad luma| difference)
 *    in the band; and the probe term's own gradient (view probeSpecular, glossy px) in the band / out of it;
 *  - volumes blended per px (mean, p99, max, histogram) over geometry;
 * plus bake ms (2 bounces, wall clock, 3 bakes) and GPU ms at 1920x1080, RT off, loop stopped (three's
 * passes, 30 frames, 3 repeats; the probe-free frame for the lookup's share; the core passes).
 * Sponza also against the path tracer on the showcase compare page ('probes' = the probe term alone,
 * 'ours-denoised' = SSR + probes with RT off, both vs 64 spp + OIDN over the glossy px).
 * JSON to out/w61-probe-layouts.json (merged per scene; W61_SCENES=rooms,offscreen and
 * W61_PARTS=error,timing,pt pick), contact sheets to out/w61-<scene>-<pose>-layouts.jpg.
 */
const PROBE_LAYOUT_MEASURE = {
  rooms: ['default', 'table', 'doorway'],
  offscreen: ['default', 'mirror'],
  showcaseSponza: ['courtyard', 'low', 'aisle'],
};
const PROBE_LAYOUT_VARIANTS = [
  ['shipped'], ['few'], ['medium'], ['many'], ['manyCell'], ['mixed'], ['many', 0.05], ['many', 0.1], ['many', 0.5], ['medium', 0.1],
];
const LAYOUT_MEASURE = `async (poses, variants) => {
  const p = window.__p;
  const px = async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = new OffscreenCanvas(i.width, i.height); const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  const shotOf = async (view, n = 3) => { p.setView(view); await p.step(n); return p.shot(); };
  p.setHitColor('current'); p.setDenoise(false);
  const ref = await p.setTraceProbes(p.kit.probes.map((v) => ({ ...v, resolution: 256 })), { resolution: 256 });
  const W = 960, H = 540, L = (d, k) => 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
  const grad = (d) => { const g = new Float32Array(W * H); for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const k = (y * W + x) * 4; g[y * W + x] = Math.hypot(L(d, k + 4) - L(d, k), L(d, k + W * 4) - L(d, k)); } return g; };
  const out = { reference: ref, rows: [] }, sheets = {};
  for (const [name, blend] of variants) {
    const baked = await p.setProbeLayout(name, blend ?? 0.25);
    const bakes = [baked.ms];
    for (let i = 0; i < 2; i++) bakes.push((await p.setProbeLayout(name, blend ?? 0.25)).ms);
    bakes.sort((a, b) => a - b);
    const row = { layout: name, blend: baked.blend, spacing: baked.spacing, description: baked.description, probes: baked.probes, sizes: baked.sizes, bytes: baked.bytes, bakeMs: bakes[1], bakes, poses: {} };
    for (const pose of poses) {
      p.setPose(pose);
      p.setRT(true);
      const S = await px(await shotOf('rtSource'));
      const Ru = await shotOf('final'), R = await px(Ru);
      p.setRT(false);
      const Fu = await shotOf('final'), F = await px(Fu);
      const D = await px(await shotOf('probeData'));
      const PSu = await shotOf('probeSpecular'), PS = await px(PSu);
      // masks: traced hits (rtSource blue / cyan), lit in the RT frame; geometry; band
      const traced = new Uint8Array(W * H), band = new Uint8Array(W * H);
      let tracedPx = 0, darkPx = 0;
      for (let i = 0; i < W * H; i++) {
        const k = i * 4, isHit = S[k + 2] > 200 && S[k] < 80 && (S[k + 1] < 140 || S[k + 1] > 200);
        if (!isHit) continue;
        tracedPx++;
        if (L(R, k) > 10) traced[i] = 1; else darkPx++;
      }
      const hist = [0, 0, 0, 0, 0, 0, 0]; let geo = 0, csum = 0, cmax = 0; const counts = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, k = i * 4;
        if (D[k] === 0) continue;
        geo++; const n = D[k + 1]; csum += n; cmax = Math.max(cmax, n); hist[Math.min(6, n)]++; counts.push(n);
        let edge = n >= 2;
        for (let dy = -2; dy <= 2 && !edge; dy++) for (let dx = -2; dx <= 2 && !edge; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const kk = (yy * W + xx) * 4; if (D[kk] !== 0 && D[kk] !== D[k]) edge = true;
        }
        band[i] = edge ? 1 : 0;
      }
      counts.sort((a, b) => a - b);
      const gF = grad(F), gR = grad(R), gP = grad(PS);
      const acc = () => ({ n: 0, d: 0, g: 0 });
      const inB = acc(), outB = acc(), pIn = { n: 0, g: 0 }, pOut = { n: 0, g: 0 };
      for (let i = 0; i < W * H; i++) {
        const k = i * 4;
        if (traced[i]) {
          const a = band[i] ? inB : outB;
          a.n++; a.d += (Math.abs(F[k] - R[k]) + Math.abs(F[k + 1] - R[k + 1]) + Math.abs(F[k + 2] - R[k + 2])) / 3; a.g += gF[i] - gR[i];
        }
        if (D[k] !== 0 && D[k + 2] < 114) { const b = band[i] ? pIn : pOut; b.n++; b.g += gP[i]; }
      }
      const n = inB.n + outB.n;
      row.poses[pose] = {
        tracedPx, darkPx, maskPx: n, mad: n ? (inB.d + outB.d) / n : null,
        bandShare: n ? inB.n / n : null, bandMad: inB.n ? inB.d / inB.n : null, restMad: outB.n ? outB.d / outB.n : null,
        bandGradExcess: inB.n ? inB.g / inB.n : null, restGradExcess: outB.n ? outB.g / outB.n : null,
        probeGradBand: pIn.n ? pIn.g / pIn.n : null, probeGradRest: pOut.n ? pOut.g / pOut.n : null,
        volumesPerPx: { mean: geo ? csum / geo : 0, p99: counts[Math.floor(counts.length * 0.99)] ?? 0, max: cmax, hist },
      };
      if (blend === undefined && pose === poses[0]) {
        const I = await shotOf('probeIndex'), C = await shotOf('probeCount');
        (sheets[pose] ??= { ref: Ru, rows: [] }).rows.push({ label: name + ' - ' + baked.description + ' - ' + (baked.bytes / 1e6).toFixed(1) + ' MB', urls: [Fu, PSu, I, C] });
      }
    }
    out.rows.push(row);
  }
  // contact sheet: the RT reference, then one row per layout: RT-off final, probe term, dominant probe, volumes per px
  out.sheets = {};
  for (const [pose, sh] of Object.entries(sheets)) {
    const cw = 480, ch = 270, cols = 4, lh = 18, c = new OffscreenCanvas(cw * cols, (ch + lh) * (sh.rows.length + 1)), g = c.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height); g.font = '13px sans-serif'; g.fillStyle = '#ddd';
    const draw = async (u, x, y) => { const i = new Image(); i.src = u; await i.decode(); g.drawImage(i, x, y, cw, ch); };
    g.fillText('reference: ?rt=1 (hits lit by the shipped set at 256 px) | columns: RT-off final, probeSpecular (probe term), probeIndex, probeCount', 6, 13);
    await draw(sh.ref, 0, lh);
    for (let r = 0; r < sh.rows.length; r++) {
      const y = (ch + lh) * (r + 1);
      g.fillStyle = '#ddd'; g.fillText(sh.rows[r].label, 6, y + 13);
      for (let k = 0; k < cols; k++) await draw(sh.rows[r].urls[k], k * cw, y + lh);
    }
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    (window.__w61sheets ??= {})[pose] = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    out.sheets[pose] = true;
  }
  await p.setTraceProbes(null);
  return out;
}`;
/** GPU ms at the page's size, RT off: three's passes (median of 30, 3 repeats), the probe-free frame, the core passes. */
const LAYOUT_TIMING = `async (variants, pose) => {
  const p = window.__p; p.setDenoise(false); p.setRT(false); p.setPose(pose); p.setView('final');
  const rows = [];
  const rep = async () => { const v = []; for (let i = 0; i < 3; i++) v.push((await p.renderTime(30)).ms); v.sort((a, b) => a - b); return v; };
  for (const [name, blend] of variants) {
    await p.setProbeLayout(name, blend ?? 0.25);
    await p.step(4);
    const render = await rep();
    p.setProbesEnabled(false); await p.step(4); const free = await rep(); p.setProbesEnabled(true); await p.step(4);
    const core = await p.time(30);
    rows.push({ layout: name, blend: blend ?? null, render, probeFree: free, lookup: render[1] - free[1], core: Object.values(core.ms).reduce((a, b) => a + b, 0) });
  }
  return rows;
}`;
async function probeLayoutMeasure(pages) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'w61-probe-layouts.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const want = process.env.W61_SCENES?.split(',') ?? Object.keys(PROBE_LAYOUT_MEASURE);
  const parts = process.env.W61_PARTS?.split(',') ?? ['error', 'timing', 'pt'];
  const save = () => fs.writeFileSync(file, JSON.stringify(all, null, 1));
  for (const scene of want) {
    const poses = PROBE_LAYOUT_MEASURE[scene];
    all[scene] ??= {};
    if (parts.includes('error')) {
      const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&rt=1&bvh=three-mesh-bvh&denoise=0&probeLayout=shipped&scene=${scene}`);
      pages.push(p);
      const t0 = Date.now();
      const r = await p.T(`(${LAYOUT_MEASURE})(${JSON.stringify(poses)}, ${JSON.stringify(PROBE_LAYOUT_VARIANTS)})`);
      // one CDP reply per sheet (several MB in one reply never arrived, see probeLayoutChecks)
      for (const pose of Object.keys(r.sheets)) { const u = await p.T(`window.__w61sheets[${JSON.stringify(pose)}]`); fs.writeFileSync(path.join(OUT, `w61-${scene}-${pose}-layouts.jpg`), Buffer.from(u.split(',')[1], 'base64')); }
      delete r.sheets;
      all[scene].error = r; save();
      for (const row of r.rows) {
        console.log(`  ${scene} ${row.layout}${row.blend != null ? ` b ${row.blend}` : ''}: ${row.probes} probes, ${(row.bytes / 1e6).toFixed(1)} MB, bake ${row.bakeMs.toFixed(0)} ms | ` + poses.map((q) => {
          const v = row.poses[q];
          return `${q} mad ${v.mad?.toFixed(2)} (${v.maskPx} px; band ${(100 * v.bandShare).toFixed(0)}% ${v.bandMad?.toFixed(2)} / rest ${v.restMad?.toFixed(2)}; grad+ ${v.bandGradExcess?.toFixed(2)}; vol/px ${v.volumesPerPx.mean.toFixed(2)} max ${v.volumesPerPx.max})`;
        }).join(' | '));
      }
      console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      p.close(); pages.splice(pages.indexOf(p), 1);
    }
    if (parts.includes('timing')) {
      const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&aa=off&denoise=0&w=1920&h=1080&probeLayout=shipped&scene=${scene}`);
      pages.push(p);
      const r = await p.T(`(${LAYOUT_TIMING})(${JSON.stringify(PROBE_LAYOUT_VARIANTS.slice(0, 6))}, ${JSON.stringify(poses[0])})`);
      all[scene].timing = r; save();
      for (const t of r) console.log(`  ${scene} 1080p ${t.layout}: three's passes ${t.render.map((x) => x.toFixed(2)).join(' / ')} ms, probe-free ${t.probeFree.map((x) => x.toFixed(2)).join(' / ')}, lookup ${t.lookup.toFixed(2)}, core ${t.core.toFixed(2)}`);
      p.close(); pages.splice(pages.indexOf(p), 1);
    }
    if (parts.includes('pt') && scene === 'showcaseSponza') {
      all[scene].pt = {};
      for (const pose of ['courtyard', 'low']) {
        const p = await openPage(`http://127.0.0.1:${PORT}/showcase/compare.html?manual&scene=sponza&pose=${pose}&left=probes&right=pathtraced`);
        pages.push(p);
        if (!(await p.T('window.__p.entries()')).length) { console.log('  (no showcase assets: path tracer skipped)'); p.close(); break; }
        await p.T('window.__p.freeze(true)');
        const rows = [];
        for (const [name, blend] of PROBE_LAYOUT_VARIANTS.slice(0, 6)) {
          await p.T(`(window.__p.setParam('probeLayout', ${JSON.stringify(name === 'shipped' ? null : name)}), window.__p.setParam('probeBlend', ${JSON.stringify(String(blend ?? 0.25))}), window.__p.drop('probes'), window.__p.drop('ours-denoised'), true)`);
          const m = await p.T("window.__p.measure({ samples: 64, warmup: 24, frames: 8, methods: ['probes', 'ours-denoised'], orbitFrames: 0 })");
          rows.push({ layout: name, glossyPixels: m.glossyPixels, referenceSamples: m.referenceSamples, rows: m.rows.map(({ method, mad, bias, stdMean, info }) => ({ method, mad, bias, stdMean, probes: info?.probes, probeLayout: info?.probeLayout })) });
          console.log(`  sponza vs path traced ${pose} ${name}: ${m.glossyPixels} glossy px, ${m.rows.map((x) => `${x.method} MAD ${x.mad.toFixed(2)} bias ${x.bias.toFixed(2)} (${x.info?.probes} probes)`).join(', ')}`);
          if (name === 'shipped') savePng(`w61-sponza-${pose}-pathtraced.png`, await p.T("window.__p.shotOf('pathtraced')"));
        }
        all[scene].pt[pose] = rows; save();
        p.close(); pages.splice(pages.indexOf(p), 1);
      }
    }
  }
}

/**
 * W62 (D4900): probe sizes against WebGPU's sampled-texture limit. `--only probe-bindings` (checks):
 * Sponza's three-size mixed set on examples/ssr at the default 16 sampled textures per stage draws
 * without validation errors and matches the same page at the adapter's limit (the composite shares
 * its lookups' atlas nodes, so each size costs one binding there, not two); the library asks for
 * up to 32. `--only probe-bindings-measure` (minutes): Sponza with fewer sizes against the path
 * tracer (compare page, glossy px, 'probes' and 'ours-denoised': MAD and PSNR) and the lookup's GPU
 * ms at 1080p; JSON to out/w62-probe-bindings.json (W62_PARTS=bake,timing,pt and W62_VARIANTS pick).
 */
const BINDING_VARIANTS = ['shipped', 'few', 'mixed', 'twoSize', 'twoSizeFew', 'mixedDown', 'oneSize256', 'oneSize128'];
async function probeBindingChecks(pages) {
  console.log('probe bindings (W62):');
  const shots = {}, info = {};
  // 'adapter' twice: the page's own run-to-run floor (SSR's ray noise is seeded, but a few px move between runs)
  for (const lim of ['default', 'adapter', 'adapter2']) {
    const before = results.logs.length;
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0&scene=showcaseSponza&probeLayout=mixed&texLimit=${lim.replace('2', '')}`);
    pages.push(p);
    info[lim] = await p.T(`(async () => { const p = window.__p; p.setPose('courtyard'); p.setView('final'); await p.step(6);
      return { limit: p.renderer.backend.device.limits.maxSampledTexturesPerShaderStage, sizes: p.probes.bakedResolutions }; })()`);
    shots[lim] = await p.T('window.__p.shot()');
    savePng(`w62-sponza-mixed-${lim}.png`, shots[lim]);
    info[lim].bad = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception|exceeds/i.test(l));
    p.close(); pages.splice(pages.indexOf(p), 1);
  }
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0&scene=rooms`);
  pages.push(p);
  const st = await p.T(`(${IMAGE_STATS})(${JSON.stringify(shots.default)}, ${JSON.stringify(shots.adapter)})`);
  const floor = await p.T(`(${IMAGE_STATS})(${JSON.stringify(shots.adapter2)}, ${JSON.stringify(shots.adapter)})`);
  const lib = await p.T('window.__p.renderer.backend.device.limits.maxSampledTexturesPerShaderStage');
  p.close(); pages.splice(pages.indexOf(p), 1);
  const d = info.default;
  check(`Sponza's ${d.sizes.length}-size probe set (${d.sizes.join(' / ')} px) draws at WebGPU's default ${d.limit} sampled textures per stage, as at the adapter's ${info.adapter.limit} (shared atlas nodes, D4900)`,
    d.limit === 16 && d.sizes.length === 3 && d.bad.length === 0 && st.lum > 10 && st.mean <= 2 * floor.mean + 0.01,
    `errors ${d.bad.length}${d.bad.length ? ` "${d.bad[0].slice(0, 200)}"` : ''}; vs ${info.adapter.limit}: mean ${st.mean.toFixed(4)}, max ${st.max} / 255 (the page against itself: mean ${floor.mean.toFixed(4)}, max ${floor.max}), luminance ${st.lum.toFixed(1)}`);
  check('examples/ssr without ?texLimit gets the library limits: up to 32 sampled textures per stage (reflectionsRequiredLimits)', lib === 32 || lib === 16, `device limit ${lib}`);
}

async function probeBindingMeasure(pages) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'w62-probe-bindings.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const parts = process.env.W62_PARTS?.split(',') ?? ['bake', 'timing', 'pt'];
  const variants = process.env.W62_VARIANTS?.split(',') ?? BINDING_VARIANTS;
  const save = () => fs.writeFileSync(file, JSON.stringify(all, null, 1));
  if (parts.includes('bake')) {
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&denoise=0&scene=showcaseSponza&probeLayout=shipped`);
    pages.push(p);
    all.bake ??= {};
    for (const name of variants) {
      const b = await p.T(`window.__p.setProbeLayout(${JSON.stringify(name)})`);
      all.bake[name] = { probes: b.probes, sizes: b.sizes, bytes: b.bytes, bakeMs: b.ms, description: b.description };
      console.log(`  ${name}: ${b.probes} probes, sizes ${b.sizes.join(' / ')}, ${(b.bytes / 1e6).toFixed(1)} MB, bake ${b.ms.toFixed(0)} ms - ${b.description}`);
    }
    save(); p.close(); pages.splice(pages.indexOf(p), 1);
  }
  if (parts.includes('timing')) {
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&aa=off&denoise=0&w=1920&h=1080&probeLayout=shipped&scene=showcaseSponza`);
    pages.push(p);
    all.timing = await p.T(`(${LAYOUT_TIMING})(${JSON.stringify(variants.map((v) => [v]))}, 'courtyard')`);
    save();
    for (const t of all.timing) console.log(`  1080p ${t.layout}: three's passes ${t.render.map((x) => x.toFixed(2)).join(' / ')} ms, probe-free ${t.probeFree.map((x) => x.toFixed(2)).join(' / ')}, lookup ${t.lookup.toFixed(2)}`);
    p.close(); pages.splice(pages.indexOf(p), 1);
  }
  if (parts.includes('pt')) {
    all.pt ??= {};
    for (const pose of ['courtyard', 'low']) {
      const p = await openPage(`http://127.0.0.1:${PORT}/showcase/compare.html?manual&scene=sponza&pose=${pose}&left=probes&right=pathtraced&texLimit=default`);
      pages.push(p);
      if (!(await p.T('window.__p.entries()')).length) { console.log('  (no showcase assets: path tracer skipped)'); p.close(); break; }
      await p.T('window.__p.freeze(true)');
      const rows = all.pt[pose] ?? [];
      for (const name of variants) {
        await p.T(`(window.__p.setParam('probeLayout', ${JSON.stringify(name === 'shipped' ? null : name)}), window.__p.drop('probes'), window.__p.drop('ours-denoised'), true)`);
        const m = await p.T("window.__p.measure({ samples: 64, warmup: 24, frames: 8, methods: ['probes', 'ours-denoised'], orbitFrames: 0 })");
        const row = { layout: name, glossyPixels: m.glossyPixels, referenceSamples: m.referenceSamples, rows: m.rows.map(({ method, mad, psnr, bias, stdMean, info }) => ({ method, mad, psnr, bias, stdMean, probes: info?.probes, probeLayout: info?.probeLayout })) };
        const k = rows.findIndex((r) => r.layout === name);
        if (k >= 0) rows[k] = row; else rows.push(row);
        all.pt[pose] = rows; save();
        console.log(`  sponza vs path traced ${pose} ${name}: ${m.glossyPixels} glossy px, ${m.rows.map((x) => `${x.method} MAD ${x.mad.toFixed(2)} PSNR ${x.psnr.toFixed(2)} (${x.info?.probes} probes)`).join(', ')}`);
      }
      p.close(); pages.splice(pages.indexOf(p), 1);
    }
  }
}

/**
 * W63 (`--only probe-lookup-cost`): the probe lookup's GPU cost at 1920x1080 on examples/ssr, RT off,
 * loop stopped, per lookup variant (`?lookupExp=`, core's bench-only PROBE_LOOKUP_EXPERIMENT; '' = the
 * shipped lookup) and grid size (n x 128 px cells over the scene's regions, ../examples/shared/probeLayouts.ts).
 * Per row: three's passes (median of 30, 3 repeats), the same with the materials' lookups off (composite only)
 * and with every lookup off (probe-free). W63_SCENES, W63_VARIANTS ('|'-separated), W63_COUNTS pick.
 * JSON to out/w63-probe-lookup-cost.json (merged by scene / variant).
 */
const LOOKUP_COST = `async (counts, pose) => {
  const p = window.__p; p.setDenoise(false); p.setRT(false); if (pose) p.setPose(pose); p.setView('final');
  const rep = async () => { const v = []; for (let i = 0; i < 3; i++) v.push((await p.renderTime(30)).ms); v.sort((a, b) => a - b); return v; };
  const rows = [];
  for (const n of counts) {
    const vols = n === 'shipped' ? null : p.probeGrid(n);
    await p.setProbeVolumes(vols, vols ? { resolution: 128 } : {});
    await p.step(4);
    const all = await rep();
    p.setProbeParts(false, true); await p.step(4); const compositeOnly = await rep();
    p.setProbeParts(false, false); await p.step(4); const free = await rep();
    p.setProbeParts(true, true); await p.step(4);
    const core = await p.time(30);
    rows.push({ n, probes: p.probes?.bakedProbes?.length ?? null, all, compositeOnly, free, material: all[1] - compositeOnly[1], composite: compositeOnly[1] - free[1], lookup: all[1] - free[1], core: Object.values(core.ms).reduce((a, b) => a + b, 0) });
  }
  return rows;
}`;
/** W63: lookup variants A/B in one page, interleaved per round (a shared GPU drifts between pages). */
const LOOKUP_AB = `async (counts, variants, pose, rounds, stat) => {
  const p = window.__p; p.setDenoise(false); p.setRT(false); if (pose) p.setPose(pose); p.setView('final');
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  // the 10th percentile of 30 frames: on a shared GPU the low frames are the ones nobody else slowed
  const t = async () => { await p.step(4); const r = await p.renderTime(30); return stat === 'p10' ? r.p10 : r.ms; };
  const rows = [];
  for (const n of counts) {
    const vols = n === 'shipped' ? null : p.probeGrid(n);
    await p.setProbeVolumes(vols, vols ? { resolution: 128 } : {});
    const free = [], all = {}, comp = {};
    for (let r = 0; r < rounds; r++) {
      p.setProbeParts(false, false); free.push(await t());
      for (const v of variants) {
        p.setLookupExp(v); (all[v] ??= []).push(await t());
        p.setProbeParts(false, true); (comp[v] ??= []).push(await t());
      }
    }
    p.setLookupExp('');
    const f = med(free);
    rows.push({ n, probes: p.probes?.bakedProbes?.length ?? null, free, all, comp, lookup: Object.fromEntries(variants.map((v) => [v || 'base', { lookup: med(all[v]) - f, material: med(all[v]) - med(comp[v]), composite: med(comp[v]) - f }])) });
  }
  return rows;
}`;
async function probeLookupAB(pages) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'w63-probe-lookup-ab.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const scenes = process.env.W63_SCENES?.split(',') ?? ['rooms', 'showcaseSponza'];
  const variants = process.env.W63_VARIANTS?.split('|') ?? ['', 'loop,skip', 'grid,skip'];
  const counts = process.env.W63_COUNTS?.split(',').map((c) => (c === 'shipped' ? c : Number(c))) ?? [4, 8, 16, 32];
  const rounds = Number(process.env.W63_ROUNDS ?? 3);
  const poses = { rooms: 'default', offscreen: 'default', showcaseSponza: 'courtyard' };
  for (const scene of scenes) {
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&aa=off&denoise=0&w=1920&h=1080&probeLayout=shipped&texLimit=adapter&scene=${scene}`);
    pages.push(p);
    const before = results.logs.length;
    const r = await p.T(`(${LOOKUP_AB})(${JSON.stringify(counts)}, ${JSON.stringify(variants)}, ${JSON.stringify(poses[scene] ?? null)}, ${rounds}, ${JSON.stringify(process.env.W63_STAT ?? 'p10')})`);
    all[scene] = r;
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
    for (const row of r) console.log(`  ${scene} n ${row.n} (${row.probes}), free ${row.free.map((x) => x.toFixed(2)).join('/')}: ` + Object.entries(row.lookup).map(([v, x]) => `[${v}] ${x.lookup.toFixed(2)} (mat ${x.material.toFixed(2)} + comp ${x.composite.toFixed(2)})`).join(', '));
    const bad = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
    if (bad.length) console.log(`  !! ${bad.slice(0, 3).join(' | ')}`);
    p.close(); pages.splice(pages.indexOf(p), 1);
  }
}
/**
 * W63: what a per-frame clustered volume list (HDRP / Unreal / Godot style: froxels, each cluster's
 * volume bitmask built by a compute pass from the view) costs to build, on its own device in the
 * probe-core page: tiles x slices clusters, n volumes as view-space boxes, one thread per cluster.
 * GPU ms, median of 50 dispatches (timestamp queries).
 */
const CLUSTER_BUILD = `async (configs, counts) => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  const code = \`
struct P { dims: vec4u, proj: vec4f };
@group(0) @binding(0) var<uniform> pr: P;
@group(0) @binding(1) var<storage, read> boxes: array<vec4f>;   // per volume: view min.xyz, view max.xyz (2 rows)
@group(0) @binding(2) var<storage, read_write> masks: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let nx = pr.dims.x; let ny = pr.dims.y; let nz = pr.dims.z; let n = pr.dims.w;
  let k = id.x; if (k >= nx * ny * nz) { return; }
  let x = k % nx; let y = (k / nx) % ny; let z = k / (nx * ny);
  // exponential slices from near to far, the tile's frustum corners at both depths -> view AABB
  let near = pr.proj.z; let far = pr.proj.w;
  let z0 = near * pow(far / near, f32(z) / f32(nz)); let z1 = near * pow(far / near, f32(z + 1u) / f32(nz));
  let t0 = (vec2f(f32(x), f32(y)) / vec2f(f32(nx), f32(ny)) * 2.0 - 1.0) * pr.proj.xy;
  let t1 = (vec2f(f32(x + 1u), f32(y + 1u)) / vec2f(f32(nx), f32(ny)) * 2.0 - 1.0) * pr.proj.xy;
  let lo = vec3f(min(min(t0 * z0, t0 * z1), min(t1 * z0, t1 * z1)), -z1);
  let hi = vec3f(max(max(t0 * z0, t0 * z1), max(t1 * z0, t1 * z1)), -z0);
  let words = (n + 31u) / 32u;
  for (var w = 0u; w < words; w++) {
    var m = 0u;
    for (var b = 0u; b < 32u; b++) {
      let i = w * 32u + b; if (i >= n) { break; }
      let bmin = boxes[2u * i].xyz; let bmax = boxes[2u * i + 1u].xyz;
      if (all(bmin <= hi) && all(bmax >= lo)) { m |= 1u << b; }
    }
    masks[k * words + w] = m;
  }
}\`;
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const qs = device.createQuerySet({ type: 'timestamp', count: 2 });
  const res = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const out = [];
  for (const [nx, ny, nz] of configs) for (const n of counts) {
    const cells = nx * ny * nz, words = Math.ceil(n / 32);
    const u = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const ub = new ArrayBuffer(32); new Uint32Array(ub, 0, 4).set([nx, ny, nz, n]); new Float32Array(ub, 16, 4).set([Math.tan(0.6) * 16 / 9, Math.tan(0.6), 0.05, 80]);
    device.queue.writeBuffer(u, 0, ub);
    const bx = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) { const c = [(i % 8) * 2.7 - 10, 0, -2 - Math.floor(i / 8) * 2.4]; bx.set([c[0] - 1.7, c[1] - 2.7, c[2] - 1.6, 0, c[0] + 1.7, c[1] + 2.7, c[2] + 1.6, 0], i * 8); }
    const b = device.createBuffer({ size: bx.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, bx);
    const m = device.createBuffer({ size: cells * words * 4, usage: GPUBufferUsage.STORAGE });
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: u } }, { binding: 1, resource: { buffer: b } }, { binding: 2, resource: { buffer: m } }] });
    const ms = [];
    for (let r = 0; r < 55; r++) {
      const e = device.createCommandEncoder();
      const pass = e.beginComputePass({ timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
      pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(Math.ceil(cells / 64)); pass.end();
      e.resolveQuerySet(qs, 0, 2, res, 0); e.copyBufferToBuffer(res, 0, read, 0, 16);
      device.queue.submit([e.finish()]);
      await read.mapAsync(GPUMapMode.READ); const t = new BigUint64Array(read.getMappedRange().slice(0)); read.unmap();
      if (r >= 5) ms.push(Number(t[1] - t[0]) / 1e6);
    }
    ms.sort((a, b) => a - b);
    out.push({ clusters: [nx, ny, nz], cells, n, ms: ms[ms.length >> 1], p10: ms[5], p90: ms[45] });
    u.destroy(); b.destroy(); m.destroy();
  }
  device.destroy();
  return out;
}`;
async function probeClusterBuild(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/probe-core/`);
  pages.push(p);
  const r = await p.T(`(${CLUSTER_BUILD})(${JSON.stringify([[30, 17, 32], [60, 34, 32], [120, 68, 32]])}, [4, 8, 16, 32, 64, 128])`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'w63-cluster-build.json'), JSON.stringify(r, null, 1));
  for (const x of r) console.log(`  clusters ${x.clusters.join('x')} (${x.cells}), ${x.n} volumes: build ${x.ms.toFixed(4)} ms (p10 ${x.p10.toFixed(4)}, p90 ${x.p90.toFixed(4)})`);
  p.close(); pages.splice(pages.indexOf(p), 1);
}
/**
 * W63 (`--only probe-lookup-parity`): the lookup variant `W63_VARIANT` (default 'grid,skip') against the
 * shipped lookup, image for image, at 960x540: per scene and layout (shipped, few, many, mixed = several
 * atlases), views final and probeSpecular, RT off in one page (the variant switched in place), and
 * `?rt=1` (traced hits shade through core's lookup too) as two pages. Mean / max abs diff per channel /255.
 */
const PARITY_SHOTS = `async (layouts, views, mode, stats) => {
  const p = window.__p; p.setDenoise(false); p.setHitColor('current');
  const diff = stats ? eval('(' + stats + ')') : null;
  const out = {}; window.__w63shots = {};
  for (const L of layouts) {
    if (L !== 'shipped') await p.setProbeLayout(L); else await p.setProbeVolumes(null);
    for (const v of views) {
      p.setView(v);
      if (mode !== null) p.setLookupExp('');
      await p.step(3); const a = await p.shot();
      if (mode !== null) { p.setLookupExp(mode); await p.step(3); out[L + ':' + v] = await diff(a, await p.shot()); p.setLookupExp(''); }
      else { window.__w63shots[L + ':' + v] = a; out[L + ':' + v] = true; }
    }
  }
  return out;
}`;
async function probeLookupParity(pages) {
  const mode = process.env.W63_VARIANT ?? 'legacy';
  const scenes = process.env.W63_SCENES?.split(',') ?? ['rooms', 'offscreen', 'showcaseSponza'];
  const layouts = ['shipped', 'few', 'many', 'mixed'], views = ['final', 'probeSpecular'];
  const rows = [];
  for (const scene of scenes) {
    const url = `http://127.0.0.1:${PORT}/ssr/?manual&aa=off&denoise=0&probeLayout=shipped&texLimit=adapter&scene=${scene}`;
    const before = results.logs.length;
    const p = await openPage(url); pages.push(p);
    // RT off: the variant switched in place, diffed in the page (several MB in one CDP reply never arrive)
    const d = await p.T(`(${PARITY_SHOTS})(${JSON.stringify(layouts)}, ${JSON.stringify(views)}, ${JSON.stringify(mode)}, ${JSON.stringify(IMAGE_STATS)})`);
    for (const [k, x] of Object.entries(d)) rows.push({ scene, rt: false, k, ...x });
    p.close(); pages.splice(pages.indexOf(p), 1);
    // RT: the traced hits' lookup compiles once per page, so one page per variant; shots move one per reply
    const base = await openPage(url + '&rt=1'); pages.push(base);
    const keys = Object.keys(await base.T(`(${PARITY_SHOTS})(${JSON.stringify(layouts)}, ['final'], null, null)`));
    const sa = {};
    for (const k of keys) sa[k] = await base.T(`window.__w63shots[${JSON.stringify(k)}]`);
    base.close(); pages.splice(pages.indexOf(base), 1);
    const alt = await openPage(url + `&rt=1&lookupExp=${mode}`); pages.push(alt);
    await alt.T(`(${PARITY_SHOTS})(${JSON.stringify(layouts)}, ['final'], null, null)`);
    for (const k of keys) { const x = await alt.T(`(${IMAGE_STATS})(${JSON.stringify(sa[k])}, window.__w63shots[${JSON.stringify(k)}])`); rows.push({ scene, rt: true, k, ...x }); }
    alt.close(); pages.splice(pages.indexOf(alt), 1);
    const bad = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
    check(`lookup parity ${scene}: no validation errors or exceptions`, bad.length === 0, bad.slice(0, 2).join(' | '));
    for (const r of rows.filter((x) => x.scene === scene)) console.log(`  ${r.scene}${r.rt ? ' rt=1' : ''} ${r.k}: mean ${r.mean.toFixed(4)} max ${r.max} /255`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'w63-probe-lookup-parity.json'), JSON.stringify({ mode, rows }, null, 1));
  return rows;
}
async function probeLookupCost(pages) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'w63-probe-lookup-cost.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const scenes = process.env.W63_SCENES?.split(',') ?? ['rooms', 'showcaseSponza'];
  const variants = process.env.W63_VARIANTS?.split('|') ?? [''];
  const counts = process.env.W63_COUNTS?.split(',').map((c) => (c === 'shipped' ? c : Number(c))) ?? [4, 8, 16, 32];
  const poses = { rooms: 'default', offscreen: 'default', showcaseSponza: 'courtyard' };
  for (const scene of scenes) for (const v of variants) {
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&aa=off&denoise=0&w=1920&h=1080&probeLayout=shipped&texLimit=adapter&scene=${scene}${v ? `&lookupExp=${v}` : ''}`);
    pages.push(p);
    const before = results.logs.length;
    const r = await p.T(`(${LOOKUP_COST})(${JSON.stringify(counts)}, ${JSON.stringify(poses[scene] ?? null)})`);
    (all[scene] ??= {})[v || 'base'] = r;
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
    for (const t of r) console.log(`  ${scene} [${v || 'base'}] n ${t.n} (${t.probes}): all ${t.all[1].toFixed(2)} ms, composite-only ${t.compositeOnly[1].toFixed(2)}, free ${t.free[1].toFixed(2)} | lookup ${t.lookup.toFixed(2)} = material ${t.material.toFixed(2)} + composite ${t.composite.toFixed(2)} | core ${t.core.toFixed(2)}`);
    const bad = results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
    if (bad.length) console.log(`  !! ${bad.slice(0, 3).join(' | ')}`);
    p.close(); pages.splice(pages.indexOf(p), 1);
  }
}

async function offscreenFillChecks(pages) {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&rt=1&bvh=three-mesh-bvh&denoise=0&scene=offscreen`);
  pages.push(p);
  // W60: `all256` is the kit with every probe at the set's 256 px (the kit before per-probe sizes)
  const r = await p.T(`(${OFFSCREEN_FILL})(['default', 'mirror'], ${JSON.stringify(OFFSCREEN_FILL_RECT)}, { single: { probes: [0] }, all256: { sizes: [256, 256, 256] }, kit: {} }, ${JSON.stringify(OFFSCREEN_RING_RECT)})`);
  const d = r.default;
  const ring = (v) => `warm px rt ${v.ringRT}, rt-off ${v.ringOff}, both ${v.both}; floor ring rt ${v.ring.rt}, rt-off ${v.ring.off}, both ${v.ring.both}`;
  // rt-off / rt warm px: the excess is the ring and the wall mirror's yellow bar drawn fat by the probes
  // (W60: all 256 1.70 / 1.18 for the floor ring alone, kit 1.44 / 1.12; W38 allowed 2.5)
  check('offscreen: the ring shows in the RT-off fallback where ?rt=1 has it (emissives captured, floor probe lidded at the ring, D4400; floor + mirror probes 512 px, D4701)',
    d.kit.probes === 3 && d.kit.sizes.join(',') === '256,512' && d.kit.ringRT > 500 && d.kit.both >= 0.9 * d.kit.ringRT && d.kit.ringOff <= 1.6 * d.kit.ringRT
      && d.kit.ring.both >= 0.97 * d.kit.ring.rt && d.kit.ring.off <= 1.15 * d.kit.ring.rt && d.single.both < 0.6 * d.single.ringRT,
    `kit (${d.kit.probes} probes, atlases ${d.kit.sizes} px): ${ring(d.kit)}; all 256 px: ${ring(d.all256)}; one room probe: ${ring(d.single)}`);
  check('offscreen: per-probe sizes (floor and mirror at 512 px) fill the SSR misses closer to RT than all 256 px (D4701)',
    r.default.kit.mad < r.default.all256.mad - 0.3 && r.mirror.kit.mad < r.mirror.all256.mad && d.kit.bytes < 0.7 * 67.1e6,
    `default ${r.default.all256.mad.toFixed(2)} -> ${r.default.kit.mad.toFixed(2)}, mirror ${r.mirror.all256.mad.toFixed(2)} -> ${r.mirror.kit.mad.toFixed(2)}; atlases ${(d.all256.bytes / 1e6).toFixed(1)} -> ${(d.kit.bytes / 1e6).toFixed(1)} MB (all 512: 67.1)`);
  check('offscreen: the probe fallback in the SSR misses stays near the ray-traced fill (D4400)',
    ['default', 'mirror'].every((k) => r[k].kit.px > 10000 && r[k].kit.mad < OFFSCREEN_FILL_MAX[k] && r[k].kit.mad < r[k].single.mad - OFFSCREEN_FILL_MARGIN[k]),
    `mean abs diff / 255 vs rt=1 over the misses (mirror: the wall mirror's upper part); ${['default', 'mirror'].map((k) => `${k}: ${r[k].kit.px} miss px, one room probe ${r[k].single.mad.toFixed(2)} -> kit ${r[k].kit.mad.toFixed(2)}`).join('; ')} (limits ${JSON.stringify(OFFSCREEN_FILL_MAX)}, margins ${JSON.stringify(OFFSCREEN_FILL_MARGIN)})`);
}

/**
 * W47 (D4702): traced hits over a mixed-size probe set. offscreen's kit (room 256, floor + wall
 * mirror 512: two atlases) against all three at 512 (one atlas: the hit shading always saw these)
 * and the room probe alone (what a hit saw of the kit while the RT hit shading bound only the
 * primary atlas: the 512 probes took no weight there). Per pose, the tracer's radiance on the same
 * rays (`rtHitRadiance`: frame index pinned, on-screen reuse off), over the px that are traced hits
 * in both frames: mean abs diff of rgb vs all 512, and the px where the kit's hit differs from the
 * room-only hit by > 1%. `self` is the kit read twice (noise floor).
 */
const RT_HIT_ATLASES = `async (poses) => {
  const p = window.__p;
  p.setHitColor('current'); p.setDenoise(false); p.setRT(true); p.setView('final');
  // W76: each probe set rebuilds the tracer, whose default cone then builds asynchronously (its first frames run
  // 'off'), and the traced rays follow the sample width: this compares probe atlases, so the cone is off
  p.setSettings({ hitColorFilter: 'off' });
  const variants = { kit: {}, all512: { sizes: [512, 512, 512], resolution: 512 }, room: { probes: [0] } };
  const runs = {};
  for (const [name, v] of Object.entries(variants)) {
    const volumes = (v.probes ? v.probes.map((i) => p.kit.probes[i]) : p.kit.probes).map((x, i) => (v.sizes ? { ...x, resolution: v.sizes[i] } : x));
    await p.setProbeVolumes(volumes, v.resolution ? { resolution: v.resolution } : {});
    runs[name] = { sizes: p.probes.bakedResolutions.slice(), atlases: p.probes.textures.length, poses: {} };
    for (const pose of poses) {
      p.setPose(pose); await p.step(3);
      const r = await p.rtHitRadiance();
      runs[name].kind = r.kind;
      runs[name].poses[pose] = r;
      if (name === 'kit') runs[name].poses[pose + ':again'] = await p.rtHitRadiance();
    }
  }
  const lum = (r, i) => (r[i * 4] + r[i * 4 + 1] + r[i * 4 + 2]) / 3;
  const diff = (a, b) => {
    let n = 0, d = 0, ref = 0;
    for (let i = 0; i < a.source.length; i++) {
      if (a.source[i] !== 1 || b.source[i] !== 1) continue;
      n++; ref += lum(b.radiance, i);
      for (let c = 0; c < 3; c++) d += Math.abs(a.radiance[i * 4 + c] - b.radiance[i * 4 + c]) / 3;
    }
    return { px: n, mad: n ? d / n : 0, rel: ref ? d / ref : 0 };
  };
  // px where a's hit differs from b's by > 1%; with ref, over those px, the mean abs rgb diff of a and of b vs ref
  const changed = (a, b, ref) => {
    let n = 0, ch = 0, da = 0, db = 0;
    const d = (x, y, i) => (Math.abs(x.radiance[i * 4] - y.radiance[i * 4]) + Math.abs(x.radiance[i * 4 + 1] - y.radiance[i * 4 + 1]) + Math.abs(x.radiance[i * 4 + 2] - y.radiance[i * 4 + 2])) / 3;
    for (let i = 0; i < a.source.length; i++) {
      if (a.source[i] !== 1 || b.source[i] !== 1) continue;
      n++; const x = lum(a.radiance, i), y = lum(b.radiance, i);
      if (!(Math.abs(x - y) > 0.01 * y + 1e-4)) continue;
      ch++;
      if (ref && ref.source[i] === 1) { da += d(a, ref, i); db += d(b, ref, i); }
    }
    return { px: n, changed: ch, ...(ref ? { madA: ch ? da / ch : 0, madB: ch ? db / ch : 0 } : {}) };
  };
  const out = { variants: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { sizes: v.sizes, atlases: v.atlases, kind: v.kind }])), poses: {} };
  for (const pose of poses) {
    const ref = runs.all512.poses[pose];
    out.poses[pose] = {
      kit: diff(runs.kit.poses[pose], ref), room: diff(runs.room.poses[pose], ref),
      self: diff(runs.kit.poses[pose + ':again'], runs.kit.poses[pose]),
      kitVsRoom: changed(runs.kit.poses[pose], runs.room.poses[pose], ref), allVsRoom: changed(ref, runs.room.poses[pose]),
    };
  }
  await p.setProbeVolumes(null);
  delete p.ssr.settings.hitColorFilter;
  return out;
}`;
/** examples/ssr offscreen, `bvh` '' (three-mesh-bvh) or 'pmndrs': the {@link RT_HIT_ATLASES} check. JSON to out/w47-rt-hit-atlases[-pmndrs].json. */
async function rtHitAtlasChecks(pages, bvh = '') {
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?manual&rt=1&bvh=three-mesh-bvh&denoise=0&scene=offscreen&bvh=${bvh || 'three-mesh-bvh'}`);
  pages.push(p);
  const r = await p.T(`(${RT_HIT_ATLASES})(['default', 'mirror'])`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `w47-rt-hit-atlases${bvh ? `-${bvh}` : ''}.json`), JSON.stringify(r, null, 1));
  // the kit with RT on as a user sees it (on-screen reuse on): the wall mirror's traced hits behind the camera
  for (const pose of ['default', 'mirror']) {
    for (const view of ['final', 'ssr']) {
      await p.T(`(async () => { const p = window.__p; p.setPose('${pose}'); p.setRT(true); p.setView('${view}'); await p.step(3); })()`);
      savePng(`w47-rt-${pose}-${view}${bvh ? `-${bvh}` : ''}.png`, await p.T('window.__p.shot()'));
    }
  }
  const v = r.variants, fmt = (x) => `${x.mad.toFixed(4)} (rel ${x.rel.toFixed(3)})`;
  const detail = `${Object.entries(r.poses).map(([pose, x]) => `${pose}: ${x.kit.px} hit px, vs all 512: kit ${fmt(x.kit)}, room only ${fmt(x.room)}, self ${x.self.mad.toExponential(1)}; kit != room on ${x.kitVsRoom.changed} px (all 512 != room on ${x.allVsRoom.changed}), there vs all 512: kit ${x.kitVsRoom.madA.toFixed(4)}, room ${x.kitVsRoom.madB.toFixed(4)}`).join('; ')}; kit atlases ${v.kit.atlases} [${v.kit.sizes}]`;
  // the kit's hits read the 512 px floor / mirror probes: they move off the room probe's answer (before
  // the fix on no px) and toward all-512's (the room probe's own 256 vs 512 is the rest of the gap)
  check(`rt${bvh ? ` (${bvh})` : ''}: traced hits over a mixed-size probe set see the probes outside the primary atlas (offscreen, floor + mirror 512 px, D4702)`,
    v.kit.atlases === 2 && v.kit.kind === 'probes' && v.all512.atlases === 1 && Object.values(r.poses).every((x) => x.kit.px > 10000 && x.self.mad === 0
      && x.kitVsRoom.changed > 1000 && x.kitVsRoom.madA < 0.5 * x.kitVsRoom.madB && x.kit.mad < x.room.mad),
    detail);
}

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
  if (args.includes('--rt-bvh-timing-only')) return rtBvhTiming(pages);
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
    if (builder !== 'auto') { await rtMaterialChecks(p, `@pmndrs/bvh (${bvh.builder})`, oracleOk); continue; } // W49
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
    await rtMaterialChecks(p, `@pmndrs/bvh (${bvh.builder})`, oracleOk); // W49 (D1701 / D1702)
    if (args.includes('--rt-material-assets')) await rtMaterialAssetSurvey(p, '@pmndrs/bvh');
  }
  if (args.includes('--rt-shadow-timing')) await rtShadowTiming('@pmndrs/bvh', '&bvh=pmndrs');
  await rtHitAtlasChecks(pages, 'pmndrs'); // W47 (D4702)

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
  if (args.includes('--rt-bvh-timing')) await rtBvhTiming(pages);
}

/**
 * W48: 'rt trace' GPU ms at 1080p per walk (three-mesh-bvh, @pmndrs/bvh, @pmndrs/bvh with its
 * instance-mask test compiled in, `&bvhRayMasks=1`), loop stopped, median of 20 frames per run, `--rt-bvh-rounds` runs (default 3)
 * in rotating order, median of the runs. Two loads per run: the default miss list, then every pixel
 * below confidence 1.01 traced (the walk's cost on a full screen of rays). Opt-in (`--rt-bvh-timing`).
 */
async function rtBvhTiming(pages) {
  const rounds = args.includes('--rt-bvh-rounds') ? Number(args[args.indexOf('--rt-bvh-rounds') + 1]) : 3;
  const variants = [['three-mesh-bvh', '&bvh=three-mesh-bvh'], ['@pmndrs/bvh', '&bvh=pmndrs'], ['@pmndrs/bvh rayMasks on', '&bvh=pmndrs&bvhRayMasks=1']];
  const scenes = [['offscreen', 'mirror'], ['mirrorWall', ''], ['contact', ''], ['moving', ''], ['boxRoom', ''],
    ...(fs.existsSync(path.join(ROOT, 'examples/assets/Sponza')) ? [['sponza', '']] : [])];
  const url = (param, scene, pose) => `http://127.0.0.1:${PORT}/ssr/?manual&timing&w=1920&h=1080&rt=1${param}&scene=${scene}${pose ? `&pose=${pose}` : ''}`;
  const page = await openPage(url(variants[0][1], ...scenes[0]));
  pages.push(page);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const out = {};
  for (const [scene, pose] of scenes) {
    const ms = Object.fromEntries(variants.map(([v]) => [v, { def: [], all: [] }]));
    let misses = { def: 0, all: 0 };
    for (let r = 0; r < rounds; r++) {
      for (let k = 0; k < variants.length; k++) {
        const [v, param] = variants[(k + r) % variants.length];
        await page.navigate(url(param, scene, pose));
        ms[v].def.push((await page.T('window.__p.time(20)')).ms['rt trace'] ?? NaN);
        await page.T('window.__p.step(1)');
        misses.def = (await page.T('window.__p.traceStats()')).misses;
        await page.T('window.__p.setSettings({ missConfidenceThreshold: 1.01 })');
        ms[v].all.push((await page.T('window.__p.time(20)')).ms['rt trace'] ?? NaN);
        await page.T('window.__p.step(1)');
        misses.all = (await page.T('window.__p.traceStats()')).misses;
      }
    }
    out[scene] = { misses, ms: Object.fromEntries(variants.map(([v]) => [v, { def: med(ms[v].def), all: med(ms[v].all), runs: ms[v] }])) };
    console.log(`  (info) rt trace GPU ms at 1920x1080, ${scene}${pose ? ` '${pose}'` : ''}, median of ${rounds} runs (default ${misses.def} misses / all traced ${misses.all}): ${variants.map(([v]) => `${v} ${out[scene].ms[v].def.toFixed(3)} / ${out[scene].ms[v].all.toFixed(3)}`).join(', ')}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'rt-bvh-timing.json'), JSON.stringify(out, null, 2));
  page.close();
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
    // W46 (D3570): roughness from normal variance (?specAA, on by default) reaches the G-buffer the composite reads
    // (the paint's flake map: door 0.25 -> ~0.35 at 1280x720 hero), and turning it off restores the authored value
    const beforeAA = results.logs.length;
    const aa = await p.T(`(async () => {
      const P = window.__p; await P.load('carConcept'); P.setPose('hero'); P.stop();
      const rt = P.ssr.gbuffer.renderTarget, i = rt.textures.indexOf(P.ssr.gbuffer.textures.normalRoughness);
      const door = async () => {
        await P.step(2);
        const d = await P.renderer.readRenderTargetPixelsAsync(rt, 560, 345, 161, 44, i);
        const f = (v) => (d instanceof Uint16Array ? P.THREE.DataUtils.fromHalfFloat(v) : v);
        let s = 0, n = 0; for (let k = 3; k < d.length; k += 4) { const v = f(d[k]); if (v > 0) { s += v; n++; } }
        return s / n;
      };
      P.setSpecAA(0); const off = await door(); P.setSpecAA(1); const on = await door(); P.setSpecAA(0); const back = await door(); P.setSpecAA(1);
      return { off, on, back, errors: P.gpuErrors.length };
    })()`);
    const aaErrs = results.logs.slice(beforeAA).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
    check('showcase carConcept: roughness from normal variance (specAA) reaches the G-buffer and turns off cleanly', aa.errors === 0 && aaErrs.length === 0 && Math.abs(aa.off - 0.25) < 0.01 && aa.on > 0.3 && Math.abs(aa.back - aa.off) < 1e-3,
      `door G-buffer roughness off ${aa.off.toFixed(3)}, on ${aa.on.toFixed(3)}, off again ${aa.back.toFixed(3)}${aaErrs.length ? '; ' + aaErrs[0] : ''}`);
  }
}

/**
 * examples/showcase/bench.html (W51, the tuning bench): loads carConcept with ours + RT | three SSR +
 * denoise, moves every schema control once through the page's own DOM controls (live ones reset after
 * each move; creation-time ones left set, then one Rebuild with all of them, then three SSR + FFX, the
 * path tracer, probes only and ours denoised created with them), switches the scene and back, renders
 * each view mode (split, side by side, |A - B| heat map), and runs Measure once on carConcept at W50's
 * pose (path-traced reference, W50's named regions plus a dragged-in one). Passes with no GPU validation
 * errors or exceptions, images that aren't black and finite region numbers. Skipped without assets.
 * Screenshots: out/bench-{split,side,diff,rebuilt}.png.
 */
async function benchChecks(pages) {
  console.log('examples/showcase/bench.html:');
  const p = await openPage(`http://127.0.0.1:${PORT}/showcase/bench.html?manual&scene=carConcept&pose=w50&left=ours-rt&right=three-denoise`);
  pages.push(p);
  if (!(await p.T('window.__p.entries()')).length) { console.log('  (no assets downloaded: bench skipped)'); return; }
  const errsSince = (n) => results.logs.slice(n).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));
  const lum = (url) => p.T(`(async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const g = c.getContext('2d'); g.drawImage(i, 0, 0, 160, 90); const d = g.getImageData(0, 0, 160, 90).data; let s = 0; for (let k = 0; k < d.length; k += 4) s += d[k] + d[k + 1] + d[k + 2]; return s / (d.length / 4) / 3; })(${JSON.stringify(url)})`);
  let before = results.logs.length;
  await p.T('window.__p.step(4)');
  // 1. every control once, through the DOM
  const sweep = await p.T(`(async () => {
    const P = window.__p, out = { live: 0, rebuild: [], planned: [], failed: [] };
    for (const s of P.settings()) {
      if (s.planned) { out.planned.push(s.id); continue; }
      if (s.id === 'scene' || s.id === 'pose') continue; // below / the camera
      try {
        P.moveControl(s.id); await P.step(2);
        if (s.apply === 'live' || s.page) { P.resetControl(s.id); await P.step(1); out.live++; } else out.rebuild.push(s.id);
      } catch (e) { out.failed.push(s.id + ': ' + (e.message ?? e)); }
    }
    return out;
  })()`);
  let errs = errsSince(before).concat(await p.T('window.__p.gpuErrors()'));
  check('bench: every live control moved and reset through the DOM, no GPU errors or exceptions', errs.length === 0 && sweep.failed.length === 0,
    `${sweep.live} live, ${sweep.rebuild.length} creation-time left set, planned: ${sweep.planned.join(', ') || 'none'}${sweep.failed.length ? '; ' + sweep.failed[0] : ''}${errs.length ? '; ' + errs[0] : ''}`);
  // 2. one Rebuild with every creation-time setting moved, then the other methods built with them
  before = results.logs.length;
  const rb = await p.T(`(async () => {
    const P = window.__p; const pend = P.pending();
    await P.rebuild(); await P.step(8);
    const a = await P.shot();
    await P.setSides('three-ffx', 'pathtraced'); await P.step(4);
    const b = await P.shot();
    await P.setSides('probes', 'ours-denoised'); await P.step(4);
    const c = await P.shot();
    const info = P.info();
    P.resetAll(false); await P.setSides('ours-rt', 'three-denoise'); await P.rebuild(); await P.step(4);
    return { pend, a, b, c, info, after: P.pending() };
  })()`);
  savePng('bench-rebuilt.png', rb.a);
  errs = errsSince(before).concat(await p.T('window.__p.gpuErrors()'));
  const lums = [await lum(rb.a), await lum(rb.b), await lum(rb.c)];
  check('bench: one Rebuild with every creation-time setting moved, then three SSR + FFX, PT, probes, ours denoised built with them', errs.length === 0 && lums.every((l) => l > 8) && rb.pend.methods.length > 0,
    `pending ${rb.pend.methods.join(', ')}${rb.pend.page ? ' + page (size)' : ''}; means ${lums.map((l) => l.toFixed(0)).join(' / ')}/255${errs.length ? '; ' + errs[0] : ''}`);
  // 3. the scene control: away and back
  before = results.logs.length;
  const sc = await p.T(`(async () => {
    const P = window.__p, wait = async (id) => { const t0 = Date.now(); while ((P.info().scene !== id || P.info().live.length < 2) && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 200)); };
    P.moveControl('scene', 'toyCar'); await wait('toyCar'); await P.step(3); const t = P.info().scene;
    P.moveControl('scene', 'carConcept'); await wait('carConcept'); P.setPose('w50'); await P.step(3);
    return { t, back: P.info().scene };
  })()`);
  errs = errsSince(before).concat(await p.T('window.__p.gpuErrors()'));
  check('bench: the scene control switches and comes back', errs.length === 0 && sc.t === 'toyCar' && sc.back === 'carConcept', `${sc.t} -> ${sc.back}${errs.length ? '; ' + errs[0] : ''}`);
  // 4. view modes
  before = results.logs.length;
  const shots = {};
  for (const m of ['split', 'side', 'diff']) {
    shots[m] = await p.T(`(async () => { const P = window.__p; P.setMode('${m}'); await P.step(6); return P.shot(); })()`);
    savePng(`bench-${m}.png`, shots[m]);
  }
  const diff = await p.T('window.__p.lastDiff');
  errs = errsSince(before).concat(await p.T('window.__p.gpuErrors()'));
  const ml = { split: await lum(shots.split), side: await lum(shots.side), diff: await lum(shots.diff) };
  check('bench: view modes render (split, side by side, |A - B| heat map with its stats)', errs.length === 0 && ml.split > 8 && ml.side > 8 && !!diff && Number.isFinite(diff.mean) && diff.mean > 0,
    `means split ${ml.split.toFixed(0)}, side ${ml.side.toFixed(0)}, heat ${ml.diff.toFixed(0)}/255; |A - B| mean ${diff?.mean.toFixed(2)}, p99 ${diff?.p99}${errs.length ? '; ' + errs[0] : ''}`);
  // 4b. both sides follow the camera (W51 found the upscaler presenting a stale first frame once several
  // renderers' GPU timers exhausted Metal's query sample buffers): A alone and B alone at two poses must differ
  const follow = await p.T(`(async () => { const P = window.__p; P.setMode('split'); const out = {};
    for (const [side, x] of [['A', 1], ['B', 0]]) { P.setSplit(x); P.setPose('hero'); await P.step(6); const a = await P.shot(); P.setPose('w50'); await P.step(6); const b = await P.shot(); out[side] = [a, b]; }
    P.setSplit(0.5); return out; })()`);
  const fa = await p.T(`(${IMAGE_STATS})(${JSON.stringify(follow.A[0])}, ${JSON.stringify(follow.A[1])})`);
  const fb = await p.T(`(${IMAGE_STATS})(${JSON.stringify(follow.B[0])}, ${JSON.stringify(follow.B[1])})`);
  check('bench: both sides follow the shared camera (pose hero -> w50 changes A and B, AA on)', fa.mean > 3 && fb.mean > 3, `mean |hero - w50| A ${fa.mean.toFixed(1)}, B ${fb.mean.toFixed(1)}/255`);
  // 4c. setting A/B on one method: snapshot A as B, flip a candidate (hitLobeFilter 1 -> 0, W50's halo), heat map of live A vs the snapshot
  before = results.logs.length;
  const ab = await p.T(`(async () => { const P = window.__p; await P.setSides('ours-rt', 'three-denoise'); P.setPose('w50'); P.freeze(true); P.setMode('diff');
    await P.step(24); P.snapshot(); await P.step(2); const same = P.lastDiff.mean;
    P.setSetting('lobeFilter', 0); await P.step(24); const flipped = P.lastDiff.mean; const shot = await P.shot();
    P.setSetting('lobeFilter', null); P.clearSnapshot(); P.freeze(false); P.setMode('split'); await P.step(2);
    return { same, flipped, shot }; })()`);
  savePng('bench-snapshot-lobefilter.png', ab.shot);
  errs = errsSince(before).concat(await p.T('window.__p.gpuErrors()'));
  check('bench: snapshot A as B, flip hitLobeFilter 1 -> 0, heat map shows the change', errs.length === 0 && ab.flipped > ab.same,
    `|live A - snapshot| mean ${ab.same.toFixed(3)} right after the snapshot, ${ab.flipped.toFixed(3)} with lobeFilter 0${errs.length ? '; ' + errs[0] : ''}`);
  // 5. Measure once on carConcept at W50's pose: W50's regions plus a dragged-in one
  before = results.logs.length;
  const m = await p.T(`(async () => { const P = window.__p; P.setMode('split'); await P.setSides('ours-rt', 'pathtraced'); P.setPose('w50');
    P.addRegion('underside', [0.47, 0.6, 0.2, 0.12]);
    return P.measure({ samples: 16, warmup: 16, frames: 4 }); })()`);
  errs = errsSince(before).concat(await p.T('window.__p.gpuErrors()'));
  const need = ['frame', 'glossy', 'lip', 'band', 'wheel', 'door', 'car', 'underside'];
  const byName = Object.fromEntries(m.rows.map((r) => [r.region, r]));
  const missing = need.filter((n) => !byName[n] || !(byName[n].px > 0) || !Number.isFinite(byName[n].methods['ours-rt']?.mad));
  check('bench: Measure on carConcept (pose w50) vs the path tracer over frame, glossy, W50\'s regions and a dragged one', errs.length === 0 && missing.length === 0,
    `${m.referenceSamples} spp; ${m.rows.map((r) => `${r.region} ${r.px} px MAD ${r.methods['ours-rt']?.mad.toFixed(1)} (luma ${r.methods['ours-rt']?.luma.toFixed(1)}, PT ${r.refLuma.toFixed(1)})`).join('; ')}${missing.length ? '; missing ' + missing.join(', ') : ''}${errs.length ? '; ' + errs[0] : ''}`);
  // 6. state: copy as code, URL, presets
  const st = await p.T(`(() => { const P = window.__p; P.setSetting('lobeFilter', 0); const code = P.copyAsCode(); const q = P.settingsQuery();
    const pre = P.presets.read(); pre['check'] = q; const ok = P.presets.write(pre); const back = P.presets.read()['check']; P.setSetting('lobeFilter', null);
    return { code, q, ok, back }; })()`);
  check('bench: copy as code, URL state and presets', st.code.includes('ScreenSpaceReflectionsPass') && st.code.includes('hitLobeFilter: 0') && st.q.includes('lobeFilter=0') && (!st.ok || st.back === st.q),
    `query '${st.q}', preset round trip ${st.ok ? 'ok' : 'storage unavailable'}, code ${st.code.split('\n').length} lines`);
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
      // W76: the babylon adapter dispatches core with its own settings object: core's defaults reach it (cone +
      // compensation at mirrorBias 0.5), and the cone's async variant comes up without errors
      const w76 = await p.T(`(async () => { const P = window.__p, t = () => P.ssr.tracer;
        for (let i = 0; i < 60 && !t()?.outputs.hitColorFilterActive; i++) { await P.step(1); await new Promise((r) => setTimeout(r, 100)); }
        const ran = t()?.outputs.settings ?? {};
        return { active: !!t()?.outputs.hitColorFilterActive, hitColorFilter: ran.hitColorFilter, mirrorBias: ran.mirrorBias, mirrorBiasCompensate: ran.mirrorBiasCompensate, gpuErrors: (P.gpuErrors ?? []).length }; })()`);
      check('babylon: W76 defaults reach the adapter (cone + compensation at mirrorBias 0.5, active, no GPU errors)',
        w76.active && w76.hitColorFilter === 'cone' && w76.mirrorBias === 0.5 && w76.mirrorBiasCompensate === true && w76.gpuErrors === 0, JSON.stringify(w76));
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
  setTimeout(() => { console.error('FAILED: timed out'); /* the 'exit' handler kills this run's Chromes */ process.exit(3); }, probeBenchFull || ssrBenchFull || mirrorBiasFull || only === 'probe-layouts-measure' || only === 'probe-bindings-measure' || only === 'probe-lookup-cost' || only === 'probe-lookup-ab' || only === 'probe-lookup-parity' || only === 'ssr-exp-baseline' || only === 'ssr-exp-grazing' ? 3_600_000 : 600_000).unref();
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
      // W60 (D4700): per-probe resolution, one atlas per size; each probe's lookups (plain and re-fit)
      // equal a one-size set's at its size, bit for bit, on the cube array and both 2D-array fallbacks
      for (const [storage, bounces] of [['cube-array', 1], ['warp', 1], ['none', 1], ['cube-array', 2]]) {
        const mr = await p.T(`window.__p.checks.mixedResolution('${storage}', ${bounces})`);
        const okInfo = mr.info.textures === 3 && mr.info.resolutions.join(',') === '128,64,256' && mr.info.atlases.join(',') === '0,2,1,2' && mr.info.slots.join(',') === '0,0,0,1' && mr.info.environmentSlot === 1
          && mr.info.layout === (storage === 'cube-array' ? 'cube-array' : 'cube2d');
        check(`mixed probe resolutions (${storage}${bounces > 1 ? `, ${bounces} bounces` : ''}): each probe samples its own atlas at its own size (D4700)`,
          okInfo && mr.probes.every((q) => q.own === 0 && q.ownRefit === 0 && q.other > 1e-3 && q.lum > 0.1),
          `${JSON.stringify(mr.info)}; ${mr.probes.map((q) => `${q.res} px (atlas ${q.atlas} slot ${q.slot}): vs own size ${q.own}, re-fit ${q.ownRefit}, vs other sizes >= ${q.other.toExponential(1)}, lum ${q.lum.toFixed(2)}`).join('; ')}`);
        if (bounces === 1 && storage === 'cube-array') {
          check('mixed probe resolutions: a time-sliced re-bake of one probe moves only its lookups (D4700)', mr.slice[3] > 0.05 && mr.slice.slice(0, 3).every((d) => d === 0), `max change per probe ${mr.slice.map((d) => d.toExponential(1)).join(', ')}`);
        }
      }
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
    if (only === 'hit-color-filter') await hitColorFilterChecks(pages); // W72: hitColorFilter / mirrorBiasCompensate alone (also part of ssr)
    if (only === 'mirror-bias') await mirrorBiasChecks(pages); // W32: the mirrorBias check alone (also part of ssr)
    if (only === 'ray-reuse') await rayReuseChecks(pages); // W73: the rayReuse check alone (also part of ssr)
    if (only === 'denoiser-gate') await denoiserGateChecks(pages); // W34: the D1402 check alone (also part of ssr)
    if (only === 'spec-occ') await specOccChecks(pages); // W39: the specOcc toggle alone (also part of ssr)
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
    if (only === 'halo-options') await haloOptionChecks(pages); // W52 (D3640-D3642)
    if (only === 'ssr-exp-x1') await x1Checks(pages); // W71 (X1, D5000-D5003): defaults identical on examples/ssr
    if (only === 'ssr-exp-grazing') await grazingSweep(pages); // W71 (X1 #3): grazing sweep vs the path tracer (minutes), JSON to out/w71-grazing.json
    if (only === 'hit-source') await hitSourceChecks(pages); // W53 (D3660-D3662)
    if (only === 'half-res') { await halfResChecks(pages); await presetChecks(pages); } // W75 (X5, D5080), W77: also part of hybrid
    if (only === 'preset') await presetChecks(pages); // W77
    if (only === 'brdf-prefilter') await brdfPrefilterChecks(pages); // W78 (D5140-D5146)
    if (runs('probe-layouts')) await probeLayoutChecks(pages); // W61
    if (runs('probe-bindings')) await probeBindingChecks(pages); // W62
    if (only === 'probe-bindings-measure') await probeBindingMeasure(pages); // W62: the measurement (minutes), JSON to out/w62-probe-bindings.json
    if (only === 'probe-layouts-measure') await probeLayoutMeasure(pages); // W61: the measurement (minutes), JSON to out/w61-probe-layouts.json
    if (only === 'probe-lookup-ab') await probeLookupAB(pages); // W63: lookup variants interleaved in one page, JSON to out/w63-probe-lookup-ab.json
    if (only === 'probe-cluster-build') await probeClusterBuild(pages); // W63: a clustered volume list's build cost (compute), JSON to out/w63-cluster-build.json
    if (only === 'probe-lookup-parity') await probeLookupParity(pages); // W63: a lookup variant vs the shipped lookup, image for image
    if (only === 'probe-lookup-cost') await probeLookupCost(pages); // W63: the lookup's cost per variant and volume count, JSON to out/w63-probe-lookup-cost.json
    if (only === 'offscreen-sizes') await offscreenSizeMeasure(pages); // W60 (D4700): offscreen per-probe sizes, JSON to out/w60-offscreen.json
    if (only === 'rt-hit-atlases') { await rtHitAtlasChecks(pages); await rtHitAtlasChecks(pages, 'pmndrs'); } // W47 (D4702): RT hits over a mixed-size set alone (also part of ssr-rt / ssr-rt-bvh)
    if (only === 'rt-materials') await rtMaterialsAlone(pages); // W49 (D1701 / D1702): per-triangle hit materials on both providers alone (also part of ssr-rt / ssr-rt-bvh)
    if (runs('babylon')) await babylonChecks(pages);
    if (runs('ssr-rt-bvh')) await ssrRtBvhChecks(pages);
    if (runs('pixi3d')) await pixi3dChecks(pages);
    if (ssrBenchFull) await ssrBench();
    else if (runs('ssr-bench')) await ssrBenchSmoke(pages);
    if (runs('showcase')) await showcaseChecks(pages);
    if (runs('showcase-compare')) await showcaseCompareChecks(pages);
    if (runs('bench')) await benchChecks(pages); // W51: the tuning bench
    if (only === 'ssr-exp-metrics') await ssrExpMetricsSmoke({ openPage, check, PORT, OUT, results, savePng }, pages); // X0 (W70)
    if (only === 'ssr-exp-baseline') await ssrExpBaseline({ openPage, check, PORT, OUT, results, savePng }, pages); // X0 (W70)
    if (only === 'ssr-exp-run') await ssrExpRun({ openPage, check, PORT, OUT, results, savePng }, pages); // X0 (W70): one metric call on one page (SSR_EXP_URL, SSR_EXP_EVAL)

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
      // W60 (D4700): ProbeSet slotSizes, one atlas per size; each slot (and the environment) as a one-size set at its size
      for (const z of r.sizes) {
        check(`probe core: slot sizes ${z.info.slotSizes.join('/')} in ${z.info.atlases} atlases (${z.layout}) = one-size sets at each size, plain and re-fit (D4700)`,
          z.info.atlases === 3 && z.per.every((q) => q.plain === 0 && q.refit === 0), z.per.map((q) => `${q.what} ${q.plain} / ${q.refit}`).join(', '));
      }
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
      // W64 (D4901): one set as the SSSR fallback and its hitSpecularShading; the frame = the fallback-only frame
      for (const [k, b] of Object.entries(r.sssr.both)) {
        check(`sssr probe fallback + hit shading on one set (${b.atlases} atlas${b.atlases > 1 ? 'es' : ''}): builds, = the fallback seam alone (to one f16 step), the hit shading's copy live, + the traced pass (D4901)`,
          b.error === null && b.vsSeparate === 0 && b.hitShadingLive > 100 && b.hitAloneVsConstant > 100 && b.rtHits > 100 && (k === 'one' ? b.atlases === 1 : b.atlases === 4),
          b.error ?? `${b.vsSeparate} px differ from the fallback alone; intensity 0 changes ${b.hitShadingLive}, the hit shading alone over the constant fallback ${b.hitAloneVsConstant} of ${r.sssr.pixels} px; traced ${b.rtHits} hits`);
      }
      // W47 (D4702): core probeHitShading over a set with probes of two sizes (the wall's probe in atlas 1)
      const hz = r.sssr.hitSizes;
      check(`rt probe hit shading: slot sizes ${hz.mixed.sizes.join('/')} in ${hz.mixed.atlases} atlases = a one-size set at the wall probe's size, and its probe reaches the hits (D4702)`,
        hz.errors.length === 0 && hz.mixed.atlases === 2 && hz.mixed.wgslAtlasBindings === 2 && hz.one.wgslAtlasBindings === 1 && hz.vsOneSize === 0 && hz.hits > 100 && hz.wallProbeReaches > 100,
        hz.errors.length ? hz.errors.join(' | ') : `${hz.vsOneSize} px differ from the one-size set; the wall probe's capture changes ${hz.wallProbeReaches} of ${r.sssr.pixels} px (${hz.hits} traced hits)`);
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
      // W62 (D4902): three probe sizes in one 2D octahedral atlas (HDRP-style) read exactly what each probe
      // reads in its own texture (no bleed into the 1000-filled rest; UV rounding only). `--probe-atlas`: the
      // full run (65536 directions, error vs GGX, lookup timing, side 2x and 4x the capture), JSON to out/w62-probe-atlas.json
      const full = args.includes('--probe-atlas');
      const atlasRuns = [];
      for (const ratio of full ? [2, 4] : [2]) {
        const r = await pb.T(`window.__p.atlas(${JSON.stringify(full ? { ratio } : { ratio, nDirs: 4096, timing: false })})`);
        atlasRuns.push(r);
        const worst = Math.max(...r.identity.map((x) => x.maxTone));
        // bleed would read the 1000 fill (tone ~254 / 255); what is left is filtering precision: a small tile's
        // bilinear weights are quantized against the atlas's width, not its own (W62: <= 2.4 / 255, lod 0 near the sun, 128 px tile in 2048)
        check(`octa atlas (side ${ratio}x, ${r.memory.tiles.map((t) => t.capture).join(' / ')} px in one ${r.memory.atlasSize.join('x')} texture): every tile reads as its own probe at every lod, no bleed (W62, D4902)`,
          r.identity.length > 0 && worst <= 4, `max ${worst.toFixed(2)} / 255 over ${r.identity.length} tile x lod lookups (bleed would read ~254)`);
      }
      if (full) {
        console.log((await pb.cdp.evalJs('window.__p.log', false)).split('\n').filter((l) => /atlas|error vs|lookup 1920/.test(l)).join('\n').replace(/^/gm, '    '));
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'w62-probe-atlas.json'), JSON.stringify(atlasRuns, null, 1));
      }
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
