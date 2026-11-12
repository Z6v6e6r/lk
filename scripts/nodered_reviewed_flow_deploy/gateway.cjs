'use strict';
// Persistent admission proxy. It is never restarted by the flow deploy helper.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { protectedPath, readMarker, readResolution, admissionKey, ADMISSION_HEADER, BASE } = require('./lifecycle.cjs');
function endToEndHeaders(headers) {
  const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !hop.has(key.toLowerCase())));
}
function startGateway({ baseDir = BASE, port = 18809, host = '127.0.0.1', upstreamPort = 1880 } = {}) {
  protectedPath(baseDir, { directory: true, mode: 0o755 });
  const policyPath = path.join(baseDir, 'policy.json'); protectedPath(policyPath);
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const key = admissionKey(baseDir, true);
  let active = 0; let uncertain = 0; let resolvedId = null; let uncertaintyRevision = 0;
  const bootId = crypto.randomUUID();
  const closed = () => fs.existsSync(path.join(baseDir, 'closed.json'));
  const unavailable = res => {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5', 'Cache-Control': 'no-store' });
    res.end('{"code":"NODE_RED_RELEASING","retryable":true}');
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/__padlhub_release_probe') {
      const generation = req.headers['x-padlhub-edge-generation'];
      const worker = req.headers['x-padlhub-edge-worker'];
      if (generation !== policy.edgeGeneration || !/^\d+$/.test(worker || '')) return unavailable(res);
      res.writeHead(closed() ? 503 : 204, { 'X-Padlhub-Edge-Generation': generation,
        'X-Padlhub-Edge-Worker': worker, 'Retry-After': '5', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (closed()) return unavailable(res);
    // Count immediately, before body buffering, connect or upstream dispatch.
    active++;
    let completed = false;
    const done = unknown => { if (!completed) { completed = true; active--; if (unknown) { uncertain++; uncertaintyRevision++; } } };
    const requestHeaders = { ...endToEndHeaders(req.headers), [ADMISSION_HEADER]: key };
    if (requestHeaders.host === `127.0.0.1:${server.address().port}`) requestHeaders.host = `127.0.0.1:${upstreamPort}`;
    const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method,
      path: req.url, headers: requestHeaders, agent: false }, response => {
      // Forward application errors byte-for-byte as well. Never retry a POST.
      const headers = endToEndHeaders(response.headers); delete headers[ADMISSION_HEADER];
      res.writeHead(response.statusCode, headers);
      response.pipe(res);
      res.once('close', () => { if (!res.writableFinished) { response.unpipe(res); response.resume(); } });
      response.once('end', () => done(false));
      response.once('aborted', () => { done(true); res.destroy(); });
      response.once('error', () => { done(true); res.destroy(); });
    });
    upstream.once('error', () => {
      done(true);
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '5' });
        res.end('{"code":"NODE_RED_TRANSPORT_UNAVAILABLE"}');
      } else res.destroy();
    });
    // A client response abort does not cancel an already dispatched write.
    req.once('aborted', () => { upstream.destroy(); done(true); });
    req.once('error', () => { upstream.destroy(); done(true); });
    res.on('error', () => {}); // A disconnected client must not crash admission.
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (closed()) return socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n');
    active++;
    let complete = false;
    const done = unknown => { if (!complete) { complete = true; active--; if (unknown) { uncertain++; uncertaintyRevision++; } } };
    const upstream = require('node:net').connect(upstreamPort, '127.0.0.1', () => {
      const headers = req.rawHeaders.reduce((out, value, i, all) => i % 2 || value.toLowerCase() === ADMISSION_HEADER ? out : out + `${value}: ${all[i + 1]}\r\n`, '') + `${ADMISSION_HEADER}: ${key}\r\n`;
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.once('close', () => upstream.end());
    upstream.once('close', () => { socket.end(); done(false); });
    upstream.once('error', () => { socket.destroy(); done(true); });
    socket.once('error', () => { upstream.destroy(); done(true); });
    // Open upgrades block drain rather than being killed during a flow release.
  });
  const runtime = path.join(baseDir, 'runtime');
  if (!fs.existsSync(runtime)) fs.mkdirSync(runtime, { mode: 0o700 });
  protectedPath(runtime, { directory: true, mode: 0o700 });
  const socket = path.join(runtime, 'gateway.sock');
  // No automatic takeover of a prior proxy: a gateway crash requires explicit
  // recovery, not silently resetting active/uncertain counters.
  const control = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/resolve') {
      try {
        const r = readResolution(baseDir);
        if (!readMarker(baseDir) || active || r.gatewayPid !== process.pid || r.gatewayBootId !== bootId
          || r.gatewayUncertaintyRevision !== uncertaintyRevision
          || !(r.resolutionId === resolvedId ? uncertain === 0 : r.gatewayUncertain === uncertain)) throw Error('resolution mismatch');
        uncertain = 0; resolvedId = r.resolutionId;
      } catch { res.writeHead(409); return res.end(); }
    } else if (req.method !== 'GET' || req.url !== '/status') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ version: 1, pid: process.pid, bootId, active, uncertain, uncertaintyRevision,
      port: server.address()?.port, host, upstreamPort, admissionKeyDigest: crypto.createHash('sha256').update(key).digest('hex') }));
  });
  control.listen(socket, () => fs.chmodSync(socket, 0o600));
  server.listen(port, host);
  return { server, control };
}
module.exports = { startGateway };
if (require.main === module) startGateway();
