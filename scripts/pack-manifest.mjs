// The published manifest names no private workspace package (W91).
//
// The root package.json links the private workspace packages (@pmndrs/reflections-core / -three / -babylon / -pixi)
// as `workspace:*` devDependencies, so src/*.ts resolves them for the build; dist bundles them. npm would publish
// those devDependencies verbatim. `prepack` strips them (a backup goes to node_modules/.cache), `postpack` restores
// the original. CI (release.yml, `npm publish --ignore-scripts`) runs `strip` alone: its checkout is thrown away.
//
//   node scripts/pack-manifest.mjs strip     # prepack
//   node scripts/pack-manifest.mjs restore   # postpack
//   node scripts/pack-manifest.mjs check     # exit 1 if the manifest names a workspace package or specifier
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = resolve(root, 'package.json');
const backup = resolve(root, 'node_modules/.cache/package.json.prepack');
const isPrivate = (name, spec) => /^@pmndrs\/reflections-/.test(name) || String(spec).startsWith('workspace:');
const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const mode = process.argv[2];
if (mode === 'strip') {
  const text = readFileSync(manifest, 'utf8');
  const pkg = JSON.parse(text);
  let removed = 0;
  for (const f of fields) {
    for (const [name, spec] of Object.entries(pkg[f] ?? {})) if (isPrivate(name, spec)) { delete pkg[f][name]; removed++; }
  }
  if (removed) {
    mkdirSync(dirname(backup), { recursive: true });
    if (!existsSync(backup)) writeFileSync(backup, text);
    writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
  }
  console.log(`pack-manifest: ${removed} workspace entr${removed === 1 ? 'y' : 'ies'} removed from package.json`);
} else if (mode === 'restore') {
  if (existsSync(backup)) { copyFileSync(backup, manifest); rmSync(backup); console.log('pack-manifest: package.json restored'); }
} else if (mode === 'check') {
  const pkg = JSON.parse(readFileSync(process.argv[3] ?? manifest, 'utf8'));
  const bad = fields.flatMap((f) => Object.entries(pkg[f] ?? {}).filter(([n, s]) => isPrivate(n, s)).map(([n, s]) => `${f}.${n}: ${s}`));
  if (bad.length) { console.error(`pack-manifest: the manifest names workspace packages: ${bad.join(', ')}`); process.exit(1); }
  console.log('pack-manifest: no workspace package or specifier in the manifest');
} else {
  console.error('usage: node scripts/pack-manifest.mjs strip | restore | check [package.json]');
  process.exit(2);
}
