import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';

export default defineConfig(({ mode }) => ({
  plugins: [react(), cssInjectedByJsPlugin()],
  define: { 'process.env': {}, 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist/subscription-storefront', emptyOutDir: false, cssCodeSplit: false,
    lib: {
      entry: 'src/subscription-storefront.tsx', name: 'LKWidgetSubscriptionStorefrontBundle',
      fileName: () => mode === 'dev' ? 'subscription-storefront-dev.js' : 'subscription-storefront.js',
      formats: ['iife'],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
}));
