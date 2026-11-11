// W39 task 3: specular occlusion off / on vs a fully traced reference (examples/ssr ?rt=1, AA off).
import fs from 'node:fs';
import { openPage, BASE, savePng } from './cdp.mjs';
const SP = new URL('.', import.meta.url).pathname;
const INPAGE = fs.readFileSync(SP + 'inpage.js', 'utf8');
const RUNS = [
  { label: 'contact', scene: 'contact' },
  { label: 'contact-low', scene: 'contact', pose: 'low' },
  { label: 'contact-floor0.6', scene: 'contact', floor: 0.6 },
  { label: 'roughnessRamp', scene: 'roughnessRamp' },
  { label: 'boxRoom-floor', scene: 'boxRoom', pose: 'floor' },
].filter((r) => !process.argv[2] || process.argv[2].split(',').includes(r.label));
const file = SP + 'task3.json';
const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
for (const run of RUNS) {
  const page = await openPage(`${BASE}/ssr/?scene=${run.scene}&w=960&h=540&aa=off&rt=1`);
  try {
    await page.evalJs(INPAGE);
    await page.T('window.__p.stop()');
    if (run.pose) await page.T(`window.__p.setPose('${run.pose}')`);
    if (run.floor !== undefined) await page.T(`window.__p.setFloorRoughness(${run.floor})`);
    const t0 = Date.now();
    const r = await page.T('window.__w39.soStudy({ shots: true })');
    savePng(`${SP}task3/${run.label}-rtref.png`, r.refShot); delete r.refShot;
    all[run.label] = r;
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
    console.log(run.label, `${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(r.px));
    for (const k of Object.keys(r.px)) console.log(`   ${k.padEnd(9)} off mad ${r.tests.off[k].mad} signed ${r.tests.off[k].signed} | on mad ${r.tests.on[k].mad} signed ${r.tests.on[k].signed}`);
    const errs = await page.T('window.__p.gpuErrors');
    if (errs?.length || page.logs.length) console.log('errors', errs, page.logs.slice(0, 5));
  } finally { page.close(); }
}
