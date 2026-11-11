// Wall-clock ms per frame (loop stopped, queue drained per frame), specOcc off / on, median of runs.
import { openPage, BASE } from './cdp.mjs';
const [w, h] = (process.argv[2] ?? '1920x1080').split('x');
const page = await openPage(`${BASE}/ssr/?scene=contact&w=${w}&h=${h}&aa=off`);
try {
  const r = await page.T(`(async () => {
    const P = window.__p; P.stop();
    const run = async (so) => { P.setSpecOcc(so); for (let i = 0; i < 20; i++) await P.step(1); const t = []; for (let k = 0; k < 120; k++) { const t0 = performance.now(); await P.step(1); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return t[t.length >> 1]; };
    const out = [];
    for (let rep = 0; rep < 3; rep++) out.push([await run(false), await run(true)]);
    return out;
  })()`);
  console.log(`${w}x${h} [off, on] ms per frame:`, JSON.stringify(r.map((x) => x.map((v) => Number(v.toFixed(2))))));
} finally { page.close(); }
