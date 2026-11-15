import { defineConfig } from 'tsdown'

/** Bundle the worker frontend and the separate acceptance tool preset row. */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    acceptance: 'lib/types/acceptance.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
