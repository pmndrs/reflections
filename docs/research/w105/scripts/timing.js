// W105: GPU ms of three's render passes (G-buffer + lit image + composite + display; `?gpuTime`), render loop
// stopped, specular AA off / variance alternating in one page (ROUNDS rounds, median of N frames each).
// node drive.mjs 'http://127.0.0.1:5427/showcase/?manual&gpuTime&w=1920&h=1080&scene=carConcept' <outDir> timing.js
// prelude (optional): SCENES = ['carConcept', ...], ROUNDS, N, POSE
const scenes = typeof SCENES !== 'undefined' ? SCENES : ['carConcept'];
const rounds = typeof ROUNDS !== 'undefined' ? ROUNDS : 4;
const n = typeof N !== 'undefined' ? N : 40;
const out = {};
for (const s of scenes) {
  await P.load(s);
  if (typeof POSE !== 'undefined') P.setPose(POSE);
  P.stop();
  const rows = { off: [], variance: [] };
  for (let r = 0; r < rounds; r++) {
    for (const mode of r % 2 ? ['variance', 'off'] : ['off', 'variance']) {
      P.setSpecularAA(mode);
      await P.step(8);
      const t = await P.renderTime(n);
      rows[mode].push(t.ms);
    }
  }
  const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
  out[s] = { off: rows.off.map((x) => +x.toFixed(3)), variance: rows.variance.map((x) => +x.toFixed(3)), medOff: +med(rows.off).toFixed(3), medVariance: +med(rows.variance).toFixed(3) };
  log({ scene: s, ...out[s] });
  P.setSpecularAA('off');
}
return { out, errors: P.gpuErrors.slice(0, 3) };
