import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { performance } from "node:perf_hooks";
import test, { before, after } from "node:test";
import { collectPartnerNginxTransportObservations } from "../partner_game_membership_nginx_probes.mjs";
import { PARTNER_INGRESS_REQUIRED_PROBES, verifyPartnerProductionIngress } from "../partner_game_membership_ingress_evidence.mjs";
import { createPartnerNginxTestCertificates } from "./fixtures/partner-nginx124-certificates.mjs";
import { createPartnerRawRequestGuard } from "../partner_game_membership_sidecar/raw-request-guard.cjs";
import registerPartnerNode from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-node.cjs";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
let root, fixture, credentials;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "partner-probes-owned-"));
  const certDir = path.join(root, "certs"); fixture = createPartnerNginxTestCertificates(certDir);
  const read = name => fs.readFileSync(path.join(certDir, name));
  credentials = {
    serverCaBytes: fixture.caCertificateBytes, clientCertificateBytes: fixture.clientCertificateBytes,
    clientKeyBytes: read("client.key"), wrongClientCertificateBytes: read("wrong-client.crt"), wrongClientKeyBytes: read("wrong-client.key"),
    approvedServerSpkiSha256: hash(new crypto.X509Certificate(fixture.serverCertificateBytes).publicKey.export({ type: "spki", format: "der" })),
    approvedClientSpkiSha256: fixture.approvedClientSpkiSha256,
    approvedWrongClientSpkiSha256: hash(new crypto.X509Certificate(read("wrong-client.crt")).publicKey.export({ type: "spki", format: "der" })),
    serverKeyBytes: read("server.key"),
  };
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
function input(port = 4443, sidecarPort = 18894) {
  const client = Object.fromEntries(Object.entries(credentials).filter(([key]) => key !== "serverKeyBytes"));
  return { ...client, targetAddress: "127.0.0.1", sourceAddress: "127.0.0.1", port, sidecarPort,
    exactHost: "fixture.invalid", sharedHost: "shared.invalid" };
}
const reply = (status = 503, extra = "", body = "off") => `HTTP/1.1 ${status} Fixture\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`;
async function serve(t, onRequest, options = {}) {
  const requests = [], sockets = new Set();
  const server = tls.createServer({ key: credentials.serverKeyBytes, cert: fixture.serverCertificateBytes,
    ca: fixture.caCertificateBytes, requestCert: true, rejectUnauthorized: false,
    minVersion: "TLSv1.2", maxVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"], ...options }, socket => {
    socket.on("error", () => {}); // Client deliberately tears down rejected responses.
    let text = "";
    socket.on("data", chunk => {
      text += chunk.toString();
      if (text.includes("\r\n\r\n")) { const raw = text; text = ""; requests.push(raw); onRequest(socket, raw); }
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
  server.on("tlsClientError", () => {});
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  // A listener on the same owned loopback host supplies a deterministic refused
  // port after close. A racing listener can only invalidate the observation.
  const unused = net.createServer();
  await new Promise((resolve, reject) => { unused.once("error", reject); unused.listen(0, "127.0.0.1", resolve); });
  const sidecarPort = unused.address().port; await new Promise(resolve => unused.close(resolve));
  return { requests, server, options: input(server.address().port, sidecarPort) };
}

for (const [label, changes] of [
  ["URL target", { targetAddress: "https://fixture.invalid" }], ["DNS target", { targetAddress: "fixture.invalid" }],
  ["octal IP", { targetAddress: "127.0.0.01" }], ["IPv6", { targetAddress: "::1" }],
  ["multicast", { targetAddress: "224.0.0.1" }], ["unspecified", { targetAddress: "0.0.0.0" }],
  ["unbound source", { sourceAddress: "0.0.0.0" }], ["string port", { port: "443" }], ["zero port", { port: 0 }],
  ["large port", { sidecarPort: 65536 }], ["equal ports", { port: 18894 }],
  ["wildcard host", { exactHost: "*.invalid" }], ["header injection", { exactHost: "fixture.invalid\r\nHost: bad.invalid" }],
  ["duplicate hosts", { sharedHost: "fixture.invalid" }], ["wrong SNI control collision", { exactHost: "unbound.invalid" }],
  ["noncanonical host", { exactHost: "Fixture.invalid" }], ["weak pin", { approvedServerSpkiSha256: "short" }],
  ["URL override", { url: "https://unbound.invalid" }], ["POST override", { method: "POST" }],
  ["body override", { body: "private" }], ["proxy override", { proxy: "http://unbound.invalid" }],
  ["caller verdict", { productionVerified: true }], ["caller observations", { probes: [] }],
  ["deadline override", { timeout: 0 }], ["TLS override", { rejectUnauthorized: false }],
  ["key path", { clientKeyBytes: "/private/not-read" }], ["oversized key", { clientKeyBytes: Buffer.alloc(8193) }],
  ["invalid certificate", { serverCaBytes: Buffer.from("not a certificate") }],
]) test(`probe input rejects ${label} before any socket`, async t => {
  let calls = 0;
  t.mock.method(tls, "connect", () => { calls++; throw new Error("must not connect"); });
  t.mock.method(net, "createConnection", () => { calls++; throw new Error("must not connect"); });
  await assert.rejects(collectPartnerNginxTransportObservations({ ...input(), ...changes }), error => {
    assert.match(error.code, /^(INVALID_NGINX_PROBE_|NGINX_PROBE_)/);
    assert.equal(error.message, error.code); return true;
  });
  assert.equal(calls, 0);
});

test("probe validation pins distinct client identities and matching keys before IO", async t => {
  let calls = 0; t.mock.method(tls, "connect", () => { calls++; });
  for (const changes of [
    { approvedWrongClientSpkiSha256: credentials.approvedClientSpkiSha256 },
    { approvedClientSpkiSha256: "f".repeat(64) }, { clientKeyBytes: credentials.wrongClientKeyBytes },
    { clientCertificateBytes: Buffer.concat([credentials.clientCertificateBytes, credentials.clientCertificateBytes]) },
    { clientKeyBytes: credentials.clientCertificateBytes },
  ]) await assert.rejects(collectPartnerNginxTransportObservations({ ...input(), ...changes }), /NGINX_PROBE_/);
  assert.equal(calls, 0);
});

test("real TLS sockets collect exactly the read-only matrix without promoting insecure fixture to proof", async t => {
  const f = await serve(t, (socket, raw) => socket.end(reply(raw.startsWith("OPTIONS") ? 405 : 503)));
  const result = await collectPartnerNginxTransportObservations(f.options);
  assert.deepEqual(result.probes.map(row => row.id), PARTNER_INGRESS_REQUIRED_PROBES);
  assert.equal(new Set(result.probes.map(row => row.probeId)).size, 11);
  const positive = result.probes[0];
  assert.equal(positive.outcome, "HTTP_RESPONSE"); assert.equal(positive.httpStatus, 503);
  assert.equal(positive.complete, true); assert.equal(positive.tlsAuthorized, true);
  assert.equal(positive.serverSpkiSha256, credentials.approvedServerSpkiSha256);
  assert.equal(positive.serverLeafSha256, hash(new crypto.X509Certificate(fixture.serverCertificateBytes).raw));
  assert.equal(positive.actualClientLeafSha256, hash(new crypto.X509Certificate(fixture.clientCertificateBytes).raw));
  assert.equal(positive.peerAddress, "127.0.0.1"); assert.equal(positive.sourceAddress, "127.0.0.1");
  assert.equal(positive.peerPort, f.options.port); assert.equal(positive.bodySha256, hash("off"));
  assert.equal(positive.cacheControl, "no-store"); assert.equal(positive.corsHeaderPresent, false);
  assert.equal(result.probes.find(row => row.id === "noClientCertificate").httpStatus, 503);
  const wrong = result.probes.find(row => row.id === "wrongClientCertificate");
  assert.equal(wrong.httpStatus, 503); // Insecure fixture intentionally admits it.
  assert.equal(wrong.actualClientLeafSha256, hash(new crypto.X509Certificate(credentials.wrongClientCertificateBytes).raw));
  const refused = result.probes.find(row => row.id === "directSidecar");
  assert.equal(refused.outcome, "CONNECTION_REFUSED"); assert.equal(refused.errorCode, "ECONNREFUSED");
  assert.equal(refused.sourceAddress, null); assert.equal(refused.peerAddress, null); assert.equal(refused.peerPort, null);
  assert.equal(result.probes.find(row => row.id === "wrongSni").outcome, "TRANSPORT_ERROR"); // Hostname mismatch != TLS alert.
  assert.equal(f.requests.length, 9);
  for (const raw of f.requests) {
    assert.match(raw, /^(GET|OPTIONS) (\/flows|\/lk\/integrations\/v1\/operations\/ingress-probe-[a-f0-9]{64}(\?probe=1)?) HTTP\/1.1/);
    assert.equal(raw.split("\r\n\r\n")[1], "");
    assert.doesNotMatch(raw, /authorization:|content-length:|cookie:/i);
    assert.match(raw, /X-Padlhub-Signature: not-a-v2-signature\r\n/);
    const wireId = /X-Padlhub-Probe-Id: ([a-f0-9]{64})\r\n/.exec(raw)?.[1];
    assert.ok(result.probes.some(row => row.probeId === wireId));
  }
  assert.equal(result.state, "NGINX_TRANSPORT_OBSERVATIONS_NOT_INGRESS_PROOF");
  for (const flag of ["productionVerified", "deployAuthorized", "activationAuthorized"]) assert.equal(result[flag], false);
  assert.equal(result.vantage, "UNATTESTED"); assert.equal(result.upstreamAdmission, "NOT_COLLECTED");
  assert.throws(() => verifyPartnerProductionIngress(result), /UNSUPPORTED_INGRESS_ADAPTER/);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /BEGIN |PRIVATE KEY|"body":|Untrusted fixture/);
  assert.ok(Buffer.from(f.options.clientKeyBytes).equals(credentials.clientKeyBytes)); // Caller buffers preserved.
});

test("actual TLS verification rejects server key drift before sending HTTP", async t => {
  const f = await serve(t, socket => socket.end(reply())); f.options.approvedServerSpkiSha256 = "f".repeat(64);
  const result = await collectPartnerNginxTransportObservations(f.options);
  assert.equal(f.requests.length, 0);
  assert.equal(result.probes[0].outcome, "TLS_IDENTITY_MISMATCH");
  assert.equal(result.productionVerified, false);
});

test("actual mTLS rejection is an observation, not proof of upstream isolation", async t => {
  const f = await serve(t, socket => socket.end(reply()), { rejectUnauthorized: true });
  const result = await collectPartnerNginxTransportObservations(f.options);
  for (const id of ["noClientCertificate", "wrongClientCertificate"]) {
    const row = result.probes.find(probe => probe.id === id);
    assert.equal(row.complete, false); assert.equal(row.httpStatus, null);
    assert.ok(["TLS_ALERT", "HTTP_INCOMPLETE", "TRANSPORT_ERROR"].includes(row.outcome));
  }
  assert.equal(result.probes[0].outcome, "HTTP_RESPONSE"); assert.equal(result.productionVerified, false);
});

for (const [label, response, expected] of [
  ["redirect", reply(302, "Location: https://must-not-resolve.invalid/private\r\n"), "HTTP_RESPONSE"],
  ["HTTP400 without client admission proof", reply(400), "HTTP_RESPONSE"],
  ["duplicate cache headers", reply(503, "Cache-Control: public\r\n"), "HTTP_REJECTED"],
  ["compression", reply(503, "Content-Encoding: gzip\r\n"), "HTTP_REJECTED"],
  ["declared oversized body", "HTTP/1.1 503 Fixture\r\nContent-Length: 16385\r\n\r\n", "HTTP_REJECTED"],
  ["streaming oversized body", `HTTP/1.1 503 Fixture\r\nConnection: close\r\n\r\n${"x".repeat(16385)}`, "HTTP_REJECTED"],
  ["truncated body", "HTTP/1.1 503 Fixture\r\nContent-Length: 3\r\n\r\nx", "HTTP_INCOMPLETE"],
  ["truncated chunk", "HTTP/1.1 503 Fixture\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nx", "HTTP_INCOMPLETE"],
  ["trailers", "HTTP/1.1 503 Fixture\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\nX-Proof: untrusted\r\n\r\n", "HTTP_INCOMPLETE"],
  ["CL plus TE", "HTTP/1.1 503 Fixture\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "HTTP_INCOMPLETE"],
  ["large headers", reply(503, `X-Large: ${"x".repeat(16384)}\r\n`), "HTTP_INCOMPLETE"],
  ["upgrade", "HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: test\r\n\r\n", "HTTP_REJECTED"],
  ["interim response", "HTTP/1.1 100 Continue\r\n\r\n" + reply(), "HTTP_REJECTED"],
]) test(`HTTP observation handles ${label} without followup or body leakage`, async t => {
  const f = await serve(t, socket => socket.end(response));
  const result = await collectPartnerNginxTransportObservations(f.options);
  assert.equal(result.probes[0].outcome, expected);
  assert.equal(result.productionVerified, false); assert.equal(f.requests.length, 9);
  assert.ok(result.probes.every(row => row.completedAt >= row.startedAt));
  assert.doesNotMatch(JSON.stringify(result), /must-not-resolve|untrusted|X-Large/);
});

test("complete chunked framing and CORS observation are retained without approval", async t => {
  const f = await serve(t, socket => socket.end("HTTP/1.1 503 Fixture\r\nTransfer-Encoding: chunked\r\nAccess-Control-Allow-Origin: *\r\n\r\n2\r\nof\r\n1\r\nf\r\n0\r\n\r\n"));
  const result = await collectPartnerNginxTransportObservations(f.options);
  assert.equal(result.probes[0].outcome, "HTTP_RESPONSE"); assert.equal(result.probes[0].bodySha256, hash("off"));
  assert.equal(result.probes[0].bodyBytes, 3); assert.equal(result.probes[0].corsHeaderPresent, true);
  assert.equal(result.probes[0].cacheControl, null); assert.equal(result.productionVerified, false);
});

test("a reachable sidecar is captured as connected, never refused", async t => {
  const f = await serve(t, socket => socket.end(reply()));
  [f.options.sidecarPort, f.options.port] = [f.options.port, f.options.sidecarPort];
  const result = await collectPartnerNginxTransportObservations(f.options);
  const direct = result.probes.find(row => row.id === "directSidecar");
  assert.equal(direct.outcome, "TCP_CONNECTED"); assert.equal(direct.peerPort, f.options.sidecarPort);
  assert.equal(result.probes[0].outcome, "TRANSPORT_ERROR"); // Refused frontdoor != negative TLS proof.
  assert.equal(result.productionVerified, false);
});

test("mutable caller bytes cannot swap client identity during collection", async t => {
  const f = await serve(t, socket => socket.end(reply()));
  const options = Object.fromEntries(Object.entries(f.options).map(([key, value]) => [key, Buffer.isBuffer(value) ? Buffer.from(value) : value]));
  const run = collectPartnerNginxTransportObservations(options);
  options.clientCertificateBytes.fill(0); options.clientKeyBytes.fill(0); options.approvedServerSpkiSha256 = "f".repeat(64);
  const result = await run;
  assert.equal(result.probes[0].outcome, "HTTP_RESPONSE"); assert.equal(result.probes[0].serverSpkiSha256, credentials.approvedServerSpkiSha256);
});

test("each invocation owns a new challenge and never reuses TLS sessions", async t => {
  const f = await serve(t, socket => { assert.equal(socket.isSessionReused(), false); socket.end(reply()); });
  const a = await collectPartnerNginxTransportObservations(f.options), b = await collectPartnerNginxTransportObservations(f.options);
  assert.notEqual(a.challenge, b.challenge); assert.match(a.challenge, /^[a-f0-9]{64}$/);
});

test("absolute monotonic deadline defeats body drip even before its timer callback", async t => {
  let elapsed = 0; const original = performance.now.bind(performance);
  t.mock.method(performance, "now", () => original() + elapsed);
  const f = await serve(t, socket => { elapsed += 5001; socket.end(reply()); });
  const result = await collectPartnerNginxTransportObservations(f.options);
  assert.equal(result.probes[0].outcome, "TIMEOUT"); assert.equal(result.probes[0].complete, false);
  assert.equal(result.probes[0].bodySha256, null); assert.equal(result.productionVerified, false);
});

test("wall clock rollback and total session deadline abort remaining probes", async t => {
  const original = Date.now; let rollback = false;
  t.mock.method(Date, "now", () => original() - (rollback ? 120000 : 0));
  const f = await serve(t, socket => { rollback = true; socket.end(reply()); });
  await assert.rejects(collectPartnerNginxTransportObservations(f.options), /NGINX_PROBE_SESSION_EXPIRED/);
  assert.equal(f.requests.length, 1);
});

test("real body stall ends at absolute deadline and closes the owned socket", async t => {
  let first = true, stalledClosed = false;
  const f = await serve(t, socket => {
    if (first) {
      first = false; socket.once("close", () => { stalledClosed = true; });
      socket.write("HTTP/1.1 503 Fixture\r\nContent-Length: 3\r\n\r\nx");
    } else socket.end(reply());
  });
  const start = performance.now(), result = await collectPartnerNginxTransportObservations(f.options);
  assert.ok(performance.now() - start >= 4900 && performance.now() - start < 10000);
  assert.equal(result.probes[0].outcome, "TIMEOUT"); assert.equal(result.probes[0].bodyBytes, 1);
  assert.equal(result.probes[0].complete, false); assert.equal(stalledClosed, true);
  assert.equal(result.probes.at(-1).outcome, "HTTP_RESPONSE");
});

test("literal target and preconnected TLS socket never consult DNS", async t => {
  const f = await serve(t, socket => socket.end(reply())); let calls = 0;
  t.mock.method(dns, "lookup", () => { calls++; throw new Error("UNEXPECTED_DNS"); });
  const result = await collectPartnerNginxTransportObservations(f.options);
  assert.equal(result.probes[0].outcome, "HTTP_RESPONSE"); assert.equal(calls, 0);
});

test("expired certificates are refused before network IO", async t => {
  let calls = 0; const now = Date.now();
  t.mock.method(Date, "now", () => now + 3 * 86400000);
  t.mock.method(tls, "connect", () => { calls++; });
  await assert.rejects(collectPartnerNginxTransportObservations(input()), /NGINX_PROBE_CERTIFICATE_TIME_INVALID/);
  assert.equal(calls, 0);
});

test("raw setup errors are redacted and cannot become TLS or refusal evidence", async t => {
  t.mock.method(tls, "connect", () => { throw new Error("private-upstream-detail"); });
  t.mock.method(net, "createConnection", () => { throw new Error("private-upstream-detail"); });
  const result = await collectPartnerNginxTransportObservations(input());
  assert.ok(result.probes.every(row => row.outcome === "TRANSPORT_ERROR" && row.errorCode === "CONNECTION_SETUP_FAILED"));
  assert.doesNotMatch(JSON.stringify(result), /private-upstream-detail/);
});

test("real raw guard reaches actual default-off store with public invalid proof, no provider or DB", async t => {
  const registered = new Map();
  registerPartnerNode({ nodes: {
    createNode(node) { const events = new EventEmitter(); node.on = events.on.bind(events); },
    registerType(name, constructor) { registered.set(name, constructor); },
  } });
  const Store = registered.get("padlhub-partner-game-membership-store");
  // Fresh absent name keeps this actual Node-RED store path off without reading
  // or changing a real runtime setting. No env/DB/provider fixture is imported.
  const store = new Store({ enabledEnv: `PARTNER_PROBE_TEST_${crypto.randomUUID().replaceAll("-", "")}` });
  const audit = [], codes = [], sockets = new Set();
  const guard = createPartnerRawRequestGuard({ expectedHost: "fixture.invalid", audit: entry => { audit.push(entry); return true; } });
  const server = https.createServer({ key: credentials.serverKeyBytes, cert: fixture.serverCertificateBytes,
    ca: fixture.caCertificateBytes, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    req.originalUrl = req.url;
    guard(req, res, () => {
      store.handleHttpMessage({ req, payload: req.body }).then(() => assert.fail("Disabled runtime must not accept"), error => {
        codes.push(error.code); res.writeHead(error.httpStatus, { "Cache-Control": "no-store" }); res.end("disabled");
      });
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
  server.on("tlsClientError", () => {});
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const unused = net.createServer();
  await new Promise(resolve => unused.listen(0, "127.0.0.1", resolve));
  const sidecarPort = unused.address().port; await new Promise(resolve => unused.close(resolve));
  const result = await collectPartnerNginxTransportObservations(input(server.address().port, sidecarPort));
  for (const id of ["positiveDefaultOff", "cors"]) {
    const row = result.probes.find(item => item.id === id);
    assert.equal(row.outcome, "HTTP_RESPONSE"); assert.equal(row.httpStatus, 503);
  }
  assert.equal(codes.length, 4); assert.ok(codes.every(code => code === "PARTNER_API_DISABLED"));
  assert.equal(audit.filter(row => row.code === "RAW_ACCEPTED").length, 4);
  assert.equal(audit.filter(row => row.code === "RAW_SECURITY_HEADER_INVALID").length, 0);
  assert.equal(result.productionVerified, false);
});
