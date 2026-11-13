// W74 phase 2: X0's page metrics on examples/ssr (ssr/?scene=<id>&rt=1, page defaults: upscaler AA) per traceSettings
// config, denoiser on and off. prelude: CONFIGS = [[name, traceSettings], ...], optional METRICS, OPTS
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p.metrics && window.__p.kit); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
S.stop();
const metrics = typeof METRICS !== 'undefined' ? METRICS : ['quadEnergy', 'orbitFlicker'];
const opts = typeof OPTS !== 'undefined' ? OPTS : {};
for (const [name, set] of CONFIGS) {
  for (const dn of [true, false]) {
    S.setTraceSettings(set);
    S.setDenoise(dn);
    const row = { name, denoise: dn };
    for (const m of metrics) {
      const r = await S.metrics[m](opts[m] ?? {});
      row[m] = m === 'quadEnergy' ? { display: r.display, signal: r.signal } : r.regions;
    }
    row.stats = await S.traceStats();
    log(row);
  }
}
S.setTraceSettings({}); S.setDenoise(true);
return { errors: S.gpuErrors.slice(0, 3) };
