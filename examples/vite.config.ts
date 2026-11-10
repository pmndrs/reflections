import { resolve } from 'path';
import { readdirSync, existsSync } from 'fs';
import { defineConfig } from 'vite';

// Examples dev server: http://127.0.0.1:5370/<name>/ ($REFLECTIONS_PORT overrides; worktrees use their own) for each examples/<name>/index.html.
// The package is resolved to its source, so edits under packages/ show up without a build.
const root = __dirname;
const pages = Object.fromEntries(
  readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, 'index.html')))
    .map((d) => [d.name, resolve(root, d.name, 'index.html')]),
);

export default defineConfig({
  root,
  server: { port: Number(process.env.REFLECTIONS_PORT ?? 5370), strictPort: true, host: '127.0.0.1' },
  resolve: {
    alias: [
      { find: /^@pmndrs\/reflections\/three$/, replacement: resolve(root, '../src/three.ts') },
      { find: /^@pmndrs\/reflections\/core$/, replacement: resolve(root, '../src/core.ts') },
      { find: /^@pmndrs\/reflections$/, replacement: resolve(root, '../src/index.ts') },
    ],
  },
  build: { outDir: resolve(root, 'dist'), emptyOutDir: true, rollupOptions: { input: pages } },
});
