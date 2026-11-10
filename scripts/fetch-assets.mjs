#!/usr/bin/env node
// Downloads the demo assets into examples/assets/ (gitignored; never commit them).
//
//   pnpm assets               # everything in the table that isn't there yet
//   pnpm assets ToyCar Sponza # only these
//   pnpm assets --force       # re-download
//
// The table is the whole configuration: add a row to add an asset. `dir` is the folder under
// examples/assets/ and `file` the entry the scene kit loads (examples/shared/gltf.ts, ASSET_SCENES).
// A Khronos row downloads Models/<khronos>/<variant>/ from glTF-Sample-Assets: a .glb is one file,
// a .gltf is fetched with every buffer and image it references. A row with `local` copies from that
// folder instead when it exists (same layout as the Khronos glTF variant), and falls back to Khronos.
// `devOnly`: licence allows local testing but not a hosted demo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KHRONOS = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';

// prettier-ignore
export const ASSETS = [
  //  dir                 source                                            file                     licence                 notes
  { dir: 'Sponza',            khronos: 'Sponza',            variant: 'glTF',        file: 'Sponza.gltf',            license: 'CC-BY 3.0 (Crytek)',     local: '/Users/dex/Developer/sponza-optimized' },
  { dir: 'ABeautifulGame',    khronos: 'ABeautifulGame',    variant: 'glTF-Binary', file: 'ABeautifulGame.glb',     license: 'CC-BY 4.0' },
  { dir: 'FlightHelmet',      khronos: 'FlightHelmet',      variant: 'glTF',        file: 'FlightHelmet.gltf',      license: 'CC0' },
  { dir: 'MetalRoughSpheres', khronos: 'MetalRoughSpheres', variant: 'glTF-Binary', file: 'MetalRoughSpheres.glb',  license: 'CC0' },
  { dir: 'EnvironmentTest',   khronos: 'EnvironmentTest',   variant: 'glTF',        file: 'EnvironmentTest.gltf',   license: 'Adobe Stock (see its LICENSE.md)', devOnly: true },
  { dir: 'ToyCar',            khronos: 'ToyCar',            variant: 'glTF-Binary', file: 'ToyCar.glb',             license: 'CC0' },
  { dir: 'CarConcept',        khronos: 'CarConcept',        variant: 'glTF-Binary', file: 'CarConcept.glb',         license: 'CC-BY 4.0' },
  // TODO Bistro (Amazon Lumberyard, CC-BY 4.0): ships as FBX; needs an FBX -> glTF conversion step before it can be a row.
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'examples', 'assets');
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf;
}

/** Relative uris a .gltf references (buffers and images), data: uris skipped. */
function dependencies(json) {
  const uris = [...(json.buffers ?? []), ...(json.images ?? [])].map((b) => b.uri).filter((u) => u && !u.startsWith('data:'));
  return [...new Set(uris.map((u) => decodeURIComponent(u)))];
}

function copyLocal(asset, dest) {
  const src = path.join(asset.local, asset.file);
  if (!fs.existsSync(src)) return false;
  const json = JSON.parse(fs.readFileSync(src, 'utf8'));
  for (const f of [asset.file, ...dependencies(json)]) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(path.join(asset.local, f), path.join(dest, f));
  }
  return true;
}

async function fetchKhronos(asset, dest) {
  const base = `${KHRONOS}/${asset.khronos}/${asset.variant}`;
  const entry = await download(`${base}/${asset.file}`, path.join(dest, asset.file));
  if (!asset.file.endsWith('.gltf')) return 1;
  const deps = dependencies(JSON.parse(entry.toString('utf8')));
  let n = 1;
  // a few at a time: Sponza has ~70 textures
  for (let i = 0; i < deps.length; i += 8) {
    await Promise.all(deps.slice(i, i + 8).map((u) => download(`${base}/${u.split('/').map(encodeURIComponent).join('/')}`, path.join(dest, u))));
    n += Math.min(8, deps.length - i);
  }
  return n;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = only.length ? ASSETS.filter((a) => only.includes(a.dir)) : ASSETS;
  if (only.length && rows.length !== only.length) console.warn('unknown:', only.filter((o) => !ASSETS.some((a) => a.dir === o)).join(', '));
  let failed = 0;
  for (const a of rows) {
    const dest = path.join(OUT, a.dir);
    if (!force && fs.existsSync(path.join(dest, a.file))) { console.log(`  have ${a.dir}`); continue; }
    try {
      if (a.local && fs.existsSync(a.local) && copyLocal(a, dest)) { console.log(`  copied ${a.dir} from ${a.local}`); continue; }
      const n = await fetchKhronos(a, dest);
      console.log(`  fetched ${a.dir} (${n} file${n > 1 ? 's' : ''}, ${a.license}${a.devOnly ? ', dev only' : ''})`);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${a.dir}: ${e.message}`);
    }
  }
  // the kit reads this to know what's there without probing each file
  const have = ASSETS.filter((a) => fs.existsSync(path.join(OUT, a.dir, a.file))).map(({ dir, file, license, devOnly }) => ({ dir, file, license, devOnly: !!devOnly }));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(have, null, 2));
  console.log(`${have.length}/${ASSETS.length} assets in examples/assets/`);
  process.exit(failed ? 1 : 0);
}

main();
