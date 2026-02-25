import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { visualizer } from 'rollup-plugin-visualizer'

const shouldAnalyze = process.env.ANALYZE === '1' || process.env.ANALYZE === 'true'

export default defineConfig({
  plugins: [
    react(),
    cssInjectedByJsPlugin(), // вшивает CSS прямо в bundle.js
    ...(shouldAnalyze
      ? [
          visualizer({
            filename: 'dist/stats.html',
            template: 'treemap',
            gzipSize: true,
            brotliSize: true,
            open: false,
          }),
        ]
      : []),
  ],
  define: {
    'process.env': {},
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    cssCodeSplit: false,
    assetsInlineLimit: 4096,
    lib: {
      entry: 'src/main.tsx',
      name: 'LKWidget',
      fileName: () => 'bundle.js',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
