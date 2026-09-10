"use strict";
// Disposable synthetic observer OR peer in a separate internal network namespace.
const fs = require("node:fs"), http = require("node:http"), https = require("node:https"), net = require("node:net"), crypto = require("node:crypto");
const network = JSON.parse(fs.readFileSync("/fixture/network.json"));
const namespace = () => crypto.createHash("sha256").update(fs.readlinkSync("/proc/self/ns/net")).digest("hex");
const fail = () => { throw new Error("NGINX_APPLICATION_PEER_FAILED"); };
if (process.argv[2] === "serve" && process.argv.length === 3) {
  let received = 0;
  const publish = () => fs.writeFileSync("/control/observer.json", JSON.stringify({ received }), { mode: 0o600 });
  publish();
  const server = http.createServer((req, res) => {
    received++; publish(); req.resume();
    res.writeHead(503, { "content-type": "application/json", "cache-control": "public",
      "access-control-allow-origin": "*", "x-generation": "UNTRUSTED_UPSTREAM_MARKER" });
    res.end('{"fixture":"partner-application-default-off"}');
  });
  server.listen(18894, "127.0.0.1", () => fs.writeFileSync("/control/observer-ready", "ready", { mode: 0o600 }));
} else if (process.argv[2] === "probe" && process.argv.length === 4) {
  const name = process.argv[3];
  if (!["client", "client-2", "direct-sidecar"].includes(name)) fail();
  const base = { name, outcome: "CONNECTION_REFUSED", status: null, tlsAuthorized: false, noStore: false,
    cors: false, complete: false, sourceAddress: null, peerAddress: network.peerAddress,
    port: name === "direct-sidecar" ? 18894 : 8443, networkNamespaceSha256: namespace(), clientLeafDerSha256: null };
  const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
  if (name === "direct-sidecar") {
    // A refused socket has no connected peer/localAddress. Report the explicit
    // target and null actual source; the preceding frontdoor control proves the
    // vantage. Never fabricate a successfully observed socket for this refusal.
    const socket = net.createConnection({ host: network.peerAddress, port: 18894, localAddress: network.probeAddress });
    socket.setTimeout(3000, () => socket.destroy(new Error("TIMEOUT")));
    socket.once("connect", () => { socket.destroy(); process.stderr.write("DIRECT_SIDECAR_REACHABLE\n"); process.exitCode = 1; });
    socket.once("error", error => { if (error.code === "ECONNREFUSED") emit(base); else { process.stderr.write("DIRECT_SIDECAR_REFUSAL_UNPROVEN\n"); process.exitCode = 1; } });
  } else {
    let actualSource, actualPeer, actualClientLeaf;
    const request = https.request({ host: network.peerAddress, port: 8443, localAddress: network.probeAddress,
      servername: "fixture.invalid", path: "/lk/integrations/v1/operations/fixture-operation", method: "GET",
      ca: fs.readFileSync("/fixture/ca.crt"), cert: fs.readFileSync(`/fixture/${name}.crt`), key: fs.readFileSync(`/fixture/${name}.key`),
      rejectUnauthorized: true, agent: false, headers: { Host: "fixture.invalid", Connection: "close" }, timeout: 5000,
    }, response => {
      let bytes = 0; const authorized = response.socket.authorized;
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 4096) request.destroy(new Error("OVERSIZED")); });
      response.on("end", () => emit({ ...base, outcome: "HTTP_RESPONSE", status: response.statusCode,
        tlsAuthorized: authorized, noStore: response.headers["cache-control"] === "no-store",
        cors: Object.keys(response.headers).some(header => header.startsWith("access-control-")), complete: response.complete,
        sourceAddress: actualSource, peerAddress: actualPeer, clientLeafDerSha256: actualClientLeaf }));
    });
    request.on("socket", socket => socket.once("secureConnect", () => {
      actualSource = socket.localAddress; actualPeer = socket.remoteAddress;
      const used = socket.getCertificate();
      if (!Buffer.isBuffer(used?.raw) || !used.raw.length) { request.destroy(new Error("CLIENT_CERTIFICATE_UNPROVEN")); return; }
      actualClientLeaf = crypto.createHash("sha256").update(used.raw).digest("hex");
    }));
    request.on("timeout", () => request.destroy(new Error("TIMEOUT")));
    request.on("error", () => { process.stderr.write("NGINX_APPLICATION_TLS_PROBE_FAILED\n"); process.exitCode = 1; });
    request.end();
  }
} else fail();
