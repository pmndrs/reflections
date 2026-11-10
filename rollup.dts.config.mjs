import { dts } from 'rollup-plugin-dts';

// One .d.ts per public entry. The private workspace packages (@pmndrs/reflections-core / -three / -babylon / -pixi)
// are inlined, so the published types never name a package that isn't on npm; three, babylon and pixi stay external.
export default {
  input: { index: 'src/index.ts', three: 'src/three.ts', core: 'src/core.ts', babylon: 'src/babylon.ts', pixi: 'src/pixi.ts' },
  output: { dir: 'dist', format: 'es', chunkFileNames: 'chunks/reflections-[hash].d.ts' },
  external: [/^three(\/|$)/, /^@babylonjs\/core(\/|$)/, /^pixi\.js(\/|$)/],
  plugins: [dts({ respectExternal: true, tsconfig: 'tsconfig.build.json' })],
};
