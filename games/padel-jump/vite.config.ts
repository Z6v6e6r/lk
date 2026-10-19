import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Independent guest build; does not alter LK release manifests or native settings. */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/padel-jump',
    emptyOutDir: true,
    rollupOptions: { input: 'padel-jump.html' },
  },
});
