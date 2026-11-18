// Local HTTPS origin for the exact published old bundle and the locally built
// new pilot bundle. /lk/residency/* is proxied to the isolated Node-RED gateway.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const GATEWAY = new URL(process.env.GATEWAY_URL || "http://127.0.0.1:1880");
const NEW_PORT = Number(process.env.NEW_PORT || 8443);
const OLD_PORT = Number(process.env.OLD_PORT || 8444);
const NEW_BUNDLE = process.env.NEW_BUNDLE;
const OLD_BUNDLE = process.env.OLD_BUNDLE;
const NEW_VERSION = process.env.NEW_VERSION || "local-pilot-new";
const OLD_VERSION = process.env.OLD_VERSION || "local-pilot-old";

const TLS_KEY = process.env.TLS_KEY || new URL("./certs/key.pem", import.meta.url);
const TLS_CERT = process.env.TLS_CERT || new URL("./certs/cert.pem", import.meta.url);
const cert = { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) };

function html(version) {
  return "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"/>"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>"
    + "<title>LK pilot fixture</title><script>window.__LK_RELEASE_VERSION__=" + JSON.stringify(version) + ";</script>"
    + "</head><body><div id=\"root\"></div><script src=\"/bundle.js\"></script></body></html>";
}

function proxy(req, res) {
  const upstream = http.request({
    hostname: GATEWAY.hostname, port: GATEWAY.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: GATEWAY.host },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    const body = JSON.stringify({ code: "GATEWAY_UNAVAILABLE" });
    res.writeHead(502, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  req.pipe(upstream);
}

function serveFile(res, filePath) {
  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

function makeServer(kind, port, bundle, version) {
  const server = https.createServer(cert, (req, res) => {
    const url = new URL(req.url, "https://" + (req.headers.host || "localhost"));

    if (url.pathname.startsWith("/lk/residency/")) return proxy(req, res);
    if (url.pathname === "/bundle.js") return serveFile(res, bundle);
    if (url.pathname === "/lk/release.json") {
      const body = JSON.stringify({ version, sourceCommit: "isolated-fixture", generatedAt: new Date().toISOString() });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
      return res.end(body);
    }
    if (url.pathname === "/" || url.pathname === "/lk_new" || url.pathname === "/lk_new/") {
      const body = html(version);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
      return res.end(body);
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end("not found");
  });
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "frontend_listening", kind, port })));
}

makeServer("new", NEW_PORT, NEW_BUNDLE, NEW_VERSION);
makeServer("old", OLD_PORT, OLD_BUNDLE, OLD_VERSION);