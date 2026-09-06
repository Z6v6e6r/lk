import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { completeHttpResponse } from "./fixtures/partner-http-response.cjs";
import { boundaryRow, concurrencyRow, missingDeadlineRow, summarizeNginxRows, BOUNDARY_NAMES } from "./fixtures/partner-nginx124-evidence.cjs";
import { generatePartnerNginx124Candidate } from "../partner_game_membership_nginx_candidate.mjs";
import { createPartnerNginxTestCertificates } from "./fixtures/partner-nginx124-certificates.mjs";
import { verifyPartnerProductionIngress } from "../partner_game_membership_ingress_evidence.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "partner-nginx-unit-"));
fs.chmodSync(root, 0o700);
after(() => fs.rmSync(root, { recursive: true, force: true }));
const input = createPartnerNginxTestCertificates(path.join(root, "certificates"));

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

const observedHttp = (status, extra = {}) => ({ status, outcome: "HTTP_RESPONSE", serverAuthorized: true, noStore: true, cors: false, elapsedMs: 100, ...extra });
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
  Object.assign(rows.find(row => row.name === "absolute-request-deadline"), { result: "KNOWN_BLOCKER_CONFIRMED", control: "ABSOLUTE_REQUEST_DEADLINE" });
  assert.deepEqual(summarizeNginxRows(rows), { passed: 62, confirmedBlockers: ["ABSOLUTE_REQUEST_DEADLINE"], notTested: [] });
  assert.throws(() => summarizeNginxRows(rows.slice(1)));
  assert.throws(() => summarizeNginxRows([...rows.slice(1), rows[1]]));
  assert.throws(() => summarizeNginxRows(rows.map(row => row.name === "absent-sni" ? { ...row, name: "unknown" } : row)));
  assert.throws(() => summarizeNginxRows(rows.map(row => row.result === "KNOWN_BLOCKER_CONFIRMED" ? { ...row, result: "PASS" } : row)));
});
