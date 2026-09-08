import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localPreviewPlugin } from './scripts/lk1_local_preview.mjs';

export default defineConfig({
  // A separate config prevents production env files and optional DEV runtimes
  // from enabling providers or write-capable middleware in this preview.
  envDir: '/nonexistent-lk1-preview-env',
  define: { 'import.meta.env.VITE_FIREBASE_ANALYTICS_ENABLED': JSON.stringify('false') },
  plugins: [localPreviewPlugin(), react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true,
    allowedHosts: ['127.0.0.1'], cors: false,
    hmr: { host: '127.0.0.1', clientPort: 5180 },
    fs: { strict: true, allow: ['/workspace'], deny: ['.env', '.env.*', '**/.git/**', '**/secrets/**'] },
  },
});
