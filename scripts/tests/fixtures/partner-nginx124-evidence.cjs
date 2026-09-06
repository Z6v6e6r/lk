"use strict";
// Pure assertions for physical fixture observations, not a production verifier.
const assert = require("node:assert/strict");
function assertHttpResponse(response) {
  assert.equal(response.outcome, "HTTP_RESPONSE");
  assert.equal(response.serverAuthorized, true);
  assert.equal(response.noStore, true);
  assert.equal(response.cors, false);
}

function boundaryRow(name, response, before, after, policy) {
  assert.ok(policy.statuses.includes(response.status), `${name}: unexpected status`);
  assert.equal(after.calls - before.calls, policy.dispatch, `${name}: observer dispatch`);
  assert.equal(after.received - before.received, policy.upstream, `${name}: upstream count`);
  assert.ok(Number.isFinite(response.elapsedMs) && response.elapsedMs >= 0);
  if (policy.minElapsedMs !== undefined) assert.ok(response.elapsedMs >= policy.minElapsedMs, `${name}: too early`);
  if (policy.maxElapsedMs !== undefined) assert.ok(response.elapsedMs <= policy.maxElapsedMs, `${name}: too late`);
  if (response.status === null) {
    assert.equal(response.outcome, "TLS_ALERT_REJECTED");
    assert.equal(response.tlsAlertCode, policy.tlsAlertCode, `${name}: explicit server alert required`);
  } else {
    assertHttpResponse(response);
  }
  return { name, ...response, observerCalls: after.calls - before.calls, upstreamCalls: after.received - before.received, result: "PASS" };
}

// Build a synthetic request head packed on 2k field boundaries. The first
// buffer includes the request line and mandatory headers; the final CRLF counts.
// This constructs wire input, not a model of Nginx's parser or proof of admission.
function packedHeaderFixture(method, target, headers, headBytes) {
  assert.ok(["POST", "DELETE", "GET"].includes(method));
  assert.match(target, /^\/[A-Za-z0-9/_-]+$/);
  assert.ok(Array.isArray(headers) && headers.length % 2 === 0);
  const result = [...headers];
  const fieldBytes = (name, value) => Buffer.byteLength(`${name}: ${value}\r\n`);
  const lineBytes = Buffer.byteLength(`${method} ${target} HTTP/1.1\r\n`);
  assert.ok([16384, 16385, 16385 + lineBytes].includes(headBytes));
  let used = lineBytes;
  for (let i = 0; i < result.length; i += 2) {
    assert.match(result[i], /^[A-Za-z0-9-]+$/); assert.match(result[i + 1], /^[\x20-\x7e]*$/);
    used += fieldBytes(result[i], result[i + 1]);
  }
  assert.ok(used < 2000);
  for (let i = 0; used < headBytes - 2; i++) {
    const name = `X-Budget-${i}`, bytes = Math.min(2048 - used % 2048, headBytes - 2 - used);
    assert.ok(bytes >= fieldBytes(name, ""));
    result.push(name, "a".repeat(bytes - fieldBytes(name, ""))); used += bytes;
  }
  assert.equal(new Set(result.filter((_, i) => i % 2 === 0).map(name => name.toLowerCase())).size, result.length / 2);
  return { headers: result, headBytes: used + 2, headerSectionBytes: used + 2 - lineBytes, lineBytes };
}

function ingressDenialRow(name, response, before, after, logs, wire = {}) {
  const row = boundaryRow(name, response, before, after, { statuses: [400], dispatch: 0, upstream: 0 });
  // Node's own 431 can occur before its request counter increments. Require
  // the actual serial Nginx access record to prove no upstream attempt.
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, "400"); assert.equal(logs[0].upstream, "");
  return { ...row, ...wire, ingressUpstreamStatus: "" };
}

function concurrencyRow(responses, rejected, before, held, after, logs) {
  assert.equal(responses.length, 4);
  [...responses, rejected].forEach(assertHttpResponse);
  for (const response of responses) assert.equal(response.status, 503);
  assert.equal(rejected.status, 429);
  assert.equal(held.active, 4); assert.equal(after.active, 0);
  assert.equal(after.calls - before.calls, 4); assert.equal(after.received - before.received, 4);
  assert.equal(logs.length, 5);
  assert.equal(logs.filter(row => row.status === "429" && row.concurrency === "REJECTED").length, 1);
  assert.ok(logs.every(row => row.rate !== "REJECTED"), "Rate denial cannot stand in for concurrency denial");
  return { name: "client-concurrency", result: "PASS", held: 4, accepted: 4, rejected: 1, observerCalls: 4, upstreamCalls: 4, activeAfter: 0 };
}

function missingDeadlineRow(response, before, after) {
  const row = boundaryRow("absolute-request-deadline", response, before, after, {
    statuses: [503], dispatch: 1, upstream: 1, minElapsedMs: 17500, maxElapsedMs: 23000,
  });
  assert.ok(Number.isFinite(response.firstByteMs) && response.firstByteMs >= 0 && response.firstByteMs < 5000);
  assert.ok(response.responseChunks >= 2);
  assert.equal(after.trickleWrites - before.trickleWrites, 10);
  // A fully completed drip response beyond 15 seconds CONFIRMS a missing bound.
  // Never relabel this observed failure of the desired control as PASS.
  return { ...row, result: "KNOWN_BLOCKER_CONFIRMED", control: "ABSOLUTE_REQUEST_DEADLINE", requiredBoundMs: 15000 };
}
// Only the two explicit deadline fixtures may observe a deliberately incomplete
// response. Ordinary probes still require the unchanged complete HTTP parser.
function deadlineTransportResponse(bytes, mode, parseComplete) {
  if (mode === "late") {
    assert.equal(bytes.length, 0);
    return { status: null, outcome: "NO_HTTP_RESPONSE", complete: false };
  }
  assert.equal(mode, "trickle");
  assert.throws(() => parseComplete(bytes), /INCOMPLETE_OR_AMBIGUOUS/);
  // Each received chunk must be complete; only the terminal chunk is absent.
  const parsed = parseComplete(Buffer.concat([bytes, Buffer.from("0\r\n\r\n")]));
  assert.equal(parsed.status, 503);
  return { ...parsed, outcome: "TRUNCATED_HTTP_RESPONSE", complete: false };
}
function deadlineRow(name, response, before, after, mode) {
  assert.ok(["trickle", "late"].includes(mode));
  assert.equal(response.complete, false);
  assert.equal(response.outcome, mode === "trickle" ? "TRUNCATED_HTTP_RESPONSE" : "NO_HTTP_RESPONSE");
  assert.ok(response.elapsedMs >= 14500 && response.elapsedMs <= 17000, "15s budget with explicit local scheduler/transport tolerance");
  assert.equal(after.calls - before.calls, 1); assert.equal(after.received - before.received, 1);
  assert.equal(after.active, 0);
  const events = after.audits.slice(before.audits.length);
  assert.deepEqual(events.map(event => event.code), ["RAW_ACCEPTED", "RAW_REQUEST_DEADLINE"]);
  assert.match(events[0].requestId, /^[a-f0-9-]{36}$/);
  assert.equal(events[0].requestId, events[1].requestId);
  if (mode === "trickle") {
    assert.equal(response.serverAuthorized, true); assert.equal(response.noStore, true); assert.equal(response.cors, false);
    assert.equal(response.status, 503); assert.ok(response.firstByteMs >= 0 && response.firstByteMs < 5000);
    assert.ok(response.responseChunks >= 2); assert.equal(after.trickleWrites - before.trickleWrites, 8);
  } else { assert.equal(response.status, null); assert.equal(response.responseChunks, 0); }
  return { name, ...response, result: "PASS", control: "SIDECAR_RESPONSE_DEADLINE", requiredBoundMs: 15000,
    observationToleranceMs: 2000, watchdogAudits: 1, observerCalls: 1, upstreamCalls: 1, activeAfter: 0 };
}
const BOUNDARY_NAMES = Object.freeze(["reject-TLSv1", "reject-TLSv1.1", "absent-sni", "source-cidr-denial",
  "request-line-2048", "request-line-2049", "header-field-2048", "header-field-2049", "aggregate-header-over-16k",
  "packed-head-post-16384", "packed-head-delete-16384", "packed-head-get-16384", "packed-head-post-16385",
  "header-section-16385", "packed-head-reordered-16384-denied",
  "client-concurrency", "concurrency-slot-recovery", "upstream-silence-bound-no-retry", "absolute-request-deadline",
  "sidecar-late-httpout-after-deadline", "positive-after-boundaries"]);
function summarizeNginxRows(rows) {
  assert.equal(rows.length, 49 + BOUNDARY_NAMES.length);
  assert.equal(new Set(rows.map(row => row.name)).size, rows.length);
  for (const name of BOUNDARY_NAMES) assert.ok(rows.some(row => row.name === name), `Missing boundary ${name}`);
  for (const row of rows) {
    assert.equal(row.result, "PASS");
    if (["absolute-request-deadline", "sidecar-late-httpout-after-deadline"].includes(row.name)) {
      assert.equal(row.control, "SIDECAR_RESPONSE_DEADLINE"); assert.equal(row.watchdogAudits, 1);
    }
  }
  return { passed: rows.length, confirmedBlockers: [], notTested: [] };
}
module.exports = { boundaryRow, packedHeaderFixture, ingressDenialRow, concurrencyRow, missingDeadlineRow, deadlineTransportResponse, deadlineRow, summarizeNginxRows, BOUNDARY_NAMES };
