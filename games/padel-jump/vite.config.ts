import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Independent guest build; does not alter LK release manifests or native settings. */
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { proxy: { '/jump-live-api': 'http://127.0.0.1:5193' } },
  build: {
    outDir: 'dist/padel-jump',
    emptyOutDir: true,
    rollupOptions: { input: ['padel-jump.html', 'padel-jump-race.html', 'padel-jump-live.html'] },
  },
});
