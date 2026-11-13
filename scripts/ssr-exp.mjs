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
  return r;
}

export async function ssrExpBaseline(ctx, pages) {
  throw new Error("not yet");
}
