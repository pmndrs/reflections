// W71 phase 2 on the bench. prelude: TAG, CONFIGS = [{ name, set: { <bench key>: value } }], and either
//   PAGE = { method, pose, which: [...metrics], opts: {...} }   page metrics per config, or
//   PT = { fn: 'lineSpread' | 'grazing', opts: {...} }           PT metrics per config (config.set goes in opts.settings)
const all = [...new Set(CONFIGS.flatMap((c) => Object.keys(c.set)))];
const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'heat' || k === 'images' || (typeof v === 'string' && v.startsWith('data:')) ? undefined : v)));
for (const c of CONFIGS) {
  const out = { tag: TAG, config: c.name };
  if (typeof PAGE !== 'undefined' && PAGE) {
    for (const k of all) P.setSetting(k, k in c.set ? c.set[k] : null);
    if (PAGE.pose) P.setPose(PAGE.pose);
    await P.step(2);
    const M = P.metrics.of(PAGE.method);
    for (const m of PAGE.which) out[m] = strip(await M[m](PAGE.opts?.[m] ?? {}));
  } else {
    const settings = Object.fromEntries(all.map((k) => [k, k in c.set ? c.set[k] : null]));
    out[PT.fn] = strip(await P.metrics[PT.fn]({ ...PT.opts, settings: { ...(PT.opts.settings ?? {}), ...settings } }));
  }
  log(out);
}
return { errors: P.gpuErrors().slice(0, 3) };
