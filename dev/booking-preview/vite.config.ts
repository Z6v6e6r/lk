import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { transformPreviewNavigation, transformPreviewPayments } from './previewTransform';
import { hostedPreviewConfig, writeHostedPreview } from './hostedPreview';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const hosting = hostedPreviewConfig(process.env);
const modules: Record<string, string> = {
  apiClient: 'src/utils/apiClient.ts',
  tournamentSignupApi: 'src/utils/tournamentSignupApi.ts',
  groupScheduleApi: 'src/utils/groupScheduleApi.ts',
  communityApi: 'src/utils/communityApi.ts',
  analytics: 'src/utils/analytics.ts',
};

// Only this separate Vite configuration substitutes APIs. Production builds do
// not import this directory and continue using their existing configuration.
function previewApis(): Plugin {
  return {
    name: 'booking-preview-apis',
    enforce: 'pre',
    resolveId(source) {
      if (source.includes('?preview-original')) return null;
      if (/\/context\/AuthContext(?:\.tsx)?$/.test(source)) {
        return resolve(directory, 'auth.tsx');
      }
      if (!source.startsWith('.') && !source.startsWith('/')) return null;
      const name = basename(source).replace(/\.tsx?$/, '');
      if (modules[name]) return `\0booking-preview:${name}`;
    },
    transform(source, id) {
      const path = id.split('?')[0];
      if (!path.includes('/src/') || !/\.tsx?$/.test(path)) return null;
      return transformPreviewNavigation(transformPreviewPayments(source, basename(path)) || source, basename(path));
    },
    load(id) {
      if (!id.startsWith('\0booking-preview:')) return null;
      const name = id.slice('\0booking-preview:'.length);
      const file = modules[name];
      const source = readFileSync(resolve(root, file), 'utf8');
      const names = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
        .map(match => match[1])
        .filter(key => name === 'analytics' || key.startsWith('api') || key === 'request');
      return [
        `export * from ${JSON.stringify(`/@fs/${resolve(root, file)}?preview-original`)};`,
        `import { call } from '/dev/booking-preview/fixtures.ts';`,
        ...names.map(key => `export const ${key} = (...args) => ${name === 'analytics' ? 'undefined' : `call(${JSON.stringify(key)}, args)`};`),
      ].join('\n');
    },
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        const screens: Record<string, string> = { '/game_join': 'game-join', '/game_create': 'game-booking', '/group': 'training-join', '/finde_game': 'game-list', '/lk_new': 'game-list' };
        if (screens[url.pathname]) {
          url.searchParams.set('screen', screens[url.pathname]);
          request.url = '/dev/booking-preview/frame.html?' + url.searchParams;
          next();
          return;
        }
        if (request.url === '/' || request.url?.startsWith('/?')) {
          request.url = '/dev/booking-preview/index.html' + (request.url.slice(1));
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root,
  base: hosting.base,
  envDir: directory,
  plugins: [previewApis(), react(), {
    name: 'booking-preview-hosted-output',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace("connect-src 'self' ws://127.0.0.1:5173", "connect-src 'none'")
        .replace("script-src 'self' 'unsafe-inline'", "script-src 'self'");
    },
    async closeBundle() { await writeHostedPreview(resolve(root, 'dist/booking-preview'), hosting); },
  }],
  define: {
    'import.meta.env.VITE_PUBLIC_INVITE_ORIGIN': JSON.stringify(''),
    'import.meta.env.VITE_CABINET_URL': JSON.stringify(`${hosting.base}dev/booking-preview/frame.html?screen=game-list`),
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: 'dist/booking-preview',
    rollupOptions: {
      input: {
        index: resolve(directory, 'index.html'),
        frame: resolve(directory, 'frame.html'),
      },
    },
  },
});
