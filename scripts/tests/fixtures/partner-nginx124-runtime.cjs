"use strict";
// Two owned containers share an otherwise network:none namespace. These are
// physical local probes; direct external reachability is intentionally NOT proven.
const fs = require("node:fs"), http = require("node:http"), tls = require("node:tls"), net = require("node:net");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const runtimeRequire = createRequire("/runtime/package.json");
const { createGuardedPartnerSettings } = require("/fixture/settings-guarded.cjs");
const { SECURITY_HEADERS } = require("/fixture/raw-request-guard.cjs");
const { completeHttpResponse } = require("/fixture/http-response.cjs");
const { boundaryRow, packedHeaderFixture, ingressDenialRow, concurrencyRow, deadlineTransportResponse, deadlineRow, summarizeNginxRows } = require("/fixture/evidence.cjs");
const route = "/lk/integrations/v1/open-games/fixture-game/members";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const requestHeaders = (body, host = "fixture.invalid", extra = []) => ["Host", host, "Connection", "close", "Content-Length", String(Buffer.byteLength(body)),
  ...SECURITY_HEADERS.flatMap(name => [name, name === "content-type" ? "application/json" : "fixture-value"]), ...extra];
const accessLogs = () => fs.readFileSync("/out/nginx-access.jsonl", "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

async function serve() {
  const RED = runtimeRequire("node-red"), express = runtimeRequire("express");
  const app = express(), state = { received: 0, calls: 0, active: 0, trickleWrites: 0, audits: [], last: null,
    operationsStarted: 0, operationsCompleted: 0, lateHttpOutComplete: 0, lateHttpOutErrors: 0 };
  const operationTimers = new Set();
  const server = http.createServer((req, res) => { state.received++; app(req, res); });
  const flows = [{ id: "tab", type: "tab", label: "nginx-local-only" },
    ...["post", "get", "delete"].map((method, i) => ({ id: `in-${method}`, type: "http in", z: "tab", method, x: 100, y: 100 + i * 60,
      url: method === "get" ? "/lk/integrations/v1/operations/:operationId" : `/lk/integrations/v1/open-games/:gameId/members${method === "delete" ? "/:membershipId" : ""}`,
      skipBodyParsing: false, upload: false, wires: [["observer"]] })),
    { id: "observer", type: "fixture-observer", z: "tab", x: 300, y: 100, wires: [["late-out"]] },
    { id: "late-out", type: "http response", z: "tab", statusCode: "", headers: {}, wires: [] },
    { id: "late-complete", type: "complete", z: "tab", scope: ["late-out"], wires: [["completion-counter"]] },
    { id: "late-catch", type: "catch", z: "tab", scope: ["late-out", "observer"], uncaught: false, wires: [["error-counter"]] },
    { id: "completion-counter", type: "fixture-counter", z: "tab", counter: "lateHttpOutComplete", wires: [] },
    { id: "error-counter", type: "fixture-counter", z: "tab", counter: "lateHttpOutErrors", wires: [] }];
  fs.mkdirSync("/tmp/user", { recursive: true }); fs.writeFileSync("/tmp/user/flows.json", JSON.stringify(flows));
  const audit = event => { state.audits.push(event); return true; };
  const settings = createGuardedPartnerSettings({ expectedHost: "fixture.invalid", flows, audit });
  Object.assign(settings, { userDir: "/tmp/user", flowFile: "flows.json", nodesDir: [], logging: { console: { level: "info" } } });
  RED.init(server, settings);
  RED.nodes.registerType("fixture-counter", function Counter(config) {
    RED.nodes.createNode(this, config);
    this.on("input", (_msg, _send, done) => { state[config.counter]++; done(); });
  });
  RED.nodes.registerType("fixture-observer", function Observer(config) {
    RED.nodes.createNode(this, config);
    this.on("input", msg => {
      state.calls++;
      state.last = { payload: msg.payload, target: msg.req.url, forwarded: msg.req.headers["forwarded"] ?? null,
        xff: msg.req.headers["x-forwarded-for"] ?? null, arbitraryForwardedPresent: msg.req.headers["x-forwarded-fixture"] !== undefined };
      const res = msg.res._res, timers = []; state.active++;
      res.once("close", () => { state.active--; timers.forEach(clearTimeout); });
      const headers = () => res.writeHead(503, { "content-type": "application/json", "cache-control": "public", "access-control-allow-origin": "*" });
      const reply = () => { if (!res.destroyed) { headers(); res.end('{"fixtureOnly":true}'); } };
      if (msg.payload?.fixtureMode === "late") {
        state.operationsStarted++;
        // Models a dispatched operation: response.close must NOT undo it. The
        // real locked Node-RED HTTPOut receives its one late result at 18s.
        const timer = setTimeout(() => {
          operationTimers.delete(timer); state.operationsCompleted++;
          msg.statusCode = 200; msg.headers = { "content-type": "application/json" }; msg.payload = { fixtureOnly: true };
          this.send(msg);
        }, 18000);
        operationTimers.add(timer);
      } else if (msg.payload?.fixtureMode === "trickle") {
        headers(); res.flushHeaders();
        for (let i = 0; i < 10; i++) timers.push(setTimeout(() => {
          if (res.destroyed) return;
          state.trickleWrites++; res.write(i === 0 ? '{"fixtureOnly":true' : " ");
          if (i === 9) res.end("}");
        }, i * 2000));
      } else if (msg.payload?.fixtureMode === "idle") timers.push(setTimeout(reply, 20000));
      else if (msg.payload?.hold === true) timers.push(setTimeout(reply, 4000));
      else reply();
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
  process.on("SIGTERM", async () => { operationTimers.forEach(clearTimeout); await RED.stop(); server.close(); diagnostic.close(); process.exit(0); });
}

const snapshot = () => new Promise((resolve, reject) => {
  const req = http.get("http://127.0.0.1:18895", res => { let bytes = "";
    res.on("data", b => { bytes += b; if (bytes.length > 1e6) req.destroy(new Error("SNAPSHOT_SIZE")); });
    res.on("end", () => { try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
  });
  req.setTimeout(2000, () => req.destroy(new Error("SNAPSHOT_TIMEOUT"))); req.on("error", reject);
});
function request({ method = "POST", target = route, body = "{}", host = "fixture.invalid", sni = "fixture.invalid", client = "client", extra = [], headers, protocol, localAddress = "127.0.0.1", deadlineMs = 4500, alpn = ["http/1.1"], deadlineMode = null } = {}) {
  assert.ok([4500, 8000, 23000].includes(deadlineMs));
  assert.ok(["127.0.0.1", "127.0.0.2"].includes(localAddress));
  assert.ok([null, "trickle", "late"].includes(deadlineMode));
  if (deadlineMode) { assert.equal(body, JSON.stringify({ fixtureMode: deadlineMode })); assert.equal(deadlineMs, 23000); }
  return new Promise((resolve, reject) => {
    const chunks = [], startedAt = performance.now(); let receivedBytes = 0, firstByteMs = null, serverAuthorized = false, negotiatedProtocol = null, alpnProtocol = null, handled = false;
    const observation = () => ({ serverAuthorized, negotiatedProtocol, alpnProtocol, elapsedMs: Math.round(performance.now() - startedAt), firstByteMs, responseChunks: chunks.length });
    const socket = deadlineMode === "late" ? net.connect({ host: "127.0.0.1", port: 18894 }) : tls.connect({ host: "127.0.0.1", port: 8443, localAddress, ...(sni === null ? {} : { servername: sni }),
      ca: fs.readFileSync("/fixture/ca.crt"), ALPNProtocols: alpn,
      ...(protocol ? { minVersion: protocol, maxVersion: protocol } : {}),
      // Negative clients only; never downgrade the generated Nginx server.
      ...(["TLSv1", "TLSv1.1"].includes(protocol) ? { ciphers: "DEFAULT@SECLEVEL=0" } : {}),
      ...(client ? { cert: fs.readFileSync(`/fixture/${client}.crt`), key: fs.readFileSync(`/fixture/${client}.key`) } : {}) });
    const deadline = setTimeout(() => socket.destroy(new Error("FIXTURE_DEADLINE")), deadlineMs);
    socket.once(deadlineMode === "late" ? "connect" : "secureConnect", () => {
      if (deadlineMode !== "late") { serverAuthorized = socket.authorized; negotiatedProtocol = socket.getProtocol(); alpnProtocol = socket.alpnProtocol || null; }
      const all = headers || requestHeaders(body, host, extra);
      socket.write(`${method} ${target} HTTP/1.1\r\n${all.map((v, i) => i % 2 ? `${v}\r\n` : `${v}: `).join("")}\r\n${body}`);
    });
    socket.on("data", b => { firstByteMs ??= Math.round(performance.now() - startedAt); receivedBytes += b.length; if (receivedBytes > 65536) socket.destroy(new Error("FIXTURE_RESPONSE_SIZE")); else chunks.push(b); });
    socket.once("error", error => {
      handled = true; clearTimeout(deadline);
      // Explicit server TLS alert only; a client validation failure, timeout,
      // arbitrary reset or local protocol failure cannot masquerade as refusal.
      if (["ERR_SSL_TLSV1_UNRECOGNIZED_NAME", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION"].includes(error.code)) {
        resolve({ status: null, outcome: "TLS_ALERT_REJECTED", tlsAlertCode: error.code, ...observation() });
      } else reject(new Error(`FIXTURE_TRANSPORT_${error.code || "ERROR"}`));
    });
    socket.once("close", () => {
      clearTimeout(deadline); if (handled) return;
      try {
        const bytes = Buffer.concat(chunks);
        resolve({ ...(deadlineMode ? deadlineTransportResponse(bytes, deadlineMode, completeHttpResponse)
          : { ...completeHttpResponse(bytes, method), outcome: "HTTP_RESPONSE" }), ...observation() });
      }
      catch (error) { reject(error); }
    });
  });
}

async function untilState(predicate) {
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) { const current = await snapshot(); if (predicate(current)) return current; await wait(25); }
  throw new Error("FIXTURE_STATE_BARRIER_TIMEOUT");
}

async function remainingBoundaries(rows) {
  const check = async (name, options, policy) => {
    await wait(550); const before = await snapshot(), response = await request(options);
    const after = await untilState(state => state.active === 0);
    const row = boundaryRow(name, response, before, after, policy); rows.push(row); return row;
  };
  for (const protocol of ["TLSv1", "TLSv1.1"]) await check(`reject-${protocol}`, { protocol }, {
    statuses: [null], dispatch: 0, upstream: 0, tlsAlertCode: "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  });
  await check("absent-sni", { sni: null }, { statuses: [null], dispatch: 0, upstream: 0, tlsAlertCode: "ERR_SSL_TLSV1_UNRECOGNIZED_NAME" });
  await check("source-cidr-denial", { localAddress: "127.0.0.2", extra: ["X-Forwarded-For", "127.0.0.1"] }, { statuses: [403], dispatch: 0, upstream: 0 });

  // Whole wire request line (including CRLF) and individual header field bounds.
  for (const bytes of [2048, 2049]) await check(`request-line-${bytes}`, { target: "/" + "a".repeat(bytes - 17), deadlineMs: 8000 }, { statuses: [bytes === 2048 ? 404 : 414], dispatch: 0, upstream: 0 });
  for (const bytes of [2048, 2049]) await check(`header-field-${bytes}`, { extra: ["X-Fixture-Pad", "a".repeat(bytes - 17)], deadlineMs: 8000 }, {
    statuses: [bytes === 2048 ? 503 : 400], dispatch: bytes === 2048 ? 1 : 0, upstream: bytes === 2048 ? 1 : 0,
  });
  const ingressCheck = async (name, options, wire) => {
    await wait(550); const offset = accessLogs().length, before = await snapshot(), response = await request(options);
    const after = await untilState(state => state.active === 0);
    rows.push(ingressDenialRow(name, response, before, after, accessLogs().slice(offset), wire));
  };
  const oversized = requestHeaders("{}", "fixture.invalid", Array.from({ length: 17 }, (_, i) => [`X-Pad-${i}`, "a".repeat(1000)]).flat());
  const headerSectionBytes = Buffer.byteLength(oversized.map((v, i) => i % 2 ? `${v}\r\n` : `${v}: `).join("") + "\r\n");
  assert.equal(headerSectionBytes, 17562);
  await ingressCheck("aggregate-header-over-16k", { headers: oversized, deadlineMs: 8000 }, { headerSectionBytes });

  for (const method of ["POST", "DELETE", "GET"]) {
    const target = method === "GET" ? `/lk/integrations/v1/operations/${"a".repeat(160)}`
      : method === "DELETE" ? `/lk/integrations/v1/open-games/${"a".repeat(160)}/members/${"b".repeat(160)}` : route;
    const body = method === "GET" ? "" : method === "POST" ? '{"x":"' + "a".repeat(16376) + '"}' : "{}";
    const packed = packedHeaderFixture(method, target, requestHeaders(body), 16384);
    const { headers, ...wire } = packed;
    const row = await check(`packed-head-${method.toLowerCase()}-16384`, { method, target, body, headers, deadlineMs: 8000 }, { statuses: [503], dispatch: 1, upstream: 1 });
    Object.assign(row, wire, { bodyBytes: Buffer.byteLength(body) });
  }
  const { headers: overHeaders, ...overWire } = packedHeaderFixture("POST", route, requestHeaders("{}"), 16385);
  await ingressCheck("packed-head-post-16385", { headers: overHeaders, deadlineMs: 8000 }, overWire);
  const lineBytes = Buffer.byteLength(`POST ${route} HTTP/1.1\r\n`);
  const { headers: sectionHeaders, ...sectionWire } = packedHeaderFixture("POST", route, requestHeaders("{}"), 16385 + lineBytes);
  assert.equal(sectionWire.headerSectionBytes, 16385);
  await ingressCheck("header-section-16385", { headers: sectionHeaders, deadlineMs: 8000 }, sectionWire);
  const base = requestHeaders("{}"), { headers: packed, ...reorderedWire } = packedHeaderFixture("POST", route, base, 16384);
  const pairs = packed.slice(base.length).reduce((all, value, i, list) => i % 2 ? all : [...all, list.slice(i, i + 2)], []);
  // Same byte count, fields and proof, only padding order changes. Large fields
  // waste the initial buffer: an intentional conservative early refusal, not
  // proof that every header section below 16k can be accepted.
  await ingressCheck("packed-head-reordered-16384-denied", { headers: [...base, ...pairs.reverse().flat()], deadlineMs: 8000 }, reorderedWire);

  // Full headers + four actual upstream handlers are held; the fifth must be
  // denied by limit_conn, not by rate limiting or an unprocessed TLS socket.
  await wait(6000);
  const logStart = accessLogs().length, before = await snapshot();
  const pending = Array.from({ length: 4 }, () => request({ body: '{"hold":true}', deadlineMs: 8000 }));
  const settled = Promise.allSettled(pending);
  let held, rejected;
  try { held = await untilState(state => state.active === 4); rejected = await request(); }
  finally { await settled; }
  const responses = (await settled).map(result => { assert.equal(result.status, "fulfilled"); return result.value; });
  const after = await untilState(state => state.active === 0);
  rows.push(concurrencyRow(responses, rejected, before, held, after, accessLogs().slice(logStart)));
  await check("concurrency-slot-recovery", {}, { statuses: [503], dispatch: 1, upstream: 1 });

  // Nginx idle timer and sidecar watchdog can race on silence; this row proves
  // only the combined bound, not which component owned the cutoff.
  await check("upstream-silence-bound-no-retry", { body: '{"fixtureMode":"idle"}', deadlineMs: 23000 }, {
    statuses: [502, 504], dispatch: 1, upstream: 1, minElapsedMs: 14500, maxElapsedMs: 17000,
  });
  const dripBefore = await snapshot();
  const drip = await request({ body: '{"fixtureMode":"trickle"}', deadlineMs: 23000, deadlineMode: "trickle" });
  const dripAfter = await untilState(state => state.active === 0);
  rows.push(deadlineRow("absolute-request-deadline", drip, dripBefore, dripAfter, "trickle"));
  const lateBefore = await snapshot();
  const late = await request({ body: '{"fixtureMode":"late"}', deadlineMs: 23000, deadlineMode: "late" });
  const lateClosed = await untilState(state => state.active === 0);
  const lateRow = deadlineRow("sidecar-late-httpout-after-deadline", late, lateBefore, lateClosed, "late");
  assert.equal(lateClosed.operationsStarted - lateBefore.operationsStarted, 1);
  assert.equal(lateClosed.operationsCompleted - lateBefore.operationsCompleted, 0);
  await wait(3500);
  const lateAfter = await untilState(state => state.lateHttpOutComplete - lateBefore.lateHttpOutComplete === 1);
  assert.equal(lateAfter.operationsStarted - lateBefore.operationsStarted, 1);
  assert.equal(lateAfter.operationsCompleted - lateBefore.operationsCompleted, 1);
  assert.equal(lateAfter.lateHttpOutErrors - lateBefore.lateHttpOutErrors, 0);
  assert.equal(lateAfter.calls - lateBefore.calls, 1); assert.equal(lateAfter.active, 0);
  assert.equal(lateAfter.trickleWrites, dripAfter.trickleWrites);
  assert.deepEqual(lateAfter.audits, lateClosed.audits);
  Object.assign(lateRow, { operationsStarted: 1, operationsCompletedAfterClose: 1, lateHttpOutComplete: 1, lateHttpOutErrors: 0 });
  rows.push(lateRow);
  await check("positive-after-boundaries", {}, { statuses: [503], dispatch: 1, upstream: 1 });
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
    assert.equal(forwarded.after.last.forwarded, null); assert.equal(forwarded.after.last.xff, null);
    const arbitrary = await check("wildcard-forwarded-scrub", { extra: ["X-Forwarded-Fixture", "DO_NOT_LOG_ME"] }, [503], 1);
    assert.equal(arbitrary.after.last.arbitraryForwardedPresent, false);
    await check("duplicate-wildcard-forwarded", { extra: ["X-Forwarded-Fixture", "DO_NOT_LOG_ME", "x-FORWARDED-fixture", "DO_NOT_LOG_ME"] }, [400]);
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
    await remainingBoundaries(rows);
    fs.writeFileSync("/out/nginx-probes.json", JSON.stringify({ state: "LOCAL_NGINX_MATRIX_CHECKED_NOT_PRODUCTION", node: process.version,
      nodeRed: runtimeRequire("node-red/package.json").version, platform: process.platform, architecture: process.arch, rows,
      productionVerified: false, externalDirectSidecarProven: false, sourceLimitsIndependentlyProven: false,
      ...summarizeNginxRows(rows) }, null, 2) + "\n");
  } catch (error) {
    const state = await snapshot().catch(() => null);
    fs.writeFileSync("/out/nginx-probes.json", JSON.stringify({ state: "FAILED", rows, error: error.message,
      fixtureState: state && { received: state.received, calls: state.calls, flowNodeCount: state.flowNodeCount, auditCodes: state.audits.map(a => a.code) } }, null, 2) + "\n"); throw error;
  }
}
(process.argv[2] === "serve" ? serve() : probes()).catch(error => { console.error(error.message); process.exitCode = 1; });
