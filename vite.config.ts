import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { visualizer } from 'rollup-plugin-visualizer'
import { managedSubscriptionDevPlugin } from './scripts/managed_subscription_dev_runtime.ts'

const shouldAnalyze = process.env.ANALYZE === '1' || process.env.ANALYZE === 'true'

export default defineConfig(({ command, mode }) => {
  const isDevBundle = mode === 'dev'
  const managedSubscriptionsDevEnabled =
    command === 'serve' && process.env.MANAGED_SUBSCRIPTIONS_DEV_RUNTIME === '1'

  return {
    plugins: [
      react(),
      managedSubscriptionDevPlugin({
        enabled: managedSubscriptionsDevEnabled,
        cupBaseUrl: process.env.MANAGED_SUBSCRIPTIONS_CUP_BASE_URL,
        typeCode: process.env.MANAGED_SUBSCRIPTIONS_TYPE_CODE,
        policyVersion: process.env.MANAGED_SUBSCRIPTIONS_POLICY_VERSION,
      }),
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
      emptyOutDir: !isDevBundle,
      cssCodeSplit: false,
      assetsInlineLimit: 4096,
      lib: {
        entry: 'src/main.tsx',
        name: 'LKWidget',
        fileName: () => (isDevBundle ? 'bundle-dev.js' : 'bundle.js'),
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
