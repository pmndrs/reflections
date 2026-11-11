// W39 task 3: specOcc off / on vs the path tracer (examples/showcase/compare.html, 64 spp + OIDN).
import fs from 'node:fs';
import { openPage, BASE, savePng } from './cdp.mjs';
const SP = new URL('.', import.meta.url).pathname;
const [scene, floor = ''] = process.argv.slice(2);
const tag = `${scene}${floor ? `-floor${floor}` : ''}`;
for (const so of ['0', '1']) {
  const page = await openPage(`${BASE}/showcase/compare.html?manual&scene=${scene}&left=ours-denoised&right=pathtraced&w=960&h=540&specOcc=${so}${floor ? `&floorRoughness=${floor}` : ''}`);
  try {
    await page.T('window.__p.freeze(true)');
    if (so === '0') {
      const c = await page.T('window.__p.converge(64)');
      console.log(tag, 'pt', JSON.stringify(c).slice(0, 200));
      savePng(`${SP}task3/pt-${tag}-ref.png`, await page.T("window.__p.shotOf('pathtraced')"));
      await page.T("window.__p.drop('pathtraced')");
    }
    savePng(`${SP}task3/pt-${tag}-ours-so${so}.png`, await page.T("window.__p.shotOf('ours-denoised', 150)"));
    console.log(tag, so, 'errors', await page.T('window.__p.gpuErrors()'), page.logs.slice(0, 3));
  } finally { page.close(); }
}
// the AO / geometry mask from the showcase page at the same scene, pose and size
const page = await openPage(`${BASE}/showcase/?scene=${scene}&w=960&h=540&aa=off&specOcc=1${floor ? '' : ''}`);
try {
  await page.T('window.__p.stop()');
  await page.T("(async () => { const P = window.__p; P.setView('ao'); for (let i = 0; i < 4; i++) await P.step(1); })()");
  savePng(`${SP}task3/pt-${tag}-ao.png`, await page.T('window.__p.shot()'));
  await page.T("(async () => { const P = window.__p; P.setSpecOcc(false); P.setView('final'); for (let i = 0; i < 150; i++) await P.step(1); })()");
  savePng(`${SP}task3/pt-${tag}-showcase.png`, await page.T('window.__p.shot()'));
} finally { page.close(); }
