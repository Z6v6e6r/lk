import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createIdentityVerifier } from './identity.mjs';
import { createEnrollment } from './enrollment.mjs';
import { createRegistry, fail } from './registry.mjs';
import { LIVE_ENGINE_VERSION, LIVE_RULE, LIVE_SYNC, LIVE_LIVES } from '../../../src/components/padel-jump/live-contract.ts';

export function createLiveServer({ origin = 'http://127.0.0.1:5192', directory, requestLimit = 6000, communityId, authenticate = createIdentityVerifier({ communityId }), registry = createRegistry({ directory, communityId }), enrollment = createEnrollment({ authenticate, communityId, directory }) } = {}) {
  const viewers = new Set(), rates = new Map();
  let diagnosticAt = 0;
  const response = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin), path = url.pathname;
      const at = Date.now(), key = req.socket.remoteAddress;
      for (const [k, rate] of rates) if (at - rate.at > 60000) rates.delete(k);
      if (rates.size >= 2048 && !rates.has(key)) fail(429, 'RATE_LIMIT');
      const rate = rates.get(key) ?? { at, count: 0 }; rates.set(key, rate); if (++rate.count > requestLimit) fail(429, 'RATE_LIMIT');
      if (path === '/jump-live-api/community-ranking') {
        // Only this member-authenticated read is exposed to the cabinet origin.
        // Game writes, entry and stream retain their existing origin policy.
        const source = req.headers.origin;
        if (source && ![origin, 'https://padlhub.ru'].includes(source)) fail(403, 'ORIGIN_DENIED');
        if (source) { res.setHeader('Access-Control-Allow-Origin', source); res.setHeader('Vary', 'Origin'); }
        if (url.searchParams.size !== 1 || url.searchParams.get('communityId') !== communityId) fail(404, 'JUMP_COMMUNITY_NOT_CONFIGURED');
        if (req.method === 'OPTIONS') {
          const headers = String(req.headers['access-control-request-headers'] ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
          if (req.headers['access-control-request-method'] !== 'GET' || headers.some(value => value !== 'authorization')) fail(403, 'ORIGIN_DENIED');
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization', 'Cache-Control': 'no-store' }); res.end(); return;
        }
        if (req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED');
        const actor = await authenticate(req);
        return response(res, 200, registry.communityRanking(actor));
      }
      if (path === '/jump-live-api/health' && req.method === 'GET') return response(res, 200, { engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, sync: LIVE_SYNC, lives: LIVE_LIVES, communityConfigured: !!communityId, persistence: !!directory });
      if (path === '/jump-live-api/me' && req.method === 'GET') return response(res, 200, await authenticate(req));
      if (path === '/jump-live-api/entry' && req.method === 'GET') return response(res, 200, await enrollment.status(req));
      if (path === '/jump-live-api/board' && req.method === 'GET') return response(res, 200, registry.board());
      if (path === '/jump-live-api/stream' && req.method === 'GET') {
        if (req.headers.origin && req.headers.origin !== origin) fail(403, 'ORIGIN_DENIED');
        if (viewers.size >= 24) fail(429, 'VIEWER_LIMIT');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        res.write('data: ' + JSON.stringify(registry.board()) + '\n\n'); viewers.add(res); res.on('close', () => viewers.delete(res)); return;
      }
      if (req.method !== 'POST' || !/^\/jump-live-api\/(?:enrollment|runs|runs\/[a-f0-9-]{36})$/.test(path)) fail(404, 'NOT_FOUND');
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'ORIGIN_DENIED');
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'JSON_REQUIRED');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 8192) fail(413, 'BODY_LIMIT'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'JSON_INVALID'); }
      if (path === '/jump-live-api/enrollment') return response(res, 200, await enrollment.submit(req, body));
      const actor = await authenticate(req, { fresh: body.command === 'finish' || path === '/jump-live-api/runs' });
      if (path === '/jump-live-api/runs') return response(res, 201, registry.join(body, actor));
      const token = req.headers['x-jump-run-token'];
      return response(res, 200, registry.command(path.split('/').at(-1), token, body, actor));
    } catch (error) {
      const httpError = Number.isInteger(error.code) && error.code >= 400 && error.code <= 599;
      const status = httpError ? error.code : 503;
      const code = httpError && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'SERVICE_UNAVAILABLE';
      if (status === 503 && Date.now() - diagnosticAt > 60000) {
        diagnosticAt = Date.now();
        console.warn(JSON.stringify({ event: 'jump_service_unavailable', code, stage: ['profile', 'community'].includes(error.identityStage) ? error.identityStage : 'verification' }));
      }
      if (!res.headersSent && !res.destroyed) response(res, status, { error: code });
    }
  });
  server.maxConnections = 80;
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000;
  const interval = setInterval(() => {
    let data; try { data = 'data: ' + JSON.stringify(registry.board()) + '\n\n'; } catch { for (const res of viewers) res.destroy(); viewers.clear(); return; }
    for (const res of viewers) { if (res.writableLength > 262144) { res.destroy(); viewers.delete(res); } else res.write(data); }
  }, 500); interval.unref();
  server.on('close', () => { clearInterval(interval); for (const res of viewers) res.destroy(); viewers.clear(); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.env.JUMP_PUBLIC_ORIGIN;
  if (!origin || !/^https?:\/\/[a-zA-Z0-9.:-]+$/.test(origin) || !process.env.JUMP_RESULTS_DIR) throw new Error('Explicit origin and isolated result directory required');
  const server = createLiveServer({ origin, directory: process.env.JUMP_RESULTS_DIR, communityId: process.env.JUMP_COMMUNITY_ID });
  server.listen(Number(process.env.JUMP_PORT ?? 5193), '127.0.0.1');
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
