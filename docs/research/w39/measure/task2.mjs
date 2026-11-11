// W39 task 2: mirrorBias under the upscaler (and AA off), still + pendulum orbit, denoise off / on.
import fs from 'node:fs';
import { openPage, BASE } from './cdp.mjs';
const SP = new URL('.', import.meta.url).pathname;
const INPAGE = fs.readFileSync(SP + 'inpage.js', 'utf8');
const which = process.argv[2] ?? 'roughnessRamp';
const opts = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const runs = which === 'roughnessRamp'
  ? [{ scene: 'roughnessRamp', label: 'roughnessRamp', o: { bins: [0.1, 0.2, 0.3, 0.4] } }]
  : (process.env.FLOORS ?? "0.2,0.3").split(",").map(Number).map((r) => ({ scene: 'mirrorWall', label: `mirrorWall-floor-r${r}`, floor: r, o: { bins: [r], floorOnly: true } }));
const file = SP + 'task2.json';
const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
for (const run of runs) {
  const page = await openPage(`${BASE}/ssr/?scene=${run.scene}&w=960&h=540`);
  try {
    await page.evalJs(INPAGE);
    await page.T('window.__p.stop()');
    if (run.floor !== undefined) await page.T(`window.__p.setFloorRoughness(${run.floor})`);
    const t0 = Date.now();
    const r = await page.T(`window.__w39.biasStudy(${JSON.stringify({ ...run.o, ...opts })})`);
    all[run.label] = r;
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
    console.log(run.label, `${((Date.now() - t0) / 1000).toFixed(0)}s px ${r.binPx}`);
    for (const x of r.results) {
      console.log(`  ${x.aa.padEnd(8)} dn ${x.denoise ? 'on ' : 'off'} bias ${x.mirrorBias.toFixed(2)}: ` + x.bins.map((b) => `r${b.roughness} still std ${b.still.std} fl ${b.still.flicker} bias ${b.still.bias} rmse ${b.still.rmse} | moving rmse ${b.moving.rmse} bias ${b.moving.bias} std ${b.moving.std} d2 ${b.moving.d2} >4 ${b.moving.pctD2Over4}%`).join('\n' + ' '.repeat(30)));
    }
    const errs = await page.T('window.__p.gpuErrors');
    if (errs?.length || page.logs.length) console.log('errors', errs, page.logs.slice(0, 5));
  } finally { page.close(); }
}
