import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

export default defineConfig({
  plugins: [
    react(),
    cssInjectedByJsPlugin(),
  ],
  define: {
    'process.env': {},
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    lib: {
      entry: 'src/games.tsx',
      name: 'LKWidget',
      fileName: () => 'games.js',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
