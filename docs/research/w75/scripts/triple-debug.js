// W75: why the half-rate fill skips nothing under half res (debug). ssr/?manual&rt=1[&res=half]
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
await S.load('contact');
S.ssr.traceSettings.tracedMissRate = 'half';
const out = [];
for (const rr of ['copy', 'ratio']) {
  S.ssr.settings.rayReuse = rr;
  for (let i = 0; i < 4; i++) { await S.step(10); }
  out.push({ rr, res: S.ssr.resolution, ready: S.ssr.traced?.halfRateReady, stats: await S.ssr.readTraceStats() });
}
log(out);
return { errors: (S.gpuErrors ?? []).slice?.(0, 3) };
