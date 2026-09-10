import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { completeHttpResponse } from "./fixtures/partner-http-response.cjs";
import { boundaryRow, packedHeaderFixture, ingressDenialRow, concurrencyRow, sourceRateRow, sourceConcurrencyRow, missingDeadlineRow, deadlineTransportResponse, deadlineRow, summarizeNginxRows, BOUNDARY_NAMES } from "./fixtures/partner-nginx124-evidence.cjs";
import { generatePartnerNginx124Candidate } from "../partner_game_membership_nginx_candidate.mjs";
import { createPartnerNginxTestCertificates } from "./fixtures/partner-nginx124-certificates.mjs";
import { verifyPartnerProductionIngress } from "../partner_game_membership_ingress_evidence.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "partner-nginx-unit-"));
fs.chmodSync(root, 0o700);
after(() => fs.rmSync(root, { recursive: true, force: true }));
const input = createPartnerNginxTestCertificates(path.join(root, "certificates"));
const sourceInput = createPartnerNginxTestCertificates(path.join(root, "source-certificates"), { sourceLimits: true });

test("source-limit opt-in binds exactly three distinct TLS identities without changing any thresholds", () => {
  const single = generatePartnerNginx124Candidate(input), multi = generatePartnerNginx124Candidate(sourceInput);
  assert.doesNotMatch(single.configuration, /fixture-client-[23]|allow 127\.0\.0\.3/);
  assert.equal(single.clientIdentities.length, 1); assert.equal(multi.clientIdentities.length, 3);
  assert.equal(new Set(multi.clientIdentities.map(item => item.spkiSha256)).size, 3);
  assert.equal(new Set(multi.clientIdentities.map(item => item.leafSha256)).size, 3);
  assert.deepEqual(multi.clientIdentities.map(item => item.bucket), ["fixture-client", "fixture-client-2", "fixture-client-3"]);
  assert.deepEqual(Object.keys(multi.certificateHashes).sort(), ["ca", "client", "client-2", "client-3", "server"]);
  assert.match(multi.configuration, /allow 127\.0\.0\.1;[\s\S]*allow 127\.0\.0\.3;[^\n]*\n\s*deny all;/);
  assert.doesNotMatch(multi.configuration, /^\s*(?:allow 127\.0\.0\.2|set_real_ip_from|real_ip_header|limit_(req|conn)_dry_run|include |load_module )/m);
  const policy = config => config.split("\n").filter(line => /^\s*limit_(req|conn)/.test(line));
  assert.deepEqual(policy(single.configuration), policy(multi.configuration));
  assert.equal(multi.unresolvedControls.includes("SOURCE_LIMIT_INDEPENDENT_PROOF"), true);
  for (const flag of ["productionVerified", "deployAuthorized", "activationAuthorized"]) assert.equal(multi[flag], false);
  assert.throws(() => verifyPartnerProductionIngress(multi), /UNSUPPORTED_INGRESS_ADAPTER/);
});

test("additional TLS bindings reject malformed arrays, alias keys, unpinned leaves and input overrides", () => {
  const build = bindings => generatePartnerNginx124Candidate({ ...sourceInput, sourceLimitClients: bindings });
  for (const value of [undefined, null, [], [sourceInput.sourceLimitClients[0]], Array(2), [...sourceInput.sourceLimitClients, sourceInput.sourceLimitClients[0]]]) assert.throws(() => build(value));
  const [a, b] = sourceInput.sourceLimitClients;
  for (const binding of [{ ...a, label: "attacker" }, { ...a, approvedClientSpkiSha256: "0".repeat(64) },
    { ...a, clientCertificateBytes: sourceInput.serverCertificateBytes },
    { ...a, clientCertificateBytes: fs.readFileSync(path.join(root, "source-certificates/wrong-client.crt")) },
    { ...a, clientCertificateBytes: input.clientCertificateBytes }]) assert.throws(() => build([binding, b]));
  assert.throws(() => build([a, a]), /IDENTITY_DUPLICATE/);
  assert.throws(() => build([{ clientCertificateBytes: sourceInput.clientCertificateBytes, approvedClientSpkiSha256: sourceInput.approvedClientSpkiSha256 }, b]), /IDENTITY_DUPLICATE/);
  for (const changes of [{ sourceCidrs: ["0.0.0.0/0"] }, { sourceRate: 999 }, { clientLimit: 999 }, { skipLimits: true }]) assert.throws(() => generatePartnerNginx124Candidate({ ...sourceInput, ...changes }));
});

test("Nginx candidate is deterministic, include-free, loopback-only and never production evidence", () => {
  const a = generatePartnerNginx124Candidate(input);
  assert.deepEqual(a, generatePartnerNginx124Candidate({ ...input }));
  assert.match(a.configuration, /ssl_verify_client on;/);
  assert.match(a.configuration, /ssl_reject_handshake on;/);
  assert.match(a.configuration, /ssl_early_data off;/);
  assert.match(a.configuration, /proxy_next_upstream off;/);
  assert.match(a.configuration, /map \$ssl_client_escaped_cert \$partner_client/);
  assert.ok(a.configuration.includes(`"~^${encodeURIComponent(input.clientCertificateBytes.toString())}$" fixture-client`));
  assert.doesNotMatch(a.configuration, /^\s*(?:include |load_module )|listen (?:0\.0\.0\.0|\[::\])|real_ip_header|proxy_pass_request_headers off|\$ssl_client_fingerprint/m);
  for (const flag of ["productionVerified", "deployAuthorized", "activationAuthorized"]) assert.equal(a[flag], false);
  assert.equal(a.unresolvedControls.includes("WILDCARD_FORWARDED_HEADERS"), true);
  assert.throws(() => verifyPartnerProductionIngress(a), /UNSUPPORTED_INGRESS_ADAPTER/);
});

test("HTTP fixture evidence requires complete unambiguous framing, including HEAD and chunked", () => {
  const parse = (text, method) => completeHttpResponse(Buffer.from(text), method);
  assert.equal(parse("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\n\r\n{}").status, 503);
  assert.equal(parse("HTTP/1.1 404 Not Found\r\nContent-Length: 99\r\n\r\n", "HEAD").status, 404);
  assert.equal(parse("HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n").status, 503);
  for (const response of [
    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 3\r\n\r\n{}",
    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 1\r\n\r\n{}",
    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\ncontent-length: 2\r\n\r\n{}",
    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
    "HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n",
    "HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n",
    "HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nextra",
    "HTTP/1.1 503 Service Unavailable\r\n\r\n{}",
    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0",
  ]) assert.throws(() => parse(response), /INCOMPLETE_OR_AMBIGUOUS/);
  assert.throws(() => parse("HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}", "HEAD"), /INCOMPLETE_OR_AMBIGUOUS/);
  for (const body of [Buffer.from([0xb2, 13, 10, 123, 125, 13, 10, 48, 13, 10, 13, 10]), Buffer.from([0xb0, 13, 10, 13, 10])]) {
    assert.throws(() => completeHttpResponse(Buffer.concat([Buffer.from("HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n"), body])), /INCOMPLETE_OR_AMBIGUOUS/);
  }
});

test("pre-Docker preparation failure removes generated keys and writes a failure receipt", () => {
  const auditRoot = fs.mkdtempSync(path.join(os.tmpdir(), "partner-runtime-audit-")); fs.chmodSync(auditRoot, 0o700);
  let output;
  try {
    fs.mkdirSync(path.join(auditRoot, "results")); fs.mkdirSync(path.join(auditRoot, "runtime"));
    fs.writeFileSync(path.join(auditRoot, "results/receipt.json"), JSON.stringify({ state: "PASS_LOCAL_AUDIT_ONLY", containerPresentAfterCleanup: false, sourceHashes: { "partner_game_membership_runtime/package.json": "deliberate-fixture-mismatch" } }));
    fs.writeFileSync(path.join(auditRoot, "runtime/package.json"), "{}");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../rehearse_partner_game_membership_nginx_candidate.mjs", import.meta.url)), "--audited-runtime-root", auditRoot], { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 1);
    output = JSON.parse(result.stdout.trim()).output;
    assert.ok(path.basename(output).startsWith("partner-nginx-candidate-"));
    const receipt = JSON.parse(fs.readFileSync(path.join(output, "results/receipt.json")));
    assert.equal(receipt.state, "FAILED"); assert.deepEqual(receipt.cleanup, []);
    assert.equal(receipt.syntheticPrivateKeysRemoved, true);
    assert.equal(fs.readdirSync(path.join(output, "fixture")).some(name => /\.(key|csr)$/.test(name)), false);
  } finally {
    fs.rmSync(auditRoot, { recursive: true, force: true });
    if (output && path.basename(output).startsWith("partner-nginx-candidate-")) fs.rmSync(output, { recursive: true, force: true });
  }
});

for (const [name, changes] of Object.entries({
  production: { scope: "PRODUCTION" }, publicHost: { exactHost: "partner.example.com" },
  sameHost: { sharedHost: "fixture.invalid" }, injection: { exactHost: "fixture.invalid; include /etc/passwd;" },
  wildcard: { exactHost: "*.invalid" }, uppercase: { exactHost: "FIXTURE.invalid" },
  unknown: { deployAuthorized: true }, snippet: { configuration: "anything" }, invalidClock: { now: NaN },
})) test(`Nginx candidate rejects ${name}`, () => {
  assert.throws(() => generatePartnerNginx124Candidate({ ...input, ...changes }), /INVALID_NGINX_CANDIDATE_INPUT/);
});

test("Nginx certificate admission rejects wrong SPKI, other leaf, private bytes, wrong SAN and time", () => {
  assert.throws(() => generatePartnerNginx124Candidate({ ...input, approvedClientSpkiSha256: "0".repeat(64) }), /SPKI_MISMATCH/);
  assert.throws(() => generatePartnerNginx124Candidate({ ...input, clientCertificateBytes: fs.readFileSync(path.join(root, "certificates/other-client.crt")) }), /SPKI_MISMATCH/);
  const privateHeaderSentinel = ["-----BEGIN", "PRIVATE KEY-----\n"].join(" ");
  assert.throws(() => generatePartnerNginx124Candidate({ ...input, clientCertificateBytes: Buffer.from(privateHeaderSentinel) }), /INVALID_NGINX_PUBLIC_CERTIFICATE/);
  assert.throws(() => generatePartnerNginx124Candidate({ ...input, exactHost: "other.invalid" }), /CERTIFICATE_BINDING_REJECTED/);
  assert.throws(() => generatePartnerNginx124Candidate({ ...input, now: input.now + 2 * 86400000 }), /EXPIRED_OR_FUTURE/);
  assert.throws(() => generatePartnerNginx124Candidate({ ...input, now: input.now - 2 * 86400000 }), /EXPIRED_OR_FUTURE/);
  assert.throws(() => generatePartnerNginx124Candidate({ ...input, clientCertificateBytes: input.serverCertificateBytes }), /CERTIFICATE_BINDING_REJECTED/);
});

test("rate admission uses bound TLS leaf, never caller client-ID or forwarded-IP buckets", () => {
  const { configuration } = generatePartnerNginx124Candidate(input);
  assert.match(configuration, /limit_req_zone \$partner_client zone=partner_client_rate:1m rate=2r\/s/);
  assert.match(configuration, /limit_req_zone \$binary_remote_addr zone=partner_source_rate:1m rate=5r\/s/);
  assert.match(configuration, /limit_conn partner_client_connections 4;/);
  assert.match(configuration, /limit_conn partner_source_connections 8;/);
  assert.doesNotMatch(configuration, /limit_(req|conn)_zone \$http_/);
  const log = configuration.split("\n").find(line => line.includes("log_format"));
  assert.doesNotMatch(log, /\$request[" ]|\$request_uri|\$remote_addr|\$http_|\$ssl_client_s_dn|\$ssl_client_escaped_cert/);
});

test("aggregate budget includes the initial buffer and cannot silently enable HTTP/2 or connection reuse", () => {
  const { configuration } = generatePartnerNginx124Candidate(input);
  const initial = [...configuration.matchAll(/^\s*client_header_buffer_size (\d+)k;/gm)];
  const large = [...configuration.matchAll(/^\s*large_client_header_buffers (\d+) (\d+)k;/gm)];
  assert.equal(initial.length, 1); assert.equal(large.length, 1);
  assert.equal(Number(initial[0][1]), 2); assert.equal(Number(large[0][2]), 2);
  assert.equal((Number(initial[0][1]) + Number(large[0][1]) * Number(large[0][2])) * 1024, 16384);
  assert.equal(configuration.match(/^\s*keepalive_timeout 0;/gm)?.length, 1);
  assert.doesNotMatch(configuration, /^\s*http2\s|^\s*listen .*\b(?:http2|quic|reuseport)\b|^\s*proxy_pass_request_headers off;/m);
});

test("packed header fixture measures the whole head independently of body and preserves unique proof fields", () => {
  const base = ["Host", "fixture.invalid", "Connection", "close", "Content-Length", "2", "X-Proof", "fixture-value"];
  for (const method of ["POST", "DELETE", "GET"]) for (const bytes of [16384, 16385]) {
    const target = "/fixture/" + "a".repeat(160), built = packedHeaderFixture(method, target, base, bytes);
    const fields = built.headers.reduce((all, value, i, list) => i % 2 ? all : [...all, `${value}: ${list[i + 1]}\r\n`], []);
    const head = `${method} ${target} HTTP/1.1\r\n${fields.join("")}\r\n`;
    assert.equal(Buffer.byteLength(head), bytes); assert.equal(built.headBytes, bytes);
    assert.equal(built.headerSectionBytes, Buffer.byteLength(fields.join("") + "\r\n"));
    assert.ok(fields.every(field => Buffer.byteLength(field) <= 2048));
    assert.deepEqual(built.headers.slice(0, base.length), base); assert.deepEqual(base.slice(-2), ["X-Proof", "fixture-value"]);
  }
  assert.throws(() => packedHeaderFixture("POST", "/fixture", base, 20000));
  assert.throws(() => packedHeaderFixture("POST", "/fixture", [...base, "host", "duplicate"], 16384));
  assert.throws(() => packedHeaderFixture("POST", "/fixture\r\nInjected", base, 16384));
});

const observedHttp = (status, extra = {}) => ({ status, outcome: "HTTP_RESPONSE", serverAuthorized: true, noStore: true, cors: false, elapsedMs: 100, ...extra });
test("aggregate ingress proof rejects a hidden upstream parser refusal even if request counters stay zero", () => {
  const state = { calls: 0, received: 0 }, response = observedHttp(400);
  const log = { status: "400", upstream: "" };
  assert.equal(ingressDenialRow("oversize", response, state, state, [log]).ingressUpstreamStatus, "");
  for (const logs of [[], [log, log], [{ status: "400" }], [{ ...log, upstream: "-" }], [{ ...log, upstream: "400" }], [{ status: "431", upstream: "431" }]]) {
    assert.throws(() => ingressDenialRow("oversize", response, state, state, logs));
  }
  assert.throws(() => ingressDenialRow("oversize", observedHttp(431), state, state, [{ status: "431", upstream: "431" }]));
});
test("boundary proof rejects wrong status, hidden dispatch, insecure response and invalid timing", () => {
  const before = { calls: 0, received: 0 }, after = { calls: 0, received: 0 };
  const policy = { statuses: [403], dispatch: 0, upstream: 0 };
  assert.equal(boundaryRow("source", observedHttp(403), before, after, policy).result, "PASS");
  for (const response of [observedHttp(503), observedHttp(403, { serverAuthorized: false }), observedHttp(403, { cors: true }),
    observedHttp(403, { noStore: false }), observedHttp(403, { elapsedMs: NaN }), observedHttp(403, { outcome: "LOCAL_TIMEOUT" })]) {
    assert.throws(() => boundaryRow("source", response, before, after, policy));
  }
  for (const altered of [{ calls: 1, received: 0 }, { calls: 0, received: 1 }]) assert.throws(() => boundaryRow("source", observedHttp(403), before, altered, policy));
  assert.throws(() => boundaryRow("timeout", observedHttp(504), before, { calls: 1, received: 1 }, { statuses: [504], dispatch: 1, upstream: 1, minElapsedMs: 14000 }));
  assert.throws(() => boundaryRow("timeout", observedHttp(504, { elapsedMs: 25000 }), before, { calls: 1, received: 1 }, { statuses: [504], dispatch: 1, upstream: 1, maxElapsedMs: 21000 }));
});

test("legacy TLS proof requires the expected server alert, not any TLS or local error", () => {
  const state = { calls: 0, received: 0 };
  const policy = { statuses: [null], dispatch: 0, upstream: 0, tlsAlertCode: "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION" };
  const response = { status: null, outcome: "TLS_ALERT_REJECTED", elapsedMs: 30, tlsAlertCode: policy.tlsAlertCode };
  assert.equal(boundaryRow("legacy", response, state, state, policy).result, "PASS");
  for (const code of ["ERR_SSL_NO_PROTOCOLS_AVAILABLE", "ERR_SSL_TLSV1_UNRECOGNIZED_NAME", "ECONNRESET", undefined]) {
    assert.throws(() => boundaryRow("legacy", { ...response, tlsAlertCode: code }, state, state, policy));
  }
});

test("concurrency proof requires four active upstream requests and an actual limit_conn denial", () => {
  const responses = Array.from({ length: 4 }, () => observedHttp(503)), rejected = observedHttp(429);
  const before = { calls: 0, received: 0 }, held = { active: 4 }, after = { calls: 4, received: 4, active: 0 };
  const logs = [...Array.from({ length: 4 }, () => ({ status: "503", concurrency: "PASSED", rate: "PASSED" })), { status: "429", concurrency: "REJECTED", rate: "-" }];
  assert.equal(concurrencyRow(responses, rejected, before, held, after, logs).result, "PASS");
  assert.throws(() => concurrencyRow(responses, rejected, before, { active: 3 }, after, logs));
  assert.throws(() => concurrencyRow(responses, rejected, before, held, { ...after, active: 1 }, logs));
  assert.throws(() => concurrencyRow(responses, rejected, before, held, { ...after, received: 5 }, logs));
  assert.throws(() => concurrencyRow(responses, rejected, before, held, after, logs.map(row => row.status === "429" ? { ...row, concurrency: "-", rate: "REJECTED" } : row)));
  assert.throws(() => concurrencyRow(responses, rejected, before, held, after, logs.slice(1)));
});

test("completed drip response beyond the bound confirms a blocker and can never become PASS", () => {
  const response = observedHttp(503, { elapsedMs: 18050, firstByteMs: 20, responseChunks: 11 });
  const before = { calls: 0, received: 0, trickleWrites: 0 }, after = { calls: 1, received: 1, trickleWrites: 10 };
  assert.equal(missingDeadlineRow(response, before, after).result, "KNOWN_BLOCKER_CONFIRMED");
  for (const changes of [{ elapsedMs: 14000 }, { elapsedMs: 25000 }, { firstByteMs: 18000 }, { firstByteMs: null }, { responseChunks: 1 }, { status: 504 }]) {
    assert.throws(() => missingDeadlineRow({ ...response, ...changes }, before, after));
  }
  assert.throws(() => missingDeadlineRow(response, before, { ...after, trickleWrites: 1 }));
});

test("complete matrix summary cannot drop, duplicate or relabel a remaining boundary", () => {
  const rows = [...Array.from({ length: 49 }, (_, i) => ({ name: `baseline-${i}`, result: "PASS" })), ...BOUNDARY_NAMES.map(name => ({ name, result: "PASS" }))];
  for (const row of rows.filter(row => ["absolute-request-deadline", "sidecar-late-httpout-after-deadline"].includes(row.name))) {
    Object.assign(row, { control: "SIDECAR_RESPONSE_DEADLINE", watchdogAudits: 1 });
  }
  assert.deepEqual(summarizeNginxRows(rows), { passed: 77, confirmedBlockers: [], notTested: [] });
  assert.throws(() => summarizeNginxRows(rows.slice(1)));
  assert.throws(() => summarizeNginxRows([...rows.slice(1), rows[1]]));
  assert.throws(() => summarizeNginxRows(rows.map(row => row.name === "absent-sni" ? { ...row, name: "unknown" } : row)));
  assert.throws(() => summarizeNginxRows(rows.map(row => row.name === "absolute-request-deadline" ? { ...row, result: "KNOWN_BLOCKER_CONFIRMED" } : row)));
  assert.throws(() => summarizeNginxRows(rows.map(row => row.name === "absolute-request-deadline" ? { ...row, watchdogAudits: 0 } : row)));
});
test("deadline transport parser never labels a truncated response complete or accepts arbitrary framing", () => {
  const prefix = "HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\n\r\n2\r\n{}\r\n";
  const parse = (bytes, mode = "trickle") => deadlineTransportResponse(Buffer.from(bytes), mode, completeHttpResponse);
  assert.equal(parse(prefix).outcome, "TRUNCATED_HTTP_RESPONSE");
  assert.equal(parse(prefix).complete, false);
  assert.equal(parse("", "late").outcome, "NO_HTTP_RESPONSE");
  for (const bytes of ["", prefix + "0\r\n\r\n", prefix.slice(0, -1), prefix.replace("chunked", "unknown"), prefix.replace("503", "200")]) assert.throws(() => parse(bytes));
  assert.throws(() => parse(prefix, "late")); assert.throws(() => parse(prefix, "unknown"));
});
test("deadline proof requires trusted same-request watchdog audit, timing, no redispatch and incomplete response", () => {
  const requestId = "00000000-0000-4000-8000-000000000000";
  const before = { calls: 0, received: 0, active: 0, audits: [], trickleWrites: 0 };
  const after = { calls: 1, received: 1, active: 0, trickleWrites: 8,
    audits: ["RAW_ACCEPTED", "RAW_REQUEST_DEADLINE"].map(code => ({ code, requestId })) };
  const response = observedHttp(503, { complete: false, outcome: "TRUNCATED_HTTP_RESPONSE", elapsedMs: 15040, firstByteMs: 25, responseChunks: 9 });
  assert.equal(deadlineRow("absolute-request-deadline", response, before, after, "trickle").result, "PASS");
  for (const changes of [{ complete: true }, { outcome: "HTTP_RESPONSE" }, { elapsedMs: 100 }, { elapsedMs: 18000 }, { status: 504 }, { noStore: false }]) {
    assert.throws(() => deadlineRow("deadline", { ...response, ...changes }, before, after, "trickle"));
  }
  for (const changes of [{ calls: 2 }, { received: 2 }, { active: 1 }, { trickleWrites: 10 }, { audits: [] },
    { audits: [after.audits[0], { ...after.audits[1], requestId: "other" }] }, { audits: [...after.audits, after.audits[1]] }]) {
    assert.throws(() => deadlineRow("deadline", response, before, { ...after, ...changes }, "trickle"));
  }
});

test("source rate proof refuses client-budget, socket, log, warm-state and timing substitutions", () => {
  const fresh = () => {
    const attempts = Array.from({ length: 30 }, (_, i) => ({ client: ["client", "client-2", "client-3"][i % 3],
      source: "source-a", callerId: `fixture-caller-${i}`, forwardedSource: "source-b",
      response: observedHttp(i < 21 ? 503 : 429, { socketLocalAddress: "127.0.0.1" }) }));
    const differential = { client: "client-3", source: "source-b", forwardedSource: "source-a", response: observedHttp(503, { socketLocalAddress: "127.0.0.3" }) };
    const logs = [...attempts, differential].map(item => ({ status: String(item.response.status), clientVerified: "1",
      upstream: item.response.status === 503 ? "503" : "", rate: item.response.status === 503 ? "PASSED" : "REJECTED", concurrency: item.response.status === 503 ? "PASSED" : "" }));
    return [attempts, differential, { calls: 0, received: 0, active: 0 }, { calls: 22, received: 22, active: 0 }, 800, logs, 6005];
  };
  assert.equal(sourceRateRow(...fresh()).rejected, 9);
  for (const mutate of [args => { args[0][0].client = "client-3"; }, args => { args[0][0].source = "source-b"; },
    args => { args[0][0].response.socketLocalAddress = "127.0.0.3"; }, args => { args[0][0].callerId = "same"; },
    args => { args[0][0].response.serverAuthorized = false; }, args => { args[1].response.status = 429; },
    args => { args[1].response.socketLocalAddress = "127.0.0.1"; }, args => { args[3].calls++; },
    args => { args[4] = 1600; }, args => { args[6] = 5999; }, args => { args[2].active = 1; },
    args => { args[5][21].concurrency = "REJECTED"; }, args => { args[5][21].upstream = "429"; },
    args => { args[5][21].rate = "PASSED"; }, args => { args[5].pop(); }]) {
    const args = fresh(); mutate(args); assert.throws(() => sourceRateRow(...args));
  }
});

test("source concurrency proof requires eight actual held handlers below every client cap and other-source admission", () => {
  const fresh = () => {
    const attempt = (client, source, status, changes = {}) => ({ client, source, forwardedSource: "source-a", callerId: "fixture-caller",
      response: observedHttp(status, { socketLocalAddress: source === "source-a" ? "127.0.0.1" : "127.0.0.3" }), ...changes });
    const held = Array.from({ length: 8 }, (_, i) => attempt(["client", "client-2", "client-3"][i % 3], "source-a", 503));
    const rejected = attempt("client-3", "source-a", 429), spoofed = attempt("client-3", "source-a", 429, { callerId: "fixture-other-caller", forwardedSource: "source-b" });
    const differential = attempt("client-3", "source-b", 503);
    const logs = [...held, rejected, spoofed, differential].map(item => ({ status: String(item.response.status), clientVerified: "1", rate: "PASSED",
      upstream: item.response.status === 503 ? "503" : "", concurrency: item.response.status === 503 ? "PASSED" : "REJECTED" }));
    return [held, rejected, spoofed, differential, { calls: 0, received: 0, active: 0 }, { calls: 8, received: 8, active: 8 }, { calls: 9, received: 9, active: 0 }, logs, 6005];
  };
  assert.equal(sourceConcurrencyRow(...fresh()).result, "PASS");
  for (const mutate of [args => { args[0][7].client = "client"; }, args => { args[5].active = 7; }, args => { args[5].calls = 7; },
    args => { args[1].client = "client"; }, args => { args[2].response.socketLocalAddress = "127.0.0.3"; },
    args => { args[3].response.status = 429; }, args => { args[3].response.socketLocalAddress = "127.0.0.1"; },
    args => { args[6].calls = 10; }, args => { args[6].active = 1; }, args => { args[7][8].rate = "REJECTED"; },
    args => { args[7][8].upstream = "429"; }, args => { args[8] = 5000; }, args => { args[7].pop(); }]) {
    const args = fresh(); mutate(args); assert.throws(() => sourceConcurrencyRow(...args));
  }
});
