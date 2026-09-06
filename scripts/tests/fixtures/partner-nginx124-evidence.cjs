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

const SOURCE_CLIENTS = Object.freeze(["client", "client-2", "client-3"]);
function sourceRateRow(attempts, differential, before, after, elapsedMs, logs, coldElapsedMs) {
  assert.ok(Number.isFinite(coldElapsedMs) && coldElapsedMs >= 6000); assert.equal(before.active, 0);
  assert.equal(attempts.length, 30); assert.equal(logs.length, 31);
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs <= 1500);
  const counts = Object.fromEntries(SOURCE_CLIENTS.map(client => [client, 0]));
  for (const [i, attempt] of attempts.entries()) {
    assert.equal(attempt.client, SOURCE_CLIENTS[i % 3]); counts[attempt.client]++;
    assert.equal(attempt.source, "source-a"); assert.equal(attempt.callerId, `fixture-caller-${i}`);
    assert.equal(attempt.response.socketLocalAddress, "127.0.0.1");
    assert.equal(attempt.forwardedSource, "source-b");
    assertHttpResponse(attempt.response); assert.ok([503, 429].includes(attempt.response.status));
    assert.equal(logs[i].status, String(attempt.response.status));
    assert.equal(logs[i].clientVerified, "1");
    assert.equal(logs[i].rate, attempt.response.status === 429 ? "REJECTED" : "PASSED");
    assert.equal(logs[i].concurrency, attempt.response.status === 429 ? "" : "PASSED");
    assert.equal(logs[i].upstream, attempt.response.status === 429 ? "" : "503");
  }
  assert.deepEqual(Object.values(counts), [10, 10, 10]); // each strictly below client first+burst=11
  const accepted = attempts.filter(attempt => attempt.response.status === 503).length;
  assert.ok(accepted >= 21 && accepted < 30, "Cold source first+burst=21, then actual source denial");
  assert.equal(differential.client, "client-3"); assert.equal(differential.source, "source-b");
  assert.equal(differential.response.socketLocalAddress, "127.0.0.3");
  assert.equal(differential.forwardedSource, "source-a"); // opposite spoof must not poison fresh source
  assertHttpResponse(differential.response); assert.equal(differential.response.status, 503);
  assert.equal(logs[30].status, "503"); assert.equal(logs[30].upstream, "503");
  assert.equal(logs[30].rate, "PASSED"); assert.equal(logs[30].concurrency, "PASSED");
  assert.equal(after.active, 0); assert.equal(after.calls - before.calls, accepted + 1);
  assert.equal(after.received - before.received, accepted + 1);
  return { name: "source-rate-independent", result: "PASS", clientAttempts: counts, coldElapsedMs,
    sameSourceAttempts: 30, accepted, rejected: 30 - accepted, batchElapsedMs: elapsedMs,
    differentialOtherSourceStatus: 503, forwardedAndCallerSpoofed: true, attempts, differential };
}

function sourceConcurrencyRow(attempts, rejected, spoofed, differential, before, held, after, logs, coldElapsedMs) {
  assert.ok(Number.isFinite(coldElapsedMs) && coldElapsedMs >= 6000); assert.equal(before.active, 0);
  assert.equal(attempts.length, 8); assert.equal(logs.length, 11);
  assert.equal(held.active, 8); assert.equal(held.calls - before.calls, 8); assert.equal(held.received - before.received, 8);
  assert.deepEqual(attempts.map(attempt => attempt.client), ["client", "client-2", "client-3", "client", "client-2", "client-3", "client", "client-2"]);
  for (const attempt of attempts) { assert.equal(attempt.source, "source-a"); assert.equal(attempt.response.socketLocalAddress, "127.0.0.1"); assertHttpResponse(attempt.response); assert.equal(attempt.response.status, 503); }
  for (const attempt of [rejected, spoofed]) {
    assert.equal(attempt.client, "client-3"); assert.equal(attempt.source, "source-a");
    assert.equal(attempt.response.socketLocalAddress, "127.0.0.1");
    assertHttpResponse(attempt.response); assert.equal(attempt.response.status, 429);
  }
  assert.equal(spoofed.forwardedSource, "source-b"); assert.equal(spoofed.callerId, "fixture-other-caller");
  assert.equal(differential.client, "client-3"); assert.equal(differential.source, "source-b");
  assert.equal(differential.response.socketLocalAddress, "127.0.0.3");
  assert.equal(differential.forwardedSource, "source-a");
  assertHttpResponse(differential.response); assert.equal(differential.response.status, 503);
  assert.equal(after.calls - before.calls, 9); assert.equal(after.received - before.received, 9); assert.equal(after.active, 0);
  assert.equal(logs.filter(row => row.status === "429" && row.concurrency === "REJECTED" && row.upstream === "").length, 2);
  assert.equal(logs.filter(row => row.status === "503" && row.concurrency === "PASSED" && row.upstream === "503").length, 9);
  assert.ok(logs.every(row => row.rate === "PASSED" && row.clientVerified === "1"));
  return { name: "source-concurrency-independent", result: "PASS", held: 8, perClientHeld: [3, 3, 2], coldElapsedMs,
    rejected: 2, differentialOtherSourceStatus: 503, observerCalls: 9, upstreamCalls: 9, activeAfter: 0,
    attempts, rejectedAttempt: rejected, spoofedAttempt: spoofed, differential };
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
  "sidecar-late-httpout-after-deadline", "positive-after-boundaries",
  "source-client-2-admitted", "source-client-3-admitted", "source-unbound-leaf-spoof-denied",
  "source-rate-independent", "source-rate-recovery", "source-concurrency-independent", "source-concurrency-recovery"]);
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
module.exports = { boundaryRow, packedHeaderFixture, ingressDenialRow, concurrencyRow, sourceRateRow, sourceConcurrencyRow,
  missingDeadlineRow, deadlineTransportResponse, deadlineRow, summarizeNginxRows, BOUNDARY_NAMES };
