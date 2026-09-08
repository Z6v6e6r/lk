// Fixed local Docker hop only. There is no configurable or request-derived
// upstream, credential handling, production API route, or CONNECT support.
import http from 'node:http';
import net from 'node:net';

const valid = (req) => req.headers.host === '127.0.0.1:5180'
  && req.url?.startsWith('/') && !req.url.startsWith('//')
  && (!req.headers.origin || req.headers.origin === 'http://127.0.0.1:5180')
  && req.headers['sec-fetch-site'] !== 'cross-site';

const server = http.createServer((req, res) => {
  if (!valid(req) || !['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ code: 'LK1_LOCAL_EXTERNAL_ACCESS_DISABLED' }));
    return;
  }
  const upstream = http.request({
    hostname: 'web', port: 5173, path: req.url, method: req.method,
    headers: req.headers, timeout: 15000,
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => upstream.destroy());
  upstream.end();
});

server.on('upgrade', (req, socket, head) => {
  if (!valid(req) || req.headers['sec-websocket-protocol'] !== 'vite-hmr') { socket.destroy(); return; }
  const upstream = net.connect(5173, 'web', () => {
    upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.on('connect', (_req, socket) => socket.destroy());
server.listen(5180, '0.0.0.0');
