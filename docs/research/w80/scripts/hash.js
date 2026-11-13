// W80: bit-for-bit check of the default: FNV hash of the tracer's radiance at frame index 7 (occupancy 0 = deterministic, D301).
// prelude: POSE, optional MC (maxCandidates, default unset). Prints the hash twice.
P.stop && P.stop();
if (typeof POSE !== 'undefined') P.setPose(POSE);
P.setSettings({ frameIndex: 7, minTraversalOccupancy: 0, ...(typeof MC !== 'undefined' ? { maxCandidates: MC } : {}) });
await P.step(6);
const a = await P.radianceHash(7);
await P.step(2);
const b = await P.radianceHash(7);
log({ hash: a, again: b, misses: (await P.stats()).misses });
return { errors: P.gpuErrors.slice(0, 3) };
