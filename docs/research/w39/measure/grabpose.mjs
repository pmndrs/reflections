// Grab still frames (after warm) on a page for a list of aa:hit settings; save full-size PNGs.
import fs from 'node:fs';
import { openPage, BASE, savePng } from './cdp.mjs';
const SP = new URL('.', import.meta.url).pathname;
const [url, outPrefix, combos, warm = '120'] = process.argv.slice(2);
const page = await openPage(`${BASE}${url}`);
try {
  await page.evalJs(fs.readFileSync(SP + 'inpage.js', 'utf8'));
  await page.T('window.__p.stop()');
  for (const c of combos.split(',')) {
    const [aa, hit] = c.split(':');
    await page.T(`(async () => { const P = window.__p; P.setAA('${aa}'); (P.setHitColor ?? P.setHit)('${hit}'); P.hybrid?.resetHistory(); P.ssr.resetHistory(); for (let i = 0; i < ${warm}; i++) await P.step(1); })()`);
    const a = await page.T('window.__p.shot()');
    const b = await page.T('window.__p.shot()');
    savePng(`${SP}${outPrefix}-${aa}-${hit}.png`, a);
    savePng(`${SP}${outPrefix}-${aa}-${hit}-b.png`, b);
    console.log('saved', `${outPrefix}-${aa}-${hit}`);
  }
} finally { page.close(); }
