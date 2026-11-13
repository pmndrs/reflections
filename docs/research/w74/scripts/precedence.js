// W74 review fix 3: tracedMissRate from settings or traceSettings (traceSettings wins). ssr/?manual&rt=1
await P.load('contact');
P.setTraceSettings({}); P.setSettings({ tracedMissRate: 'half' }); await P.step(4);
const a = await P.traceStats();
P.setSettings({ tracedMissRate: 'full' }); P.setTraceSettings({ tracedMissRate: 'half' }); await P.step(4);
const b = await P.traceStats();
P.setSettings({ tracedMissRate: 'half' }); P.setTraceSettings({ tracedMissRate: 'full' }); await P.step(4);
const c = await P.traceStats();
return { settingsOnly: a.halfRateSkipped, traceOnly: b.halfRateSkipped, traceFullWins: c.halfRateSkipped, errors: P.gpuErrors.slice(0, 2) };
