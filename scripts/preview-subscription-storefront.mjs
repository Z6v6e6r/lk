/**
 * Local preview harness for the direct-payment storefront CTA.
 *
 * Serves the built `dist/subscription-storefront` bundle on http://127.0.0.1:5194
 * and stubs every LK1 endpoint in `window.fetch`, so the whole CTA flow
 * (status -> payment creation -> bank redirect -> confirmation) can be exercised
 * in a browser without touching production payments.
 *
 *   node scripts/preview-subscription-storefront.mjs
 *
 * Scenarios: `?auth=0` (default) and `?auth=1`.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist', 'subscription-storefront');
const port = Number(process.env.PREVIEW_PORT || 5194);
const nowSeconds = Math.floor(Date.now() / 1000);

const contentTypes = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function page(search = '') {
  const query = new URLSearchParams(search || process.env.PREVIEW_QUERY || 'auth=0');
  const auth = query.get('auth') === '1';
  const autoClick = query.get('click') === '1';
  const token = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ phone_number: '+79990000000', exp: nowSeconds + 3600, sub: 'preview' })).toString('base64url'),
    'preview',
  ].join('.');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Preview /subsription</title>
<style>body{margin:0;font-family:Arial,sans-serif}header{padding:16px;background:#111;color:#fff}
code{background:#f0f0f0;padding:2px 4px;border-radius:4px}#preview-log{padding:8px 16px;font:12px/1.4 monospace;color:#444;white-space:pre-wrap}</style>
</head><body>
<header>Preview витрины /subsription — оплата создаётся виджетом. Сценарий: ${auth ? 'авторизован' : 'без входа'}.</header>
<div id="padlhub-subscriptions"></div>
<pre id="preview-log">log:</pre>
<script>
  if (${auth}) {
    window.localStorage.setItem('padlhub_auth_token_v1', JSON.stringify({ token: ${JSON.stringify(token)}, expiresAt: Date.now() + 3600000 }));
  } else {
    window.localStorage.clear();
  }
  var log = document.getElementById('preview-log');
  function note(message) { log.textContent += '\\n' + message; }
  window.__previewNote = note;
  var realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    if (url.indexOf('/lk/tournaments/summer-subscription/status') !== -1) {
      var scoped = url.indexOf('counterKey=') !== -1;
      var payload = scoped
        ? [{ counterKey: 'network_friendship', inventoryId: 'preview', unlimited: false,
             planType: 'friendship', campaignKey: 'preview', productId: null,
             priceMinor: 5680000, canPurchase: true, bindingReady: true,
             remainingCount: 10, totalLimit: 10, paidCount: 0, status: 'READY' }]
        : [
            { counterKey: 'friendship', inventoryId: 'preview', unlimited: false, planType: 'friendship',
              campaignKey: 'preview', productId: null, priceMinor: 980000, canPurchase: true,
              bindingReady: true, remainingCount: 8, totalLimit: 100, paidCount: 92, status: 'READY' },
            { counterKey: 'ra', inventoryId: 'preview', unlimited: false, planType: 'friendship',
              campaignKey: 'preview', productId: null, priceMinor: 2380000, canPurchase: true,
              bindingReady: true, remainingCount: 12, totalLimit: 100, paidCount: 88, status: 'READY' },
            { counterKey: 'academy', inventoryId: 'preview', unlimited: false, planType: 'friendship',
              campaignKey: 'preview', productId: null, priceMinor: 2380000, canPurchase: true,
              bindingReady: true, remainingCount: 7, totalLimit: 100, paidCount: 93, status: 'READY' },
          ];
      note('stub status <- ' + url);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.indexOf('/end-user/api/v1/') !== -1 && url.indexOf('/transactions') !== -1) {
      note('stub transactions <- ' + init.method);
      return new Response(JSON.stringify({ toPay: 0, paymentUrl: 'http://127.0.0.1:${port}/mock-bank' }), {
        status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.indexOf('/lk/tournaments/summer-subscription/purchase') !== -1) {
      note('stub purchase <- ' + init.body);
      var request = JSON.parse(String(init.body || '{}'));
      return new Response(JSON.stringify({
        paymentRef: request.paymentRef, counterKey: request.counterKey, planType: request.planType,
        campaignKey: 'preview', toPayMinor: 980000, status: 'PAYMENT_PENDING',
        paymentUrl: 'http://127.0.0.1:${port}/mock-bank',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.indexOf('/lk/tournaments/summer-subscription/confirm') !== -1) {
      note('stub confirm <- ' + init.body);
      var confirmRequest = JSON.parse(String(init.body || '{}'));
      return new Response(JSON.stringify({
        paymentRef: confirmRequest.paymentRef, counterKey: confirmRequest.counterKey,
        planType: confirmRequest.planType, campaignKey: 'preview', status: 'PAID', paid: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.indexOf('/end-user/api/v1/') !== -1 && url.indexOf('/profile') !== -1) {
      note('stub profile');
      return new Response(JSON.stringify({ id: 'preview', phone: '+79990000000' }), {
        status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  };
</script>
<script src="/subscription-storefront.js"></script>
<script>
  (function () {
    var raw = window.localStorage.getItem('padlhub_auth_token_v1');
    window.__previewNote('auth token stored: ' + (raw ? raw.slice(0, 40) + '…' : 'none'));
    var envelope = raw ? JSON.parse(raw) : null;
    var token = envelope && envelope.token ? envelope.token : null;
    var parts = token ? token.split('.') : [];
    var payload = null;
    try { payload = parts.length > 1 ? JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) : null; } catch (error) { payload = String(error); }
    window.__previewNote('decoded jwt payload: ' + JSON.stringify(payload));
  })();
  window.LKWidgetSubscriptionStorefront.mount({ targetId: 'padlhub-subscriptions' });
  ${autoClick ? `setTimeout(function () {
    var button = Array.prototype.find.call(
      document.querySelectorAll('#padlhub-subscriptions button'),
      function (candidate) { return candidate.textContent.trim() === 'Оформить подписку'; },
    );
    if (button) { window.__previewNote('auto-click: Оформить подписку'); button.click(); }
    else { window.__previewNote('auto-click: кнопка не найдена'); }
  }, 2500);` : ''}
</script>
</body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(url.search));
    return;
  }
  if (url.pathname === '/mock-bank') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<p id="mock-bank">MOCK BANK: достигнуто. Оплата создана виджетом.</p>');
    return;
  }
  const relative = normalize(url.pathname).replace(/^([/\\])+/, '');
  const filePath = join(distDir, relative);
  if (!filePath.startsWith(distDir)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Preview: http://127.0.0.1:${port}/`);
  console.log(`  без входа: http://127.0.0.1:${port}/?auth=0`);
  console.log(`  авторизован: http://127.0.0.1:${port}/?auth=1`);
});
