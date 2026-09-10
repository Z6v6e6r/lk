import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import guardModule from "../partner_game_membership_sidecar/raw-request-guard.cjs";
import auditModule from "../partner_game_membership_sidecar/raw-audit.cjs";
import settingsModule from "../partner_game_membership_sidecar/settings-guarded.cjs";
import baseline from "../partner_game_membership_sidecar/settings.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import httpFixture from "./fixtures/partner-raw-guard-http.cjs";

const { parsePartnerRawJson: parse, createPartnerRawRequestGuard: create, SECURITY_HEADERS } = guardModule;
const host = "fixture.invalid";
const baseHeaders = (body = "{}") => ["Host", host, "Content-Length", String(Buffer.byteLength(body)),
  ...SECURITY_HEADERS.flatMap((name) => [name, name === "content-type" ? "application/json" : "fixture-value"])];
const call = async ({ body = "{}", method = "POST", url, headers, mutate, action, audit, holdResponse = false, requestTimeoutMs = 15000 } = {}) => {
  const req = new PassThrough();
  req.method = method;
  req.originalUrl = req.url = url || (method === "GET" ? "/lk/integrations/v1/operations/fixture-op"
    : `/lk/integrations/v1/open-games/fixture-game/members${method === "DELETE" ? "/fixture-member" : ""}`);
  req.rawHeaders = headers || baseHeaders(body);
  req.headers = {};
  req.headersDistinct = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase(), value = req.rawHeaders[i + 1];
    req.headers[name] = Object.hasOwn(req.headers, name) ? `${req.headers[name]}, ${value}` : value;
    (req.headersDistinct[name] ||= []).push(value);
  }
  req.complete = true;
  req.trailers = {};
  const events = [];
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  let nextCount = 0;
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  res.destroy = () => { res.destroyed = true; res.emit("close"); resolve(); };
  res.end = (bytes, callback) => { res.result = JSON.parse(bytes); res.emit("finish"); callback?.(); resolve(); };
  mutate?.(req, res);
  create({ expectedHost: host, bodyTimeoutMs: 20, requestTimeoutMs, audit: audit || ((e) => { events.push(e); return true; }) })(req, res, () => {
    nextCount++; if (!holdResponse) res.emit("finish"); resolve();
  });
  if (action) action(req, res);
  else if (!req.destroyed) req.end(body);
  await done;
  return { req, res, events, nextCount };
};
const denied = (out, code) => {
  assert.equal(out.nextCount, 0);
  assert.equal(out.res.result.error, code);
  assert.equal(out.res.headers["cache-control"], "no-store");
  assert.equal(out.res.headers.connection, "close");
  assert.equal(out.res.headers["access-control-allow-origin"], undefined);
  assert.equal(out.req.listenerCount("data"), 0);
  assert.equal(out.req.listenerCount("end"), 0);
};

test("raw JSON preserves non-canonical whitespace/key order and safe object semantics", () => {
  const source = ' { "z": [{"a":1},{"a":2}], "a": "é", "__proto__": {"polluted":true}, "constructor": 1 } ';
  const result = parse(Buffer.from(source));
  assert.deepEqual(result, JSON.parse(source));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal({}.polluted, undefined);
});
for (const [name, source] of Object.entries({
  root: '{"x":1,"x":2}', nested: '{"x":[{"a":1,"a":2}]}',
  escape: '{"a":1,"\\u0061":2}', unicode: '{"é":1,"\\u00e9":2}',
  surrogate: '{"😀":1,"\\ud83d\\ude00":2}', proto: '{"__proto__":1,"__proto__":2}',
})) test(`duplicate decoded JSON key: ${name}`, () => assert.throws(() => parse(Buffer.from(source)), /RAW_JSON_DUPLICATE_KEY/));
for (const source of ['{"a":}', '{"x":1,}', '{"x":"\\q"}', '{"x":"\\uZZZZ"}', '{"x":"\n"}', '{}{}', '\uFEFF{}', '{"x":01}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e}', '{"x":tru}', '{"x":[1,]}']) {
  test(`malformed JSON is redacted: ${JSON.stringify(source)}`, () => assert.throws(() => parse(Buffer.from(source)), /^Error: RAW_JSON_INVALID$/));
}
test("reject invalid UTF-8", () => assert.throws(() => parse(Buffer.from([123,34,120,34,58,34,0xc0,0x80,34,125])), /RAW_JSON_INVALID/));
for (const source of ['null', '[]', '1', 'true', '"x"']) test(`reject non-object root ${source}`, () => assert.throws(() => parse(Buffer.from(source)), /RAW_JSON_OBJECT_REQUIRED/));
test("bounded bytes, nesting and tokens", () => {
  assert.throws(() => parse(Buffer.alloc(0)), /RAW_BODY_SIZE/);
  assert.throws(() => parse(Buffer.alloc(16385)), /RAW_BODY_SIZE/);
  assert.throws(() => parse(Buffer.from('{"x":' + '['.repeat(34) + '0' + ']'.repeat(34) + '}')), /RAW_JSON_COMPLEXITY/);
  assert.throws(() => parse(Buffer.from('{"x":[' + Array(4100).fill('0').join(',') + ']}')), /RAW_JSON_COMPLEXITY/);
});
test("middleware preserves parsed payload and marks body-parser complete exactly once", async () => {
  const body = '{ "b": 2, "a": [{"z":"é"}] }';
  const out = await call({ body });
  assert.equal(out.nextCount, 1);
  assert.deepEqual(out.req.body, JSON.parse(body));
  assert.equal(out.req._body, true);
  assert.equal(out.req.skipRawBodyParser, undefined);
  assert.equal(out.req.listenerCount("data"), 0);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].code, "RAW_ACCEPTED");
  assert.deepEqual(Object.keys(out.events[0]), ["stage", "code", "requestId"]);
});
test("DELETE empty object and bodyless GET", async () => {
  assert.equal((await call({ method: "DELETE" })).nextCount, 1);
  const out = await call({ method: "GET", body: "" });
  assert.equal(out.nextCount, 1);
  assert.deepEqual(out.req.body, {});
  denied(await call({ method: "DELETE", body: '{"x":1}' }), "RAW_DELETE_BODY_INVALID");
  denied(await call({ method: "GET" }), "RAW_FRAMING_INVALID");
});

test("forwarding scrub removes arbitrary mixed-case names from every view without changing proof/body/route", async () => {
  for (const method of ["POST", "DELETE", "GET"]) {
    const body = method === "GET" ? "" : "{}", raw = baseHeaders(body);
    const names = ["Forwarded", "X-Forwarded-For", "x-FoRwArDeD-Fixture", "X-Forwarded-", "X-Real-IP"];
    const out = await call({ method, body, headers: [...raw, ...names.flatMap(name => [name, "DO_NOT_LOG_ME"])] });
    assert.equal(out.nextCount, 1);
    assert.deepEqual(out.req.rawHeaders, raw);
    for (const name of names) {
      assert.equal(out.req.headers[name.toLowerCase()], undefined);
      assert.equal(out.req.headersDistinct[name.toLowerCase()], undefined);
    }
    for (const name of SECURITY_HEADERS) {
      const value = name === "content-type" ? "application/json" : "fixture-value";
      assert.equal(out.req.headers[name], value);
      assert.deepEqual(out.req.headersDistinct[name], [value]);
    }
    assert.equal(out.req.url, out.req.originalUrl);
    assert.deepEqual(out.req.body, {});
    assert.doesNotMatch(JSON.stringify([out.events, out.res.result]), /DO_NOT_LOG_ME/);
  }
});

test("duplicates cannot be hidden by removing forwarding headers", async () => {
  for (const name of ["Forwarded", "X-Forwarded-Fixture", ...SECURITY_HEADERS]) {
    const headers = [...baseHeaders(), "X-Forwarded-Other", "DO_NOT_LOG_ME"];
    if (!SECURITY_HEADERS.includes(name)) headers.push(name, "DO_NOT_LOG_ME");
    headers.push(name.toUpperCase(), "DO_NOT_LOG_ME");
    const out = await call({ headers });
    denied(out, "RAW_HEADER_DUPLICATE");
    assert.deepEqual(out.req.rawHeaders, headers); // validation precedes mutation
    assert.doesNotMatch(JSON.stringify([out.events, out.res.result]), /DO_NOT_LOG_ME/);
  }
});

test("unmodifiable or missing header views fail closed before body/parser/dispatch", async () => {
  for (const field of ["headers", "headersDistinct"]) {
    const out = await call({ headers: [...baseHeaders(), "X-Forwarded-Fixture", "DO_NOT_LOG_ME"],
      mutate: req => Object.freeze(req[field]) });
    denied(out, "RAW_FORWARDING_SANITIZATION_FAILED");
  }
  denied(await call({ mutate: req => { delete req.headersDistinct; } }), "RAW_FORWARDING_SANITIZATION_FAILED");
  denied(await call({ mutate: req => Object.defineProperty(req, "rawHeaders", { writable: false }) }), "RAW_FORWARDING_SANITIZATION_FAILED");
});

test("real durable audit records sanitizer failure without poisoning later requests or restart", async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-forwarding-audit-"));
  fs.chmodSync(directory, 0o700);
  let sink;
  try {
    sink = auditModule.openPartnerRawAudit({ directory });
    const failed = await call({ headers: [...baseHeaders(), "X-Forwarded-Fixture", "DO_NOT_LOG_ME"],
      mutate: req => Object.freeze(req.headers), audit: sink.write });
    denied(failed, "RAW_FORWARDING_SANITIZATION_FAILED");
    assert.equal(failed.res.statusCode, 400);
    assert.equal((await call({ audit: sink.write })).nextCount, 1);
    sink.close();
    sink = auditModule.openPartnerRawAudit({ directory });
    assert.equal((await call({ audit: sink.write })).nextCount, 1);
    const bytes = fs.readFileSync(path.join(directory, "raw-requests.audit.jsonl"), "utf8");
    const rows = bytes.trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map(row => row.code), ["RAW_FORWARDING_SANITIZATION_FAILED", "RAW_ACCEPTED", "RAW_ACCEPTED"]);
    assert.doesNotMatch(bytes, /DO_NOT_LOG_ME|fixture-value|X-Forwarded/);
  } finally {
    sink?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
for (const header of [...SECURITY_HEADERS, "host", "content-length"]) {
  test(`raw duplicate ${header} case-insensitive`, async () => denied(await call({ headers: [...baseHeaders(), header.toUpperCase(), "fixture-value"] }), "RAW_HEADER_DUPLICATE"));
}
for (const header of SECURITY_HEADERS) test(`comma-joined ${header}`, async () => {
  const headers = baseHeaders();
  const i = headers.findIndex((v) => v === header);
  headers[i + 1] += ",fixture-value";
  denied(await call({ headers }), "RAW_SECURITY_HEADER_INVALID");
});
for (const [header, value] of [["Transfer-Encoding","chunked"],["Content-Encoding","gzip"],["Trailer","x"],["Expect","100-continue"],["Connection","x-padlhub-nonce"],["Upgrade","websocket"],["Proxy-Connection","close"]]) {
  test(`ambiguous framing ${header}`, async () => denied(await call({ headers: [...baseHeaders(),header,value] }), "RAW_FRAMING_INVALID"));
}
for (const length of ["0", "02", "-2", "+2", "999999999999999999"]) test(`invalid length ${length}`, async () => {
  const headers = baseHeaders(); headers[3] = length;
  denied(await call({ headers }), "RAW_FRAMING_INVALID");
});
test("exact 16KiB byte boundary, not character count", async () => {
  const body = '{"x":"' + 'é'.repeat(8188) + '"}';
  assert.equal(Buffer.byteLength(body), 16384);
  assert.equal((await call({ body })).nextCount, 1);
  denied(await call({ body: body + " " }), "RAW_BODY_SIZE");
});
for (const path of ["/lk/integrations/v1/open-games/g/members?x=1", "/lk/integrations/v1/open-games/g/members/", "/lk/integrations/v1/open-games/g%2f/members", "/lk/integrations/v1/open-games/g/members#x", "/other"]) {
  test(`exact request target ${path}`, async () => denied(await call({ url: path }), "RAW_ROUTE_INVALID"));
}
for (const field of ["body", "_body", "skipRawBodyParser", "readableEnded", "readableDidRead", "readableFlowing", "readableEncoding"]) {
  test(`fail closed for earlier parser: ${field}`, async () => denied(await call({ mutate: (req) => Object.defineProperty(req, field, { value: true }) }), "RAW_GUARD_ORDER_INVALID"));
}
test("duplicate JSON rejection is before next and redacted", async () => {
  const out = await call({ body: '{"DO_NOT_LOG_ME":1,"DO_NOT_LOG_ME":2}' });
  denied(out, "RAW_JSON_DUPLICATE_KEY");
  assert.doesNotMatch(JSON.stringify([out.events, out.res.result]), /DO_NOT_LOG_ME|fixture-value|fixture-game/);
});
test("unexpected error messages never reach response or audit", async () => {
  const out = await call({ mutate: (req) => Object.defineProperty(req, "originalUrl", { get: () => { throw new Error("DO_NOT_LOG_ME"); } }) });
  denied(out, "RAW_GUARD_INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify([out.events, out.res.result]), /DO_NOT_LOG_ME/);
});
test("absolute read deadline before first byte and between bytes", async () => {
  denied(await call({ action: () => {} }), "RAW_BODY_TIMEOUT");
  denied(await call({ action: (req) => req.write("{") }), "RAW_BODY_TIMEOUT");
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test("early timer wakeup re-arms the original monotonic deadline without early cutoff", async context => {
  const realTimeout = global.setTimeout;
  let early;
  context.mock.method(global, "setTimeout", (callback, delay, ...args) => {
    if (!early) { early = callback; return { unref() {} }; }
    return realTimeout(callback, delay, ...args);
  });
  const out = await call({ holdResponse: true, requestTimeoutMs: 60 });
  early();
  assert.equal(out.res.destroyed, undefined);
  assert.deepEqual(out.events.map(e => e.code), ["RAW_ACCEPTED"]);
  await wait(85);
  assert.equal(out.res.destroyed, true);
  assert.deepEqual(out.events.map(e => e.code), ["RAW_ACCEPTED", "RAW_REQUEST_DEADLINE"]);
});
test("response watchdog survives dispatch and request close, cuts transport exactly once", async () => {
  const out = await call({ holdResponse: true, requestTimeoutMs: 40 });
  out.req.emit("close");
  out.res.headersSent = true; // a drip cannot renew the absolute response budget
  await wait(70);
  assert.equal(out.nextCount, 1);
  assert.equal(out.res.destroyed, true);
  assert.equal(out.res.result, undefined); // no synthetic HTTP error after dispatch
  assert.deepEqual(out.events.map(e => e.code), ["RAW_ACCEPTED", "RAW_REQUEST_DEADLINE"]);
  assert.equal(out.events[0].requestId, out.events[1].requestId);
  assert.equal(out.res.listenerCount("close"), 0);
  assert.equal(out.res.listenerCount("finish"), 0);
  out.res.emit("close"); out.res.emit("finish");
  await wait(20);
  assert.equal(out.events.length, 2);
});
test("normal finish, early client close and body rejection clear watchdog without a late audit", async () => {
  for (const terminal of ["finish", "close"]) {
    const out = await call({ holdResponse: true, requestTimeoutMs: 40 });
    out.res.emit(terminal);
    await wait(60);
    assert.deepEqual(out.events.map(e => e.code), ["RAW_ACCEPTED"]);
    assert.equal(out.res.destroyed, undefined);
    assert.equal(out.res.listenerCount("finish"), 0);
    assert.equal(out.res.listenerCount("close"), 0);
  }
  for (const options of [{ body: '{"x":}' }, { action: () => {} }]) {
    const out = await call({ ...options, requestTimeoutMs: 40 });
    await wait(60);
    assert.equal(out.events.length, 1);
    assert.equal(out.events.some(e => e.code === "RAW_REQUEST_DEADLINE"), false);
    assert.equal(out.res.listenerCount("finish"), 0);
  }
});
test("monotonic budget is checked after synchronous audit before dispatch", async () => {
  const events = [];
  const out = await call({ requestTimeoutMs: 20, audit: event => {
    events.push(event);
    if (event.code === "RAW_ACCEPTED") { const until = performance.now() + 30; while (performance.now() < until) { /* bounded synchronous sink stall */ } }
    return true;
  } });
  assert.equal(out.nextCount, 0);
  assert.equal(out.res.destroyed, true);
  assert.deepEqual(events.map(e => e.code), ["RAW_ACCEPTED", "RAW_REQUEST_DEADLINE"]);
  assert.equal(events[0].requestId, events[1].requestId);
});
test("deadline audit failure cannot retain the connection or emit a second response", async () => {
  for (const failure of [() => false, () => { throw new Error("DO_NOT_LOG_ME"); }, () => Promise.reject(new Error("DO_NOT_LOG_ME"))]) {
    let attempts = 0;
    const out = await call({ holdResponse: true, requestTimeoutMs: 30, audit: event => {
      if (event.code === "RAW_REQUEST_DEADLINE") { attempts++; return failure(); }
      return true;
    } });
    await wait(50);
    assert.equal(out.res.destroyed, true);
    assert.equal(out.res.result, undefined);
    assert.equal(attempts, 1);
    assert.equal(out.nextCount, 1);
  }
});
test("real durable sink accepts deadline, later request and reopen without poisoning audit", async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-deadline-audit-"));
  fs.chmodSync(directory, 0o700);
  let sink;
  try {
    sink = auditModule.openPartnerRawAudit({ directory });
    const out = await call({ holdResponse: true, requestTimeoutMs: 30, audit: sink.write });
    await wait(50);
    assert.equal(out.res.destroyed, true);
    assert.equal((await call({ audit: sink.write })).nextCount, 1);
    sink.close(); sink = auditModule.openPartnerRawAudit({ directory });
    assert.equal((await call({ audit: sink.write })).nextCount, 1);
    const bytes = fs.readFileSync(path.join(directory, "raw-requests.audit.jsonl"), "utf8");
    const rows = bytes.trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map(row => row.code), ["RAW_ACCEPTED", "RAW_REQUEST_DEADLINE", "RAW_ACCEPTED", "RAW_ACCEPTED"]);
    assert.equal(rows[0].requestId, rows[1].requestId);
    assert.doesNotMatch(bytes, /DO_NOT_LOG_ME|fixture-value|fixture-game/);
  } finally { sink?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test("trusted factory may only shorten the 15s response budget and cannot outrun body budget", () => {
  for (const requestTimeoutMs of [0, 19, 15001, 1.5, NaN, "15000"]) {
    assert.throws(() => create({ expectedHost: host, audit: () => true, bodyTimeoutMs: 20, requestTimeoutMs }), /RAW_GUARD_CONFIGURATION_INVALID/);
  }
});
test("abort, IO error, premature end, oversized streamed body", async () => {
  denied(await call({ action: (req) => req.emit("aborted") }), "RAW_BODY_ABORTED");
  denied(await call({ action: (req) => req.emit("error", new Error("DO_NOT_LOG_ME")) }), "RAW_BODY_IO_ERROR");
  denied(await call({ action: (req) => req.end("{") }), "RAW_FRAMING_INVALID");
  denied(await call({ action: (req) => req.end("{} ") }), "RAW_BODY_SIZE");
  denied(await call({ action: (req) => { req.complete = false; req.end("{}"); } }), "RAW_FRAMING_INVALID");
  denied(await call({ action: (req) => { req.trailers = { x: "y" }; req.end("{}"); } }), "RAW_FRAMING_INVALID");
});
test("response close cancels pending read without next", async () => {
  denied(await call({ action: (_req, res) => res.emit("close") }), "RAW_RESPONSE_CLOSED");
});
for (const audit of [() => false, () => { throw new Error("DO_NOT_LOG_ME"); }, () => Promise.resolve(true), () => Promise.reject(new Error("DO_NOT_LOG_ME"))]) {
  test("audit failure prevents dispatch", async () => {
    const out = await call({ audit }); denied(out, "RAW_AUDIT_UNAVAILABLE"); assert.equal(out.res.statusCode, 503);
  });
}
test("factory is explicit, does not mutate frozen baseline, rejects conflicting middleware", () => {
  const flows = [
    { type: "http in", method: "post", url: "/lk/integrations/v1/open-games/:gameId/members" },
    { type: "http in", method: "delete", url: "/lk/integrations/v1/open-games/:gameId/members/:membershipId" },
    { type: "http in", method: "get", url: "/lk/integrations/v1/operations/:operationId" },
  ];
  const before = JSON.stringify(baseline);
  const config = settingsModule.createGuardedPartnerSettings({ expectedHost: host, audit: () => true, flows });
  assert.equal(typeof config.httpNodeMiddleware, "function");
  assert.equal(config.httpAdminRoot, false);
  assert.equal(JSON.stringify(baseline), before);
  assert.equal(baseline.httpNodeMiddleware, undefined);
  assert.throws(() => settingsModule.createGuardedPartnerSettings({ expectedHost: host, flows }), /RAW_GUARD_CONFIGURATION_INVALID/);
  for (const field of ["httpNodeMiddleware", "httpNodeCors", "httpNodeAuth"]) assert.throws(() => settingsModule.createGuardedPartnerSettings({}, { ...baseline, [field]: () => {} }), /RAW_GUARD_SETTINGS_CONFLICT/);
  for (let i = 0; i < flows.length; i++) for (const option of ["skipBodyParsing", "upload"]) {
    assert.throws(() => settingsModule.validatePartnerGuardFlows(flows.map((node, index) => ({ ...node, [option]: index === i }))), /RAW_GUARD_FLOW_CONFIGURATION_INVALID/);
  }
  for (const bad of [undefined, [], flows.slice(1), [...flows, flows[0]]]) assert.throws(() => settingsModule.validatePartnerGuardFlows(bad), /RAW_GUARD_FLOW_CONFIGURATION_INVALID/);
});
test("preparation failure cleans fixture key and writes failure receipt before any Docker call", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-guard-prep-failure-"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  // Fault injection executable exists only inside this private temporary test.
  fs.writeFileSync(path.join(bin, "openssl"), `#!${process.execPath}\nif(process.argv[2]==="version")console.log("fixture-only");else{require("node:fs").writeFileSync("ca.key","synthetic-failure-marker");process.exit(1);}\n`, { mode: 0o700 });
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../rehearse_partner_game_membership_raw_guard.mjs", import.meta.url)), "--install-locked-runtime"],
      { env: { PATH: bin, TMPDIR: root }, encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 1);
    const summary = JSON.parse(child.stdout.trim());
    const receipt = JSON.parse(fs.readFileSync(path.join(summary.output, "receipt.json")));
    assert.equal(receipt.state, "FAILED");
    assert.match(receipt.error, /openssl/);
    assert.deepEqual(receipt.containers, []);
    assert.equal(receipt.syntheticPrivateKeysRemoved, true);
    assert.equal(fs.existsSync(path.join(path.dirname(summary.output), "fixture/ca.key")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("reset classification requires complete final response even after interim 100", () => {
  const final = "HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\n{}";
  const interim = "HTTP/1.1 100 Continue\r\n\r\n";
  assert.equal(httpFixture.completeResponseBeforeReset(final), true);
  assert.equal(httpFixture.completeResponseBeforeReset(interim + final), true);
  assert.equal(httpFixture.withoutContinue(interim + final), final);
  for (const value of ["", interim, final.slice(0, -1), interim + final.slice(0, -1), final + "x",
    final.replace("Content-Length: 2", "Content-Length: 2\r\nContent-Length: 2"),
    final.replace("Content-Length: 2", "Content-Length: 2\r\nTransfer-Encoding: chunked")]) {
    assert.equal(httpFixture.completeResponseBeforeReset(value), false);
  }
});
