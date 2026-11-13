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
  const ls = await b.T("window.__p.metrics.lineSpread({ roughness: [0.15], samples: 16, warmup: 8, frames: 2 })");
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
    `line spread r 0.15 @ e15: PT ${lr?.pt} px, ours ${lr?.methods['ours-denoised']?.width} px (${lr?.methods['ours-denoised']?.columns} columns); grazing e15: ${gr?.px} glossy px, MAD ${gr?.methods['ours-denoised']?.mad}, gradient ratio ${gr?.methods['ours-denoised']?.gradientRatio}; glossy std ${cols.find((c) => c.region === 'glossy')?.std}, quad ${cols.find((c) => c.region === 'glossy')?.quad}; bench energy loss ${pm.energy?.regions?.reflection?.loss}${bad.length ? '; non-finite ' + bad.slice(0, 3).join(', ') : ''}${errs.length ? '; ' + errs[0] : ''}`);
  return { ssr: r, lineSpread: ls, grazing: gz, measure: cols, bench: pm };
}

export async function ssrExpBaseline(ctx, pages) {
  throw new Error("not yet");
}
