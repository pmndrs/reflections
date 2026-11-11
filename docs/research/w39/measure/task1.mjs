// W39 task 1: hit=current vs hit=final under upscaler / taa / off.
import fs from 'node:fs';
import { openPage, BASE, savePng } from './cdp.mjs';

const SP = new URL('.', import.meta.url).pathname;
const INPAGE = fs.readFileSync(SP + 'inpage.js', 'utf8');
const OUTDIR = SP + 'task1/';
const args = process.argv.slice(2);
const scenes = (args[0] ?? 'facingMirrors,mirrorWall,carConcept').split(',');
const aas = (args[1] ?? 'upscaler,taa,off').split(',');
const hits = ['current', 'final'];
const shades = (args[2] ?? 'reshade,off').split(',');
const results = fs.existsSync(OUTDIR + 'results.json') ? JSON.parse(fs.readFileSync(OUTDIR + 'results.json', 'utf8')) : {};

for (const shade of shades) for (const scene of scenes) {
  const showcase = scene === 'carConcept';
  const url = showcase ? `${BASE}/showcase/?scene=${scene}&w=960&h=540&reshade=${shade}` : `${BASE}/ssr/?scene=${scene}&w=960&h=540&reshade=${shade}`;
  const page = await openPage(url);
  try {
    await page.evalJs(INPAGE);
    await page.T('window.__p.stop()');
    const cam0 = showcase ? await page.T('window.__p.camera()') : null;
    for (const aa of aas) for (const hit of hits) {
      const key = `${shade}|${scene}|${aa}|${hit}`;
      const shots = aa !== 'off' || true;
      await page.T(showcase
        ? `(async () => { const P = window.__p; P.setAA('${aa}'); P.setHit('${hit}'); P.setCamera(${JSON.stringify(cam0[0])}, ${JSON.stringify(cam0[1])}); await P.step(2); })()`
        : `(async () => { const P = window.__p; P.setAA('${aa}'); P.setHitColor('${hit}'); P.setPose('default'); P.hybrid.resetHistory(); P.ssr.resetHistory(); await P.step(2); })()`);
      const t0 = Date.now();
      const r = await page.T(`window.__w39.measure({ scene: '${scene}', shots: ${shots} })`);
      for (const k of ['restHeat', 'orbitHeat', 'moving', 'settled', 'ghostHeat']) if (r[k]) { savePng(`${OUTDIR}${shade}-${scene}-${aa}-${hit}-${k}.png`, r[k]); delete r[k]; }
      results[key] = r;
      const f = (x) => (typeof x === 'number' ? Number(x.toFixed(3)) : x);
      console.log(key, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
      for (const m of Object.keys(r.rest)) console.log(`   ${m.padEnd(10)} rest mean ${f(r.rest[m].mean)} >1 ${f(r.rest[m].pctMeanOver1)}% >4 ${f(r.rest[m].pctOver4)}% p99 ${f(r.rest[m].p99)} | orbit d2 ${f(r.orbit[m].d2mean)} >4 ${f(r.orbit[m].pctD2Over4)}% p99 ${f(r.orbit[m].d2p99)} d1>4 ${f(r.orbit[m].pctD1Over4)}% | ghost ${f(r.ghost[m]?.mean)} p99 ${f(r.ghost[m]?.p99)}`);
      fs.mkdirSync(OUTDIR, { recursive: true });
      fs.writeFileSync(OUTDIR + 'results.json', JSON.stringify(results, null, 1));
    }
    console.log('hitShading', await page.T('window.__p.ssr.settings.hitShading ?? "(default)"'));
    const errs = await page.T('window.__p.gpuErrors');
    if (errs?.length || page.logs.length) console.log('errors', errs, page.logs.slice(0, 5));
  } finally { page.close(); }
}
