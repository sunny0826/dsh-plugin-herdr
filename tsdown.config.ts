import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/client-entry.ts', 'src/session-mode.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  target: 'node22',
  clean: true,
})
