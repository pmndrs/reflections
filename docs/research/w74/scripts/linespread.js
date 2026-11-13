// W74 phase 2: X0's line spread on the bench (lineSpreadThin by default: with RT our reflection matches the PT; does 'half' keep it?).
// bench.html?manual&left=ours-rt&right=pathtraced. prelude: CONFIGS = [[name, {benchKey: value}], ...], optional SCENE, METHODS, SPP
const S = await (async () => { for (let i = 0; i < 600 && !(window.__p.metrics && window.__p.setSetting); i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
const out = [];
for (const [name, settings] of CONFIGS) {
  const r = await S.metrics.lineSpread({ scene: typeof SCENE !== 'undefined' ? SCENE : 'lineSpreadThin', methods: typeof METHODS !== 'undefined' ? METHODS : ['ours-rt'], settings, samples: typeof SPP !== 'undefined' ? SPP : 256 });
  const rows = r.rows.map((x) => ({ r: x.roughness, pt: x.pt, ptPeak: x.ptPeak, ...Object.fromEntries(Object.entries(x.methods).map(([id, m]) => [id, { width: m.width, ratio: m.ratio, peak: m.peak, pass: m.pass }])) }));
  out.push({ name, rows });
  log({ name, rows });
}
return { errors: S.gpuErrors().slice(0, 3) };
