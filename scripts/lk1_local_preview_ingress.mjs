// The local hop stays fixed. Only the separately validated gateway may reach
// the fixed identity provider and five own-account read templates.
import http from 'node:http';
import net from 'node:net';
import { createGateway, webHeaders } from './lk1_local_gateway.mjs';

const gateway = createGateway();

const valid = (req) => req.headers.host === '127.0.0.1:5180'
  && req.url?.startsWith('/') && !req.url.startsWith('//')
  && (!req.headers.origin || req.headers.origin === 'http://127.0.0.1:5180')
  && req.headers['sec-fetch-site'] !== 'cross-site';

const server = http.createServer((req, res) => {
  if (req.url === '/__lk1_local/gateway') { void gateway.handle(req, res); return; }
  if (!valid(req) || !['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ code: 'LK1_LOCAL_EXTERNAL_ACCESS_DISABLED' }));
    return;
  }
  if (req.url === '/__lk1_local/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(gateway.status())); return;
  }
  const upstream = http.request({
    hostname: 'web', port: 5173, path: req.url, method: req.method,
    headers: webHeaders(req.headers), timeout: 15000,
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
    upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(webHeaders(req.headers)).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
server.on('connect', (_req, socket) => socket.destroy());
server.listen(5180, '0.0.0.0');
