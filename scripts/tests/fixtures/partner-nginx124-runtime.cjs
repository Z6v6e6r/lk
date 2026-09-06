"use strict";
// Two owned containers share an otherwise network:none namespace. These are
// physical local probes; direct external reachability is intentionally NOT proven.
const fs = require("node:fs"), http = require("node:http"), tls = require("node:tls");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const runtimeRequire = createRequire("/runtime/package.json");
const { createGuardedPartnerSettings } = require("/fixture/settings-guarded.cjs");
const { SECURITY_HEADERS } = require("/fixture/raw-request-guard.cjs");
const { completeHttpResponse } = require("/fixture/http-response.cjs");
const route = "/lk/integrations/v1/open-games/fixture-game/members";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function serve() {
  const RED = runtimeRequire("node-red"), express = runtimeRequire("express");
  const app = express(), state = { received: 0, calls: 0, audits: [], last: null };
  const server = http.createServer((req, res) => { state.received++; app(req, res); });
  const flows = [{ id: "tab", type: "tab", label: "nginx-local-only" },
    ...["post", "get", "delete"].map((method, i) => ({ id: `in-${method}`, type: "http in", z: "tab", method, x: 100, y: 100 + i * 60,
      url: method === "get" ? "/lk/integrations/v1/operations/:operationId" : `/lk/integrations/v1/open-games/:gameId/members${method === "delete" ? "/:membershipId" : ""}`,
      skipBodyParsing: false, upload: false, wires: [["observer"]] })),
    { id: "observer", type: "fixture-observer", z: "tab", x: 300, y: 100, wires: [] }];
  fs.mkdirSync("/tmp/user", { recursive: true }); fs.writeFileSync("/tmp/user/flows.json", JSON.stringify(flows));
  const audit = event => { state.audits.push(event); return true; };
  const settings = createGuardedPartnerSettings({ expectedHost: "fixture.invalid", flows, audit });
  Object.assign(settings, { userDir: "/tmp/user", flowFile: "flows.json", nodesDir: [], logging: { console: { level: "info" } } });
  RED.init(server, settings);
  RED.nodes.registerType("fixture-observer", function Observer(config) {
    RED.nodes.createNode(this, config);
    this.on("input", msg => {
      state.calls++;
      state.last = { payload: msg.payload, target: msg.req.url, forwarded: msg.req.headers["forwarded"] ?? null,
        xff: msg.req.headers["x-forwarded-for"] ?? null, arbitraryForwardedPresent: msg.req.headers["x-forwarded-fixture"] !== undefined };
      const reply = () => { const res = msg.res._res; res.writeHead(503, { "content-type": "application/json", "cache-control": "public", "access-control-allow-origin": "*" }); res.end('{"fixtureOnly":true}'); };
      if (msg.payload?.hold === true) setTimeout(reply, 1500); else reply();
    });
  });
  app.use(RED.httpNode);
  const started = new Promise(resolve => RED.events.once("flows:started", resolve));
  await RED.start(); await started;
  state.flowNodeCount = RED.nodes.getFlows().flows.length;
  for (const flow of flows.filter(node => node.type !== "tab")) assert.ok(RED.nodes.getNode(flow.id), `FIXTURE_NODE_NOT_RUNNING:${flow.id}`);
  await new Promise(resolve => server.listen(18894, "127.0.0.1", resolve));
  const diagnostic = http.createServer((_req, res) => res.end(JSON.stringify(state)));
  await new Promise(resolve => diagnostic.listen(18895, "127.0.0.1", resolve));
  fs.writeFileSync("/tmp/nginx-fixture-ready", "ready");
  process.on("SIGTERM", async () => { await RED.stop(); server.close(); diagnostic.close(); process.exit(0); });
}

const snapshot = () => new Promise((resolve, reject) => {
  const req = http.get("http://127.0.0.1:18895", res => { let bytes = "";
    res.on("data", b => { bytes += b; if (bytes.length > 1e6) req.destroy(new Error("SNAPSHOT_SIZE")); });
    res.on("end", () => { try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
  });
  req.setTimeout(2000, () => req.destroy(new Error("SNAPSHOT_TIMEOUT"))); req.on("error", reject);
});
function request({ method = "POST", target = route, body = "{}", host = "fixture.invalid", sni = "fixture.invalid", client = "client", extra = [], headers, protocol, alpn = ["http/1.1"] } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []; let receivedBytes = 0, serverAuthorized = false, negotiatedProtocol = null, alpnProtocol = null, handled = false;
    const socket = tls.connect({ host: "127.0.0.1", port: 8443, servername: sni,
      ca: fs.readFileSync("/fixture/ca.crt"), ALPNProtocols: alpn,
      ...(protocol ? { minVersion: protocol, maxVersion: protocol } : {}),
      ...(client ? { cert: fs.readFileSync(`/fixture/${client}.crt`), key: fs.readFileSync(`/fixture/${client}.key`) } : {}) });
    const deadline = setTimeout(() => socket.destroy(new Error("FIXTURE_DEADLINE")), 4500);
    socket.once("secureConnect", () => {
      serverAuthorized = socket.authorized; negotiatedProtocol = socket.getProtocol(); alpnProtocol = socket.alpnProtocol || null;
      const all = headers || ["Host", host, "Connection", "close", "Content-Length", String(Buffer.byteLength(body)),
        ...SECURITY_HEADERS.flatMap(name => [name, name === "content-type" ? "application/json" : "fixture-value"]), ...extra];
      socket.write(`${method} ${target} HTTP/1.1\r\n${all.map((v, i) => i % 2 ? `${v}\r\n` : `${v}: `).join("")}\r\n${body}`);
    });
    socket.on("data", b => { receivedBytes += b.length; if (receivedBytes > 65536) socket.destroy(new Error("FIXTURE_RESPONSE_SIZE")); else chunks.push(b); });
    socket.once("error", error => {
      handled = true; clearTimeout(deadline);
      // Explicit server TLS alert only; a client validation failure, timeout,
      // arbitrary reset or local protocol failure cannot masquerade as refusal.
      if (["ERR_SSL_TLSV1_UNRECOGNIZED_NAME", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION"].includes(error.code)) {
        resolve({ status: null, outcome: "TLS_ALERT_REJECTED", serverAuthorized, negotiatedProtocol, alpnProtocol });
      } else reject(new Error(`FIXTURE_TRANSPORT_${error.code || "ERROR"}`));
    });
    socket.once("close", () => {
      clearTimeout(deadline); if (handled) return;
      try { resolve({ ...completeHttpResponse(Buffer.concat(chunks), method), outcome: "HTTP_RESPONSE", serverAuthorized, negotiatedProtocol, alpnProtocol }); }
      catch (error) { reject(error); }
    });
  });
}

async function probes() {
  const rows = [];
  const check = async (name, options, statuses, dispatch = 0) => {
    await wait(550); const before = await snapshot(); const result = await request(options); const after = await snapshot();
    assert.ok(statuses.includes(result.status), `${name}: unexpected status ${result.status}`);
    assert.equal(after.calls - before.calls, dispatch, `${name}: observer dispatch`);
    if (result.outcome === "HTTP_RESPONSE") { assert.equal(result.serverAuthorized, true); assert.equal(result.cors, false); assert.equal(result.noStore, true); }
    if (["no-client", "wrong-ca", "unbound-leaf", "wrong-sni", "shared-host", "shared-sni-bypass"].includes(name)) assert.equal(after.received, before.received, `${name}: no upstream`);
    rows.push({ name, ...result, observerCalls: after.calls - before.calls, upstreamCalls: after.received - before.received, result: "PASS" });
    return { result, after };
  };
  try {
    for (const protocol of ["TLSv1.2", "TLSv1.3"]) {
      const { result } = await check(`positive-${protocol}`, { protocol }, [503], 1); assert.equal(result.negotiatedProtocol, protocol);
    }
    await check("no-client", { client: null }, [400, 403]);
    await check("wrong-ca", { client: "wrong-client" }, [400, 403]);
    await check("unbound-leaf", { client: "other-client" }, [403]);
    await check("wrong-sni", { sni: "wrong.invalid" }, [null]);
    await check("shared-host", { sni: "shared.invalid", host: "shared.invalid", client: null }, [404]);
    await check("shared-sni-bypass", { sni: "shared.invalid", client: null }, [421]);
    await check("wrong-host", { host: "wrong.invalid" }, [421]);
    await check("host-with-port", { host: "fixture.invalid:8443" }, [421]);
    const { result: h1 } = await check("http2-not-negotiated", { alpn: ["h2", "http/1.1"] }, [503], 1); assert.notEqual(h1.alpnProtocol, "h2");
    await check("delete", { method: "DELETE", target: `${route}/fixture-member` }, [503], 1);
    await check("get", { method: "GET", target: "/lk/integrations/v1/operations/fixture-op", body: "" }, [503], 1);
    for (const method of ["OPTIONS", "HEAD", "PUT"]) await check(`method-${method}`, { method }, [404]);
    for (const [name, target] of Object.entries({ query: route + "?x=1", bareQuery: route + "?", encoded: route.replace("fixture-game", "%66ixture-game"), slash: route.replace("open-games", "open-games/"), editor: "/", admin: "/flows" })) {
      await check(name, { target }, [404]);
    }
    for (const header of SECURITY_HEADERS) for (const uppercase of [false, true]) {
      await check(`duplicate-${header}-${uppercase}`, { extra: [uppercase ? header.toUpperCase() : header, header === "content-type" ? "application/json" : "fixture-value"] }, [400]);
    }
    await check("duplicate-json", { body: '{"a":1,"a":2}' }, [400]);
    await check("escaped-duplicate-json", { body: '{"a":1,"\\u0061":2}' }, [400]);
    await check("body-16384", { body: '{"x":"' + "a".repeat(16376) + '"}' }, [503], 1);
    await check("body-16385", { body: '{"x":"' + "a".repeat(16377) + '"}' }, [413]);
    const forwarded = await check("known-forwarded-scrub", { extra: ["Forwarded", "for=DO_NOT_LOG_ME", "X-Forwarded-For", "DO_NOT_LOG_ME"] }, [503], 1);
    assert.equal(forwarded.after.last.forwarded, null); assert.equal(forwarded.after.last.xff, "127.0.0.1");
    const arbitrary = await check("wildcard-forwarded-open-control", { extra: ["X-Forwarded-Fixture", "DO_NOT_LOG_ME"] }, [503], 1);
    assert.equal(arbitrary.after.last.arbitraryForwardedPresent, true); rows.at(-1).result = "KNOWN_BLOCKER_CONFIRMED";
    await wait(6000);
    const beforeRate = await snapshot(); const rate = [];
    for (let i = 0; i < 20; i++) rate.push(await request());
    const afterRate = await snapshot();
    assert.ok(rate.some(r => r.status === 429)); assert.ok(rate.some(r => r.status === 503));
    assert.ok(rate.every(r => [429, 503].includes(r.status)));
    assert.equal(afterRate.calls - beforeRate.calls, rate.filter(r => r.status === 503).length);
    rows.push({ name: "client-rate", result: "PASS", accepted: rate.filter(r => r.status === 503).length, rejected: rate.filter(r => r.status === 429).length });
    await wait(6000);
    await check("positive-after-negatives", {}, [503], 1);
    fs.writeFileSync("/out/nginx-probes.json", JSON.stringify({ state: "LOCAL_NGINX_MATRIX_CHECKED_NOT_PRODUCTION", node: process.version,
      nodeRed: runtimeRequire("node-red/package.json").version, platform: process.platform, architecture: process.arch, rows,
      productionVerified: false, externalDirectSidecarProven: false, sourceLimitsIndependentlyProven: false,
      notTested: ["TLS_BELOW_1_2", "ABSENT_SNI", "CLIENT_CONCURRENCY", "SOURCE_CIDR_DENIAL", "REQUEST_LINE_AND_HEADER_LIMITS", "UPSTREAM_IDLE_TIMEOUT_AND_NO_RETRY", "ABSOLUTE_REQUEST_DEADLINE"] }, null, 2) + "\n");
  } catch (error) {
    const state = await snapshot().catch(() => null);
    fs.writeFileSync("/out/nginx-probes.json", JSON.stringify({ state: "FAILED", rows, error: error.message,
      fixtureState: state && { received: state.received, calls: state.calls, flowNodeCount: state.flowNodeCount, auditCodes: state.audits.map(a => a.code) } }, null, 2) + "\n"); throw error;
  }
}
(process.argv[2] === "serve" ? serve() : probes()).catch(error => { console.error(error.message); process.exitCode = 1; });
