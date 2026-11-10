import { dts } from 'rollup-plugin-dts';

// One .d.ts per public entry. The private workspace packages (@pmndrs/reflections-core / -three)
// are inlined, so the published types never name a package that isn't on npm; three stays external.
export default {
  input: { index: 'src/index.ts', three: 'src/three.ts', core: 'src/core.ts' },
  output: { dir: 'dist', format: 'es', chunkFileNames: 'chunks/reflections-[hash].d.ts' },
  external: [/^three(\/|$)/, /^@pmndrs\/bvh(\/|$)/],
  plugins: [dts({ respectExternal: true, tsconfig: 'tsconfig.build.json' })],
};
