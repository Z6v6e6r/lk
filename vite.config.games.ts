import { defineConfig } from 'vite'
import { diagnosticBuildIdentity } from './scripts/diagnostic_build_identity'
import react from '@vitejs/plugin-react'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

export default defineConfig(({ mode }) => {
  const isDevBundle = mode === 'dev'

  return {
    plugins: [
      react(),
      cssInjectedByJsPlugin(),
    ],
    define: {
      'import.meta.env.VITE_DIAGNOSTIC_BUILD': JSON.stringify(diagnosticBuildIdentity()),
      'process.env': {},
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
      emptyOutDir: false,
      cssCodeSplit: false,
      assetsInlineLimit: 4096,
      lib: {
        entry: 'src/games.tsx',
        name: 'LKWidget',
        fileName: () => (isDevBundle ? 'games-dev.js' : 'games.js'),
        formats: ['iife'],
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  }
})
