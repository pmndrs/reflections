// W39 task 3: specular occlusion off / on, the AO input and the factor, per scene (examples/ssr).
import fs from 'node:fs';
import { openPage, BASE, savePng } from './cdp.mjs';
const SP = new URL('.', import.meta.url).pathname;
const [scene, extra = '', tag = '', pose = ''] = process.argv.slice(2);
const page = await openPage(`${BASE}/ssr/?scene=${scene}&w=960&h=540${extra}`);
const out = `${SP}task3/${scene}${tag}`;
try {
  await page.T('window.__p.stop()');
  if (pose) await page.T(`window.__p.setPose('${pose}')`);
  if (process.env.FLOOR) await page.T(`window.__p.setFloorRoughness(${process.env.FLOOR})`);
  for (const [k, on] of [false, true].entries()) {
    await page.T(`(async () => { const P = window.__p; P.setSpecOcc(${on}); P.setView('final'); P.hybrid.resetHistory(); P.ssr.resetHistory(); P.aa.reset(); for (let i = 0; i < 120; i++) await P.step(1); })()`);
    savePng(`${out}-final-so${on ? 1 : 0}${k > 1 ? "b" : ""}.png`, await page.T('window.__p.shot()'));
    if (on && k < 2) {
      for (const v of ['ao', 'specularOcclusion']) {
        await page.T(`(async () => { const P = window.__p; P.setView('${v}'); for (let i = 0; i < 4; i++) await P.step(1); })()`);
        savePng(`${out}-${v}.png`, await page.T('window.__p.shot()'));
      }
    }
  }
  console.log('done', out, await page.T('window.__p.gpuErrors'), page.logs.slice(0, 5));
} finally { page.close(); }
