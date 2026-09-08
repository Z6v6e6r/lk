import { readFileSync } from 'node:fs';

export const PREVIEW_ORIGIN = 'http://127.0.0.1:5180';
export const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://127.0.0.1:5180",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "worker-src 'none'",
  "base-uri 'self'",
].join('; ');

export const blockedPayload = {
  code: 'LK1_LOCAL_EXTERNAL_ACCESS_DISABLED',
  message: 'LK1 запущен локально. Подключение боевого аккаунта ещё не разрешено.',
};

export function localPreviewPlugin() {
  let blockedRequests = 0;
  const json = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  return {
    name: 'lk1-local-offline-preview',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', PREVIEW_CSP);
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
        if (req.headers.origin && req.headers.origin !== PREVIEW_ORIGIN) return json(res, 403, blockedPayload);
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, blockedPayload);
        if (!['127.0.0.1:5180', '127.0.0.1:5173'].includes(req.headers.host || '')) return json(res, 403, blockedPayload);
        if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
          blockedRequests += 1;
          return json(res, 403, blockedPayload);
        }
        const url = new URL(req.url || '/', PREVIEW_ORIGIN);
        if (url.pathname === '/__lk1_local/status') {
          return json(res, 200, { mode: 'offline', upstreamConnections: 0, blockedRequests });
        }
        if (url.pathname === '/__lk1_local/blocked') {
          blockedRequests += 1;
          return json(res, 403, blockedPayload);
        }
        if (url.pathname === '/__lk1_local/guard.js') {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.end(readFileSync(new URL('./lk1_local_preview_browser.js', import.meta.url), 'utf8'));
          return;
        }
        if (url.pathname === '/') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LK1 — локальная версия</title><style>
            *{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#f4f6f8;color:#152b3a}
            body{display:flex;flex-direction:column}header{padding:12px 20px;background:#152b3a;color:white;display:flex;gap:8px 20px;align-items:center;flex-wrap:wrap}strong{white-space:nowrap}span{font-size:13px;line-height:1.4;color:#dde6ee}iframe{width:100%;flex:1;border:0;background:white}
          </style></head><body><header><strong>LK1 · Локальная версия</strong><span>Внешние запросы заблокированы. Вход в боевой аккаунт ещё не подключён.</span></header><iframe title="Личный кабинет LK1" src="/lk_new?authMode=viva" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></body></html>`);
          return;
        }
        // Keep the application inside the shell: its frame-src blocks remote
        // location changes and the sandbox prevents popups/top-level navigation.
        if (req.headers['sec-fetch-dest'] === 'document') {
          res.writeHead(302, { Location: '/' }); res.end(); return;
        }
        next();
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [{ tag: 'script', attrs: { src: '/__lk1_local/guard.js' }, injectTo: 'head-prepend' }];
      },
    },
  };
}
