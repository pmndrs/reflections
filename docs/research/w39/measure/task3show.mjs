// W39 task 3: showcase specOcc off / on (+ RT on as a reference for the glossy misses), AO and factor views.
import { openPage, BASE, savePng } from './cdp.mjs';
const SP = new URL('.', import.meta.url).pathname;
const [scene, extra = ''] = process.argv.slice(2);
const page = await openPage(`${BASE}/showcase/?scene=${scene}&w=960&h=540&aa=off&rt=1${extra}`);
const out = `${SP}task3/show-${scene}`;
try {
  await page.T('window.__p.stop()');
  const run = async (rt, so, view, n = 150) => {
    await page.T(`(async () => { const P = window.__p; await P.setSources({ rt: ${rt} }); P.setSpecOcc(${so}); P.setView('${view}'); for (let i = 0; i < ${n}; i++) await P.step(1); })()`);
    return page.T('window.__p.shot()');
  };
  savePng(`${out}-final-so0.png`, await run(false, false, 'final'));
  savePng(`${out}-final-so1.png`, await run(false, true, 'final'));
  savePng(`${out}-ao.png`, await run(false, true, 'ao', 4));
  savePng(`${out}-specularOcclusion.png`, await run(false, true, 'specularOcclusion', 4));
  savePng(`${out}-rt-so0.png`, await run(true, false, 'final'));
  savePng(`${out}-rt-so1.png`, await run(true, true, 'final'));
  console.log('done', out, await page.T('window.__p.gpuErrors'), page.logs.slice(0, 5));
} finally { page.close(); }
