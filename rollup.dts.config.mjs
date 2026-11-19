import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dts } from 'rollup-plugin-dts';

// One .d.ts per public entry. The private workspace packages (@pmndrs/reflections-core / -three / -babylon / -pixi)
// are inlined, so the published types never name a package that isn't on npm; three, babylon and pixi stay external.
//
// Two steps, because rollup-plugin-dts on .ts inputs with respectExternal builds a TypeScript program per entry and
// walks every external declaration (@babylonjs/core alone is ~2800 files): 12+ GB and ~5 min on main, a heap OOM once
// the React/JSX types joined. Instead `tsc --emitDeclarationOnly` emits our own .d.ts (one program, ~0.5 GB, ~12 s)
// into a scratch dir, and rollup only bundles those small files; external packages are never opened.
const root = dirname(fileURLToPath(import.meta.url));
const tmp = resolve(root, 'node_modules/.cache/dts');
rmSync(tmp, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', tmp],
  { cwd: root, stdio: 'inherit' },
);

const workspace = /^@pmndrs\/reflections-(core|three|babylon|pixi)$/;
const inlineWorkspace = {
  name: 'inline-workspace-dts',
  resolveId(id) {
    const m = workspace.exec(id);
    return m ? resolve(tmp, 'packages', m[1], 'src/index.d.ts') : null;
  },
  closeBundle() {
    rmSync(tmp, { recursive: true, force: true });
  },
};

export default {
  input: Object.fromEntries(['index', 'three', 'core', 'babylon', 'pixi'].map((n) => [n, resolve(tmp, 'src', `${n}.d.ts`)])),
  output: { dir: 'dist', format: 'es', chunkFileNames: 'chunks/reflections-[hash].d.ts' },
  external: [/^three(\/|$)/, /^@babylonjs\/core(\/|$)/, /^@pmndrs\/(bvh|downsampler)(\/|$)/, /^pixi\.js(\/|$)/],
  plugins: [inlineWorkspace, dts({ respectExternal: true, tsconfig: 'tsconfig.build.json' })],
};
