// W80: sssr-core page (/sssr-core/): does maxCandidates change anything on its scene, and do the two variants agree? (occupancy 0)
const out = {};
for (const mc of [1, 4, 8]) out[mc] = await P.parity({ minTraversalOccupancy: 0, samplesPerQuad: 1, maxCandidates: mc });
log(Object.fromEntries(Object.entries(out).map(([k, r]) => [k, { misses: r.misses, radianceDiff: r.radianceDiffPixels, hitDiff: r.hitDiffPixels, lists: r.rayListSame && r.missListSame }])));
return {};
