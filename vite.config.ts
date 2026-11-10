import { resolve } from 'path';
import { configDefaults, defineConfig } from 'vitest/config';

// Library build for @pmndrs/reflections (same shape as @pmndrs/upscaler). The examples have
// their own config at examples/vite.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    // Agent worktrees under .claude/ are full checkouts; without this each runs its own copy.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
  build: {
    // One entry per public subpath. The private workspace packages are bundled in; shared code
    // lands in one chunk so every entry sees the same classes.
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        three: resolve(__dirname, 'src/three.ts'),
        core: resolve(__dirname, 'src/core.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^three(\/|$)/, /^three-mesh-bvh(\/|$)/],
      output: { chunkFileNames: 'chunks/reflections-[hash].js' },
    },
  },
});
