"use strict";

// Local fixture only. No Partner business node, provider, Mongo, HMAC keys or
// production environment. Actual locked HTTP In -> observer proves parser order.
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const runtimeRequire = createRequire("/runtime/package.json");
const { createGuardedPartnerSettings } = require("/fixture/settings-guarded.cjs");
const { SECURITY_HEADERS } = require("/fixture/raw-request-guard.cjs");
const { withoutContinue, completeResponseBeforeReset } = require("/fixture/http-fixture.cjs");

const fixtureHost = "fixture.invalid";
const route = "/lk/integrations/v1/open-games/fixture-game/members";
const baseHeaders = (body, method = "POST") => ["Host", fixtureHost, "Connection", "close",
  ...(method === "GET" ? [] : ["Content-Length", String(Buffer.byteLength(body))]),
  ...SECURITY_HEADERS.flatMap((key) => [key, key === "content-type" ? "application/json" : "fixture-value"])];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serve() {
  const RED = runtimeRequire("node-red");
  const express = runtimeRequire("express");
  const state = { calls: 0, audits: [], payload: null, sameObject: false, flowPreflightFailures: 0 };
  const app = express();
  const server = http.createServer(app);
  fs.mkdirSync("/tmp/guard-user", { recursive: true });
  const flows = [{ id: "tab-fixture", type: "tab", label: "isolated-raw-guard-only" },
    ...["post", "delete", "get"].map((method) => ({ id: `in-${method}`, z: "tab-fixture", type: "http in", method,
      url: method === "get" ? "/lk/integrations/v1/operations/:operationId"
        : `/lk/integrations/v1/open-games/:gameId/members${method === "delete" ? "/:membershipId" : ""}`,
      skipBodyParsing: false, upload: false, wires: [["observe"]] })),
    { id: "observe", z: "tab-fixture", type: "guard-fixture-observer", wires: [] }];
  fs.writeFileSync("/tmp/guard-user/flows.json", JSON.stringify(flows));
  const auditFd = fs.openSync("/out/guard-audit.jsonl", "ax", 0o600);
  const audit = (event) => {
    fs.writeSync(auditFd, JSON.stringify(event) + "\n");
    fs.fsyncSync(auditFd);
    state.audits.push(event);
    return true;
  };
  for (const method of ["post", "delete", "get"]) {
    const bad = flows.map((node) => node.id === `in-${method}` ? { ...node, skipBodyParsing: true } : node);
    assert.throws(() => createGuardedPartnerSettings({ expectedHost: fixtureHost, audit, flows: bad }), /RAW_GUARD_FLOW_CONFIGURATION_INVALID/);
    state.flowPreflightFailures++;
  }
  const settings = createGuardedPartnerSettings({ expectedHost: fixtureHost, bodyTimeoutMs: 200, flows, audit });
  Object.assign(settings, { userDir: "/tmp/guard-user", flowFile: "flows.json", nodesDir: [],
    logging: { console: { level: "off" } }, editorTheme: { projects: { enabled: false } } });
  RED.init(server, settings);
  RED.nodes.registerType("guard-fixture-observer", function Observer(config) {
    RED.nodes.createNode(this, config);
    this.on("input", (msg) => {
      state.calls++;
      state.payload = msg.payload;
      state.sameObject = msg.req.method === "GET" ? Object.keys(msg.payload).length === 0 : msg.payload === msg.req.body;
      const res = msg.res._res;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ fixtureOnly: true, payload: msg.payload }));
    });
  });
  app.use(RED.httpNode);
  const started = new Promise((resolve) => RED.events.once("flows:started", resolve));
  await RED.start();
  await started;
  await new Promise((resolve) => server.listen(18894, "127.0.0.1", resolve));
  const diagnostic = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state));
  });
  await new Promise((resolve) => diagnostic.listen(18895, "127.0.0.1", resolve));
  fs.writeFileSync("/tmp/guard-ready", "ready");
  process.on("SIGTERM", async () => { await RED.stop(); server.close(); diagnostic.close(); fs.closeSync(auditFd); process.exit(0); });
}

const snapshot = () => new Promise((resolve, reject) => {
  http.get("http://127.0.0.1:18895", (res) => {
    let body = "";
    res.on("data", (data) => { body += data; });
    res.on("end", () => resolve(JSON.parse(body)));
  }).on("error", reject);
});

function send({ body = "{}", headers, method = "POST", target = route, direct = false, cert = true, slow = false, abort = false } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let output = "";
    let resetAfterResponse = false;
    const socket = direct ? net.connect({ host: "127.0.0.1", port: 18894 }) : tls.connect({ host: "127.0.0.1", port: 8443,
      servername: fixtureHost, ca: fs.readFileSync("/fixture/ca.crt"),
      ...(cert ? { cert: fs.readFileSync("/fixture/client.crt"), key: fs.readFileSync("/fixture/client.key") } : {}),
      ALPNProtocols: ["http/1.1"] });
    socket.setTimeout(3500, () => socket.destroy(new Error("FIXTURE_NETWORK_TIMEOUT")));
    socket.once(direct ? "connect" : "secureConnect", () => {
      const list = headers || baseHeaders(body, method);
      const head = `${method} ${target} HTTP/1.1\r\n${list.reduce((lines, item, i) => i % 2 ? `${lines}${item}\r\n` : `${lines}${item}: `, "")}\r\n`;
      socket.write(head);
      if (abort) { socket.write("{"); setTimeout(() => socket.destroy(), 25); }
      else if (!slow) socket.write(body);
    });
    socket.on("data", (bytes) => { output += bytes.toString("utf8"); });
    socket.once("error", (error) => {
      // An early 413 closes without draining the oversized body. A subsequent
      // reset is acceptable ONLY after a complete length-framed HTTP response;
      // a bare reset/timeout/partial response is never a rejection proof.
      if (error.code === "ECONNRESET" && completeResponseBeforeReset(output)) resetAfterResponse = true;
      else reject(error);
    });
    socket.once("close", () => {
      output = withoutContinue(output);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(output)?.[1]) || null;
      resolve({ status, output, elapsedMs: Date.now() - start, resetAfterResponse });
    });
  });
}

async function probes() {
  const rows = [];
  async function check(name, options, expected, expectedPayload) {
    const before = await snapshot();
    const response = await send(options);
    await delay(10);
    const after = await snapshot();
    const calls = after.calls - before.calls;
    const audit = after.audits.slice(before.audits.length);
    assert.equal(calls, expected === "accept" ? 1 : 0, `${name}: observer calls`);
    if (expected === "accept") {
      assert.equal(response.status, 200, `${name}: positive control`);
      assert.deepEqual(after.payload, expectedPayload);
      assert.equal(after.sameObject, true);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].code, "RAW_ACCEPTED");
    } else if (expected === "abort") {
      assert.equal(audit.length, 1, `${name}: abort audit`);
      assert.equal(audit[0].code, "RAW_BODY_ABORTED");
    } else {
      assert.ok([400, 408, 413, 414, 431].includes(response.status), `${name}: unexpected response ${response.status}`);
      assert.match(response.output, /cache-control: no-store/i, `${name}: no-store`);
      assert.doesNotMatch(response.output, /access-control-allow-/i);
      assert.ok(audit.every((event) => event.code !== "RAW_ACCEPTED"), `${name}: must not pass guard`);
    }
    for (const event of audit) {
      assert.deepEqual(Object.keys(event), ["stage", "code", "requestId"]);
      assert.doesNotMatch(JSON.stringify(event), /fixture-value|fixture-game|DO_NOT_LOG_ME/);
    }
    rows.push({ name, status: response.status, observerCalls: calls, guardCodes: audit.map((event) => event.code), resetAfterResponse: response.resetAfterResponse,
      layer: audit.length ? "NODE_RED_RAW_GUARD" : "NGINX_OR_HTTP_PARSER", result: "PASS" });
  }
  try {
    for (const direct of [true, false]) {
      const prefix = direct ? "direct" : "nginx";
      const body = ' {"z":[{"x":1},{"x":2}], "a":"é"} ';
      await check(`${prefix}:post-object-preserved`, { direct, body }, "accept", JSON.parse(body));
      await check(`${prefix}:delete-empty`, { direct, method: "DELETE", target: `${route}/fixture-member` }, "accept", {});
      await check(`${prefix}:get-empty`, { direct, method: "GET", body: "", target: "/lk/integrations/v1/operations/fixture-op" }, "accept", {});
      for (const header of SECURITY_HEADERS) {
        for (const mixed of [false, true]) for (const same of [false, true]) {
          const value = header === "content-type" ? "application/json" : "fixture-value";
          await check(`${prefix}:duplicate:${header}:${mixed}:${same}`,
            { direct, headers: [...baseHeaders("{}"), mixed ? header.toUpperCase() : header, same ? value : "different-value"] }, "reject");
        }
        const headers = baseHeaders("{}");
        headers[headers.indexOf(header) + 1] += ",fixture-value";
        await check(`${prefix}:comma:${header}`, { direct, headers }, "reject");
      }
      for (const [name, json] of Object.entries({ duplicate: '{"DO_NOT_LOG_ME":1,"DO_NOT_LOG_ME":2}',
        escaped: '{"a":1,"\\u0061":2}', nested: '{"a":[{"é":1,"\\u00e9":2}]}',
        surrogate: '{"😀":1,"\\ud83d\\ude00":2}', invalid: '{"x":}', bom: '\uFEFF{}',
        scalar: 'null', depth: '{"x":' + '['.repeat(34) + '0' + ']'.repeat(34) + '}' })) {
        await check(`${prefix}:json:${name}`, { direct, body: json }, "reject");
      }
      const boundary = '{"x":"' + 'é'.repeat(8188) + '"}';
      await check(`${prefix}:16384-bytes`, { direct, body: boundary }, "accept", JSON.parse(boundary));
      await check(`${prefix}:16385-bytes`, { direct, body: boundary + " " }, "reject");
      await check(`${prefix}:query`, { direct, target: `${route}?x=1` }, "reject");
      await check(`${prefix}:body-deadline`, { direct, slow: true }, "reject");
      for (const [header, value] of [["Content-Encoding","gzip"],["Trailer","x"],["Expect","100-continue"],["Connection","x-padlhub-nonce"]]) {
        const headers = baseHeaders("{}");
        if (header === "Connection") headers[headers.indexOf(header) + 1] = value;
        else headers.push(header, value);
        await check(`${prefix}:framing:${header}`, { direct, headers }, "reject");
      }
    }
    // Parser-level rejection is not attributed to middleware. Nginx adds no-store.
    for (const value of ["2", "3"]) await check(`nginx:duplicate-content-length:${value}`, { headers: [...baseHeaders("{}"), "Content-Length", value] }, "reject");
    await check("nginx:duplicate-host", { headers: [...baseHeaders("{}"), "Host", fixtureHost] }, "reject");
    await check("nginx:CL-plus-TE", { headers: [...baseHeaders("{}"), "Transfer-Encoding", "chunked"] }, "reject");
    await check("nginx:chunked-without-CL", { body: "2\r\n{}\r\n0\r\n\r\n", headers: baseHeaders("{}").filter((_, i) => i !== 4 && i !== 5).concat(["Transfer-Encoding", "chunked"]) }, "reject");
    await check("nginx:no-client-certificate", { cert: false }, "reject");
    await check("direct:client-abort", { direct: true, abort: true }, "abort");
    const httpInSource = fs.readFileSync(runtimeRequire.resolve("@node-red/nodes/core/network/21-httpin.js"));
    const result = { state: "LOCAL_RAW_GUARD_REHEARSAL_PASS_NOT_PRODUCTION", node: process.version,
      nodeRed: runtimeRequire("node-red/package.json").version, platform: process.platform, architecture: process.arch,
      httpInSourceSha256: crypto.createHash("sha256").update(httpInSource).digest("hex"),
      protocol: "HTTP/1.1", http2Tested: false, businessProviderTested: false, productionVerified: false,
      flowPreflightFailures: (await snapshot()).flowPreflightFailures, rows };
    fs.writeFileSync("/out/probes.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ state: result.state, passed: rows.length, node: result.node, nodeRed: result.nodeRed }));
  } catch (error) {
    fs.writeFileSync("/out/probes.json", JSON.stringify({ state: "FAILED", rows, error: error.message }, null, 2) + "\n");
    throw error;
  }
}

(process.argv[2] === "serve" ? serve() : probes()).catch((error) => { console.error(error.message); process.exitCode = 1; });
