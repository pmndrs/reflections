// X0 (W70): the SSR-sources experiment plan's shared yardsticks as `pnpm check` sections
// (docs/plans/ssr-sources-experiments.md "X0"; the API in examples/shared/metrics/README.md).
//
//   pnpm check -- --only ssr-exp-metrics    # smoke: every metric runs and returns finite numbers (examples/ssr contact + the bench)
//   pnpm check -- --only ssr-exp-baseline   # the baseline at today's defaults (long); JSON to $OUT/ssr-exp-baseline.json
//                                           # SSR_EXP_SCENES=contact,carConcept narrows it; SSR_EXP_PARTS=ssr,showcase,lineSpread,grazing
//
// run-headless.mjs passes its helpers in `ctx` ({ openPage, check, PORT, OUT, results }), so this file only adds sections.
import fs from 'node:fs';
import path from 'node:path';

/** Every number in a (nested) result is finite. Returns the paths of the ones that aren't. */
function nonFinite(o, at = '') {
  if (typeof o === 'number') return Number.isFinite(o) ? [] : [at];
  if (o === null || typeof o !== 'object') return [];
  return Object.entries(o).flatMap(([k, v]) => nonFinite(v, at ? `${at}.${k}` : k));
}
const errsSince = (ctx, n) => ctx.results.logs.slice(n).filter((l) => /invalid|validation|uncaptured|exception/i.test(l));

/** A few-frame run of every page metric (finite, no errors). */
const SMOKE_ALL = {
  restDrift: { a: 12, b: 24 },
  orbitFlicker: { warm: 4, passes: 2, half: 4 },
  quadEnergy: { warm: 4, frames: 2 },
  edgePan: { warm: 4, frames: 6 },
  speckle: { warm: 4, frames: 2 },
  energy: { warm: 4, frames: 4 },
};

export async function ssrExpMetricsSmoke(ctx, pages) {
  const { openPage, check, PORT } = ctx;
  console.log('ssr-exp-metrics (X0, W70): examples/ssr contact');
  let before = ctx.results.logs.length;
  const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?scene=contact`);
  pages.push(p);
  await p.T('window.__p.stop()');
  const r = await p.T(`window.__p.metrics.all(${JSON.stringify(SMOKE_ALL)})`);
  let bad = nonFinite(r), errs = errsSince(ctx, before).concat(await p.T('window.__p.gpuErrors'));
  const parts = ['restDrift', 'orbitFlicker', 'quadEnergy', 'edgePan', 'speckle', 'energy'];
  const px = r.restDrift?.regions?.reflection?.px ?? 0;
  check('ssr-exp metrics: every page metric runs on examples/ssr contact (upscaler, denoiser) and returns finite numbers, no GPU errors',
    bad.length === 0 && errs.length === 0 && parts.every((k) => r[k]) && px > 1000,
    `reflection px ${px}; drift ${r.restDrift?.regions?.reflection?.mean}; orbit std ${r.orbitFlicker?.regions?.reflection?.std}; quad ratio ${r.quadEnergy?.display?.reflection?.ratio} (signal ${r.quadEnergy?.signal?.reflection?.ratio}); pan d2 ${r.edgePan?.regions?.borderReflection?.d2}; speckle ${r.speckle?.regions?.reflection?.pct}%; energy loss ${r.energy?.regions?.reflection?.loss}${bad.length ? '; non-finite ' + bad.slice(0, 3).join(', ') : ''}${errs.length ? '; ' + errs[0] : ''}`);

  // the bench: the PT metrics (line spread, grazing) at a few samples, Measure's X0 columns, the page metrics on a bench method
  console.log('ssr-exp-metrics: examples/showcase/bench.html lineSpread / grazing');
  before = ctx.results.logs.length;
  const b = await openPage(`http://127.0.0.1:${PORT}/showcase/bench.html?manual&scene=lineSpread&pose=e15&left=ours-denoised&right=ours-denoised`);
  pages.push(b);
  const ents = await b.T('window.__p.entries()');
  if (!ents.includes('lineSpread')) { console.log(`  (no studio HDRI: bench part skipped; entries ${ents.join(', ')}; ${await b.T("document.querySelector('#status')?.textContent")})`); return r; }
  const ls = await b.T("window.__p.metrics.lineSpread({ roughness: [0.05], samples: 32, warmup: 8, frames: 2 })");
  ctx.savePng('ssr-exp-lineSpread.png', await b.T('window.__p.shot()'));
  const gz = await b.T("window.__p.metrics.grazing({ elevations: [15], samples: 16, warmup: 8, frames: 2 })");
  ctx.savePng('ssr-exp-grazing.png', await b.T('window.__p.shot()'));
  const cols = await b.T('window.__p.lastMeasure.rows.map((x) => ({ region: x.region, refQuad: x.refQuad, ...x.methods["ours-denoised"] }))');
  const pm = await b.T(`window.__p.metrics.all(${JSON.stringify(SMOKE_ALL)})`);
  bad = [...nonFinite(ls).map((x) => 'lineSpread.' + x), ...nonFinite(gz).map((x) => 'grazing.' + x), ...nonFinite(cols).map((x) => 'measure.' + x), ...nonFinite(pm).map((x) => 'bench.' + x)];
  errs = errsSince(ctx, before).concat(await b.T('window.__p.gpuErrors()'));
  const lr = ls.rows[0], gr = gz.rows[0];
  check('ssr-exp metrics: the bench line spread, grazing sweep, Measure X0 columns and page metrics return finite numbers, no GPU errors',
    bad.length === 0 && errs.length === 0 && lr?.pt > 0 && lr.methods['ours-denoised']?.width > 0 && gr?.px > 1000 && cols.every((c) => Number.isFinite(c.std)) && !!pm.energy,
    `line spread r 0.05 @ e15: PT ${lr?.pt} px, ours ${lr?.methods['ours-denoised']?.width} px (median column ${lr?.methods['ours-denoised']?.medianColumn}); grazing e15: ${gr?.px} glossy px, MAD ${gr?.methods['ours-denoised']?.mad}, gradient ratio ${gr?.methods['ours-denoised']?.gradientRatio}; glossy std ${cols.find((c) => c.region === 'glossy')?.std}, quad ${cols.find((c) => c.region === 'glossy')?.quad}; bench energy loss ${pm.energy?.regions?.reflection?.loss}${bad.length ? '; non-finite ' + bad.slice(0, 3).join(', ') : ''}${errs.length ? '; ' + errs[0] : ''}`);
  return { ssr: r, lineSpread: ls, grazing: gz, measure: cols, bench: pm };
}

const SSR_SCENES = ['mirrorWall', 'contact', 'facingMirrors', 'moving', 'offscreen', 'rooms'];
const SHOWCASE_SCENES = ['carConcept', 'toyCar', 'chess', 'sponza'];

/**
 * The baseline at today's defaults (W70): every page metric on examples/ssr's six scenes (AA upscaler, denoiser on,
 * the page's defaults) and the showcase's four (the bench's ours denoised: upscaler AA, hit colour final), rest
 * drift and orbit flicker run twice (the noise floor), rest drift also with AA off and with `?upscale=quality`
 * (ratio 1.5), Measure vs the PT with the X0 columns on the showcase (carConcept at W50's pose, so its lip / band /
 * door / car regions get masks and the energy metric its skirt and door), the line spread and the grazing sweep.
 * Writes $OUT/ssr-exp-baseline.json as it goes. Env: SSR_EXP_SCENES (subset), SSR_EXP_PARTS (ssr, showcase,
 * lineSpread, grazing), SSR_EXP_SPP (PT samples, default 128; line spread / grazing 256).
 */
export async function ssrExpBaseline(ctx, pages) {
  const { openPage, check, PORT, OUT } = ctx;
  const only = process.env.SSR_EXP_SCENES?.split(',');
  const parts = (process.env.SSR_EXP_PARTS ?? 'ssr,showcase,lineSpread,grazing').split(',');
  const spp = Number(process.env.SSR_EXP_SPP ?? 128);
  const file = path.join(OUT, 'ssr-exp-baseline.json');
  fs.mkdirSync(OUT, { recursive: true });
  const out = fs.existsSync(file) && process.env.SSR_EXP_APPEND ? JSON.parse(fs.readFileSync(file, 'utf8')) : { date: new Date().toISOString(), ssr: {}, showcase: {} };
  const save = () => fs.writeFileSync(file, JSON.stringify(out, null, 1));
  const errors = [];
  const t0 = Date.now();
  const say = (s) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)} s] ${s}`);
  const close = (p) => { p.close(); const k = pages.indexOf(p); if (k >= 0) pages.splice(k, 1); };

  if (parts.includes('ssr')) for (const scene of SSR_SCENES.filter((x) => !only || only.includes(x))) {
    const before = ctx.results.logs.length;
    const p = await openPage(`http://127.0.0.1:${PORT}/ssr/?scene=${scene}`);
    pages.push(p);
    await p.T('window.__p.stop()');
    const r = await p.T('window.__p.metrics.all()');
    r.restDrift2 = await p.T('window.__p.metrics.restDrift()');
    r.orbitFlicker2 = await p.T('window.__p.metrics.orbitFlicker()');
    errors.push(...(await p.T('window.__p.gpuErrors')));
    close(p);
    // the noise floor across page loads (run 3), then AA off and ?upscale=quality (ratio 1.5)
    for (const [k, q] of [['reload', ''], ['restDriftAAOff', 'aa=off'], ['restDriftUpscale', 'upscale=quality']]) {
      const x = await openPage(`http://127.0.0.1:${PORT}/ssr/?scene=${scene}${q ? '&' + q : ''}`);
      pages.push(x);
      await x.T('window.__p.stop()');
      if (k === 'reload') {
        r.restDrift3 = await x.T('window.__p.metrics.restDrift()');
        r.orbitFlicker3 = await x.T('window.__p.metrics.orbitFlicker()');
      } else {
        r[k] = await x.T('window.__p.metrics.restDrift()');
        r[k].host = await x.T("({ aa: window.__p.aa.mode, ratio: window.__p.aa.ratio })");
        if (k === 'restDriftUpscale') r.restDriftUpscaleUnaligned = await x.T('window.__p.metrics.restDrift({ alignPhase: false, restFrames: 0 })');
      }
      errors.push(...(await x.T('window.__p.gpuErrors')));
      close(x);
    }
    errors.push(...errsSince(ctx, before));
    out.ssr[scene] = r;
    save();
    const R = (o) => o?.regions?.reflection;
    say(`ssr ${scene}: drift ${R(r.restDrift)?.mean} / ${R(r.restDrift2)?.mean} / ${R(r.restDrift3)?.mean} (${R(r.restDrift)?.pctOver}% > 8; rest ${r.restDrift?.rest?.reflection?.mean}) off ${R(r.restDriftAAOff)?.mean} upscale ${R(r.restDriftUpscale)?.mean} (unaligned ${R(r.restDriftUpscaleUnaligned)?.mean}, rest ${r.restDriftUpscale?.rest?.reflection?.mean}); orbit std ${R(r.orbitFlicker)?.std} / ${R(r.orbitFlicker2)?.std} / ${R(r.orbitFlicker3)?.std}; quad ${r.quadEnergy?.display?.reflection?.ratio} raw ${r.quadEnergy?.signal?.reflection?.ratio}; pan d2 ${r.edgePan?.regions?.borderReflection?.d2}; speckle ${R(r.speckle)?.pct}%; energy loss ${R(r.energy)?.loss}`);
  }

  if (parts.includes('showcase')) for (const scene of SHOWCASE_SCENES.filter((x) => !only || only.includes(x))) {
    const before = ctx.results.logs.length;
    const pose = scene === 'carConcept' ? 'w50' : 'hero';
    const b = await openPage(`http://127.0.0.1:${PORT}/showcase/bench.html?manual&scene=${scene}&pose=${pose}&left=ours-denoised&right=ours-denoised`);
    pages.push(b);
    if (!(await b.T('window.__p.entries()')).includes(scene)) { console.log(`  (${scene}: no assets, skipped)`); close(b); continue; }
    const m = await b.T(`window.__p.measure({ samples: ${spp}, warmup: 48, frames: 16, methods: ['ours-denoised', 'ours-raw'] })`);
    const r = { pose, measure: { referenceSamples: m.referenceSamples, frames: m.frames, rows: m.rows } };
    Object.assign(r, await b.T("window.__p.metrics.all({ method: 'ours-denoised' })"));
    r.restDrift2 = await b.T("window.__p.metrics.restDrift({ method: 'ours-denoised' })");
    r.orbitFlicker2 = await b.T("window.__p.metrics.orbitFlicker({ method: 'ours-denoised' })");
    errors.push(...(await b.T('window.__p.gpuErrors()')), ...errsSince(ctx, before));
    close(b);
    out.showcase[scene] = r;
    save();
    const R = (o) => o?.regions?.reflection;
    const g = m.rows.find((x) => x.region === 'glossy');
    say(`showcase ${scene} @${pose}: glossy MAD ${g?.methods['ours-denoised']?.mad.toFixed(2)} std ${g?.methods['ours-denoised']?.std.toFixed(3)} quad ${g?.methods['ours-denoised']?.quad.toFixed(3)} (raw ${g?.methods['ours-raw']?.quad.toFixed(3)}, PT ${g?.refQuad.toFixed(3)}); drift ${R(r.restDrift)?.mean} / ${R(r.restDrift2)?.mean}; orbit std ${R(r.orbitFlicker)?.std} / ${R(r.orbitFlicker2)?.std}; energy loss ${R(r.energy)?.loss}${scene === 'carConcept' ? ` (lip ${r.energy?.regions?.lip?.loss}, door ${r.energy?.regions?.door?.loss}, band ${r.energy?.regions?.band?.loss})` : ''}`);
  }

  const methods = ['ours-denoised', 'ours-raw', 'ours-rt'];
  if (parts.includes('lineSpread')) {
    const before = ctx.results.logs.length;
    const b = await openPage(`http://127.0.0.1:${PORT}/showcase/bench.html?manual&scene=lineSpread&pose=e15&left=ours-denoised&right=ours-denoised`);
    pages.push(b);
    out.lineSpread = await b.T(`window.__p.metrics.lineSpread({ methods: ${JSON.stringify(methods)}, samples: 512, warmup: 64, frames: 16 })`);
    ctx.savePng('ssr-exp-lineSpread-r0.5.png', await b.T('window.__p.shot()'));
    // AA off: the upscaler's clamp removes the sparse glossy hits on the strip (W70)
    out.lineSpreadAAOff = await b.T(`window.__p.metrics.lineSpread({ settings: { aa: 'off' }, methods: ${JSON.stringify(methods)}, samples: 512, warmup: 64, frames: 32 })`);
    // the thin strip (no wall): SSR's depth thickness makes it a slab (the X1 #2 case)
    out.lineSpreadThin = await b.T(`window.__p.metrics.lineSpread({ scene: 'lineSpreadThin', settings: { aa: null }, roughness: [0.05, 0.15, 0.3], methods: ${JSON.stringify(methods)}, samples: 512, warmup: 64, frames: 16 })`);
    errors.push(...(await b.T('window.__p.gpuErrors()')), ...errsSince(ctx, before));
    close(b);
    save();
    for (const [k, v] of [['', out.lineSpread], [' AA off', out.lineSpreadAAOff], [' thin', out.lineSpreadThin]]) for (const row of v.rows) say(`line spread${k} r ${row.roughness}: PT ${row.pt} px (peak ${row.ptPeak}); ${methods.map((id) => `${id} ${row.methods[id]?.width} (x${row.methods[id]?.ratio}, peak x${row.methods[id]?.peakRatio})`).join(', ')}`);
  }
  if (parts.includes('grazing')) {
    const before = ctx.results.logs.length;
    const b = await openPage(`http://127.0.0.1:${PORT}/showcase/bench.html?manual&scene=grazing&pose=e15&left=ours-denoised&right=ours-denoised`);
    pages.push(b);
    out.grazing = await b.T(`window.__p.metrics.grazing({ methods: ${JSON.stringify(methods)}, samples: 256, warmup: 64, frames: 16 })`);
    errors.push(...(await b.T('window.__p.gpuErrors()')), ...errsSince(ctx, before));
    close(b);
    save();
    for (const row of out.grazing.rows) say(`grazing e${row.elevation}: ${row.px} px, PT gradient ${row.ptGradient}; ${methods.map((id) => `${id} MAD ${row.methods[id]?.mad} grad x${row.methods[id]?.gradientRatio}`).join(', ')}`);
  }
  out.seconds = (Date.now() - t0) / 1000;
  save();
  const bad = nonFinite(out);
  check('ssr-exp baseline: every metric on every scene, finite, no GPU errors', bad.length === 0 && errors.length === 0, `${((Date.now() - t0) / 60000).toFixed(1)} min; ${file}${bad.length ? '; non-finite ' + bad.slice(0, 4).join(', ') : ''}${errors.length ? '; ' + errors[0] : ''}`);
}

/**
 * `--only ssr-exp-run`: one metric call on one page, for the experiment streams' A/Bs.
 *   SSR_EXP_URL='ssr/?scene=contact&upscale=quality' SSR_EXP_EVAL='window.__p.metrics.restDrift({ heat: true })' pnpm check -- --only ssr-exp-run
 * Prints the result as JSON ($OUT/ssr-exp-run.json); every PNG data URL in it is saved as $OUT/ssr-exp-run-<path>.png
 * and replaced by the file name. The page's loop is stopped first when it has `__p.stop`.
 */
export async function ssrExpRun(ctx, pages) {
  const { openPage, PORT, OUT } = ctx;
  const url = process.env.SSR_EXP_URL ?? 'ssr/?scene=contact';
  const expr = process.env.SSR_EXP_EVAL ?? 'window.__p.metrics.all()';
  const p = await openPage(`http://127.0.0.1:${PORT}/${url.replace(/^\//, '')}`);
  pages.push(p);
  await p.T('window.__p.stop?.()');
  const r = await p.T(expr);
  const strip = (o, at) => {
    if (typeof o === 'string' && o.startsWith('data:image/png')) { const name = `ssr-exp-run-${at || 'image'}.png`; ctx.savePng(name, o); return name; }
    if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = strip(o[k], at ? `${at}-${k}` : k); }
    return o;
  };
  strip(r, '');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'ssr-exp-run.json'), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1).slice(0, 4000));
  ctx.check('ssr-exp-run: the expression returned', r !== undefined, `${url}: ${expr}`);
}
